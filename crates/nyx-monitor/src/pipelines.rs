//! CI/CD pipelines: the latest run of a branch on GitHub, GitLab, Forgejo or Gitea.
//!
//! One request per pipeline every [`EVERY_S`] seconds, which stays far under the
//! unauthenticated rate limit of the forges. A failed run opens an alert that only a
//! passing run closes: a run in progress or a cancelled one proves nothing.

use crate::state::{App, Wanted};
use anyhow::{bail, Context};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::task::JoinSet;

pub const EVERY_S: u64 = 120;
/// Runs kept per pipeline, for the history views.
const HISTORY: usize = 12;
/// The reload endpoint and the loop must not reconcile alerts at the same time.
static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone)]
pub struct Def {
    pub id: String,
    pub name: String,
    pub provider: String,
    /// Server address; empty means github.com or gitlab.com.
    pub url: String,
    pub repo: String,
    pub branch: String,
    pub token: String,
}

#[derive(Clone)]
pub struct Run {
    /// `ok`, `crit`, `info` (in progress) or `off` (cancelled, skipped, unknown).
    pub state: &'static str,
    /// The forge's own word, e.g. `success`.
    pub status: String,
    pub url: String,
    pub sha: String,
    pub at: String,
}

pub struct Live {
    pub def: Def,
    /// Newest first.
    pub runs: Vec<Run>,
    /// Outcome of the last run that ended with a verdict (`ok` or `crit`).
    pub finished: Option<&'static str>,
    pub error: String,
}

impl Live {
    pub fn new(def: Def) -> Self {
        Self { def, runs: vec![], finished: None, error: String::new() }
    }

    pub fn latest(&self) -> Option<&Run> {
        self.runs.first()
    }

    fn record(&mut self, res: anyhow::Result<Vec<Run>>) {
        match res {
            Ok(runs) => {
                self.error.clear();
                // Not the newest run: one in progress or cancelled has no verdict yet.
                self.finished = runs.iter().find(|r| matches!(r.state, "ok" | "crit")).map(|r| r.state);
                self.runs = runs;
            }
            Err(e) => self.error = format!("{e:#}"),
        }
    }

    /// For the signed-in UI and the linked manager.
    pub fn to_json(&self) -> Value {
        let d = &self.def;
        let r = self.latest();
        let runs: Vec<Value> = self.runs.iter().map(|r| json!({"state": r.state, "status": r.status, "sha": r.sha.get(..7).unwrap_or(&r.sha), "at": r.at, "url": r.url})).collect();
        json!({"id": d.id, "name": d.name, "provider": d.provider, "repo": d.repo, "branch": d.branch,
            "state": r.map_or("off", |r| r.state), "status": r.map_or("", |r| r.status.as_str()), "url": r.map_or("", |r| r.url.as_str()),
            "sha": r.map_or("", |r| r.sha.get(..7).unwrap_or(&r.sha)), "at": r.map_or("", |r| r.at.as_str()), "error": self.error, "runs": runs})
    }
}

pub fn parse_def(r: &Value) -> Def {
    let s = |k: &str| r[k].as_str().unwrap_or_default().trim().to_string();
    Def { id: s("id"), name: s("name"), provider: s("provider"), url: s("url").trim_end_matches('/').to_string(), repo: s("repo").trim_matches('/').to_string(), branch: s("branch"), token: s("token") }
}

fn classify(raw: &str) -> &'static str {
    match raw {
        "success" | "passed" => "ok",
        "failure" | "failed" | "timed_out" | "error" | "startup_failure" => "crit",
        "running" | "in_progress" | "queued" | "pending" | "waiting" | "created" | "preparing" | "scheduled" | "scheduling" | "requested" | "blocked" | "waiting_for_resource" => "info",
        _ => "off",
    }
}

/// The runs in a forge's answer, newest first. GitHub and Gitea share a shape: a `conclusion`
/// once the run has ended, a `status` before that. GitLab only has a `status`.
fn parse(provider: &str, body: &Value) -> Vec<Run> {
    let runs = if provider == "gitlab" { body.as_array() } else { body["workflow_runs"].as_array() };
    runs.into_iter().flatten().take(HISTORY).map(|run| {
        let text = |k: &str| run[k].as_str().filter(|s| !s.is_empty());
        let status = text("conclusion").or(text("status")).unwrap_or("unknown");
        Run {
            state: classify(status),
            status: status.into(),
            url: text("html_url").or(text("web_url")).unwrap_or_default().into(),
            sha: text("head_sha").or(text("sha")).unwrap_or_default().into(),
            at: text("updated_at").or(text("created_at")).unwrap_or_default().into(),
        }
    }).collect()
}

