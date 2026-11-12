//! The host's firewall: what filters incoming traffic, its rules, and the ports open
//! to the network. Rules are added and removed through the tool already in charge
//! (ufw, firewalld or iptables), and undone when the monitor is out of reach after.
//!
//! Two chains are Nyx's to keep: `NYX-INPUT`, where its iptables rules go, and Docker's
//! `DOCKER-USER`, the only place that filters published ports. The agent records them
//! in [`SNAPSHOT`] and puts them back when a restart or a reload emptied them.

use crate::{
    config::Config,
    exec::{cmd, sh},
    transport,
};
use anyhow::{bail, Context};
use nyx_proto::{Firewall, FirewallChange, FwRule, Listener};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

/// Enough for a large nftables ruleset, small enough for every report that carries it.
const RAW_MAX: usize = 20_000;
const UFW_FILES: [&str; 2] = ["/etc/ufw/user.rules", "/etc/ufw/user6.rules"];
const NYX_CHAIN: &str = "NYX-INPUT";
const DOCKER_CHAIN: &str = "DOCKER-USER";
const SNAPSHOT: &str = "/etc/nyx/firewall.rules";
const FAMILIES: [(&str, &str); 2] = [("4", "iptables"), ("6", "ip6tables")];
/// Chains other tools create and fill at start: never expanded, saved or restored by Nyx.
const OTHER_TOOLS: [&str; 9] = ["DOCKER", "f2b-", "LIBVIRT", "KUBE-", "CNI-", "ts-", "NETBIRD", "CROWDSEC", "sshguard"];
/// What Docker leaves in `DOCKER-USER` on its own.
const DOCKER_RETURN: &str = "-A DOCKER-USER -j RETURN";

fn out(program: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(program).args(args).stdin(Stdio::null()).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

fn installed(program: &str) -> bool {
    Command::new(program).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()
}

fn other_tool(chain: &str) -> bool {
    chain != DOCKER_CHAIN && OTHER_TOOLS.iter().any(|p| chain.starts_with(p))
}

fn bin(family: &str) -> &'static str {
    if family == "6" { "ip6tables" } else { "iptables" }
}

/// Always `Some`: "no firewall" must reach the monitor too.
pub fn scan() -> Option<Firewall> {
    keep_chains();
    Some(Firewall { listening: listening(), ..read() })
}

// --- reading ---

/// Rules of the filter table, by chain, as `iptables -S` prints them.
#[derive(Default)]
struct Chains {
    policy_in: String,
    rules: BTreeMap<String, Vec<String>>,
}

fn parse_chains(text: &str) -> Chains {
    let mut c = Chains::default();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        match t.as_slice() {
            ["-P", chain, policy, ..] => {
                if *chain == "INPUT" {
                    c.policy_in = policy.to_lowercase();
                }
                c.rules.entry(chain.to_string()).or_default();
            }
            ["-N", chain, ..] => {
                c.rules.entry(chain.to_string()).or_default();
            }
            ["-A", chain, ..] => c.rules.entry(chain.to_string()).or_default().push(line.trim().to_string()),
            _ => {}
        }
    }
    c
}

fn iptables_tables() -> Vec<(&'static str, Chains)> {
    FAMILIES.iter().filter_map(|(family, b)| Some((*family, parse_chains(&out(b, &["-S"])?)))).collect()
}

/// The tool in charge: the one that is on, else the one installed. Docker's rules and
/// the state of saving come on top, whatever the tool.
fn read() -> Firewall {
    let tables = iptables_tables();
    let mut fw = pick(&tables);
    for (family, chains) in &tables {
        if let Some(lines) = chains.rules.get(DOCKER_CHAIN) {
            fw.docker = true;
            fw.rules.extend(lines.iter().filter(|l| *l != DOCKER_RETURN).map(|l| iptables_rule(&split_args(l), family, l)));
        }
    }
    persistence(&mut fw);
    fw
}

fn pick(tables: &[(&str, Chains)]) -> Firewall {
    let ufw = out("ufw", &["status", "verbose"]);
    if let Some(s) = ufw.as_deref().filter(|s| s.starts_with("Status: active")) {
        return ufw_read(s);
    }
    if out("firewall-cmd", &["--state"]).is_some_and(|s| s.trim() == "running") {
        return firewalld_read();
    }
    if let Some(rs) = out("nft", &["-a", "list", "ruleset"]).filter(|rs| rs.contains("table inet ") && rs.contains("hook input")) {
        return nft_read(&rs);
    }
    let iptables = (!tables.is_empty()).then(|| iptables_read(tables));
    if let Some(fw) = iptables.as_ref().filter(|fw| fw.active) {
        return fw.clone();
    }
    if let Some(s) = ufw {
        return ufw_read(&s);
    }
    if installed("firewall-cmd") {
        return Firewall { backend: "firewalld".into(), ..Firewall::default() };
    }
    iptables.unwrap_or_default()
}

/// Applies a change, then checks the monitor can still be reached; if not, puts the
/// rules back as they were.
pub fn change(cfg: &Config, c: &FirewallChange) -> anyhow::Result<String> {
    c.check().map_err(anyhow::Error::msg)?;
    let fw = read();
    match (c.op.as_str(), c.rule.chain.as_str(), fw.backend.as_str()) {
        ("save", ..) => save_iptables(&fw),
        ("persist", ..) => install_persistence(&fw).and_then(|o| Ok(o + &save_iptables(&read())?)),
        (_, DOCKER_CHAIN, _) => iptables_change(cfg, c, &fw),
        (_, _, "ufw") if fw.active => ufw_change(cfg, c, &fw),
        (_, _, "ufw") => bail!("ufw is installed but off: run `ufw enable` on the host first"),
        (_, _, "firewalld") if fw.active => firewalld_change(cfg, c),
        (_, _, "firewalld") => bail!("firewalld is installed but stopped: run `systemctl enable --now firewalld` first"),
        (_, _, "iptables") => iptables_change(cfg, c, &fw),
        (_, _, "nftables") => bail!("Nyx shows nftables rules but does not edit them: change /etc/nftables.conf and run `nft -f` on it"),
        _ => bail!("no firewall found: install ufw, firewalld or iptables on the host"),
    }
}

fn guarded(cfg: &Config, apply: impl FnOnce() -> anyhow::Result<String>, undo: impl FnOnce() -> anyhow::Result<String>) -> anyhow::Result<String> {
    let done = apply();
    if done.is_ok() && monitor_reachable(cfg) {
        return done;
    }
    match (done, undo()) {
        (Err(e), Ok(_)) => Err(e.context("the change failed, the rules are back as they were")),
        (Ok(_), Ok(_)) => bail!("the monitor was out of reach after the change, so it was undone"),
        (_, Err(u)) => bail!("the change went wrong and could not be undone, check the host: {u:#}"),
    }
}

