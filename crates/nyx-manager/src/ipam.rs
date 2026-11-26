//! IP address management: pure logic over records, no I/O.

use ipnet::IpNet;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
};

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Conflict {
    pub severity: &'static str,
    pub message: String,
    /// `address` for one address held by several machines, which the interface offers to fix.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub address: String,
    /// The address rows involved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
}

fn crit(message: String) -> Conflict {
    Conflict { severity: "crit", message, kind: String::new(), address: String::new(), ids: vec![] }
}
fn warn(message: String) -> Conflict {
    Conflict { severity: "warn", ..crit(message) }
}

/// Two address rows of one machine: the same name, hostname or MAC, ignoring case. A host
/// renamed in the monitor keeps its hostname, so its old and new rows are still one machine.
pub fn same_item(a: &Value, b: &Value) -> bool {
    let names = |r: &Value| [s(r, "device"), s(r, "hostname")].into_iter().filter(|n| !n.is_empty()).map(str::to_lowercase).collect::<Vec<_>>();
    let (na, nb) = (names(a), names(b));
    na.iter().any(|n| nb.contains(n)) || (!s(a, "mac").is_empty() && s(a, "mac").eq_ignore_ascii_case(s(b, "mac")))
}

/// One machine and its address rows.
pub struct Item<'a> {
    pub name: String,
    pub rows: Vec<&'a Value>,
}

/// The machines behind address rows: rows of one machine joined, named after the first row
/// typed by hand, else the first with a name, else its address.
pub fn items<'a>(rows: impl IntoIterator<Item = &'a Value>) -> Vec<Item<'a>> {
    let rows: Vec<&Value> = rows.into_iter().collect();
    // shortcut: compares every pair of rows; fine for a few thousand addresses, index by name past that.
    let mut up: Vec<usize> = (0..rows.len()).collect();
    fn root(up: &mut [usize], mut i: usize) -> usize {
        while up[i] != i {
            up[i] = up[up[i]];
            i = up[i];
        }
        i
    }
    for i in 0..rows.len() {
        for j in i + 1..rows.len() {
            if same_item(rows[i], rows[j]) {
                let (a, b) = (root(&mut up, i), root(&mut up, j));
                up[b] = a;
            }
        }
    }
    let mut groups: Vec<(usize, Vec<&Value>)> = vec![];
    for (i, r) in rows.iter().enumerate() {
        let k = root(&mut up, i);
        match groups.iter_mut().find(|(g, _)| *g == k) {
            Some((_, g)) => g.push(r),
            None => groups.push((k, vec![r])),
        }
    }
    groups
        .into_iter()
        .map(|(_, rows)| {
            let named = |r: &&&Value| !s(r, "device").is_empty();
            let by_hand = rows.iter().filter(named).find(|r| s(r, "note") != "From monitoring").or(rows.iter().find(named));
            Item { name: by_hand.map_or_else(|| s(rows[0], "address").to_string(), |r| s(r, "device").to_string()), rows }
        })
        .collect()
}

/// The machines at one address that make it a conflict: none when they are one machine, or
/// when every row there is marked shared (VRRP, CARP, anycast).
fn rivals<'a>(rows: &[&'a Value]) -> Vec<Item<'a>> {
    let shared: Vec<&Value> = rows.iter().copied().filter(|r| r["shared"] == true).collect();
    let mut machines = items(rows.iter().copied().filter(|r| r["shared"] != true));
    if machines.len() == 1 && shared.iter().any(|r| !machines[0].rows.iter().any(|m| same_item(m, r))) {
        machines.extend(items(shared));
    }
    if machines.len() > 1 { machines } else { vec![] }
}

/// Usable addresses in a network, saturating for huge IPv6 prefixes.
fn capacity(net: &IpNet) -> u128 {
    let host_bits = (net.max_prefix_len() - net.prefix_len()) as u32;
    let total = 1u128.checked_shl(host_bits).unwrap_or(u128::MAX);
    match net {
        IpNet::V4(_) if host_bits >= 2 => total - 2, // network and broadcast
        _ => total,
    }
}

fn pct(used: u128, cap: u128) -> f64 {
    used as f64 * 100.0 / cap.max(1) as f64
}