/// Address and query of the "latest run" call. The repository ends up in the path, so
/// only what a repository path is made of may pass.
fn endpoint(d: &Def) -> anyhow::Result<(String, Vec<(&'static str, String)>)> {
    if d.repo.is_empty() || d.repo.contains("..") || !d.repo.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c)) {
        bail!("The repository must look like owner/name.");
    }
    let (base, branch) = (d.url.as_str(), d.branch.clone());
    let (url, query) = match d.provider.as_str() {
        "github" => (format!("{}/repos/{}/actions/runs", if base.is_empty() { "https://api.github.com".into() } else { format!("{base}/api/v3") }, d.repo), ("branch", "per_page")),
        "gitlab" => (format!("{}/api/v4/projects/{}/pipelines", if base.is_empty() { "https://gitlab.com" } else { base }, d.repo.replace('/', "%2F")), ("ref", "per_page")),
        "gitea" | "forgejo" if !base.is_empty() => (format!("{base}/api/v1/repos/{}/actions/runs", d.repo), ("branch", "limit")),
        "gitea" | "forgejo" => bail!("Give the address of your {} server.", d.provider),
        other => bail!("Unknown provider {other}."),
    };
    let mut q = vec![(query.1, HISTORY.to_string())];
    if !branch.is_empty() {
        q.push((query.0, branch));
    }
    Ok((url, q))
}

async fn fetch(http: &reqwest::Client, d: &Def) -> anyhow::Result<Vec<Run>> {
    let (url, query) = endpoint(d)?;
    let mut req = http.get(url).query(&query).header("accept", "application/json").header("user-agent", "nyx-monitor");
    if !d.token.is_empty() {
        req = if d.provider == "gitlab" { req.header("private-token", &d.token) } else { req.header("authorization", format!("token {}", d.token)) };
    }
    let res = req.send().await.context("cannot reach the server")?;
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => bail!("The server refused the token, or the rate limit is reached."),
        404 => bail!("Repository not found, or the token cannot see it. Forgejo and Gitea also need Actions turned on."),
        s => bail!("The server answered with status {s}."),
    }
    Ok(parse(&d.provider, &res.json().await.context("unexpected answer")?))
}

fn alerts(st: &crate::state::State) -> Vec<Wanted> {
    st.pipelines
        .values()
        .filter_map(|p| {
            let key = format!("pipeline:{}", p.def.id);
            let branch = if p.def.branch.is_empty() { String::new() } else { format!(" on {}", p.def.branch) };
            match p.finished {
                Some("crit") => Some(Wanted { key, kind: "pipeline", severity: "crit", message: format!("Pipeline {} failed{branch}", p.def.name), host: p.def.repo.clone() }),
                // Not known yet after a restart or while the forge is down: keep what is open.
                None => st.alerts.get(&key).map(|a| Wanted { key, kind: "pipeline", severity: "crit", message: a.message.clone(), host: p.def.repo.clone() }),
                _ => None,
            }
        })
        .collect()
}

/// Sync the followed pipelines with the collection, ask each forge, and settle the alerts.
pub async fn tick(app: &Arc<App>) -> anyhow::Result<()> {
    let _one = BUSY.lock().await;
    let defs: Vec<Def> = app.core.pb.list("pipelines", "enabled = true", "").await?.iter().map(parse_def).collect();
    {
        let mut st = app.lock();
        st.pipelines.retain(|id, _| defs.iter().any(|d| d.id == *id));
        for d in &defs {
            match st.pipelines.get_mut(&d.id) {
                Some(p) => p.def = d.clone(),
                None => drop(st.pipelines.insert(d.id.clone(), Live::new(d.clone()))),
            }
        }
    }
    let mut set = JoinSet::new();
    for d in defs {
        let http = app.http.clone();
        set.spawn(async move { (d.id.clone(), fetch(&http, &d).await) });
    }
    while let Some(Ok((id, res))) = set.join_next().await {
        if let Some(p) = app.lock().pipelines.get_mut(&id) {
            p.record(res);
        }
    }
    let wanted = alerts(&app.lock());
    app.reconcile("pipeline:", wanted).await
}

pub fn snapshot(app: &App) -> Vec<Value> {
    let st = app.lock();
    let mut v: Vec<&Live> = st.pipelines.values().collect();
    v.sort_by(|a, b| a.def.name.cmp(&b.def.name));
    v.iter().map(|p| p.to_json()).collect()
}

