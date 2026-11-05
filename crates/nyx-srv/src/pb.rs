//! Minimal PocketBase REST client, authenticated as superuser. Collections have
//! null API rules, so this process is the only thing that can reach the data.

use anyhow::{anyhow, bail, Context};
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::RwLock;

pub struct Pb {
    http: Client,
    url: String,
    email: String,
    password: String,
    token: RwLock<String>,
}

/// Quote a value for a PocketBase filter expression.
pub fn pb_quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn prune_filter(field: &str, cutoff: DateTime<Utc>) -> String {
    format!("{field} != '' && {field} < {}", pb_quote(&pb_date(cutoff)))
}

/// PocketBase's datetime format.
pub fn pb_date(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.3fZ").to_string()
}

impl Pb {
    /// Waits for PocketBase, which usually starts alongside us.
    pub async fn connect(url: &str, email: &str, password: &str) -> anyhow::Result<Self> {
        let pb = Self {
            http: Client::builder().timeout(Duration::from_secs(30)).build()?,
            url: url.into(),
            email: email.into(),
            password: password.into(),
            token: RwLock::default(),
        };
        let mut last = anyhow!("no attempt");
        for _ in 0..30 {
            match pb.login().await {
                Ok(()) => return Ok(pb),
                Err(e) => last = e,
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Err(last.context(format!("cannot reach PocketBase at {url}")))
    }

    async fn login(&self) -> anyhow::Result<()> {
        let v: Value = self
            .http
            .post(format!("{}/api/collections/_superusers/auth-with-password", self.url))
            .json(&json!({"identity": self.email, "password": self.password}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        *self.token.write().await = v["token"].as_str().context("no token in auth response")?.to_string();
        Ok(())
    }

    async fn send(&self, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> reqwest::Result<reqwest::Response> {
        let mut r = self.http.request(method, format!("{}{path}", self.url)).query(query).header("authorization", self.token.read().await.clone());
        if let Some(b) = body {
            r = r.json(b);
        }
        r.send().await
    }

    pub async fn req(&self, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> anyhow::Result<Value> {
        let mut res = self.send(method.clone(), path, query, body).await?;
        if matches!(res.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            self.login().await?;
            res = self.send(method, path, query, body).await?;
        }
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            bail!("PocketBase {status} on {path}: {text}");
        }
        Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text)? })
    }

    pub async fn list_page(&self, coll: &str, query: &[(&str, &str)]) -> anyhow::Result<Value> {
        self.req(Method::GET, &format!("/api/collections/{coll}/records"), query, None).await
    }

    /// All records matching `filter`, walking pages.
    pub async fn list(&self, coll: &str, filter: &str, sort: &str) -> anyhow::Result<Vec<Value>> {
        let mut out = vec![];
        self.each(coll, filter, sort, "*", |r| out.push(r)).await?;
        Ok(out)
    }

    /// Visit matching records with only one page in memory: long ranges hold
    /// thousands of rows, which must not pile up as JSON values.
    pub async fn each(&self, coll: &str, filter: &str, sort: &str, fields: &str, mut f: impl FnMut(Value)) -> anyhow::Result<()> {
        for page in 1.. {
            let page = page.to_string();
            let mut res = self.list_page(coll, &[("filter", filter), ("sort", sort), ("fields", fields), ("page", &page), ("perPage", "1000"), ("skipTotal", "1")]).await?;
            let Value::Array(items) = res["items"].take() else { bail!("malformed list response") };
            let done = items.len() < 1000;
            items.into_iter().for_each(&mut f);
            if done {
                break;
            }
        }
        Ok(())
    }

    pub async fn first(&self, coll: &str, filter: &str) -> anyhow::Result<Option<Value>> {
        let mut res = self.list_page(coll, &[("filter", filter), ("perPage", "1"), ("skipTotal", "1")]).await?;
        Ok(res["items"].as_array_mut().and_then(|a| (!a.is_empty()).then(|| a.remove(0))))
    }

    pub async fn get(&self, coll: &str, id: &str) -> anyhow::Result<Value> {
        self.req(Method::GET, &format!("/api/collections/{coll}/records/{id}"), &[], None).await
    }

    pub async fn create(&self, coll: &str, body: &Value) -> anyhow::Result<Value> {
        self.req(Method::POST, &format!("/api/collections/{coll}/records"), &[], Some(body)).await
    }

    pub async fn update(&self, coll: &str, id: &str, body: &Value) -> anyhow::Result<Value> {
        self.req(Method::PATCH, &format!("/api/collections/{coll}/records/{id}"), &[], Some(body)).await
    }

    pub async fn delete(&self, coll: &str, id: &str) -> anyhow::Result<()> {
        self.req(Method::DELETE, &format!("/api/collections/{coll}/records/{id}"), &[], None).await.map(drop)
    }

    /// One transaction, one fsync: the reason rollups stay cheap on disk.
    pub async fn batch(&self, requests: Vec<Value>) -> anyhow::Result<()> {
        for chunk in requests.chunks(500) {
            self.req(Method::POST, "/api/batch", &[], Some(&json!({"requests": chunk}))).await?;
        }
        Ok(())
    }

    /// Delete records whose `field` is older than `cutoff`. An empty date means
    /// "not happened yet", and must not match: `''` sorts before every date.
    pub async fn prune(&self, coll: &str, field: &str, cutoff: DateTime<Utc>) -> anyhow::Result<()> {
        let filter = prune_filter(field, cutoff);
        // One batch at a time, so that lowering the retention of a large base does
        // not hold every deletion in memory. Page 1 is always the next batch.
        loop {
            let mut res = self.list_page(coll, &[("filter", &filter), ("sort", field), ("fields", "id"), ("perPage", "500"), ("skipTotal", "1")]).await?;
            let Value::Array(old) = res["items"].take() else { bail!("malformed list response") };
            if old.is_empty() {
                return Ok(());
            }
            let reqs = old.iter().map(|r| json!({"method": "DELETE", "url": format!("/api/collections/{coll}/records/{}", r["id"].as_str().unwrap_or_default())})).collect();
            self.batch(reqs).await?;
        }
    }

    pub async fn setting(&self, key: &str) -> anyhow::Result<Option<Value>> {
        Ok(self.first("settings", &format!("key = {}", pb_quote(key))).await?.map(|mut r| r["value"].take()))
    }

    pub async fn set_setting(&self, key: &str, value: &Value) -> anyhow::Result<()> {
        match self.first("settings", &format!("key = {}", pb_quote(key))).await? {
            Some(r) => self.update("settings", r["id"].as_str().unwrap_or_default(), &json!({"value": value})).await.map(drop),
            None => self.create("settings", &json!({"key": key, "value": value})).await.map(drop),
        }
    }

    /// Log in a dashboard user; returns the PocketBase record.
    pub async fn user_login(&self, email: &str, password: &str) -> anyhow::Result<Value> {
        let res = self
            .http
            .post(format!("{}/api/collections/users/auth-with-password", self.url))
            .json(&json!({"identity": email, "password": password}))
            .send()
            .await?
            .error_for_status()?;
        Ok(res.json::<Value>().await?["record"].take())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_values_cannot_escape_their_quotes() {
        assert_eq!(pb_quote(r"a'b\"), r"'a\'b\\'");
    }

    #[test]
    fn prune_never_matches_empty_dates() {
        let t = DateTime::parse_from_rfc3339("2026-11-05T10:00:00Z").unwrap().to_utc();
        assert!(prune_filter("resolved_at", t).starts_with("resolved_at != '' && "));
    }

    #[test]
    fn dates_use_the_pocketbase_format() {
        let t = DateTime::parse_from_rfc3339("2026-11-05T10:00:01.5Z").unwrap().to_utc();
        assert_eq!(pb_date(t), "2026-11-05 10:00:01.500Z");
    }
}
