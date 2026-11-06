//! Finds Node.js apps among running processes, and how each one is run, so that the
//! manager can take over an existing site.
//!
//! The agent runs as root and all of this belongs to users or containers: files are
//! only read, with a size limit, and the binaries found are never executed.

use nyx_proto::NodeApp;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_FILE: u64 = 1 << 20;

/// By binary, not by process name: PM2, Next.js and others rename their process.
pub fn is_node(exe: Option<&Path>, name: &str) -> bool {
    let binary = exe.and_then(Path::file_name).and_then(|n| n.to_str());
    matches!(binary, Some("node" | "nodejs")) || name == "node"
}

/// A regular file of reasonable size: a link to a device or a pipe must not hang the agent.
fn read_file(path: &Path) -> Option<String> {
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    File::open(path).ok()?.take(MAX_FILE).read_to_string(&mut text).ok()?;
    Some(text)
}

fn under(root: &Path, path: &Path) -> PathBuf {
    root.join(path.strip_prefix("/").unwrap_or(path))
}

/// Tools keep their own scripts in folders such as `~/.vscode-server`: those are no sites.
fn hidden(path: &Path) -> bool {
    path.components().filter_map(|c| c.as_os_str().to_str()).any(|c| c.len() > 1 && c.starts_with('.') && c != "..")
}

fn dependency(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "node_modules")
}

/// Nearest folder holding a `package.json`, from `start` upwards.
fn project_of(root: &Path, start: &Path) -> Option<PathBuf> {
    start.ancestors().find(|d| fs::metadata(under(root, &d.join("package.json"))).is_ok()).map(Path::to_path_buf)
}

/// Where the app lives: its script tells more than the working directory, which is
/// `/` for a service without `WorkingDirectory`. A script in `node_modules` is a
/// launcher such as `next` or `npm`, which run from the project.
fn project(root: &Path, cwd: &Path, script: Option<&PathBuf>) -> Option<PathBuf> {
    let script = script.filter(|s| !dependency(s)); // Also leaves out `node_modules/.bin`.
    if script.is_some_and(|s| hidden(s)) || hidden(cwd) || dependency(cwd) {
        return None;
    }
    script.and_then(|s| project_of(root, s)).or_else(|| project_of(root, cwd))
}

/// `(manager, service)` from `/proc/<pid>/cgroup` and `environ`. `None` for a process of
/// a Proxmox container: it shows on the node too, but belongs to the agent inside.
fn runner(cgroup: &str, environ: &[u8]) -> Option<(&'static str, String)> {
    if cgroup.contains("lxc.payload") || cgroup.contains("/lxc/") {
        return None;
    }
    if ["docker", "containerd", "kubepods", "libpod"].iter().any(|c| cgroup.contains(c)) {
        return Some(("docker", String::new()));
    }
    let var = |key: &str| environ.split(|b| *b == 0).find_map(|e| e.strip_prefix(key.as_bytes())?.strip_prefix(b"=")).map(|v| String::from_utf8_lossy(v).to_string());
    if var("pm_id").is_some() {
        return Some(("pm2", var("name").map_or(String::new(), |n| format!("pm2:{n}"))));
    }
    let unit = cgroup.lines().filter_map(|l| l.rsplit(':').next()?.strip_prefix("/system.slice/")).find_map(|p| p.split('/').next()?.strip_suffix(".service").map(|u| format!("{u}.service")));
    Some(unit.map_or(("", String::new()), |u| ("systemd", u)))
}

/// Version managers install to a versioned folder, as in `.nvm/versions/node/v20.11.0/bin/node`.
fn version_in(exe: &Path) -> Option<String> {
    exe.components().rev().filter_map(|c| c.as_os_str().to_str()).find_map(|c| {
        let n = c.strip_prefix('v').unwrap_or(c);
        (n.contains('.') && n.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))).then(|| format!("v{n}"))
    })
}

/// An https remote can hold a token: it must not leave the host.
fn without_credentials(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://").filter(|(s, _)| *s == "http" || *s == "https") else { return url.into() };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    format!("{scheme}://{}/{path}", authority.rsplit('@').next().unwrap_or(authority))
}

fn git_origin(config: &str) -> String {
    let mut origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            origin = line == r#"[remote "origin"]"#;
        } else if let Some((_, value)) = line.split_once('=').filter(|(k, _)| origin && k.trim() == "url") {
            return without_credentials(value.trim());
        }
    }
    String::new()
}