/// Subnets that parse, with their VRF. Nesting is a plan, not a conflict: only the same
/// prefix twice in one VRF is.
fn parse_nets<'a>(subnets: &'a [Value], conflicts: &mut Vec<Conflict>) -> Vec<(&'a Value, IpNet)> {
    subnets
        .iter()
        .filter_map(|r| match s(r, "cidr").parse::<IpNet>() {
            Ok(n) => Some((r, n.trunc())),
            Err(_) => {
                conflicts.push(crit(format!("{}: invalid CIDR {}", s(r, "name"), s(r, "cidr"))));
                None
            }
        })
        .collect()
}

/// The smallest other subnet of the same VRF that holds `n`.
fn parent_of<'a>(nets: &[(&'a Value, IpNet)], r: &Value, n: &IpNet) -> Option<&'a Value> {
    nets.iter()
        .filter(|(o, on)| o["id"] != r["id"] && s(o, "vrf") == s(r, "vrf") && on.prefix_len() < n.prefix_len() && on.contains(n))
        .max_by_key(|(_, on)| on.prefix_len())
        .map(|(o, _)| *o)
}

/// Usage per subnet, in tree order, and everything wrong with the plan.
pub fn report(subnets: &[Value], addresses: &[Value]) -> Value {
    let mut conflicts = vec![];
    let mut nets = parse_nets(subnets, &mut conflicts);
    nets.sort_by(|(a, na), (b, nb)| (s(a, "vrf"), na.network(), na.prefix_len()).cmp(&(s(b, "vrf"), nb.network(), nb.prefix_len())));

    for (i, (a, na)) in nets.iter().enumerate() {
        for (b, nb) in &nets[i + 1..] {
            if na == nb && s(a, "vrf") == s(b, "vrf") {
                conflicts.push(crit(format!("Subnets {} and {} are both {na}", s(a, "name"), s(b, "name"))));
            }
        }
        if !s(a, "gateway").is_empty() && s(a, "gateway").parse::<IpAddr>().map_or(true, |g| !na.contains(&g)) {
            conflicts.push(warn(format!("{}: gateway {} is outside {na}", s(a, "name"), s(a, "gateway"))));
        }
    }

    let mut by_ip: HashMap<IpAddr, Vec<&Value>> = HashMap::new();
    let mut by_mac: HashMap<String, HashSet<IpAddr>> = HashMap::new();
    for r in addresses {
        let Ok(ip) = s(r, "address").parse::<IpAddr>() else {
            conflicts.push(crit(format!("Invalid address {} on {}", s(r, "address"), s(r, "device"))));
            continue;
        };
        by_ip.entry(ip).or_default().push(r);
        if !s(r, "mac").is_empty() {
            by_mac.entry(s(r, "mac").to_lowercase()).or_default().insert(ip);
        }
    }
    let mut ips: Vec<&IpAddr> = by_ip.keys().collect();
    ips.sort();
    for ip in ips {
        let rows = &by_ip[ip];
        let machines = rivals(rows);
        if !machines.is_empty() {
            let mut names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
            names.sort();
            conflicts.push(Conflict {
                kind: "address".into(),
                address: ip.to_string(),
                ids: rows.iter().map(|r| s(r, "id").to_string()).collect(),
                ..crit(format!("{ip} is assigned to {}", names.join(", ")))
            });
        }
        match nets.iter().filter(|(_, n)| n.contains(ip)).max_by_key(|(_, n)| n.prefix_len()) {
            None if !nets.is_empty() => conflicts.push(warn(format!("{ip} is outside every subnet"))),
            Some((sub, n)) if matches!(n, IpNet::V4(_)) && n.prefix_len() < 31 && (*ip == n.network() || *ip == n.broadcast()) => {
                conflicts.push(crit(format!("{ip} is the network or broadcast address of {}", s(sub, "name"))));
            }
            _ => {}
        }
    }
    let mut macs: Vec<_> = by_mac.iter().filter(|(_, v)| v.len() > 1).collect();
    macs.sort_by_key(|(m, _)| m.as_str());
    for (mac, ips) in macs {
        let mut l: Vec<String> = ips.iter().map(ToString::to_string).collect();
        l.sort();
        conflicts.push(warn(format!("MAC {mac} appears on {}", l.join(", "))));
    }

    let subnets_out: Vec<Value> = nets
        .iter()
        .map(|(r, n)| {
            let used = by_ip.keys().filter(|ip| n.contains(*ip)).count() as u128;
            let cap = capacity(n);
            let threshold = r["threshold"].as_f64().unwrap_or(0.0);
            if threshold > 0.0 && pct(used, cap) >= threshold {
                conflicts.push(warn(format!("{} is {:.0} % full, above its {threshold} % threshold", s(r, "name"), pct(used, cap))));
            }
            let mut depth = 0;
            let mut up = parent_of(&nets, r, n);
            let parent = up.map(|p| p["id"].clone());
            while let Some(p) = up {
                depth += 1;
                up = s(p, "cidr").parse::<IpNet>().ok().and_then(|pn| parent_of(&nets, p, &pn.trunc()));
            }
            json!({"id": r["id"], "name": r["name"], "cidr": n.to_string(), "vlan": r["vlan"], "gateway": r["gateway"],
                "section": r["section"], "vrf": r["vrf"], "location": r["location"], "description": r["description"], "threshold": r["threshold"],
                "parent": parent, "depth": depth, "used": used as u64, "capacity": cap.to_string(), "pct": pct(used, cap)})
        })
        .collect();
    json!({"subnets": subnets_out, "conflicts": conflicts})
}

