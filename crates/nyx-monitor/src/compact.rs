//! Keeps long history light: five-minute rollups older than a week become one
//! row per hour, which charts over such ranges could not show in finer detail
//! anyway. A host then costs about 10 000 rows for a year instead of 105 000, so a
//! year takes about what a month took at full detail.
//!
//! PocketBase has no aggregation API, so this reads one hour at a time. Each merged
//! row and the deletion of its sources land in the same transaction: an interrupted
//! run leaves every series either merged or untouched, and the next one continues.

use chrono::{DateTime, Duration, Utc};
use nyx_srv::{pb::Pb, pb_date, pb_quote};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const RAW_DAYS: i64 = 7;
/// Well under the 500 requests of a PocketBase batch, whose chunks must not split a series.
const BATCH: usize = 400;

pub struct Tier {
    coll: &'static str,
    key: &'static str,
    avg: &'static [&'static str],
    /// Averaged without zeros, which mean "no reading": a failed probe has no latency.
    readings: &'static [&'static str],
    sum: &'static [&'static str],
}

pub const TIERS: [Tier; 3] = [
    Tier { coll: "rollups", key: "host", avg: &["cpu", "mem", "disk", "temp", "rx", "tx"], readings: &[], sum: &[] },
    Tier { coll: "probe_rollups", key: "probe", avg: &[], readings: &["latency_ms"], sum: &["up", "total"] },
    Tier { coll: "power_samples", key: "plug", avg: &["watts"], readings: &[], sum: &[] },
];

fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let (sum, n) = values.fold((0.0, 0.0), |a, v| (a.0 + v, a.1 + 1.0));
    if n > 0.0 { sum / n } else { 0.0 }
}

/// SNMP values by label. A label missing from some rows is averaged over the others.
fn merge_values(rows: &[&Value]) -> Map<String, Value> {
    let mut seen: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for (label, v) in rows.iter().filter_map(|r| r["values"].as_object()).flatten() {
        if let Some(v) = v.as_f64() {
            seen.entry(label).or_default().push(v);
        }
    }
    seen.into_iter().map(|(label, v)| (label.to_string(), json!(mean(v.into_iter())))).collect()
}

/// The requests that turn the rows of one hour into one row per series.
fn merge(tier: &Tier, hour: &str, rows: &[Value]) -> Vec<Vec<Value>> {
    let mut series: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for r in rows {
        series.entry(r[tier.key].as_str().unwrap_or_default()).or_default().push(r);
    }
    series.into_iter().map(|(id, rows)| {
        let number = |r: &&Value, k: &str| r[k].as_f64().unwrap_or(0.0);
        let mut body = json!({tier.key: id, "t": hour, "n": rows.len()});
        for k in tier.avg {
            body[*k] = json!(mean(rows.iter().map(|r| number(r, k))));
        }
        for k in tier.readings {
            body[*k] = json!(mean(rows.iter().map(|r| number(r, k)).filter(|v| *v != 0.0)));
        }
        for k in tier.sum {
            body[*k] = json!(rows.iter().map(|r| number(r, k)).sum::<f64>());
        }
        if tier.coll == "probe_rollups" {
            body["values"] = Value::Object(merge_values(&rows));
        }
        let records = format!("/api/collections/{}/records", tier.coll);
        let mut reqs = vec![json!({"method": "POST", "url": records, "body": body})];
        reqs.extend(rows.iter().map(|r| json!({"method": "DELETE", "url": format!("{records}/{}", r["id"].as_str().unwrap_or_default())})));
        reqs
    }).collect()
}

fn hour_of(t: &str) -> Option<DateTime<Utc>> {
    let start = format!("{}:00:00Z", t.get(..13)?.replacen(' ', "T", 1));
    Some(DateTime::parse_from_rfc3339(&start).ok()?.to_utc())
}

pub async fn compact(pb: &Pb, tier: &Tier, now: DateTime<Utc>) -> anyhow::Result<()> {
    // Whole hours only: the cut must not split the rows of one.
    let cut = hour_of(&pb_date(now - Duration::days(RAW_DAYS))).unwrap_or(now);
    let raw = format!("n = 0 && t < {}", pb_quote(&pb_date(cut)));
    loop {
        let oldest = pb.list_page(tier.coll, &[("filter", &raw), ("sort", "t"), ("fields", "t"), ("perPage", "1"), ("skipTotal", "1")]).await?;
        let Some(hour) = oldest["items"][0]["t"].as_str().and_then(hour_of) else { return Ok(()) };
        let start = pb_date(hour);
        let filter = format!("n = 0 && t >= {} && t < {}", pb_quote(&start), pb_quote(&pb_date(hour + Duration::hours(1))));
        let rows = pb.list(tier.coll, &filter, "").await?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut pending = vec![];
        for series in merge(tier, &start, &rows) {
            pending.extend(series);
            if pending.len() >= BATCH {
                pb.batch(std::mem::take(&mut pending)).await?;
            }
        }
        pb.batch(pending).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_hour_of_host_rows_becomes_one_row_and_deletes_its_sources() {
        let rows = [json!({"id": "a", "host": "h", "cpu": 10.0, "mem": 40.0}), json!({"id": "b", "host": "h", "cpu": 30.0, "mem": 60.0}), json!({"id": "c", "host": "other", "cpu": 5.0})];
        let groups = merge(&TIERS[0], "2026-01-01 10:00:00.000Z", &rows);
        assert_eq!(groups.len(), 2, "one transaction per series");
        let h = &groups[0];
        assert_eq!((h[0]["body"]["cpu"].as_f64(), h[0]["body"]["mem"].as_f64(), h[0]["body"]["n"].as_u64()), (Some(20.0), Some(50.0), Some(2)));
        assert_eq!(h[0]["body"]["t"], "2026-01-01 10:00:00.000Z");
        assert_eq!(h.iter().filter(|r| r["method"] == "DELETE").count(), 2);
        assert_eq!(h[1]["url"], "/api/collections/rollups/records/a");
    }

    #[test]
    fn probes_sum_checks_and_failed_rows_do_not_drag_latency_down() {
        let rows = [
            json!({"id": "a", "probe": "p", "up": 5, "total": 5, "latency_ms": 20.0, "values": {"charge": 90.0, "text": "x"}}),
            json!({"id": "b", "probe": "p", "up": 0, "total": 5, "latency_ms": 0.0, "values": {"charge": 70.0, "load": 3.0}}),
        ];
        let merged = &merge(&TIERS[1], "2026-01-01 10:00:00.000Z", &rows)[0][0]["body"];
        assert_eq!((merged["up"].as_f64(), merged["total"].as_f64()), (Some(5.0), Some(10.0)));
        assert_eq!(merged["latency_ms"].as_f64(), Some(20.0));
        assert_eq!(merged["values"], json!({"charge": 80.0, "load": 3.0}));
    }

    #[test]
    fn a_probe_that_only_failed_has_no_latency_rather_than_a_division_error() {
        let rows = [json!({"id": "a", "probe": "p", "up": 0, "total": 5, "latency_ms": 0.0})];
        assert_eq!(merge(&TIERS[1], "h", &rows)[0][0]["body"]["latency_ms"].as_f64(), Some(0.0));
    }

    #[test]
    fn hours_start_on_the_hour() {
        assert_eq!(hour_of("2026-01-01 10:35:12.123Z").map(pb_date).as_deref(), Some("2026-01-01 10:00:00.000Z"));
        assert_eq!(hour_of("bad"), None);
    }
}