fn git_branch(head: &str) -> String {
    head.trim().strip_prefix("ref: refs/heads/").unwrap_or_default().to_string()
}

/// `(install, build, start)` commands, from the lock file and the scripts it declares.
fn commands(root: &Path, dir: &Path, pkg: &Value, script: Option<&PathBuf>) -> (String, String, String) {
    let locked = |file: &str| fs::metadata(under(root, &dir.join(file))).is_ok();
    let (pm, install) = if locked("pnpm-lock.yaml") {
        ("pnpm", "pnpm install --frozen-lockfile")
    } else if locked("yarn.lock") {
        ("yarn", "yarn install --frozen-lockfile")
    } else if locked("package-lock.json") {
        ("npm", "npm ci")
    } else {
        ("npm", "npm install")
    };
    let build = if pkg["scripts"]["build"].is_string() { format!("{pm} run build") } else { String::new() };
    let file = script.filter(|s| !dependency(s)).and_then(|s| s.strip_prefix(dir).ok()).filter(|s| !s.as_os_str().is_empty() && fs::metadata(under(root, &dir.join(s))).is_ok());
    let start = match file {
        _ if pkg["scripts"]["start"].is_string() => format!("{pm} start"),
        Some(f) => format!("node {}", f.display()),
        None => String::new(),
    };
    (install.into(), build, start)
}

/// What can be told about one Node.js process, or `None` when it is not a site.
pub fn inspect(pid: u32, cwd: &Path, exe: Option<&Path>, args: &[String], user: &str, system_version: &str) -> Option<NodeApp> {
    let proc_dir = PathBuf::from(format!("/proc/{pid}"));
    let cgroup = read_file(&proc_dir.join("cgroup")).unwrap_or_default();
    let environ = fs::read(proc_dir.join("environ")).unwrap_or_default();
    // Through /proc: a container sees other files at the same path.
    describe(&proc_dir.join("root"), cwd, exe, args, user, system_version, &cgroup, &environ)
}

