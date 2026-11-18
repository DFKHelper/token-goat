//! `<dataDir>/hook-broken.json`: what was missing or broken the last times a hook call had to leave its first route. Never printed to the host; `token-goat doctor` reads it. Bounded in size, written atomically, and every failure here is swallowed, since a notice must never be the reason a hook call fails.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

pub const FILE_NAME: &str = "hook-broken.json";
/// Entries kept; older ones fall off so the file stays well under [`MAX_BYTES`].
const KEEP: usize = 8;
const MAX_FIELD_CHARS: usize = 120;
const MAX_BYTES: u64 = 4096;

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for `now`, by the civil-from-days algorithm (no date crate).
pub fn iso_utc(now: SystemTime) -> String {
    let ms = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_FIELD_CHARS).collect()
}

/// Folds one event into `previous` (the old file's content, if it parsed).
fn merged(previous: Option<Value>, event: Value, now: &str) -> Value {
    let old = previous.filter(|v| v.get("schema").and_then(Value::as_u64) == Some(1));
    let first = old.as_ref().and_then(|v| v.get("first")).and_then(Value::as_str).unwrap_or(now).to_string();
    let count = old.as_ref().and_then(|v| v.get("count")).and_then(Value::as_u64).unwrap_or(0).saturating_add(1);
    let mut events: Vec<Value> = old.as_ref().and_then(|v| v.get("events")).and_then(Value::as_array).cloned().unwrap_or_default();
    events.push(event);
    let drop = events.len().saturating_sub(KEEP);
    events.drain(..drop);
    json!({ "schema": 1, "first": first, "last": now, "count": count, "events": events })
}

/// Records that `route` could not be used because of `error` at `path` (empty when no one path is to blame).
pub fn record(data_dir: &str, route: &str, path: &str, error: &str) {
    if !probing() {
        let _ = try_record(data_dir, route, path, error);
    }
}

/// The variable the self-tests and `doctor` set on a probe run (`HOOK_PROBE_ENV` in src/stats.ts): a probe's failures are not a live hook's, so it neither writes nor clears the notice.
const PROBE_ENV: &str = "TOKEN_GOAT_HOOK_PROBE";

fn probing() -> bool {
    is_probe(std::env::var(PROBE_ENV).ok().as_deref())
}

fn is_probe(value: Option<&str>) -> bool {
    value == Some("1")
}

fn try_record(data_dir: &str, route: &str, path: &str, error: &str) -> std::io::Result<()> {
    let now = iso_utc(SystemTime::now());
    let file = Path::new(data_dir).join(FILE_NAME);
    let previous = std::fs::metadata(&file).ok().filter(|m| m.len() <= MAX_BYTES).and_then(|_| std::fs::read_to_string(&file).ok()).and_then(|t| serde_json::from_str(&t).ok());
    let event = json!({ "time": now, "route": clip(route), "path": clip(path), "error": clip(error) });
    let text = merged(previous, event, &now).to_string();
    let temp = Path::new(data_dir).join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let written = std::fs::write(&temp, text).and_then(|()| std::fs::rename(&temp, &file));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// [`record`] in this process's own data directory.
pub fn record_current(route: &str, path: &str, error: &str) {
    if let Some(dir) = crate::paths::data_dir() {
        record(&dir, route, path, error);
    }
}

/// A route that needed nothing missing ran clean: the notice no longer describes anything.
pub fn clear(data_dir: &str) {
    if !probing() {
        let _ = std::fs::remove_file(Path::new(data_dir).join(FILE_NAME));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tg-notice-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn iso_utc_matches_known_instants() {
        assert_eq!(iso_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(UNIX_EPOCH + std::time::Duration::from_millis(1_709_164_800_123)), "2024-02-29T00:00:00.123Z");
    }

    #[test]
    fn events_are_counted_bounded_and_cleared() {
        let dir = scratch("bounded");
        let d = dir.to_str().unwrap();
        for i in 0..20 {
            record(d, "node-argv", &format!("/gone/{i}"), &"x".repeat(1000));
        }
        let size = std::fs::metadata(dir.join(FILE_NAME)).unwrap().len();
        assert!(size <= MAX_BYTES, "{size}");
        let value: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(value["count"], 20);
        assert_eq!(value["events"].as_array().unwrap().len(), KEEP);
        assert_eq!(value["events"][KEEP - 1]["path"], "/gone/19");
        clear(d);
        assert!(!dir.join(FILE_NAME).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_value_one_marks_a_probe() {
        assert!(is_probe(Some("1")));
        for other in [None, Some(""), Some("0"), Some("true"), Some("11")] {
            assert!(!is_probe(other), "{other:?}");
        }
    }

    #[test]
    fn an_unwritable_directory_is_swallowed() {
        record("Z:/no/such/dir/for/tg", "pointer", "", "boom");
    }
}
