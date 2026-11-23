//! `<dataDir>/hook-broken.json`: what was missing or broken the last times a hook call had to leave its first route. Never printed to the host; `token-goat doctor` reads it. Bounded in size, written atomically, and every failure here is swallowed, since a notice must never be the reason a hook call fails.

use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

pub const FILE_NAME: &str = "hook-broken.json";
/// Entries kept; older ones fall off so the file stays well under [`MAX_BYTES`].
const KEEP: usize = 8;
const MAX_FIELD_CHARS: usize = 120;
const MAX_BYTES: u64 = 4096;
const LOCK_NAME: &str = "hook-broken.json.lock";
/// Lock attempts before an event is dropped; with [`LOCK_PAUSE`] between them the wait stays under the record grace.
const LOCK_ATTEMPTS: u32 = 8;
const LOCK_PAUSE: std::time::Duration = std::time::Duration::from_millis(5);

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

pub(crate) fn probing() -> bool {
    is_probe(std::env::var(PROBE_ENV).ok().as_deref())
}

fn is_probe(value: Option<&str>) -> bool {
    value == Some("1")
}

/// The history as a reader sees it: nothing when the file is absent, over [`MAX_BYTES`] or not JSON.
fn read_history(file: &Path) -> Option<Value> {
    let within_cap = |m: &std::fs::Metadata| m.len() <= MAX_BYTES;
    let size_ok = std::fs::metadata(file).ok().filter(within_cap);
    let text = size_ok.and_then(|_| std::fs::read_to_string(file).ok())?;
    serde_json::from_str(&text).ok()
}

/// The text to write for `value`: the oldest events dropped until it fits [`MAX_BYTES`], so a reader never refuses what a writer wrote.
fn fitted(mut value: Value) -> Option<String> {
    loop {
        let text = value.to_string();
        if text.len() as u64 <= MAX_BYTES {
            return Some(text);
        }
        let events = value.get_mut("events").and_then(Value::as_array_mut)?;
        if events.is_empty() {
            return None;
        }
        events.remove(0);
    }
}

/// An exclusive hold on the history file, released (the lock file removed) when dropped.
struct Lock(std::path::PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Takes the lock by exclusive create of a sibling file holding this pid, trying at most [`LOCK_ATTEMPTS`] times and calling `pause` between tries; a lock whose owner is gone is cleared first. None when it cannot be had.
fn lock(dir: &Path, pause: &mut dyn FnMut()) -> Option<Lock> {
    let path = dir.join(LOCK_NAME);
    for attempt in 0..LOCK_ATTEMPTS {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let held = Lock(path);
                std::io::Write::write_all(&mut file, std::process::id().to_string().as_bytes()).ok()?;
                return Some(held);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if !clear_dead_lock(dir, &path) && attempt + 1 < LOCK_ATTEMPTS {
                    pause();
                }
            }
            Err(_) => return None,
        }
    }
    None
}

/// Removes `path` when the pid it names is gone, by claiming it with a rename first; a lock still held (or unreadable) is put back. True when it removed one.
fn clear_dead_lock(dir: &Path, path: &Path) -> bool {
    let claimed = dir.join(format!("{LOCK_NAME}.{}.claim", std::process::id()));
    if std::fs::rename(path, &claimed).is_err() {
        return false;
    }
    let owner = std::fs::read_to_string(&claimed).ok().and_then(|t| t.trim().parse::<u32>().ok());
    if owner.is_some_and(|pid| crate::sys::process_alive(pid) == Some(false)) {
        let _ = std::fs::remove_file(&claimed);
        return true;
    }
    // limit: a taker can create the lock in the instant it is vacated; revisit-when: events go missing under load
    let _ = std::fs::hard_link(&claimed, path);
    let _ = std::fs::remove_file(&claimed);
    false
}

/// Replaces the history with what `change` makes of it, under the lock; an error when the lock cannot be had or the write fails, and the file is then left as it was.
fn update<F>(data_dir: &str, pause: &mut dyn FnMut(), change: F) -> io::Result<()>
where
    F: FnOnce(Option<Value>) -> Option<Value>,
{
    let dir = Path::new(data_dir);
    let file = dir.join(FILE_NAME);
    let busy = || std::io::Error::new(std::io::ErrorKind::WouldBlock, "history lock not taken");
    let _held = lock(dir, pause).ok_or_else(busy)?;
    match change(read_history(&file)) {
        None => match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
        Some(value) => {
            let text = fitted(value).ok_or_else(|| std::io::Error::other("event larger than the cap"))?;
            let temp = dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
            let written = std::fs::write(&temp, text).and_then(|()| std::fs::rename(&temp, &file));
            if written.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            written
        }
    }
}

fn try_record(data_dir: &str, route: &str, path: &str, error: &str) -> std::io::Result<()> {
    let now = iso_utc(SystemTime::now());
    let event = json!({ "time": now, "route": clip(route), "path": clip(path), "error": clip(error) });
    update(data_dir, &mut || std::thread::sleep(LOCK_PAUSE), |previous| Some(merged(previous, event, &now)))
}

/// [`record`] in this process's own data directory.
pub fn record_current(route: &str, path: &str, error: &str) {
    if let Some(dir) = crate::paths::data_dir() {
        record(&dir, route, path, error);
    }
}

