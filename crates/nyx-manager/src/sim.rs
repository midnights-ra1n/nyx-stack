//! The simulator: the machines of the IPAM laid out as a network, and a ping between two of
//! them, hop by hop, the way Packet Tracer shows it. Pure logic over records, no I/O.

use crate::ipam::{items, s, Item};
use ipnet::IpNet;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashSet, net::IpAddr};

const MAX_HOPS: usize = 32;

#[derive(Serialize, Debug)]
pub struct Hop {
    pub device: String,
    /// The address the device sends from, empty when it has none to use.
    pub ip: String,
    pub detail: String,
    pub level: &'static str,
}

#[derive(Serialize, Debug)]
pub struct Trace {
    /// `reached`, `conflict` (reached, but two machines answer), `exit` (left the recorded
    /// network), `unreachable` or `loop`.
    pub status: &'static str,
    pub summary: String,
    pub hops: Vec<Hop>,
    #[serde(skip)]
    to: Option<usize>,
}

pub struct Net<'a> {
    items: Vec<Item<'a>>,
    subnets: Vec<(&'a Value, IpNet)>,
    routes: &'a [Value],
}

impl<'a> Net<'a> {
    pub fn new(subnets: &'a [Value], addresses: &'a [Value], routes: &'a [Value]) -> Self {
        let subnets = subnets.iter().filter_map(|r| Some((r, s(r, "cidr").parse::<IpNet>().ok()?.trunc()))).collect();
        Net { items: items(addresses), subnets, routes }
    }

    fn ips(&self, i: usize) -> Vec<IpAddr> {
        let mut v: Vec<IpAddr> = self.items[i].rows.iter().filter_map(|r| s(r, "address").parse().ok()).collect();
        v.dedup();
        v
    }

    /// The most specific subnet holding `ip`: the segment it is plugged into.
    fn segment(&self, ip: &IpAddr) -> Option<usize> {
        (0..self.subnets.len()).filter(|&i| self.subnets[i].1.contains(ip)).max_by_key(|&i| self.subnets[i].1.prefix_len())
    }

    fn gateway(&self, seg: usize) -> Option<IpAddr> {
        s(self.subnets[seg].0, "gateway").parse().ok()
    }

    /// The machines answering at `ip`, and whether its rows say it is shared on purpose.
    fn owners(&self, ip: IpAddr) -> (Vec<usize>, bool) {
        let rows = |i: usize| self.items[i].rows.iter().filter(move |r| s(r, "address").parse() == Ok(ip));
        let found: Vec<usize> = (0..self.items.len()).filter(|&i| rows(i).next().is_some()).collect();
        let shared = found.iter().all(|&i| rows(i).all(|r| r["shared"] == true));
        (found, shared)
    }

    fn find(&self, what: &str) -> Option<usize> {
        let what = what.trim();
        if let Ok(ip) = what.parse::<IpAddr>() {
            return self.owners(ip).0.first().copied();
        }
        (0..self.items.len()).find(|&i| self.items[i].name.eq_ignore_ascii_case(what) || self.items[i].rows.iter().any(|r| s(r, "device").eq_ignore_ascii_case(what) || s(r, "hostname").eq_ignore_ascii_case(what)))
    }

    /// A machine is a router when it has a leg in two segments or holds a segment's gateway.
    fn is_router(&self, i: usize) -> bool {
        let segs: HashSet<usize> = self.ips(i).iter().filter_map(|ip| self.segment(ip)).collect();
        segs.len() > 1 || segs.iter().any(|&g| self.gateway(g).is_some_and(|gw| self.ips(i).contains(&gw)))
    }