fn to_u128(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(a) => u32::from(a).into(),
        IpAddr::V6(a) => a.into(),
    }
}

fn from_u128(v: u128, like: &IpNet) -> IpAddr {
    match like {
        IpNet::V4(_) => IpAddr::V4((v as u32).into()),
        IpNet::V6(_) => IpAddr::V6(v.into()),
    }
}

/// Most free ranges listed for one subnet.
const MAX_RANGES: usize = 256;

/// Everything about one subnet: calculator figures, its addresses, its direct child
/// subnets and the free ranges left between the addresses (and its gateway).
pub fn detail(subnet: &Value, subnets: &[Value], addresses: &[Value]) -> Option<Value> {
    let net = s(subnet, "cidr").parse::<IpNet>().ok()?.trunc();
    let mut ignored = vec![];
    let nets = parse_nets(subnets, &mut ignored);
    let children: Vec<&Value> = nets
        .iter()
        .filter(|(r, n)| parent_of(&nets, r, n).is_some_and(|p| p["id"] == subnet["id"]))
        .map(|(r, _)| *r)
        .collect();

    let mut inside: Vec<(IpAddr, &Value)> = addresses.iter().filter_map(|r| Some((s(r, "address").parse::<IpAddr>().ok()?, r))).filter(|(ip, _)| net.contains(ip)).collect();
    inside.sort_by_key(|(ip, _)| *ip);
    let mut taken: Vec<u128> = inside.iter().map(|(ip, _)| to_u128(*ip)).collect();
    taken.extend(s(subnet, "gateway").parse::<IpAddr>().ok().filter(|g| net.contains(g)).map(to_u128));
    taken.sort_unstable();
    taken.dedup();

    let mut hosts = net.hosts();
    let (first, last) = (hosts.next().map(to_u128)?, net.hosts().last().map(to_u128)?);
    let mut free = vec![];
    let mut at = first;
    for t in taken.iter().copied().filter(|t| *t >= first && *t <= last).chain(std::iter::once(last.saturating_add(1))) {
        if t > at && free.len() < MAX_RANGES {
            let size = t - at;
            free.push(json!({"start": from_u128(at, &net), "end": from_u128(t - 1, &net), "size": size.to_string()}));
        }
        at = t.saturating_add(1);
    }
    let v4 = matches!(net, IpNet::V4(_));
    Some(json!({
        "subnet": subnet,
        "calc": {
            "network": net.network(), "prefix": net.prefix_len(), "netmask": net.netmask(), "wildcard": net.hostmask(),
            "broadcast": v4.then(|| net.broadcast()), "first": from_u128(first, &net), "last": from_u128(last, &net),
            "total": 1u128.checked_shl((net.max_prefix_len() - net.prefix_len()) as u32).map_or("a lot".into(), |t| t.to_string()),
            "usable": capacity(&net).to_string(),
        },
        "addresses": inside.iter().map(|(_, r)| *r).collect::<Vec<_>>(),
        "children": children,
        "free": free,
    }))
}

/// Largest subnet a scan pings, one ICMP echo per address.
pub const MAX_SCAN: usize = 1024;

