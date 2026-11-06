//! Disk health from `smartctl -j`, reduced to ok / warn / crit plus remaining life.

use nyx_proto::{Health, SmartDisk};
use serde_json::Value;
use std::process::Command;

const LIFE_CRIT: u8 = 10;
const LIFE_WARN: u8 = 20;
/// ATA attributes whose normalised value is "percent of life left".
const WEAR_ATTRS: [u64; 4] = [231, 233, 177, 202];

fn smartctl(args: &[&str]) -> Option<Value> {
    let out = Command::new("smartctl").args(args).output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

/// `None` when smartctl is missing, so the monitor keeps showing the last state.
pub fn scan() -> Option<Vec<SmartDisk>> {
    let list = smartctl(&["--scan-open", "-j"])?;
    Some(
        list["devices"]
            .as_array()?
            .iter()
            .filter_map(|d| d["name"].as_str())
            // `-n standby` skips sleeping disks instead of spinning them up.
            .filter_map(|dev| smartctl(&["-j", "-a", "-n", "standby", dev]).filter(|j| j["smart_status"].is_object()).map(|j| parse(dev, &j)))
            .collect(),
    )
}

fn attr(json: &Value, id: u64, field: &str) -> Option<u64> {
    json["ata_smart_attributes"]["table"].as_array()?.iter().find(|a| a["id"] == id)?[field].as_u64()
}

pub fn parse(device: &str, j: &Value) -> SmartDisk {
    let nvme = &j["nvme_smart_health_information_log"];
    let life_left_pct = nvme["percentage_used"]
        .as_u64()
        .map(|used| 100u64.saturating_sub(used) as u8)
        .or_else(|| WEAR_ATTRS.iter().find_map(|&id| attr(j, id, "value")).map(|v| v.min(100) as u8));
    let raw = |id| j["ata_smart_attributes"]["table"].as_array()?.iter().find(|a| a["id"] == id)?["raw"]["value"].as_u64();
    let kind = if !nvme.is_null() { "NVMe" } else if j["rotation_rate"].as_u64().is_some_and(|r| r > 0) { "HDD" } else if j["rotation_rate"].is_u64() { "SSD" } else { "" };
    let block = j["logical_block_size"].as_u64().unwrap_or(512);
    // An NVMe data unit is 1000 sectors of 512 bytes, whatever the drive's block size.
    let written_bytes = nvme["data_units_written"].as_u64().map(|u| u * 512_000).or_else(|| raw(241).map(|lbas| lbas * block));
    let bad_sectors = raw(5).unwrap_or(0) + raw(197).unwrap_or(0) + raw(198).unwrap_or(0);
    let critical_warning = nvme["critical_warning"].as_u64().unwrap_or(0);
    let passed = j["smart_status"]["passed"].as_bool().unwrap_or(true);

    let (health, reason) = if !passed {
        (Health::Crit, "SMART self-assessment failed".to_string())
    } else if critical_warning != 0 {
        (Health::Crit, format!("NVMe critical warning {critical_warning}"))
    } else if life_left_pct.is_some_and(|l| l <= LIFE_CRIT) {
        (Health::Crit, format!("{}% life left", life_left_pct.unwrap_or(0)))
    } else if bad_sectors > 0 {
        (Health::Warn, format!("{bad_sectors} bad sectors"))
    } else if life_left_pct.is_some_and(|l| l <= LIFE_WARN) {
        (Health::Warn, format!("{}% life left", life_left_pct.unwrap_or(0)))
    } else {
        (Health::Ok, String::new())
    };

    SmartDisk {
        device: device.to_string(),
        model: j["model_name"].as_str().unwrap_or("unknown").to_string(),
        health,
        life_left_pct,
        temp_c: j["temperature"]["current"].as_i64().map(|t| t as i32),
        power_on_hours: j["power_on_time"]["hours"].as_u64(),
        reason,
        kind: kind.to_string(),
        serial: j["serial_number"].as_str().unwrap_or_default().to_string(),
        capacity: j["user_capacity"]["bytes"].as_u64(),
        bad_sectors,
        power_cycles: j["power_cycle_count"].as_u64(),
        written_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nvme_wear_maps_to_life_left() {
        let j = json!({"model_name":"Samsung 980","smart_status":{"passed":true},"temperature":{"current":38},
            "power_on_time":{"hours":1200},"nvme_smart_health_information_log":{"percentage_used":15,"critical_warning":0}});
        let d = parse("/dev/nvme0", &j);
        assert_eq!((d.health, d.life_left_pct, d.temp_c, d.power_on_hours), (Health::Ok, Some(85), Some(38), Some(1200)));
    }

    #[test]
    fn drive_details_are_read_for_each_kind() {
        let nvme = json!({"smart_status":{"passed":true},"serial_number":"S1","user_capacity":{"bytes":1000},"power_cycle_count":7,
            "nvme_smart_health_information_log":{"percentage_used":1,"data_units_written":2}});
        let d = parse("/dev/nvme0", &nvme);
        assert_eq!((d.kind.as_str(), d.serial.as_str(), d.capacity, d.power_cycles, d.written_bytes), ("NVMe", "S1", Some(1000), Some(7), Some(1_024_000)));
        let table = json!([{"id":241,"value":100,"raw":{"value":10}}]);
        let hdd = parse("/dev/sda", &json!({"smart_status":{"passed":true},"rotation_rate":7200,"logical_block_size":4096,"ata_smart_attributes":{"table":table}}));
        assert_eq!((hdd.kind.as_str(), hdd.written_bytes), ("HDD", Some(40960)));
        assert_eq!(parse("/dev/sdb", &json!({"smart_status":{"passed":true},"rotation_rate":0})).kind, "SSD");
        assert_eq!(parse("/dev/sdc", &json!({"smart_status":{"passed":true}})).kind, "");
    }

    #[test]
    fn nvme_over_100_percent_used_does_not_underflow() {
        let j = json!({"smart_status":{"passed":true},"nvme_smart_health_information_log":{"percentage_used":130}});
        assert_eq!(parse("d", &j).life_left_pct, Some(0));
        assert_eq!(parse("d", &j).health, Health::Crit);
    }

    #[test]
    fn ata_bad_sectors_warn_and_failure_is_critical() {
        let table = json!([{"id":5,"value":100,"raw":{"value":8}},{"id":197,"value":100,"raw":{"value":0}}]);
        let j = json!({"smart_status":{"passed":true},"ata_smart_attributes":{"table":table}});
        let d = parse("/dev/sda", &j);
        assert_eq!((d.health, d.reason.as_str()), (Health::Warn, "8 bad sectors"));
        let j = json!({"smart_status":{"passed":false},"ata_smart_attributes":{"table":table}});
        assert_eq!(parse("/dev/sda", &j).health, Health::Crit);
    }

    #[test]
    fn ssd_life_attribute_thresholds() {
        let at = |v: u64| parse("d", &json!({"smart_status":{"passed":true},
            "ata_smart_attributes":{"table":[{"id":231,"value":v,"raw":{"value":0}}]}})).health;
        assert_eq!((at(90), at(20), at(10)), (Health::Ok, Health::Warn, Health::Crit));
    }
}
