//! Loaded systemd services: two `systemctl` calls per reading, one to list them, one to
//! describe them all at once. Read every minute, with the containers.

use nyx_proto::Service;
use std::{collections::HashMap, process::Command, time::Instant};

/// Beyond this many, the rest is left out: a page of thousands helps nobody.
const MAX_SERVICES: usize = 400;
const PROPS: &str = "Id,Description,ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,NRestarts,Type,Result,FragmentPath,ActiveEnterTimestampMonotonic,StateChangeTimestampMonotonic";

/// CPU time of each service at the last reading, to turn the counter into a share.
#[derive(Default)]
pub struct CpuSeen {
    at: Option<Instant>,
    ns: HashMap<String, u64>,
}

/// Whether two readings differ in more than their figures, CPU and memory, which move
/// all the time: a change of state goes out at once, new figures every few minutes.
pub fn same_states(a: &[Service], b: &[Service]) -> bool {
    let bare = |s: &Service| Service { cpu_pct: 0.0, mem: 0, ..s.clone() };
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| bare(x) == bare(y))
}

/// `None` without systemd, so the monitor keeps what it had rather than an empty list.
pub fn scan(seen: &mut CpuSeen, boot: u64) -> Option<Vec<Service>> {
    let list = run(&["list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"])?;
    let units = loaded_units(&list);
    if units.is_empty() {
        return Some(vec![]);
    }
    let mut args = vec!["show", "--no-pager", "-p", PROPS, "--"];
    args.extend(units.iter().map(String::as_str));
    let shown = run(&args)?;
    let secs = seen.at.map_or(0.0, |t| t.elapsed().as_secs_f64());
    seen.at = Some(Instant::now());
    let mut ns = HashMap::new();
    let list = parse_show(&shown, boot, |name, cpu| {
        ns.insert(name.to_string(), cpu);
        share(seen.ns.get(name).copied(), cpu, secs)
    });
    seen.ns = ns;
    Some(list)
}

fn run(args: &[&str]) -> Option<String> {
    let out = Command::new("systemctl").args(args).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Units whose file was found; `not-found` ones are only names something referred to.
fn loaded_units(list: &str) -> Vec<String> {
    let mut out: Vec<String> = list.lines()
        .filter_map(|l| { let mut f = l.split_whitespace(); Some((f.next()?, f.next()?)) })
        .filter(|(unit, load)| *load == "loaded" && unit.ends_with(".service") && nyx_proto::unit_name_ok(unit))
        .map(|(unit, _)| unit.to_string())
        .collect();
    out.truncate(MAX_SERVICES);
    out
}

/// Share of one core over `secs`: none on the first reading or after a restart of the unit.
fn share(before: Option<u64>, now: u64, secs: f64) -> f32 {
    match before {
        Some(b) if now >= b && secs > 0.0 => ((now - b) as f64 / 1e9 / secs * 100.0) as f32,
        _ => 0.0,
    }
}

/// Blocks of `key=value` lines, one per unit, as `systemctl show` prints them.
/// `cpu` gets each unit's CPU counter and gives back its share.
fn parse_show(text: &str, boot: u64, mut cpu: impl FnMut(&str, u64) -> f32) -> Vec<Service> {
    let mut out = vec![];
    for block in text.split("\n\n") {
        let kv: HashMap<&str, &str> = block.lines().filter_map(|l| l.split_once('=')).collect();
        let Some(id) = kv.get("Id").filter(|id| id.ends_with(".service")) else { continue };
        let num = |k: &str| kv.get(k).and_then(|v| v.parse::<u64>().ok()).filter(|v| *v != u64::MAX).unwrap_or(0);
        let text = |k: &str| kv.get(k).unwrap_or(&"").to_string();
        let name = id.trim_end_matches(".service").to_string();
        let active = text("ActiveState");
        // Monotonic microseconds since boot, the same on every systemd version.
        let mono = if active == "active" { num("ActiveEnterTimestampMonotonic") } else { num("StateChangeTimestampMonotonic") };
        out.push(Service {
            cpu_pct: cpu(&name, num("CPUUsageNSec")),
            description: text("Description"),
            sub: text("SubState"),
            enabled: text("UnitFileState"),
            since: if mono > 0 { (boot + mono / 1_000_000) as i64 } else { 0 },
            pid: num("MainPID") as u32,
            mem: num("MemoryCurrent"),
            restarts: num("NRestarts") as u32,
            kind: text("Type"),
            result: text("Result"),
            path: text("FragmentPath"),
            active,
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loaded_services_are_listed() {
        let list = "ssh.service loaded active running OpenBSD Secure Shell server\n\
                    ghost.service not-found inactive dead ghost.service\n\
                    nginx.service loaded failed failed A high performance web server\n\
                    systemd-fsck@dev-disk-by\\x2duuid-1.service loaded active exited File System Check\n";
        assert_eq!(loaded_units(list), ["ssh.service", "nginx.service", "systemd-fsck@dev-disk-by\\x2duuid-1.service"]);
    }

    #[test]
    fn show_blocks_become_services() {
        let text = "Id=ssh.service\nDescription=OpenBSD Secure Shell server\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=812\n\
                    MemoryCurrent=5242880\nCPUUsageNSec=2000000000\nNRestarts=1\nType=notify\nResult=success\nFragmentPath=/lib/systemd/system/ssh.service\n\
                    ActiveEnterTimestampMonotonic=30000000\nStateChangeTimestampMonotonic=30000000\n\n\
                    Id=nginx.service\nDescription=nginx\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\nMainPID=0\n\
                    MemoryCurrent=[not set]\nCPUUsageNSec=18446744073709551615\nNRestarts=0\nType=forking\nResult=exit-code\nFragmentPath=/lib/systemd/system/nginx.service\n\
                    ActiveEnterTimestampMonotonic=0\nStateChangeTimestampMonotonic=90000000\n";
        let mut before = HashMap::from([("ssh".to_string(), 1_000_000_000u64)]);
        let s = parse_show(text, 1_000, |name, ns| share(before.remove(name), ns, 10.0));
        assert_eq!(s.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["nginx", "ssh"]);
        let (nginx, ssh) = (&s[0], &s[1]);
        assert_eq!((ssh.since, ssh.pid, ssh.mem, ssh.restarts), (1_030, 812, 5_242_880, 1));
        assert!((ssh.cpu_pct - 10.0).abs() < 0.01, "1 s of CPU over 10 s is 10 % of a core");
        assert_eq!((nginx.active.as_str(), nginx.result.as_str(), nginx.since, nginx.mem), ("failed", "exit-code", 1_090, 0));
        assert_eq!(nginx.cpu_pct, 0.0, "no counter, no share");
    }

    #[test]
    fn figures_alone_are_not_a_change_of_state() {
        let a = Service { name: "ssh".into(), active: "active".into(), cpu_pct: 1.0, mem: 10, ..Service::default() };
        assert!(same_states(&[a.clone()], &[Service { cpu_pct: 3.0, mem: 99, ..a.clone() }]));
        assert!(!same_states(&[a.clone()], &[Service { active: "failed".into(), ..a.clone() }]));
        assert!(!same_states(&[a.clone()], &[]));
    }

    #[test]
    fn a_counter_that_went_back_means_a_restart() {
        assert_eq!(share(Some(5), 3, 10.0), 0.0);
        assert_eq!(share(None, 3, 10.0), 0.0);
    }
}