/// A route that needed nothing missing ran clean: the events from before `began` (an [`iso_utc`] stamp of when the call started) no longer describe anything. Events stamped at or after it stay.
pub fn clear(data_dir: &str, began: &str) {
    if !probing() {
        let _ = update(data_dir, &mut || std::thread::sleep(LOCK_PAUSE), |previous| unseen(previous, began));
    }
}

/// What of `previous` is not older than `began`, rebuilt; None when nothing is left or the file was not a history.
fn unseen(previous: Option<Value>, began: &str) -> Option<Value> {
    let old = previous.filter(|v| v.get("schema").and_then(Value::as_u64) == Some(1))?;
    let all = old["events"].as_array()?;
    let newer = |e: &&Value| e["time"].as_str().is_some_and(|t| t >= began);
    let kept: Vec<Value> = all.iter().filter(newer).cloned().collect();
    let first = kept.first()?["time"].clone();
    if kept.len() == all.len() {
        return Some(old);
    }
    Some(json!({ "schema": 1, "first": first, "last": old["last"], "count": kept.len(), "events": kept }))
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
        clear(d, "9999-12-31T23:59:59.999Z");
        assert!(!dir.join(FILE_NAME).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn event_at(time: &str, path: &str) -> Value {
        json!({ "time": time, "route": "r", "path": path, "error": "e" })
    }

    fn add(d: &str, pause: &mut dyn FnMut(), time: &str, path: &str) -> std::io::Result<()> {
        update(d, pause, |previous| Some(merged(previous, event_at(time, path), time)))
    }

    fn paths(d: &str) -> Vec<String> {
        let history = read_history(&Path::new(d).join(FILE_NAME)).unwrap_or(json!({ "events": [] }));
        history["events"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn two_writers_from_the_same_previous_state_keep_both_events() {
        let dir = scratch("two-writers");
        let d = dir.to_str().unwrap();
        add(d, &mut || {}, "2024-01-01T00:00:00.000Z", "/first").unwrap();
        // writer A holds the lock and has read the history; writer B arrives and must wait for it
        let held = lock(&dir, &mut || {}).unwrap();
        let before = read_history(&dir.join(FILE_NAME));
        let mut held = Some(held);
        let mut pauses = 0;
        let a_time = "2024-01-02T00:00:00.000Z";
        let mut a_event = Some(merged(before, event_at(a_time, "/a"), a_time));
        let file = dir.join(FILE_NAME);
        add(
            d,
            &mut || {
                pauses += 1;
                std::fs::write(&file, fitted(a_event.take().unwrap()).unwrap()).unwrap();
                held.take();
            },
            "2024-01-03T00:00:00.000Z",
            "/b",
        )
        .unwrap();
        assert_eq!(pauses, 1, "writer B must have waited for A exactly once");
        assert_eq!(paths(d), ["/first", "/a", "/b"], "both writers' events must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lock_that_stays_held_drops_the_event_after_the_bounded_attempts() {
        let dir = scratch("held-lock");
        let d = dir.to_str().unwrap();
        add(d, &mut || {}, "2024-01-01T00:00:00.000Z", "/first").unwrap();
        let _held = lock(&dir, &mut || {}).unwrap();
        let mut pauses = 0;
        let result = add(d, &mut || pauses += 1, "2024-01-02T00:00:00.000Z", "/dropped");
        assert!(result.is_err(), "no lock, no write");
        assert_eq!(pauses, LOCK_ATTEMPTS - 1, "the wait is bounded by the attempt count");
        assert_eq!(paths(d), ["/first"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lock_whose_owner_is_gone_is_taken_over() {
        let dir = scratch("dead-lock");
        let d = dir.to_str().unwrap();
        // a pid no live process has: far above any pid limit
        std::fs::write(dir.join(LOCK_NAME), "4294967294").unwrap();
        add(d, &mut || {}, "2024-01-01T00:00:00.000Z", "/after").unwrap();
        assert_eq!(paths(d), ["/after"]);
        assert!(!dir.join(LOCK_NAME).exists(), "the lock is released");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clear_keeps_an_event_written_after_the_call_began() {
        let dir = scratch("clear-newer");
        let d = dir.to_str().unwrap();
        add(d, &mut || {}, "2000-01-01T00:00:00.000Z", "/seen").unwrap();
        add(d, &mut || {}, "2024-01-01T00:00:00.000Z", "/newer").unwrap();
        clear(d, "2010-01-01T00:00:00.000Z");
        assert_eq!(paths(d), ["/newer"], "only the event older than the call may go");
        clear(d, "2030-01-01T00:00:00.000Z");
        assert!(!dir.join(FILE_NAME).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eight_maximal_entries_are_written_within_the_cap_and_read_back() {
        let dir = scratch("maximal");
        let d = dir.to_str().unwrap();
        let wide = "\u{1}".repeat(500);
        for i in 0..KEEP {
            record(d, &wide, &wide, &format!("{wide}{i}"));
        }
        let file = dir.join(FILE_NAME);
        assert!(std::fs::metadata(&file).unwrap().len() <= MAX_BYTES, "the writer must keep the cap");
        let history = read_history(&file);
        let kept = history.map(|h| h["events"].as_array().unwrap().len());
        assert!(kept.is_some_and(|n| n > 0), "the reader must accept what was written: {kept:?}");
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