/// A fresh client: a pooled connection could outlive rules that block new ones.
fn monitor_reachable(cfg: &Config) -> bool {
    let http = transport::client();
    (0..3).any(|attempt| {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2));
        }
        http.get(format!("{}/api/health", cfg.url)).config().timeout_global(Some(Duration::from_secs(5))).build().call().is_ok()
    })
}

/// A port without a protocol means both: iptables and firewalld need one per rule.
fn protos(r: &FwRule) -> Vec<&str> {
    match (r.port.is_empty(), r.proto.as_str()) {
        (true, _) => vec![""],
        (false, "") => vec!["tcp", "udp"],
        (false, p) => vec![p],
    }
}

/// Splits like a shell would, for the quoted comments `iptables -S` prints.
fn split_args(line: &str) -> Vec<String> {
    let (mut args, mut cur, mut quoted, mut started) = (vec![], String::new(), false, false);
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' if quoted => cur.extend(chars.next()),
            '"' => (quoted, started) = (!quoted, true),
            c if c.is_whitespace() && !quoted => {
                if started || !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                }
                started = false;
            }
            c => cur.push(c),
        }
    }
    if started || !cur.is_empty() {
        args.push(cur);
    }
    args
}

fn verb(action: &str) -> &'static str {
    match action {
        "deny" => "drop",
        "reject" => "reject",
        _ => "accept",
    }
}

/// Specific rules first, so that "allow my LAN" stays ahead of "block everyone".
fn source_first(r: &FwRule) -> bool {
    !r.source.is_empty()
}

// --- ufw ---

fn ufw_read(verbose: &str) -> Firewall {
    let active = verbose.starts_with("Status: active");
    let default_in = verbose.lines().find_map(|l| l.strip_prefix("Default: ")).and_then(|d| d.split_whitespace().next()).unwrap_or_default();
    // shortcut: an inactive ufw lists no rules; `ufw show added` has them if that is ever wanted.
    let rules = if active { ufw_rules(&out("ufw", &["status", "numbered"]).unwrap_or_default()) } else { vec![] };
    let default_in = if default_in == "deny" { "drop" } else { default_in };
    Firewall { backend: "ufw".into(), active, default_in: default_in.into(), rules, ..Firewall::default() }
}

/// `(number, rule)` of `ufw status numbered`.
fn ufw_numbered(text: &str) -> Vec<(usize, String)> {
    text.lines()
        .filter_map(|l| {
            let (n, body) = l.trim_start().strip_prefix('[')?.split_once(']')?;
            Some((n.trim().parse().ok()?, body.trim().to_string()))
        })
        .collect()
}

fn ufw_rules(text: &str) -> Vec<FwRule> {
    let mut rules: Vec<FwRule> = vec![];
    for (_, body) in ufw_numbered(text) {
        let r = ufw_rule(&body);
        if r.action.is_empty() {
            continue;
        }
        // A rule for both families is listed twice: one row, removed as a pair.
        if let Some(twin) = rules.iter_mut().find(|x| r.family == "6" && x.family == "4" && same(x, &r)) {
            twin.family.clear();
            continue;
        }
        rules.push(r);
    }
    rules
}

fn same(a: &FwRule, b: &FwRule) -> bool {
    (&a.action, &a.proto, &a.port, &a.source, &a.iface, &a.comment) == (&b.action, &b.proto, &b.port, &b.source, &b.iface, &b.comment)
}

/// One line such as `22/tcp (v6)   ALLOW IN   Anywhere (v6)   # ssh`. Outgoing and
/// routed rules get no action and are left out.
fn ufw_rule(body: &str) -> FwRule {
    let (cols, comment) = body.split_once(" # ").map_or((body, ""), |(c, m)| (c, m.trim()));
    let cols: Vec<&str> = cols.split("  ").map(str::trim).filter(|c| !c.is_empty()).collect();
    let (to, action, from) = (cols.first().copied().unwrap_or_default(), cols.get(1).copied().unwrap_or_default(), cols.get(2).copied().unwrap_or_default());
    let mut r = FwRule { comment: comment.into(), raw: body.into(), ..FwRule::default() };
    r.family = if to.contains("(v6)") || from.contains("(v6)") { "6" } else { "4" }.into();
    let to = to.replace(" (v6)", "");
    let (to, iface) = to.split_once(" on ").map_or((to.as_str(), ""), |(t, i)| (t, i));
    r.iface = iface.into();
    let target = to.split_whitespace().last().unwrap_or_default();
    if target != "Anywhere" {
        let (port, proto) = target.split_once('/').unwrap_or((target, ""));
        (r.port, r.proto) = (port.into(), proto.into());
    }
    let from = from.replace(" (v6)", "");
    r.source = from.split_whitespace().next().filter(|f| *f != "Anywhere").unwrap_or_default().into();
    let mut words = action.split_whitespace();
    if let (Some(v), d) = (words.next(), words.next()) {
        if matches!(d, None | Some("IN")) {
            r.action = v.to_lowercase();
        }
    }
    r
}

fn ufw_args(r: &FwRule) -> Vec<String> {
    let mut a = vec![r.action.clone()];
    if !r.proto.is_empty() {
        a.extend(["proto".into(), r.proto.clone()]);
    }
    a.extend(["from".into(), if r.source.is_empty() { "any".into() } else { r.source.clone() }]);
    if !r.port.is_empty() {
        a.extend(["to".into(), "any".into(), "port".into(), r.port.clone()]);
    }
    a.extend(["comment".into(), if r.comment.is_empty() { "nyx".into() } else { r.comment.clone() }]);
    a
}

fn ufw_change(cfg: &Config, c: &FirewallChange, fw: &Firewall) -> anyhow::Result<String> {
    let saved: Vec<(&str, Option<Vec<u8>>)> = UFW_FILES.iter().map(|f| (*f, fs::read(f).ok())).collect();
    let apply = || {
        if c.op == "delete" {
            let list = ufw_numbered(&out("ufw", &["status", "numbered"]).unwrap_or_default());
            let (n, body) = list.iter().find(|(_, b)| *b == c.rule.raw).context("rule not found, it may have changed meanwhile")?;
            let r = ufw_rule(body);
            let mut nums: Vec<usize> = list.iter().filter(|(m, b)| m == n || (r.family == "4" && { let x = ufw_rule(b); x.family == "6" && same(&r, &x) })).map(|(m, _)| *m).collect();
            nums.sort_unstable_by(|a, b| b.cmp(a)); // from the end, so the numbers stay right
            return nums.iter().map(|n| sh(cmd("ufw", ["--force", "delete", &n.to_string()]))).collect::<anyhow::Result<String>>();
        }
        let args = ufw_args(&c.rule);
        if source_first(&c.rule) && fw.rules.iter().any(|r| r.chain.is_empty()) {
            if let Ok(o) = sh(Command::new("ufw").args(["insert", "1"]).args(&args)) {
                return Ok(o);
            }
        }
        sh(Command::new("ufw").args(&args))
    };
    let undo = || {
        for (file, data) in &saved {
            if let Some(d) = data {
                fs::write(file, d)?;
            }
        }
        sh(cmd("ufw", ["reload"]))
    };
    guarded(cfg, apply, undo)
}