    /// Segments with their machines, the routers joining them, and machines outside any subnet.
    pub fn topology(&self) -> Value {
        let mut used: Vec<usize> = vec![];
        let mut hosts: Vec<Vec<Value>> = vec![vec![]; self.subnets.len()];
        let mut routers = vec![];
        let mut outside = vec![];
        for i in 0..self.items.len() {
            let ips = self.ips(i);
            let conflict = ips.iter().any(|ip| { let (o, shared) = self.owners(*ip); o.len() > 1 && !shared });
            let ip_list: Vec<String> = ips.iter().map(ToString::to_string).collect();
            if self.is_router(i) {
                let legs: Vec<Value> = ips.iter().filter_map(|ip| Some(json!({"segment": s(self.subnets[self.segment(ip)?].0, "id"), "ip": ip.to_string()}))).collect();
                used.extend(ips.iter().filter_map(|ip| self.segment(ip)));
                routers.push(json!({"name": self.items[i].name, "ips": ip_list, "links": legs, "conflict": conflict}));
            } else if let Some(seg) = ips.iter().find_map(|ip| self.segment(ip)) {
                used.push(seg);
                hosts[seg].push(json!({"name": self.items[i].name, "ips": ip_list, "conflict": conflict}));
            } else {
                outside.push(json!({"name": self.items[i].name, "ips": ip_list, "conflict": conflict}));
            }
        }
        let mut order: Vec<usize> = used.into_iter().collect::<HashSet<_>>().into_iter().collect();
        order.sort_by_key(|&i| (self.subnets[i].1.network(), self.subnets[i].1.prefix_len()));
        let segments: Vec<Value> = order
            .into_iter()
            .map(|i| {
                let (r, n) = self.subnets[i];
                let gw = self.gateway(i);
                json!({"id": r["id"], "name": r["name"], "cidr": n.to_string(), "vlan": r["vlan"], "gateway": gw.map(|g| g.to_string()),
                    "gateway_known": gw.is_some_and(|g| !self.owners(g).0.is_empty()), "hosts": hosts[i]})
            })
            .collect();
        json!({"segments": segments, "routers": routers, "outside": outside})
    }

    /// The address `src` sends from to reach `dest`: one on the same segment, else one whose
    /// segment has a gateway, else its first.
    fn source_ip(&self, src: usize, dest: IpAddr) -> Option<IpAddr> {
        let ips = self.ips(src);
        let near = ips.iter().find(|ip| self.segment(ip).is_some() && self.segment(ip) == self.segment(&dest));
        near.or_else(|| ips.iter().find(|ip| self.segment(ip).and_then(|g| self.gateway(g)).is_some())).or(ips.first()).copied()
    }

    fn route(&self, at: usize, dest: IpAddr) -> Option<(IpNet, IpAddr)> {
        let mine = |d: &str| self.items[at].name.eq_ignore_ascii_case(d) || self.items[at].rows.iter().any(|r| s(r, "device").eq_ignore_ascii_case(d));
        self.routes
            .iter()
            .filter(|r| mine(s(r, "device")))
            .filter_map(|r| Some((r, s(r, "destination").parse::<IpNet>().ok()?, s(r, "next_hop").parse::<IpAddr>().ok()?)))
            .filter(|(_, n, _)| n.contains(&dest))
            .max_by_key(|(r, n, _)| (n.prefix_len(), -r["metric"].as_i64().unwrap_or(0)))
            .map(|(_, n, h)| (n, h))
    }

    /// One way, from a machine to an address.
    pub fn trace(&self, src: usize, dest: IpAddr) -> Trace {
        let mut hops: Vec<Hop> = vec![];
        let mut seen = HashSet::new();
        let mut at = src;
        let mut conflict = false;
        let end = |status, summary: String, hops, to| Trace { status, summary, hops, to };
        loop {
            let name = self.items[at].name.clone();
            let hop = |ip: Option<IpAddr>, detail: String, level| Hop { device: name.clone(), ip: ip.map(|i| i.to_string()).unwrap_or_default(), detail, level };
            if !seen.insert(at) {
                hops.push(hop(None, "already visited".into(), "crit"));
                return end("loop", format!("Routing loop at {name}"), hops, None);
            }
            if hops.len() >= MAX_HOPS {
                return end("unreachable", format!("Gave up after {MAX_HOPS} hops"), hops, None);
            }
            let mine = self.ips(at);
            if mine.contains(&dest) {
                hops.push(hop(Some(dest), "destination".into(), if conflict { "warn" } else { "ok" }));
                let n = hops.len() - 1;
                return if conflict {
                    end("conflict", format!("{dest} answers from more than one machine: the packet may reach the wrong one"), hops, Some(at))
                } else {
                    end("reached", if n == 1 { format!("{dest} reached directly") } else { format!("{dest} reached in {n} hops") }, hops, Some(at))
                };
            }
            let from = self.source_ip(at, dest);
            let Some(from) = from else {
                hops.push(hop(None, "no recorded address".into(), "crit"));
                return end("unreachable", format!("{name} has no recorded address"), hops, None);
            };
            // Same segment: ask who has the address. Else a recorded route, else the gateway.
            let next = if self.segment(&dest).is_some() && mine.iter().any(|ip| self.segment(ip) == self.segment(&dest)) {
                let seg = self.segment(&dest).unwrap();
                hops.push(hop(Some(from), format!("{dest} is on {}, connected", self.subnets[seg].1), "ok"));
                dest
            } else if let Some((net, via)) = self.route(at, dest) {
                hops.push(hop(Some(from), format!("route {net} via {via}"), "ok"));
                via
            } else if let Some(gw) = self.segment(&from).and_then(|g| self.gateway(g)) {
                if mine.contains(&gw) {
                    hops.push(hop(Some(from), "no route beyond".into(), "info"));
                    return end("exit", format!("{dest} leaves the recorded network through {name}"), hops, None);
                }
                hops.push(hop(Some(from), format!("default gateway {gw}"), "ok"));
                gw
            } else {
                hops.push(hop(Some(from), "no route and no gateway".into(), "crit"));
                return end("unreachable", format!("{name} has no route to {dest}"), hops, None);
            };
            let (owners, shared) = self.owners(next);
            match owners.as_slice() {
                [] if next == dest => return end("unreachable", format!("Nothing answers at {dest}: no machine is recorded there"), hops, None),
                [] => return end("unreachable", format!("Gateway {next} is not recorded: add it to the addresses of your router"), hops, None),
                [one] => at = *one,
                [first, ..] => {
                    if !shared {
                        conflict = true;
                        let names: Vec<&str> = owners.iter().map(|&o| self.items[o].name.as_str()).collect();
                        let last = hops.last_mut().unwrap();
                        last.level = "warn";
                        last.detail = format!("{} · {next} answers from {}", last.detail, names.join(", "));
                    }
                    at = *first;
                }
            }
        }
    }

