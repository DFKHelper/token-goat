//! Caps concurrent Node fallback processes; a lane is a lock the kernel frees when its holder exits.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Lanes any hook call may hold.
pub const ORDINARY_LANES: usize = 2;
/// Lanes only deny-class calls may hold, so a guard is not starved by ordinary hooks.
pub const RESERVED_LANES: usize = 1;
/// The longest a waiting call sleeps between attempts: the granularity the client already waits at.
const RETRY: Duration = Duration::from_millis(2);
/// The directory under the data dir that holds the lane files.
const LANE_DIR: &str = "hook-lanes";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Ordinary,
    Deny,
}

/// Events that can refuse a tool call; the spelling varies by harness, so case and separators are ignored.
pub fn class_of(event: &str) -> Class {
    let folded: String = event.chars().filter(|c| !matches!(c, '_' | '-')).map(|c| c.to_ascii_lowercase()).collect();
    if folded == "pretooluse" { Class::Deny } else { Class::Ordinary }
}

/// A held lane; it is released when this is dropped or the process ends.
pub struct Lane {
    _file: File,
}

/// The lane files of one data directory; with no data directory known no lane can be taken.
pub struct Lanes {
    dir: Option<PathBuf>,
}

impl Lanes {
    pub fn under(data_dir: Option<String>) -> Lanes {
        Lanes { dir: data_dir.map(|dir| PathBuf::from(dir).join(LANE_DIR)) }
    }

    /// Takes a lane for `class` before `deadline`; an `Err` says why none was taken.
    pub fn acquire(&self, class: Class, deadline: Instant) -> Result<Lane, String> {
        let Some(dir) = &self.dir else { return Err("no data directory to hold a lane in".into()) };
        std::fs::create_dir_all(dir).map_err(|e| format!("lane directory {}: {e}", dir.display()))?;
        let indices: Vec<usize> = match class {
            Class::Ordinary => (0..ORDINARY_LANES).collect(),
            Class::Deny => (ORDINARY_LANES..ORDINARY_LANES + RESERVED_LANES).chain(0..ORDINARY_LANES).collect(),
        };
        loop {
            for index in &indices {
                if let Some(lane) = try_take(dir, *index)? {
                    return Ok(lane);
                }
            }
            if Instant::now() >= deadline {
                return Err(format!("no lane free before the deadline ({} held)", ORDINARY_LANES + RESERVED_LANES));
            }
            std::thread::sleep(RETRY.min(deadline.saturating_duration_since(Instant::now())));
        }
    }
}

fn try_take(dir: &Path, index: usize) -> Result<Option<Lane>, String> {
    let path = dir.join(format!("lane-{index}.lock"));
    let file = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(Lane { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(format!("{}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::{Child, Command, Stdio};

    /// Removes the test's data directory on every exit, the lanes it held included.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("tg-lanes-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            Scratch(dir)
        }

        fn lanes(&self) -> Lanes {
            Lanes::under(Some(self.0.display().to_string()))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Ends the holder child on every exit, so a failed assertion never leaves it running.
    struct Holder(Child);

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn hold_ordinary(lanes: &Lanes) -> Vec<Lane> {
        (0..ORDINARY_LANES).map(|_| lanes.acquire(Class::Ordinary, Instant::now()).expect("an ordinary lane is free")).collect()
    }

    #[test]
    #[ignore = "only runs as the holder child of the kill test below"]
    fn hold_lane_child() {
        let Some(dir) = std::env::args().find_map(|a| a.strip_prefix("dir=").map(String::from)) else { return };
        let _lane = Lanes::under(Some(dir)).acquire(Class::Ordinary, Instant::now()).expect("the child takes a free ordinary lane");
        let mut out = std::io::stdout().lock();
        writeln!(out, "lane-held").and_then(|()| out.flush()).expect("report the held lane");
        // Ends when the parent closes this pipe or kills the process, so it never outlives its test.
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
    }

    /// HAND-DERIVED: a deny-class call takes the reserved lane while both ordinary lanes are held.
    #[test]
    fn a_deny_call_gets_the_reserved_lane_while_both_ordinary_lanes_are_held() {
        let scratch = Scratch::new("deny");
        let lanes = scratch.lanes();
        let _held = hold_ordinary(&lanes);
        assert!(lanes.acquire(class_of("PreToolUse"), Instant::now()).is_ok(), "a deny-class call got no lane while the reserved one was free");
    }

    /// HAND-DERIVED: an ordinary call cannot take the reserved lane, so it gets none with both held.
    #[test]
    fn an_ordinary_call_cannot_take_the_reserved_lane() {
        let scratch = Scratch::new("ordinary");
        let lanes = scratch.lanes();
        let _held = hold_ordinary(&lanes);
        assert!(lanes.acquire(Class::Ordinary, Instant::now()).is_err(), "an ordinary call took a lane while both ordinary lanes were held");
    }

    /// HAND-DERIVED: a lane whose holder process was killed is free once the kill has been awaited.
    #[test]
    fn a_lane_whose_holder_was_killed_is_free_once_the_kill_is_awaited() {
        let scratch = Scratch::new("killed");
        let lanes = scratch.lanes();
        let child = Command::new(std::env::current_exe().expect("the test binary path"))
            .args(["--ignored", "--exact", "lanes::tests::hold_lane_child", "--nocapture"])
            .arg(format!("dir={}", scratch.0.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the holder child");
        let mut holder = Holder(child);
        let mut stdout = BufReader::new(holder.0.stdout.take().expect("piped stdout"));
        let mut line = String::new();
        loop {
            line.clear();
            let read = stdout.read_line(&mut line).expect("read the holder's report");
            assert!(read > 0, "the holder child ended before it reported its lane");
            if line.contains("lane-held") {
                break;
            }
        }
        let parent_lane = lanes.acquire(Class::Ordinary, Instant::now()).expect("the parent takes the ordinary lane the child left");
        assert!(lanes.acquire(Class::Ordinary, Instant::now()).is_err(), "a third ordinary lane was granted while the child held one");
        holder.0.kill().expect("kill the holder child");
        holder.0.wait().expect("await the holder child's exit");
        let freed = lanes.acquire(Class::Ordinary, Instant::now());
        assert!(freed.is_ok(), "the killed holder's lane was not released: {:?}", freed.err());
        drop(parent_lane);
    }
}