/// What an anonymous status page may learn: a name, a branch and a verdict.
pub fn public(st: &crate::state::State) -> Value {
    let mut v: Vec<&Live> = st.pipelines.values().collect();
    v.sort_by(|a, b| a.def.name.cmp(&b.def.name));
    json!(v.iter().map(|p| {
        let r = p.latest();
        json!({"label": p.def.name, "branch": p.def.branch, "state": r.map_or("off", |r| r.state), "status": r.map_or("", |r| r.status.as_str()),
            "at": r.map_or("", |r| r.at.as_str()), "runs": p.runs.iter().map(|r| r.state).collect::<Vec<_>>()})
    }).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(provider: &str, url: &str, repo: &str, branch: &str) -> Def {
        Def { id: "p".into(), name: "site".into(), provider: provider.into(), url: url.into(), repo: repo.into(), branch: branch.into(), token: String::new() }
    }

    #[test]
    fn each_forge_gets_its_own_call() {
        let (u, q) = endpoint(&def("github", "", "me/site", "main")).unwrap();
        assert_eq!((u.as_str(), q), ("https://api.github.com/repos/me/site/actions/runs", vec![("per_page", "12".into()), ("branch", "main".into())]));
        assert_eq!(endpoint(&def("github", "https://ghe.lan", "me/site", "")).unwrap().0, "https://ghe.lan/api/v3/repos/me/site/actions/runs");
        let (u, q) = endpoint(&def("gitlab", "", "group/sub/site", "dev")).unwrap();
        assert_eq!((u.as_str(), q[1].0), ("https://gitlab.com/api/v4/projects/group%2Fsub%2Fsite/pipelines", "ref"));
        assert_eq!(endpoint(&def("forgejo", "https://git.lan", "me/site", "")).unwrap().0, "https://git.lan/api/v1/repos/me/site/actions/runs");
        assert!(endpoint(&def("gitea", "", "me/site", "")).is_err());
    }

    #[test]
    fn a_repository_cannot_leave_its_path() {
        for bad in ["", "../x", "me/site?x=1", "me/site#a", "me site", "me\\site"] {
            assert!(endpoint(&def("github", "", bad, "")).is_err(), "{bad}");
        }
    }

    #[test]
    fn runs_are_read_whatever_the_forge() {
        let gh = parse("github", &json!({"workflow_runs": [{"status": "completed", "conclusion": "failure", "html_url": "u", "head_sha": "abcdef123", "updated_at": "t"}]})).remove(0);
        assert_eq!((gh.state, gh.status.as_str(), gh.sha.as_str()), ("crit", "failure", "abcdef123"));
        assert_eq!(parse("github", &json!({"workflow_runs": [{"status": "in_progress", "conclusion": null}]}))[0].state, "info");
        assert_eq!(parse("gitea", &json!({"workflow_runs": [{"status": "success", "conclusion": ""}]}))[0].state, "ok");
        let gl = &parse("gitlab", &json!([{"status": "failed", "web_url": "w", "sha": "s"}, {"status": "success"}]));
        assert_eq!((gl[0].state, gl[0].url.as_str(), gl.len()), ("crit", "w", 2));
        assert_eq!(parse("gitlab", &json!([{"status": "canceled"}]))[0].state, "off");
        assert!(parse("github", &json!({"workflow_runs": []})).is_empty());
        assert_eq!(parse("github", &json!({"workflow_runs": vec![json!({"status": "success"}); 30]})).len(), HISTORY);
    }

    #[test]
    fn only_a_verdict_changes_whether_the_pipeline_is_failing() {
        let run = |status: &str| Run { state: classify(status), status: status.into(), url: String::new(), sha: String::new(), at: String::new() };
        let mut p = Live::new(def("github", "", "me/site", "main"));
        p.record(Ok(vec![run("failure")]));
        assert_eq!(p.finished, Some("crit"));
        for newer in ["in_progress", "cancelled"] {
            p.record(Ok(vec![run(newer), run("failure")]));
            assert_eq!(p.finished, Some("crit"), "{newer}");
        }
        p.record(Err(anyhow::anyhow!("down")));
        assert_eq!((p.finished, p.error.as_str(), p.runs.len()), (Some("crit"), "down", 2), "an outage forgets nothing");
        p.record(Ok(vec![run("in_progress"), run("success"), run("failure")]));
        assert_eq!((p.finished, p.error.as_str()), (Some("ok"), ""));
        p.record(Ok(vec![]));
        assert_eq!(p.finished, None);
    }
}
