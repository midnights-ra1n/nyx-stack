//! Resolves the monitor's name through chosen DNS servers instead of the system's,
//! say Cloudflare when the host runs NextDNS. Plain UDP: TLS still checks the monitor.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::http::Uri;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::NextTimeout;

const A: u16 = 1;
const AAAA: u16 = 28;

#[derive(Debug)]
pub struct Servers(pub Vec<IpAddr>);

impl Resolver for Servers {
    fn resolve(&self, uri: &Uri, config: &ureq::config::Config, timeout: NextTimeout) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let host = uri.host().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
        if host.parse::<IpAddr>().is_ok() {
            return DefaultResolver::default().resolve(uri, config, timeout);
        }
        let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("http") { 80 } else { 443 });
        let mut out = self.empty();
        lookup(&self.0, host).ok_or(ureq::Error::HostNotFound)?.into_iter().take(16).for_each(|ip| out.push(SocketAddr::new(ip, port)));
        Ok(out)
    }
}

/// The first server that answers wins; the next ones are fallbacks.
fn lookup(servers: &[IpAddr], host: &str) -> Option<Vec<IpAddr>> {
    servers.iter().map(|&s| [A, AAAA].into_iter().filter_map(|t| query(s, host, t).ok()).flatten().collect::<Vec<_>>()).find(|ips| !ips.is_empty())
}

/// For the WebSocket, which does not go through ureq: `servers`, or the system's when empty.
pub fn resolve(servers: &[IpAddr], host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    if servers.is_empty() || host.parse::<IpAddr>().is_ok() {
        return Ok(std::net::ToSocketAddrs::to_socket_addrs(&(host, port))?.collect());
    }
    let ips = lookup(servers, host).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("{host} not found")))?;
    Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect())
}

fn query(server: IpAddr, host: &str, qtype: u16) -> std::io::Result<Vec<IpAddr>> {
    let bad = || std::io::Error::from(std::io::ErrorKind::InvalidData);
    let sock = UdpSocket::bind(if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })?;
    sock.set_read_timeout(Some(Duration::from_secs(3)))?;
    sock.connect((server, 53))?;
    let id = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()) as u16;
    sock.send(&encode(id, host, qtype).ok_or_else(bad)?)?;
    let mut buf = [0u8; 1500];
    let n = sock.recv(&mut buf)?;
    parse(&buf[..n], id).ok_or_else(bad)
}

fn encode(id: u16, host: &str, qtype: u16) -> Option<Vec<u8>> {
    let mut q = id.to_be_bytes().to_vec();
    q.extend([1, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // recursion desired, one question
    for label in host.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        q.push(label.len() as u8);
        q.extend(label.as_bytes());
    }
    q.extend([0, (qtype >> 8) as u8, qtype as u8, 0, 1]);
    Some(q)
}

/// The A and AAAA records of an answer. CNAME chains are followed by the server.
fn parse(m: &[u8], id: u16) -> Option<Vec<IpAddr>> {
    let u16at = |i: usize| Some(u16::from_be_bytes([*m.get(i)?, *m.get(i + 1)?]));
    if u16at(0)? != id || m.get(3)? & 0x0f != 0 {
        return None;
    }
    let mut i = 12;
    for _ in 0..u16at(4)? {
        i = skip_name(m, i)? + 4;
    }
    let mut ips = vec![];
    for _ in 0..u16at(6)? {
        i = skip_name(m, i)?;
        let (rtype, len) = (u16at(i)?, u16at(i + 8)? as usize);
        let data = m.get(i + 10..i + 10 + len)?;
        match (rtype, len) {
            (A, 4) => ips.push(IpAddr::from(<[u8; 4]>::try_from(data).ok()?)),
            (AAAA, 16) => ips.push(IpAddr::from(<[u8; 16]>::try_from(data).ok()?)),
            _ => {}
        }
        i += 10 + len;
    }
    Some(ips)
}

fn skip_name(m: &[u8], mut i: usize) -> Option<usize> {
    loop {
        match *m.get(i)? {
            0 => return Some(i + 1),
            l if l & 0xc0 == 0xc0 => return Some(i + 2),
            l => i += 1 + l as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_cname_then_a_answer() {
        let mut m = encode(7, "monitoring.example.fr", A).unwrap();
        m[2] = 0x81; // response
        m[7] = 2; // two answers
        m.extend([0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 2, 0xc0, 12]); // CNAME, compressed
        m.extend([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 10]);
        assert_eq!(parse(&m, 7), Some(vec!["192.0.2.10".parse().unwrap()]));
        assert_eq!(parse(&m, 8), None, "another query's answer");
        m[3] = 3; // NXDOMAIN
        assert_eq!(parse(&m, 7), None);
        assert!(parse(&m[..m.len() - 2], 7).is_none(), "truncated");
        assert!(encode(1, "a..b", A).is_none());
    }
}