#[allow(clippy::too_many_arguments)]
fn describe(root: &Path, cwd: &Path, exe: Option<&Path>, args: &[String], user: &str, system_version: &str, cgroup: &str, environ: &[u8]) -> Option<NodeApp> {
    let (manager, service) = runner(cgroup, environ)?;
    let script = args.iter().skip(1).find(|a| !a.starts_with('-')).map(|a| cwd.join(a));
    let dir = project(root, cwd, script.as_ref())?;
    let pkg: Value = serde_json::from_str(&read_file(&under(root, &dir.join("package.json")))?).ok()?;
    let name = pkg["name"].as_str().map_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().to_string(), str::to_string);
    let (install_cmd, build_cmd, start_cmd) = commands(root, &dir, &pkg, script.as_ref());
    let git = |file: &str| read_file(&under(root, &dir.join(".git").join(file))).unwrap_or_default();
    Some(NodeApp {
        name,
        path: dir.to_string_lossy().to_string(),
        pid: 0, // A restart is not a new app: change detection must not see the PID.
        version: exe.and_then(version_in).unwrap_or_else(|| system_version.to_string()),
        repo: git_origin(&git("config")),
        branch: git_branch(&git("HEAD")),
        user: user.to_string(),
        manager: manager.to_string(),
        service,
        install_cmd,
        build_cmd,
        start_cmd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVICE: &str = "0::/system.slice/shop.service\n";

    /// A project on disk, in `/srv/shop` below a temporary root.
    fn fixture(tag: &str, package: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nyx-node-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("srv/shop");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::write(dir.join("package.json"), package).unwrap();
        fs::write(dir.join("dist/main.js"), "").unwrap();
        root
    }

    fn app(root: &Path, cwd: &str, args: &[&str], cgroup: &str, environ: &[u8]) -> Option<NodeApp> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        describe(root, Path::new(cwd), Some(Path::new("/usr/bin/node")), &args, "web", "v22.1.0", cgroup, environ)
    }

    #[test]
    fn a_systemd_service_without_working_directory_is_found_from_its_script() {
        let root = fixture("service", r#"{"name":"shop","scripts":{"build":"tsc"}}"#);
        fs::write(root.join("srv/shop/pnpm-lock.yaml"), "").unwrap();
        fs::write(root.join("srv/shop/.git/config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://bot:s3cret@git.example.org/me/shop.git\n").unwrap();
        fs::write(root.join("srv/shop/.git/HEAD"), "ref: refs/heads/prod\n").unwrap();
        let a = app(&root, "/", &["node", "--enable-source-maps", "/srv/shop/dist/main.js"], SERVICE, b"").unwrap();
        assert_eq!((a.name.as_str(), a.path.as_str(), a.version.as_str(), a.user.as_str()), ("shop", "/srv/shop", "v22.1.0", "web"));
        assert_eq!((a.manager.as_str(), a.service.as_str()), ("systemd", "shop.service"));
        assert_eq!((a.repo.as_str(), a.branch.as_str()), ("https://git.example.org/me/shop.git", "prod"));
        assert_eq!((a.install_cmd.as_str(), a.build_cmd.as_str(), a.start_cmd.as_str()), ("pnpm install --frozen-lockfile", "pnpm run build", "node dist/main.js"));
    }

    #[test]
    fn renamed_processes_run_from_their_project() {
        let root = fixture("next", r#"{"scripts":{"start":"next start"}}"#);
        let a = app(&root, "/srv/shop", &["next-server", "(v14.2.3)"], "0::/user.slice/user-1000.slice/session-3.scope\n", b"").unwrap();
        assert_eq!((a.name.as_str(), a.manager.as_str(), a.start_cmd.as_str(), a.install_cmd.as_str()), ("shop", "", "npm start", "npm install"));
        let launcher = app(&root, "/srv/shop/dist", &["node", "/srv/shop/node_modules/.bin/next", "start"], SERVICE, b"").unwrap();
        assert_eq!(launcher.path, "/srv/shop");
    }

    #[test]
    fn pm2_apps_restart_through_pm2() {
        let root = fixture("pm2", "{}");
        let a = app(&root, "/srv/shop", &["node", "dist/main.js"], "0::/system.slice/pm2-root.service\n", b"HOME=/root\0pm_id=0\0name=shop-api\0").unwrap();
        assert_eq!((a.manager.as_str(), a.service.as_str(), a.name.as_str()), ("pm2", "pm2:shop-api", "shop"));
    }

    #[test]
    fn tools_and_guests_are_no_sites() {
        let root = fixture("tools", "{}");
        assert!(app(&root, "/srv/shop", &["node", "/home/me/.vscode-server/server.js"], SERVICE, b"").is_none());
        assert!(app(&root, "/usr/lib/node_modules/pm2", &["node", "x"], SERVICE, b"").is_none());
        assert!(app(&root, "/srv/shop", &["node", "x"], "0::/lxc.payload.101/system.slice/a.service\n", b"").is_none());
        assert!(app(&root, "/tmp", &["node"], SERVICE, b"").is_none());
        assert_eq!(app(&root, "/srv/shop", &["node", "x"], "0::/system.slice/docker-ab12.scope\n", b"").unwrap().manager, "docker");
    }

    #[test]
    fn versions_come_from_the_install_folder() {
        assert_eq!(version_in(Path::new("/home/a/.nvm/versions/node/v20.11.0/bin/node")).as_deref(), Some("v20.11.0"));
        assert_eq!(version_in(Path::new("/opt/volta/tools/image/node/20.1.0/bin/node")).as_deref(), Some("v20.1.0"));
        assert_eq!(version_in(Path::new("/usr/bin/node")), None);
    }

    #[test]
    fn credentials_stay_on_the_host() {
        assert_eq!(without_credentials("https://u:p@h.org/a.git"), "https://h.org/a.git");
        assert_eq!(without_credentials("https://h.org/a.git"), "https://h.org/a.git");
        assert_eq!(without_credentials("git@github.com:me/a.git"), "git@github.com:me/a.git");
        assert_eq!(without_credentials("ssh://git@h.org/a.git"), "ssh://git@h.org/a.git");
        assert_eq!(git_origin("[remote \"upstream\"]\n\turl = x\n"), "");
    }

    #[test]
    fn only_the_real_binary_or_name_counts() {
        assert!(is_node(Some(Path::new("/home/a/.nvm/versions/node/v20.11.0/bin/node")), "next-server (v14"));
        assert!(is_node(None, "node") && !is_node(Some(Path::new("/usr/bin/python3")), "python3"));
    }
}