    /// A ping: the request, then the reply from the machine that answered.
    pub fn ping(&self, from: &str, to: &str) -> Value {
        let fail = |summary: String| json!({"status": "unreachable", "summary": summary, "request": {"hops": []}, "reply": null});
        let Some(src) = self.find(from) else { return fail(format!("Unknown device or address {}", from.trim())) };
        let dest = match to.trim().parse::<IpAddr>() {
            Ok(ip) => ip,
            Err(_) => match self.find(to) {
                Some(d) => {
                    let ips = self.ips(d);
                    let near = ips.iter().find(|ip| self.ips(src).iter().any(|m| self.segment(m).is_some() && self.segment(m) == self.segment(ip)));
                    match near.or(ips.first()) {
                        Some(ip) => *ip,
                        None => return fail(format!("{} has no recorded address", self.items[d].name)),
                    }
                }
                None => return fail(format!("Unknown device or address {}", to.trim())),
            },
        };
        if let Some(seg) = self.segment(&dest) {
            let n = self.subnets[seg].1;
            if matches!(n, IpNet::V4(_)) && n.prefix_len() < 31 && (dest == n.network() || dest == n.broadcast()) {
                return fail(format!("{dest} is the network or broadcast address of {}", s(self.subnets[seg].0, "name")));
            }
        }
        let request = self.trace(src, dest);
        let back = match (request.to, self.source_ip(src, dest)) {
            (Some(d), Some(ip)) if d != src => Some(self.trace(d, ip)),
            _ => None,
        };
        let (status, summary) = match &back {
            Some(b) if !matches!(b.status, "reached" | "conflict") => (b.status, format!("No reply: {}", b.summary)),
            _ => (request.status, request.summary.clone()),
        };
        json!({"status": status, "summary": summary, "destination": dest.to_string(), "request": request, "reply": back})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subnet(name: &str, cidr: &str, gw: &str) -> Value {
        json!({"id": name, "name": name, "cidr": cidr, "gateway": gw})
    }
    fn addr(ip: &str, device: &str) -> Value {
        json!({"address": ip, "device": device, "mac": ""})
    }
    fn route(device: &str, dest: &str, hop: &str, metric: i64) -> Value {
        json!({"device": device, "destination": dest, "next_hop": hop, "metric": metric})
    }
    fn path(v: &Value, way: &str) -> Vec<String> {
        v[way]["hops"].as_array().unwrap().iter().map(|h| h["device"].as_str().unwrap().to_string()).collect()
    }

    /// A home network: one router with a leg in each segment, the gateway of both.
    fn home() -> (Vec<Value>, Vec<Value>) {
        let subs = vec![subnet("servers", "10.0.10.0/24", "10.0.10.1"), subnet("lab", "10.0.20.0/24", "10.0.20.1")];
        let addrs = vec![addr("10.0.10.1", "fw"), addr("10.0.20.1", "fw"), addr("10.0.10.20", "nextcloud"), addr("10.0.10.21", "gitea"), addr("10.0.20.30", "k3s")];
        (subs, addrs)
    }

    #[test]
    fn pings_through_the_default_gateway_and_back() {
        let (subs, addrs) = home();
        let v = Net::new(&subs, &addrs, &[]).ping("nextcloud", "k3s");
        assert_eq!(v["status"], "reached", "{v}");
        assert_eq!(path(&v, "request"), ["nextcloud", "fw", "k3s"]);
        assert_eq!(path(&v, "reply"), ["k3s", "fw", "nextcloud"]);
        assert_eq!(v["request"]["hops"][0]["detail"], "default gateway 10.0.10.1");
    }

    #[test]
    fn neighbours_talk_directly() {
        let (subs, addrs) = home();
        let v = Net::new(&subs, &addrs, &[]).ping("10.0.10.20", "10.0.10.21");
        assert_eq!(path(&v, "request"), ["nextcloud", "gitea"]);
    }

    #[test]
    fn says_what_to_fix() {
        let (subs, mut addrs) = home();
        let net = Net::new(&subs, &addrs, &[]);
        assert_eq!(net.ping("nextcloud", "10.0.10.99")["summary"], "Nothing answers at 10.0.10.99: no machine is recorded there");
        assert_eq!(net.ping("nextcloud", "10.0.10.255")["summary"], "10.0.10.255 is the network or broadcast address of servers");
        assert_eq!(net.ping("nextcloud", "8.8.8.8")["status"], "exit");
        assert_eq!(net.ping("nobody", "k3s")["summary"], "Unknown device or address nobody");
        addrs.retain(|a| a["device"] != "fw");
        assert_eq!(Net::new(&subs, &addrs, &[]).ping("nextcloud", "k3s")["summary"], "Gateway 10.0.10.1 is not recorded: add it to the addresses of your router");
    }

    #[test]
    fn two_machines_on_one_address_are_flagged_on_the_way() {
        let (subs, mut addrs) = home();
        addrs.push(addr("10.0.20.30", "printer"));
        let net = Net::new(&subs, &addrs, &[]);
        let v = net.ping("nextcloud", "10.0.20.30");
        assert_eq!(v["status"], "conflict", "{v}");
        assert!(v["request"]["hops"][1]["detail"].as_str().unwrap().contains("answers from k3s, printer"));
        let topo = net.topology();
        assert_eq!(topo["segments"][1]["hosts"][0]["conflict"], true);
    }

    #[test]
    fn lays_routers_between_segments() {
        let (subs, mut addrs) = home();
        addrs.push(addr("192.0.2.7", "lost"));
        let t = Net::new(&subs, &addrs, &[]).topology();
        let names = |k: &str| -> Vec<String> { t[k].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect() };
        assert_eq!(names("routers"), ["fw"]);
        assert_eq!(names("outside"), ["lost"]);
        assert_eq!(t["segments"][0]["hosts"].as_array().unwrap().len(), 2);
        assert_eq!(t["segments"][0]["gateway_known"], true);
        assert_eq!(t["routers"][0]["links"].as_array().unwrap().len(), 2);
    }

    /// Routes win over the gateway, the longest prefix first, then the lowest metric.
    fn lab() -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        let subs = vec![subnet("lan", "10.0.1.0/24", ""), subnet("dmz", "10.0.2.0/24", ""), subnet("core", "10.0.9.0/24", "")];
        let addrs = vec![addr("10.0.1.10", "pc"), addr("10.0.1.1", "r1"), addr("10.0.9.1", "r1"), addr("10.0.9.2", "r2"), addr("10.0.2.1", "r2"), addr("10.0.2.20", "web")];
        let routes = vec![route("pc", "0.0.0.0/0", "10.0.1.1", 1), route("r1", "0.0.0.0/0", "10.0.9.9", 1), route("r1", "10.0.2.0/24", "10.0.9.2", 1), route("web", "0.0.0.0/0", "10.0.2.1", 1), route("r2", "10.0.1.0/24", "10.0.9.1", 1)];
        (subs, addrs, routes)
    }

    #[test]
    fn follows_recorded_routes() {
        let (subs, addrs, mut routes) = lab();
        routes.push(route("r1", "10.0.2.0/24", "10.0.9.9", 5));
        let v = Net::new(&subs, &addrs, &routes).ping("pc", "10.0.2.20");
        assert_eq!(v["status"], "reached", "{v}");
        assert_eq!(path(&v, "request"), ["pc", "r1", "r2", "web"]);
    }

    #[test]
    fn reports_loops() {
        let looped = [route("a", "0.0.0.0/0", "10.0.0.2", 1), route("b", "0.0.0.0/0", "10.0.0.1", 1)];
        let a = [addr("10.0.0.1", "a"), addr("10.0.0.2", "b")];
        assert_eq!(Net::new(&[], &a, &looped).ping("a", "8.8.8.8")["status"], "loop");
    }
}