// --- firewalld ---

fn firewalld_read() -> Firewall {
    let zone = format!("--zone={}", out("firewall-cmd", &["--get-default-zone"]).unwrap_or_default().trim());
    let list = |what: &str| out("firewall-cmd", &[&zone, what]).unwrap_or_default();
    let mut rules = vec![];
    for s in list("--list-services").split_whitespace() {
        rules.push(FwRule { action: "allow".into(), port: s.into(), raw: format!("service {s}"), ..FwRule::default() });
    }
    for p in list("--list-ports").split_whitespace() {
        let (port, proto) = p.split_once('/').unwrap_or((p, ""));
        rules.push(FwRule { action: "allow".into(), proto: proto.into(), port: port.replace('-', ":"), raw: format!("port {p}"), ..FwRule::default() });
    }
    rules.extend(list("--list-rich-rules").lines().filter(|l| !l.trim().is_empty()).map(rich_rule));
    let default_in = match out("firewall-cmd", &["--permanent", &zone, "--get-target"]).unwrap_or_default().trim() {
        "ACCEPT" => "accept",
        "DROP" => "drop",
        _ => "reject", // `default` and `%%REJECT%%`
    };
    Firewall { backend: "firewalld".into(), active: true, default_in: default_in.into(), rules, ..Firewall::default() }
}

/// `rule family="ipv4" source address="10.0.0.0/8" port port="22" protocol="tcp" accept`
fn rich_rule(line: &str) -> FwRule {
    let t = split_args(line.trim());
    let value = |k: &str| t.iter().find_map(|a| a.strip_prefix(k)).unwrap_or_default().to_string();
    let action = t.iter().rev().find_map(|a| match a.as_str() {
        "accept" => Some("allow"),
        "drop" => Some("deny"),
        "reject" => Some("reject"),
        _ => None,
    });
    let service = value("name=");
    FwRule {
        action: action.unwrap_or("other").into(),
        proto: value("protocol="),
        port: if service.is_empty() { value("port=").replace('-', ":") } else { service },
        source: value("address="),
        family: match value("family=").as_str() { "ipv4" => "4", "ipv6" => "6", _ => "" }.into(),
        raw: format!("rich {}", line.trim()),
        ..FwRule::default()
    }
}

fn firewalld_ops(c: &FirewallChange) -> anyhow::Result<Vec<String>> {
    let r = &c.rule;
    if c.op == "delete" {
        let op = match r.raw.split_once(' ') {
            Some(("service", s)) => format!("--remove-service={s}"),
            Some(("port", p)) => format!("--remove-port={p}"),
            Some(("rich", rule)) => format!("--remove-rich-rule={rule}"),
            _ => bail!("rule not found"),
        };
        return Ok(vec![op]);
    }
    let port = r.port.replace(':', "-");
    Ok(protos(r)
        .into_iter()
        .map(|p| {
            if r.source.is_empty() && r.action == "allow" {
                return format!("--add-port={port}/{p}");
            }
            let family = match r.source.contains(':') {
                _ if r.source.is_empty() => "",
                true => " family=\"ipv6\"",
                false => " family=\"ipv4\"",
            };
            let source = if r.source.is_empty() { String::new() } else { format!(" source address=\"{}\"", r.source) };
            let ports = if p.is_empty() { String::new() } else { format!(" port port=\"{port}\" protocol=\"{p}\"") };
            format!("--add-rich-rule=rule{family}{source}{ports} {}", verb(&r.action))
        })
        .collect())
}

fn invert(op: &str) -> String {
    match (op.strip_prefix("--add-"), op.strip_prefix("--remove-")) {
        (Some(rest), _) => format!("--remove-{rest}"),
        (_, Some(rest)) => format!("--add-{rest}"),
        _ => op.into(),
    }
}

/// Runtime first, so that a bad change can be taken back; saved only once it held.
fn firewalld_change(cfg: &Config, c: &FirewallChange) -> anyhow::Result<String> {
    let zone = format!("--zone={}", out("firewall-cmd", &["--get-default-zone"]).unwrap_or_default().trim());
    let ops = firewalld_ops(c)?;
    let undo_ops: Vec<String> = ops.iter().map(|o| invert(o)).collect();
    let run = |ops: &[String], permanent: bool| {
        let mut c = Command::new("firewall-cmd");
        if permanent {
            c.arg("--permanent");
        }
        sh(c.arg(&zone).args(ops))
    };
    let done = guarded(cfg, || run(&ops, false), || run(&undo_ops, false))?;
    Ok(done + &run(&ops, true).context("applied, but not kept after a restart")?)
}

// --- iptables ---

/// Rules met from INPUT on, in the order they apply. Unconditional jumps into chains
/// of the admin's own, such as `-A INPUT -j FW-INPUT`, are followed.
fn iptables_read(tables: &[(&str, Chains)]) -> Firewall {
    let mut fw = Firewall { backend: "iptables".into(), ..Firewall::default() };
    for (family, chains) in tables {
        if *family == "4" {
            fw.default_in = chains.policy_in.clone();
        }
        walk(chains, "INPUT", family, &mut fw.rules, 0);
    }
    fw.active = fw.default_in != "accept" || !fw.rules.is_empty();
    fw
}

fn walk(chains: &Chains, chain: &str, family: &str, out: &mut Vec<FwRule>, depth: usize) {
    for line in chains.rules.get(chain).into_iter().flatten() {
        let t = split_args(line);
        let target = t.iter().position(|a| a == "-j").and_then(|i| t.get(i + 1)).map_or("", String::as_str);
        let own_chain = chains.rules.contains_key(target) && !other_tool(target) && target != DOCKER_CHAIN && depth < 4;
        // Nyx's own jump carries `! -i lo`: followed too.
        if own_chain && (t.len() == 4 || target == NYX_CHAIN) {
            walk(chains, target, family, out, depth + 1);
        } else {
            out.push(iptables_rule(&t, family, line));
        }
    }
}