/// Addresses a scan of the subnet pings: IPv4 only, as an IPv6 subnet has too many.
pub fn scan_targets(subnet: &Value) -> Result<Vec<IpAddr>, &'static str> {
    let net = s(subnet, "cidr").parse::<IpNet>().map_err(|_| "invalid CIDR")?.trunc();
    if !matches!(net, IpNet::V4(_)) {
        return Err("only IPv4 subnets can be scanned");
    }
    if net.prefix_len() < 22 {
        return Err("scan subnets of /22 or smaller");
    }
    Ok(net.hosts().take(MAX_SCAN).collect())
}

/// First free address of a subnet, skipping network, broadcast and gateway.
pub fn next_free(subnet: &Value, addresses: &[Value]) -> Option<IpAddr> {
    let net = s(subnet, "cidr").parse::<IpNet>().ok()?.trunc();
    let taken: HashSet<IpAddr> = addresses.iter().filter_map(|r| s(r, "address").parse().ok()).collect();
    let gateway = s(subnet, "gateway").parse::<IpAddr>().ok();
    net.hosts().take(65536).find(|ip| !taken.contains(ip) && Some(*ip) != gateway)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subnet(name: &str, cidr: &str, gw: &str) -> Value {
        json!({"id": name, "name": name, "cidr": cidr, "gateway": gw, "vlan": 0})
    }
    fn addr(ip: &str, device: &str) -> Value {
        json!({"address": ip, "device": device, "mac": ""})
    }
    fn messages(v: &Value) -> Vec<String> {
        v["conflicts"].as_array().unwrap().iter().map(|c| c["message"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn counts_usage() {
        let v = report(&[subnet("lan", "192.168.1.0/24", "192.168.1.1")], &[addr("192.168.1.1", "gw"), addr("192.168.1.2", "a")]);
        assert_eq!(v["subnets"][0]["used"], 2);
        assert_eq!(v["subnets"][0]["capacity"], "254");
        assert!(messages(&v).is_empty());
    }

    #[test]
    fn huge_ipv6_prefixes_do_not_overflow() {
        let v = report(&[subnet("v6", "2001:db8::/32", "")], &[]);
        assert_eq!(v["subnets"][0]["capacity"], (1u128 << 96).to_string());
        assert_eq!(report(&[subnet("all", "::/0", "")], &[])["subnets"][0]["capacity"], u128::MAX.to_string());
    }

    #[test]
    fn detects_every_conflict_kind() {
        let subs = [subnet("a", "10.0.0.0/24", "10.1.0.1"), subnet("b", "10.0.0.0/24", ""), subnet("bad", "nope", "")];
        let mut dup = addr("10.0.0.5", "x");
        dup["mac"] = "AA:BB".into();
        let mut other_ip = addr("10.0.0.6", "y");
        other_ip["mac"] = "aa:bb".into();
        let addrs = [dup, addr("10.0.0.5", "y"), other_ip, addr("10.0.0.0", "z"), addr("172.16.0.1", "z"), addr("oops", "z")];
        let m = messages(&report(&subs, &addrs));
        for expected in ["invalid CIDR", "are both 10.0.0.0/24", "gateway 10.1.0.1 is outside", "10.0.0.5 is assigned to x, y", "network or broadcast", "172.16.0.1 is outside every subnet", "Invalid address oops", "MAC aa:bb appears"] {
            assert!(m.iter().any(|x| x.contains(expected)), "missing {expected:?} in {m:?}");
        }
    }

    #[test]
    fn nested_subnets_form_a_tree_and_vrfs_keep_twins_apart() {
        let mut twin = subnet("twin", "10.0.0.0/16", "");
        twin["vrf"] = "lab".into();
        let subs = [subnet("child", "10.0.1.0/24", ""), subnet("site", "10.0.0.0/16", ""), subnet("rack", "10.0.1.0/26", ""), twin];
        let v = report(&subs, &[addr("10.0.1.255", "x")]);
        // A host of the /16 but the broadcast of the /24: the most specific subnet decides.
        assert_eq!(messages(&v), ["10.0.1.255 is the network or broadcast address of child"]);
        let tree: Vec<(&str, i64, &str)> = v["subnets"].as_array().unwrap().iter().map(|s| (s["name"].as_str().unwrap(), s["depth"].as_i64().unwrap(), s["parent"].as_str().unwrap_or(""))).collect();
        assert_eq!(tree, [("site", 0, ""), ("child", 1, "site"), ("rack", 2, "child"), ("twin", 0, "")]);
    }

    #[test]
    fn a_full_subnet_passes_its_threshold() {
        let mut s = subnet("tiny", "10.0.0.0/30", "");
        s["threshold"] = 50.into();
        assert!(messages(&report(&[s], &[addr("10.0.0.1", "a")])).iter().any(|m| m.contains("above its 50 % threshold")));
    }

    #[test]
    fn details_list_free_ranges_and_children() {
        let subs = [subnet("lan", "192.168.1.0/28", "192.168.1.1"), subnet("dhcp", "192.168.1.8/29", "")];
        let d = detail(&subs[0], &subs, &[addr("192.168.1.5", "a"), addr("10.0.0.1", "elsewhere")]).unwrap();
        assert_eq!(d["calc"]["netmask"], "255.255.255.240");
        assert_eq!(d["calc"]["usable"], "14");
        assert_eq!(d["addresses"].as_array().unwrap().len(), 1);
        assert_eq!(d["children"][0]["name"], "dhcp");
        let free: Vec<(&str, &str)> = d["free"].as_array().unwrap().iter().map(|r| (r["start"].as_str().unwrap(), r["end"].as_str().unwrap())).collect();
        assert_eq!(free, [("192.168.1.2", "192.168.1.4"), ("192.168.1.6", "192.168.1.14")]);
    }

    #[test]
    fn only_small_ipv4_subnets_are_scanned() {
        assert_eq!(scan_targets(&subnet("lan", "192.168.1.0/24", "")).unwrap().len(), 254);
        assert!(scan_targets(&subnet("big", "10.0.0.0/16", "")).is_err());
        assert!(scan_targets(&subnet("v6", "2001:db8::/64", "")).is_err());
    }

    #[test]
    fn same_device_listed_twice_is_not_a_conflict() {
        assert!(messages(&report(&[], &[addr("10.0.0.5", "x"), addr("10.0.0.5", "x")])).is_empty());
    }

    #[test]
    fn suggests_the_first_free_address() {
        let s = subnet("lan", "192.168.1.0/29", "192.168.1.1");
        assert_eq!(next_free(&s, &[addr("192.168.1.2", "a")]).unwrap().to_string(), "192.168.1.3");
    }

    #[test]
    fn one_machine_under_two_names_is_not_a_conflict() {
        let mut renamed = addr("10.0.0.5", "Forge Git");
        renamed["hostname"] = "gitea".into();
        let mut old = addr("10.0.0.5", "gitea");
        old["hostname"] = "gitea".into();
        let mut a = addr("10.0.0.6", "nas");
        a["mac"] = "AA:BB".into();
        let mut b = addr("10.0.0.6", "Synology");
        b["mac"] = "aa:bb".into();
        assert!(messages(&report(&[], &[renamed, old, a, b])).is_empty());
    }

    #[test]
    fn shared_addresses_conflict_only_with_others() {
        let mut r1 = addr("10.0.0.1", "r1");
        r1["shared"] = true.into();
        let mut r2 = addr("10.0.0.1", "r2");
        r2["shared"] = true.into();
        assert!(messages(&report(&[], &[r1.clone(), r2.clone()])).is_empty());
        let mut pc = addr("10.0.0.1", "pc");
        pc["id"] = "p".into();
        let v = report(&[], &[r1, r2, pc]);
        assert_eq!(messages(&v), ["10.0.0.1 is assigned to pc, r1, r2"]);
        assert_eq!((v["conflicts"][0]["kind"].as_str(), v["conflicts"][0]["ids"].as_array().unwrap().len()), (Some("address"), 3));
    }

    #[test]
    fn items_are_named_after_the_row_typed_by_hand() {
        let mut seen = addr("10.0.0.5", "gitea");
        seen["note"] = "From monitoring".into();
        let mut typed = addr("10.0.0.5", "Forge");
        typed["hostname"] = "gitea".into();
        let rows = [seen, typed, addr("10.0.0.9", "")];
        let names: Vec<String> = items(&rows).into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["Forge", "10.0.0.9"]);
    }
}