fn iptables_rule(t: &[String], family: &str, line: &str) -> FwRule {
    let after = |k: &str| t.iter().position(|a| a == k).and_then(|i| t.get(i + 1)).cloned().unwrap_or_default();
    let target = after("-j");
    let port = [after("--dport"), after("--dports"), after("--ctorigdstport")].concat();
    let state = [after("--ctstate"), after("--state")].concat().replace("DNAT", "");
    let state = state.trim_matches(',');
    let comment = after("--comment");
    FwRule {
        action: match target.as_str() {
            "ACCEPT" => "allow".into(),
            "RETURN" if t.get(1).is_some_and(|c| c == DOCKER_CHAIN) => "allow".into(), // back to Docker, which lets it in
            "DROP" => "deny".into(),
            "REJECT" => "reject".into(),
            other => other.to_lowercase(),
        },
        proto: after("-p").replace("all", ""),
        source: after("-s").trim_end_matches("/32").trim_end_matches("/128").into(),
        iface: after("-i"),
        family: family.into(),
        // A state alone says "replies", not "this port": the UI leaves those out.
        comment: if comment.is_empty() && !state.is_empty() && port.is_empty() { format!("state {}", state.to_lowercase()) } else { comment },
        chain: t.get(1).cloned().unwrap_or_default(),
        port,
        raw: line.trim().into(),
    }
}

/// Arguments of a new rule. Docker has already rewritten the destination of a published
/// port when `DOCKER-USER` sees it: the port the client asked for is in conntrack.
fn iptables_specs(r: &FwRule, docker: bool) -> Vec<Vec<String>> {
    protos(r)
        .into_iter()
        .map(|p| {
            let mut s: Vec<String> = vec![];
            if !p.is_empty() {
                s.extend(["-p".into(), p.into()]);
            }
            if !r.source.is_empty() {
                s.extend(["-s".into(), r.source.clone()]);
            }
            if docker {
                s.extend(["-m", "conntrack", "--ctstate", "DNAT", "--ctdir", "ORIGINAL"].map(String::from));
                if !r.port.is_empty() {
                    s.extend(["--ctorigdstport".into(), r.port.clone()]);
                }
            } else if !r.port.is_empty() {
                s.extend(["--dport".into(), r.port.clone()]);
            }
            let comment = if r.comment.is_empty() { "nyx".into() } else { r.comment.clone() };
            let target = match (docker, verb(&r.action)) {
                (true, "accept") => "RETURN".into(),
                (_, v) => v.to_uppercase(),
            };
            s.extend(["-m".into(), "comment".into(), "--comment".into(), comment, "-j".into(), target]);
            s
        })
        .collect()
}

/// 1-based place of a new rule in its chain, `None` to append: rules for a source go
/// on top, the others last, before the `RETURN` Docker may keep at the end.
fn position(r: &FwRule, chain: &[&FwRule]) -> Option<usize> {
    if source_first(r) {
        return Some(1);
    }
    chain.last().filter(|last| last.raw == DOCKER_RETURN).map(|_| chain.len())
}

fn iptables_change(cfg: &Config, c: &FirewallChange, fw: &Firewall) -> anyhow::Result<String> {
    let saved: Vec<(&str, String)> = [("iptables-save", "iptables-restore"), ("ip6tables-save", "ip6tables-restore")]
        .into_iter()
        .filter_map(|(save, restore)| out(save, &[]).map(|s| (restore, s)))
        .collect();
    let docker = c.rule.chain == DOCKER_CHAIN;
    let chain = if docker { DOCKER_CHAIN } else { NYX_CHAIN };
    let apply = || {
        if c.op == "delete" {
            // Only a rule listed right now: what the UI showed may be gone.
            let rule = fw.rules.iter().find(|r| r.raw == c.rule.raw && r.family == c.rule.family).context("rule not found, it may have changed meanwhile")?;
            let mut args = split_args(&rule.raw);
            args[0] = "-D".into(); // removes the first rule with this exact spec
            return sh(Command::new(bin(&rule.family)).args(&args));
        }
        let mut done = String::new();
        for (family, b) in FAMILIES {
            let wanted = if family == "4" { !c.rule.source.contains(':') } else { !c.rule.source.contains('.') };
            let exists = out(b, &["-S", chain]).is_some();
            if !wanted || (docker && !exists) || (family == "6" && !installed(b)) {
                continue;
            }
            if !exists {
                sh(cmd(b, ["-N", chain]))?;
            }
            if !docker {
                ensure_jump(b)?;
            }
            // Read again: the docker chain may hold Docker's RETURN, which `fw` leaves out.
            let live: Vec<FwRule> = out(b, &["-S", chain]).unwrap_or_default().lines().filter(|l| l.starts_with("-A ")).map(|l| iptables_rule(&split_args(l), family, l)).collect();
            let current: Vec<&FwRule> = live.iter().collect();
            for spec in iptables_specs(&c.rule, docker) {
                let mut command = Command::new(b);
                match position(&c.rule, &current) {
                    Some(n) => command.args(["-I", chain, &n.to_string()]),
                    None => command.args(["-A", chain]),
                };
                done += &sh(command.args(&spec))?;
            }
        }
        if done.is_empty() && docker && out("iptables", &["-S", DOCKER_CHAIN]).is_none() {
            bail!("Docker's DOCKER-USER chain is missing: is Docker running, with its iptables rules on?");
        }
        Ok(done)
    };
    let undo = || {
        for (restore, data) in &saved {
            run_stdin(restore, &[], data)?;
        }
        Ok(String::new())
    };
    let done = guarded(cfg, apply, undo)?;
    record_chains();
    let kept = match fw.saved_by.as_str() {
        "netfilter-persistent" | "iptables-services" if !fw.unsaved => save_iptables(&read())?,
        "netfilter-persistent" | "iptables-services" => "Not written to the boot file, which already differed from the live rules: press Save once they are right. Nyx puts its own rules back after a restart either way.".into(),
        _ => "Nyx puts this rule back after a restart.".into(),
    };
    Ok(format!("{done}{kept}"))
}

/// `NYX-INPUT` goes first in INPUT, loopback aside: local programs stay unaffected.
fn ensure_jump(b: &str) -> anyhow::Result<()> {
    if sh(cmd(b, ["-C", "INPUT", "!", "-i", "lo", "-j", NYX_CHAIN])).is_err() {
        sh(cmd(b, ["-I", "INPUT", "1", "!", "-i", "lo", "-j", NYX_CHAIN]))?;
    }
    Ok(())
}

fn run_stdin(program: &str, args: &[&str], data: &str) -> anyhow::Result<()> {
    let mut child = Command::new(program).args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
    child.stdin.take().context("no stdin")?.write_all(data.as_bytes())?;
    let o = child.wait_with_output()?;
    if !o.status.success() {
        bail!("{program}: {}", String::from_utf8_lossy(&o.stderr));
    }
    Ok(())
}

// --- keeping Nyx's chains ---

/// Lines `<family> -A <chain> …` of the chains Nyx keeps, as they are now.
fn chains_now() -> String {
    let mut s = String::new();
    for (family, b) in FAMILIES {
        for chain in [NYX_CHAIN, DOCKER_CHAIN] {
            for line in out(b, &["-S", chain]).unwrap_or_default().lines().filter(|l| l.starts_with("-A ") && *l != DOCKER_RETURN) {
                s += &format!("{family} {line}\n");
            }
        }
    }
    s
}

/// After a change: the file then also says "nothing" when the last rule went.
fn record_chains() {
    let _ = fs::write(SNAPSHOT, chains_now());
}

/// Puts back the rules of a chain found empty, as after a restart: Docker recreates
/// `DOCKER-USER` empty, and a reload of the boot file can drop `NYX-INPUT`. Records the
/// chains while they hold rules, so that changes made by hand are kept too.
// shortcut: emptying one of these chains by hand brings its rules back; remove them from Nyx.
fn keep_chains() {
    let Ok(saved) = fs::read_to_string(SNAPSHOT) else { return }; // nothing changed from Nyx yet
    let mut restored = false;
    for ((family, chain), lines) in group(&saved) {
        let b = bin(&family);
        let live = out(b, &["-S", &chain]);
        let empty = live.as_deref().is_none_or(|l| !l.lines().any(|l| l.starts_with("-A ") && l != DOCKER_RETURN));
        if empty {
            if live.is_none() && sh(cmd(b, ["-N", &chain])).is_err() {
                continue;
            }
            for (i, line) in lines.iter().enumerate() {
                let mut args = split_args(line);
                args.splice(0..2, ["-I".into(), chain.clone(), (i + 1).to_string()]);
                restored |= sh(Command::new(b).args(&args)).is_ok();
            }
        }
        if chain == NYX_CHAIN {
            let _ = ensure_jump(b);
        }
    }
    let now = chains_now();
    if !restored && !now.is_empty() && now != saved {
        let _ = fs::write(SNAPSHOT, now);
    }
}

fn group(snapshot: &str) -> BTreeMap<(String, String), Vec<String>> {
    let mut g: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for line in snapshot.lines() {
        let Some((family, rule)) = line.split_once(' ') else { continue };
        let Some(chain) = rule.split_whitespace().nth(1).filter(|c| [NYX_CHAIN, DOCKER_CHAIN].contains(c)) else { continue };
        if matches!(family, "4" | "6") && rule.starts_with("-A ") {
            g.entry((family.into(), chain.into())).or_default().push(rule.into());
        }
    }
    g
}

// --- saving iptables for the next boot ---

/// What reloads iptables at boot, with `(save command, file)` per family.
fn boot_files() -> Option<(&'static str, [(&'static str, &'static str); 2])> {
    if Path::new("/usr/sbin/netfilter-persistent").exists() {
        Some(("netfilter-persistent", [("iptables-save", "/etc/iptables/rules.v4"), ("ip6tables-save", "/etc/iptables/rules.v6")]))
    } else if Path::new("/usr/lib/systemd/system/iptables.service").exists() {
        Some(("iptables-services", [("iptables-save", "/etc/sysconfig/iptables"), ("ip6tables-save", "/etc/sysconfig/ip6tables")]))
    } else {
        None
    }
}

fn persistence(fw: &mut Firewall) {
    match fw.backend.as_str() {
        "ufw" | "firewalld" => fw.saved_by = fw.backend.clone(),
        "iptables" => match boot_files() {
            Some((by, files)) => {
                fw.saved_by = by.into();
                fw.unsaved = files.iter().any(|(save, file)| match (out(save, &[]), fs::read_to_string(file)) {
                    (Some(live), Ok(saved)) => normalize(&keep_own(&live)) != normalize(&saved),
                    (Some(live), Err(_)) => *save == "iptables-save" && live.lines().any(|l| l.starts_with("-A ")),
                    _ => false,
                });
            }
            None if installed("apt-get") => fw.installable = "iptables-persistent".into(),
            None if installed("dnf") => fw.installable = "iptables-services".into(),
            None => {}
        },
        _ => {}
    }
}

/// `iptables-save` without the chains other tools rebuild at start: saved, Docker's
/// would come back at boot pointing to containers that are gone.
fn keep_own(save: &str) -> String {
    save.lines()
        .filter(|l| {
            let t = split_args(l);
            let named = |i: usize| t.get(i).is_some_and(|c| other_tool(c));
            let declares = l.strip_prefix(':').and_then(|d| d.split_whitespace().next()).is_some_and(other_tool);
            let inside = matches!(t.first().map(String::as_str), Some("-A" | "-I")) && named(1);
            let jumps = t.iter().position(|a| a == "-j" || a == "-g").is_some_and(|i| named(i + 1));
            let docker_if = t.windows(2).any(|w| matches!(w[0].as_str(), "-i" | "-o") && docker_iface(&w[1]));
            !(declares || inside || jumps || docker_if)
        })
        .map(|l| format!("{l}\n"))
        .collect()
}

fn docker_iface(i: &str) -> bool {
    i == "docker0" || i == "docker_gwbridge" || i.strip_prefix("br-").is_some_and(|h| h.len() == 12 && h.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Rules as they compare: no comments, no counters.
fn normalize(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| if l.starts_with(':') { l.split_whitespace().take(2).collect::<Vec<_>>().join(" ") } else { l.into() })
        .collect()
}

fn save_iptables(fw: &Firewall) -> anyhow::Result<String> {
    if fw.backend != "iptables" {
        bail!("{} saves its own rules", fw.backend);
    }
    let (by, files) = boot_files().context("nothing reloads iptables rules at boot: install iptables-persistent or iptables-services")?;
    let mut done = vec![];
    for (save, file) in files {
        let Some(live) = out(save, &[]) else { continue };
        if let Some(dir) = Path::new(file).parent() {
            fs::create_dir_all(dir)?;
        }
        if Path::new(file).exists() {
            fs::copy(file, format!("{file}.nyx-bak"))?; // the previous file, written by hand or by a playbook
        }
        fs::write(file, keep_own(&live))?;
        done.push(file);
    }
    let unit = if by == "netfilter-persistent" { "netfilter-persistent" } else { "iptables" };
    let _ = sh(cmd("systemctl", ["enable", unit]));
    Ok(format!("Saved to {}, the previous file kept as .nyx-bak. Docker, fail2ban and other tools rebuild their own chains, so they are left out.", done.join(" and ")))
}

fn install_persistence(fw: &Firewall) -> anyhow::Result<String> {
    match (fw.backend.as_str(), fw.installable.as_str()) {
        ("iptables", "iptables-persistent") => {
            // Nyx saves the rules itself, without other tools' chains.
            run_stdin("debconf-set-selections", &[], "iptables-persistent iptables-persistent/autosave_v4 boolean false\niptables-persistent iptables-persistent/autosave_v6 boolean false\n")?;
            // --no-remove: on Ubuntu it would otherwise uninstall ufw.
            let mut c = cmd("apt-get", ["install", "-y", "--no-remove", "iptables-persistent"]);
            c.env("DEBIAN_FRONTEND", "noninteractive");
            sh(c)
        }
        ("iptables", "iptables-services") => {
            let o = sh(cmd("dnf", ["install", "-y", "iptables-services"]))?;
            Ok(o + &sh(cmd("systemctl", ["enable", "iptables"]))?)
        }
        ("iptables", _) if !fw.saved_by.is_empty() => Ok(String::new()),
        ("iptables", _) => bail!("no package to save iptables rules on this system"),
        (b, _) => bail!("{b} saves its own rules"),
    }
}

// --- nftables, shown only ---

fn nft_read(ruleset: &str) -> Firewall {
    let mut fw = Firewall { backend: "nftables".into(), active: true, raw: ruleset.chars().take(RAW_MAX).collect(), ..Firewall::default() };
    let mut input = false;
    for line in ruleset.lines().map(str::trim) {
        if line.starts_with("chain ") {
            input = false;
        } else if line.contains("hook input") {
            input = true;
            if let Some(p) = line.split("policy ").nth(1) {
                fw.default_in = p.split(';').next().unwrap_or_default().trim().into();
            }
        } else if input && !line.is_empty() && line != "}" {
            fw.rules.push(nft_rule(line));
        }
    }
    if fw.default_in.is_empty() {
        fw.default_in = "accept".into();
    }
    fw
}

/// `ip saddr 10.0.0.0/8 tcp dport { 80, 443 } accept comment "web" # handle 7`
fn nft_rule(line: &str) -> FwRule {
    let body = line.split(" # handle").next().unwrap_or(line);
    let (body, comment) = body.split_once(" comment ").map_or((body, String::new()), |(b, c)| (b, c.trim_matches('"').into()));
    let t: Vec<&str> = body.split_whitespace().collect();
    let at = |k: &str| t.iter().position(|w| *w == k);
    let value = |k: &str| -> String {
        let Some(i) = at(k) else { return String::new() };
        match t.get(i + 1) {
            Some(&"{") => t[i + 2..].iter().take_while(|w| **w != "}").map(|w| w.trim_end_matches(',')).collect::<Vec<_>>().join(","),
            Some(v) => v.trim_matches('"').replace('-', ":"),
            None => String::new(),
        }
    };
    let action = t.iter().rev().find_map(|w| match *w {
        "accept" => Some("allow"),
        "drop" => Some("deny"),
        "reject" => Some("reject"),
        _ => None,
    });
    let state = value("state");
    let port = value("dport");
    FwRule {
        action: action.unwrap_or("other").into(),
        proto: at("dport").and_then(|i| i.checked_sub(1)).map(|i| t[i]).filter(|p| matches!(*p, "tcp" | "udp")).unwrap_or_default().into(),
        source: value("saddr"),
        iface: value("iifname"),
        family: match at("saddr").and_then(|i| i.checked_sub(1)).map(|i| t[i]) { Some("ip") => "4", Some("ip6") => "6", _ => "" }.into(),
        comment: if comment.is_empty() && !state.is_empty() && port.is_empty() { format!("state {state}") } else { comment },
        port,
        raw: line.into(),
        ..FwRule::default()
    }
}

// --- open ports ---

fn listening() -> Vec<Listener> {
    let mut list = parse_ss(&out("ss", &["-Hlntup"]).unwrap_or_default());
    // Without docker-proxy nothing listens on a published port: Docker's API knows them.
    if let Some(body) = crate::collect::docker_get("/containers/json") {
        add_published(&mut list, &body);
    }
    list
}

/// `tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))`, one entry per port.
fn parse_ss(text: &str) -> Vec<Listener> {
    let mut list: Vec<Listener> = vec![];
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        let (Some(proto), Some(local)) = (t.first(), t.get(4)) else { continue };
        let Some((addr, port)) = local.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        let process = line.split("((\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or_default();
        add_listener(&mut list, proto, port, addr, process, false);
    }
    list
}

fn add_listener(list: &mut Vec<Listener>, proto: &str, port: u16, addr: &str, process: &str, docker: bool) {
    let addr = addr.trim_start_matches('[').trim_end_matches(']');
    let addr = addr.split('%').next().unwrap_or(addr);
    if addr.starts_with("127.") || addr == "::1" || addr.starts_with("::ffff:127.") {
        return; // not reachable from the network
    }
    let addr = if matches!(addr, "0.0.0.0" | "::" | "*" | "") { "*" } else { addr };
    match list.iter_mut().find(|l| l.proto == proto && l.port == port) {
        Some(l) => {
            if docker && !l.docker {
                (l.docker, l.process) = (true, process.into()); // docker-proxy: name the container
            }
            if l.addr != "*" && !l.addr.split(", ").any(|a| a == addr) {
                l.addr = if addr == "*" { "*".into() } else { format!("{}, {addr}", l.addr) };
            }
        }
        None => list.push(Listener { proto: proto.into(), port, addr: addr.into(), process: process.into(), docker }),
    }
    list.sort_by(|a, b| (a.port, &a.proto).cmp(&(b.port, &b.proto)));
}

/// Ports of `/containers/json`: `{"IP": "0.0.0.0", "PrivatePort": 80, "PublicPort": 8080, "Type": "tcp"}`.
fn add_published(list: &mut Vec<Listener>, body: &str) {
    let Ok(serde_json::Value::Array(containers)) = serde_json::from_str(body) else { return };
    for c in &containers {
        let name = c["Names"][0].as_str().unwrap_or_default().trim_start_matches('/');
        for p in c["Ports"].as_array().into_iter().flatten() {
            let Some(port) = p["PublicPort"].as_u64().and_then(|n| u16::try_from(n).ok()) else { continue }; // exposed, not published
            add_listener(list, p["Type"].as_str().unwrap_or("tcp"), port, p["IP"].as_str().unwrap_or_default(), name, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ruleset the server-deploy playbook writes, with Docker and fail2ban running.
    const PLAYBOOK: &str = "-P INPUT DROP\n-P FORWARD DROP\n-P OUTPUT ACCEPT\n-N DOCKER\n-N DOCKER-USER\n-N FW-INPUT\n-N f2b-sshd\n\
-A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd\n-A INPUT -j FW-INPUT\n-A FORWARD -j DOCKER-USER\n-A DOCKER-USER -j RETURN\n\
-A FW-INPUT -i lo -j ACCEPT\n-A FW-INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT\n-A FW-INPUT -s 192.168.1.20/32 -j ACCEPT\n\
-A FW-INPUT -i wg0 -j ACCEPT\n-A FW-INPUT -p tcp -m tcp --dport 22 -m state --state NEW -j ACCEPT\n-A FW-INPUT -p udp -m udp --dport 51820 -j ACCEPT\n\
-A f2b-sshd -s 1.2.3.4/32 -j REJECT --reject-with icmp-port-unreachable\n-A f2b-sshd -j RETURN\n";

    fn rows(rules: &[FwRule]) -> Vec<(&str, &str, &str, &str, &str, &str)> {
        rules.iter().map(|r| (r.action.as_str(), r.proto.as_str(), r.port.as_str(), r.source.as_str(), r.iface.as_str(), r.chain.as_str())).collect()
    }

    #[test]
    fn follows_the_admins_own_chains_and_leaves_other_tools_alone() {
        let fw = iptables_read(&[("4", parse_chains(PLAYBOOK))]);
        assert!(fw.active);
        assert_eq!(fw.default_in, "drop");
        assert_eq!(rows(&fw.rules), [
            ("f2b-sshd", "tcp", "22", "", "", "INPUT"),
            ("allow", "", "", "", "lo", "FW-INPUT"),
            ("allow", "", "", "", "", "FW-INPUT"),
            ("allow", "", "", "192.168.1.20", "", "FW-INPUT"),
            ("allow", "", "", "", "wg0", "FW-INPUT"),
            ("allow", "tcp", "22", "", "", "FW-INPUT"),
            ("allow", "udp", "51820", "", "", "FW-INPUT"),
        ]);
        assert_eq!(fw.rules[2].comment, "state related,established");
        assert_eq!(fw.rules[5].comment, "", "a port opened for new connections is not a state rule");
        assert!(!iptables_read(&[("4", parse_chains("-P INPUT ACCEPT\n"))]).active);
        let with_nyx = format!("{PLAYBOOK}-N NYX-INPUT\n-A INPUT ! -i lo -j NYX-INPUT\n-A NYX-INPUT -p tcp -m tcp --dport 8443 -j ACCEPT\n");
        assert_eq!(rows(&iptables_read(&[("4", parse_chains(&with_nyx))]).rules).last(), Some(&("allow", "tcp", "8443", "", "", "NYX-INPUT")));
    }

    #[test]
    fn reads_quoted_comments_back_into_arguments() {
        let line = "-A NYX-INPUT -s 192.168.1.0/24 -p tcp -m tcp --dport 22 -m comment --comment \"ssh from lan\" -j ACCEPT";
        let r = iptables_rule(&split_args(line), "4", line);
        assert_eq!((r.comment.as_str(), r.chain.as_str()), ("ssh from lan", "NYX-INPUT"));
        assert!(split_args(&r.raw).ends_with(&["--comment".into(), "ssh from lan".into(), "-j".into(), "ACCEPT".into()]));
    }

    #[test]
    fn docker_rules_match_the_published_port() {
        let r = FwRule { action: "deny".into(), proto: "tcp".into(), port: "8080".into(), ..FwRule::default() };
        assert_eq!(iptables_specs(&r, true)[0].join(" "), "-p tcp -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport 8080 -m comment --comment nyx -j DROP");
        let lan = FwRule { action: "allow".into(), source: "192.168.1.0/24".into(), ..r.clone() };
        assert!(iptables_specs(&lan, true)[0].join(" ").ends_with("-s 192.168.1.0/24 -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport 8080 -m comment --comment nyx -j RETURN"));
        assert_eq!(iptables_specs(&FwRule { proto: "".into(), ..r.clone() }, false).len(), 2, "no protocol: tcp and udp");

        let line = "-A DOCKER-USER -s 192.168.1.0/24 -p tcp -m conntrack --ctstate DNAT --ctorigdstport 8080 --ctdir ORIGINAL -m comment --comment nyx -j RETURN";
        let read = iptables_rule(&split_args(line), "4", line);
        assert_eq!((read.action.as_str(), read.port.as_str(), read.comment.as_str()), ("allow", "8080", "nyx"));

        let ret = FwRule { raw: DOCKER_RETURN.into(), ..FwRule::default() };
        assert_eq!(position(&r, &[&ret]), Some(1), "before Docker's RETURN");
        assert_eq!(position(&r, &[&read, &ret]), Some(2));
        assert_eq!(position(&r, &[]), None);
        assert_eq!(position(&lan, &[&read, &ret]), Some(1), "a source goes on top");
    }

    #[test]
    fn saves_without_the_chains_other_tools_rebuild() {
        let save = "# Generated by iptables-save\n*nat\n:PREROUTING ACCEPT [10:600]\n:DOCKER - [0:0]\n-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER\n\
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE\n-A DOCKER ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80\nCOMMIT\n\
*filter\n:INPUT DROP [5:300]\n:DOCKER-USER - [0:0]\n:FW-INPUT - [0:0]\n:NYX-INPUT - [0:0]\n:f2b-sshd - [0:0]\n-A INPUT ! -i lo -j NYX-INPUT\n\
-A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd\n-A INPUT -j FW-INPUT\n-A FORWARD -j DOCKER-USER\n-A FORWARD -o br-0123456789ab -j DOCKER\n\
-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport 8080 --ctdir ORIGINAL -j DROP\n-A FW-INPUT -i lo -j ACCEPT\n-A f2b-sshd -s 1.2.3.4/32 -j REJECT\nCOMMIT\n";
        assert_eq!(normalize(&keep_own(save)), [
            "*nat", ":PREROUTING ACCEPT", "COMMIT",
            "*filter", ":INPUT DROP", ":DOCKER-USER -", ":FW-INPUT -", ":NYX-INPUT -", "-A INPUT ! -i lo -j NYX-INPUT", "-A INPUT -j FW-INPUT",
            "-A FORWARD -j DOCKER-USER", "-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport 8080 --ctdir ORIGINAL -j DROP", "-A FW-INPUT -i lo -j ACCEPT", "COMMIT",
        ]);
        assert_eq!(normalize(":INPUT DROP [5:300]\n# x\n-A INPUT -j ACCEPT"), normalize(":INPUT DROP [0:0]\n-A INPUT -j ACCEPT\n"), "counters and comments do not count");
    }

    #[test]
    fn snapshot_groups_the_kept_chains() {
        let g = group("4 -A NYX-INPUT -p tcp --dport 22 -j ACCEPT\n6 -A DOCKER-USER -j DROP\n4 -A NYX-INPUT -s 1.2.3.4 -j DROP\n4 -A INPUT -j DROP\nx bad\n");
        assert_eq!(g.len(), 2);
        assert_eq!(g[&("4".into(), NYX_CHAIN.into())].len(), 2);
        assert_eq!(g[&("6".into(), DOCKER_CHAIN.into())], ["-A DOCKER-USER -j DROP"]);
    }

    #[test]
    fn reads_ufw_and_merges_both_families() {
        let text = "Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] 22/tcp                     ALLOW IN    192.168.1.0/24             # ssh\n[ 2] 80,443/tcp                 ALLOW IN    Anywhere\n[ 3] Anywhere on wg0            ALLOW IN    Anywhere\n[ 4] 53                         ALLOW OUT   Anywhere\n[ 5] 80,443/tcp (v6)            ALLOW IN    Anywhere (v6)\n";
        let rules = ufw_rules(text);
        let r: Vec<_> = rules.iter().map(|r| (r.action.as_str(), r.proto.as_str(), r.port.as_str(), r.source.as_str(), r.iface.as_str(), r.family.as_str(), r.comment.as_str())).collect();
        assert_eq!(r, [
            ("allow", "tcp", "22", "192.168.1.0/24", "", "4", "ssh"),
            ("allow", "tcp", "80,443", "", "", "", ""),
            ("allow", "", "", "", "wg0", "4", ""),
        ]);
        assert_eq!(ufw_numbered(text)[1], (2, rules[1].raw.clone()), "the raw rule finds its number again");
        let add = FwRule { action: "deny".into(), proto: "tcp".into(), port: "8000:8100".into(), source: "10.0.0.0/8".into(), ..FwRule::default() };
        assert_eq!(ufw_args(&add).join(" "), "deny proto tcp from 10.0.0.0/8 to any port 8000:8100 comment nyx");
    }

    #[test]
    fn reads_and_writes_firewalld_rules() {
        let r = rich_rule(r#"rule family="ipv4" source address="10.0.0.0/8" port port="8000-8100" protocol="tcp" drop"#);
        assert_eq!((r.action.as_str(), r.proto.as_str(), r.port.as_str(), r.source.as_str(), r.family.as_str()), ("deny", "tcp", "8000:8100", "10.0.0.0/8", "4"));
        let change = |op: &str, rule: FwRule| firewalld_ops(&FirewallChange { op: op.into(), rule }).unwrap();
        assert_eq!(change("add", FwRule { action: "allow".into(), proto: "tcp".into(), port: "8080".into(), ..FwRule::default() }), ["--add-port=8080/tcp"]);
        assert_eq!(change("add", FwRule { action: "reject".into(), port: "53".into(), source: "fd00::/8".into(), ..FwRule::default() }), [
            r#"--add-rich-rule=rule family="ipv6" source address="fd00::/8" port port="53" protocol="tcp" reject"#,
            r#"--add-rich-rule=rule family="ipv6" source address="fd00::/8" port port="53" protocol="udp" reject"#,
        ]);
        assert_eq!(change("delete", FwRule { raw: r.raw.clone(), ..FwRule::default() })[0], format!("--remove-rich-rule={}", &r.raw[5..]));
        assert_eq!((invert("--add-port=22/tcp"), invert("--remove-rich-rule=rule drop")), ("--remove-port=22/tcp".into(), "--add-rich-rule=rule drop".into()));
    }

    #[test]
    fn reads_nftables_input_chains_only() {
        let rs = "table inet filter { # handle 1\n\tchain input { # handle 1\n\t\ttype filter hook input priority filter; policy drop;\n\t\tct state established,related accept # handle 4\n\t\tip saddr 192.168.1.0/24 tcp dport { 80, 443 } accept comment \"web\" # handle 5\n\t\tiifname \"wg0\" accept # handle 6\n\t}\n\tchain output { # handle 2\n\t\ttype filter hook output priority filter; policy accept;\n\t\ttcp dport 25 drop # handle 7\n\t}\n}\n";
        let fw = nft_read(rs);
        assert_eq!(fw.default_in, "drop");
        let r: Vec<_> = fw.rules.iter().map(|r| (r.action.as_str(), r.proto.as_str(), r.port.as_str(), r.source.as_str(), r.iface.as_str(), r.comment.as_str())).collect();
        assert_eq!(r, [
            ("allow", "", "", "", "", "state established,related"),
            ("allow", "tcp", "80,443", "192.168.1.0/24", "", "web"),
            ("allow", "", "", "", "wg0", ""),
        ]);
    }

    #[test]
    fn lists_open_ports_once_with_their_container() {
        let ss = "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\ntcp LISTEN 0 4096 [::]:22 [::]:* users:((\"sshd\",pid=1,fd=4))\ntcp LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=2,fd=5))\nudp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:((\"systemd-resolve\",pid=3,fd=6))\ntcp LISTEN 0 128 192.168.1.10:8080 0.0.0.0:* users:((\"caddy\",pid=4,fd=7))\ntcp LISTEN 0 128 [fd00::10]:8080 [::]:* users:((\"caddy\",pid=4,fd=8))\ntcp LISTEN 0 4096 0.0.0.0:9000 0.0.0.0:* users:((\"docker-proxy\",pid=5,fd=4))\n";
        let mut list = parse_ss(ss);
        add_published(&mut list, r#"[{"Names":["/portainer"],"Ports":[{"IP":"0.0.0.0","PrivatePort":9000,"PublicPort":9000,"Type":"tcp"},{"PrivatePort":8000,"Type":"tcp"}]},
            {"Names":["/grafana"],"Ports":[{"IP":"0.0.0.0","PrivatePort":3000,"PublicPort":3001,"Type":"tcp"},{"IP":"::","PrivatePort":3000,"PublicPort":3001,"Type":"tcp"},{"IP":"127.0.0.1","PrivatePort":9090,"PublicPort":9090,"Type":"tcp"}]}]"#);
        let l: Vec<_> = list.iter().map(|l| (l.proto.as_str(), l.port, l.addr.as_str(), l.process.as_str(), l.docker)).collect();
        assert_eq!(l, [
            ("tcp", 22, "*", "sshd", false),
            ("tcp", 3001, "*", "grafana", true),
            ("tcp", 8080, "192.168.1.10, fd00::10", "caddy", false),
            ("tcp", 9000, "*", "portainer", true),
        ]);
    }
}
