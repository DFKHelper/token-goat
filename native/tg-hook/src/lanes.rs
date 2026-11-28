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

/// Why no lane was taken: every lane stayed busy to the deadline, or the lane files could not be used.
#[derive(Debug)]
pub enum LaneError {
    Busy,
    Unusable(String),
}

impl std::fmt::Display for LaneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LaneError::Busy => write!(f, "no lane free before the deadline ({} held)", ORDINARY_LANES + RESERVED_LANES),
            LaneError::Unusable(why) => f.write_str(why),
        }
    }
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
    #[cfg(any(windows, test))]
    pub fn acquire(&self, class: Class, deadline: Instant) -> Result<Lane, LaneError> {
        let sleep_only = |pause: Duration| -> Option<std::convert::Infallible> {
            std::thread::sleep(pause);
            None
        };
        match self.acquire_while(class, deadline, &sleep_only)? {
            Waited::Lane(lane) => Ok(lane),
            Waited::Answer(never) => match never {},
        }
    }

    /// Waits for a lane like `acquire`; each poll's pause goes to `between`, which spends it, and an answer it returns ends the wait.
    pub fn acquire_while<T>(&self, class: Class, deadline: Instant, between: &dyn Fn(Duration) -> Option<T>) -> Result<Waited<T>, LaneError> {
        let Some(data) = &self.dir else { return Err(LaneError::Unusable("no data directory to hold a lane in".into())) };
        ready(data).map_err(LaneError::Unusable)?;
        let indices: Vec<usize> = match class {
            Class::Ordinary => (0..ORDINARY_LANES).collect(),
            Class::Deny => (ORDINARY_LANES..ORDINARY_LANES + RESERVED_LANES).chain(0..ORDINARY_LANES).collect(),
        };
        loop {
            for index in &indices {
                if let Some(lane) = try_take(data, *index).map_err(LaneError::Unusable)? {
                    return Ok(Waited::Lane(lane));
                }
            }
            if Instant::now() >= deadline {
                return Err(LaneError::Busy);
            }
            let pause = RETRY.min(deadline.saturating_duration_since(Instant::now()));
            if let Some(answer) = between(pause) {
                return Ok(Waited::Answer(answer));
            }
        }
    }
}

/// How a lane wait ended: with a lane held, or with an answer `between` gave during the wait.
pub enum Waited<T> {
    Lane(Lane),
    Answer(T),
}

/// Creates `dir` and opens its first lane file, so a directory that cannot hold a lane fails here, not at a take.
fn ready(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("lane directory {}: {e}", dir.display()))?;
    open_lane(dir, 0).map(drop)
}

fn lane_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("lane-{index}.lock"))
}

fn open_lane(dir: &Path, index: usize) -> Result<File, String> {
    let path = lane_path(dir, index);
    OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&path).map_err(|e| format!("{}: {e}", path.display()))
}

fn try_take(dir: &Path, index: usize) -> Result<Option<Lane>, String> {
    let file = open_lane(dir, index)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(Lane { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(format!("{}: {e}", lane_path(dir, index).display())),
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

    /// Sets the stop flag on every exit from its scope, a panic included, so the thread that loops on it ends.
    struct StopOnDrop<'a>(&'a std::sync::atomic::AtomicBool);

    impl Drop for StopOnDrop<'_> {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::Release);
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
        let mut holder = Holder(spawn_holder(&scratch.0));
        let stdout = BufReader::new(holder.0.stdout.take().expect("piped stdout"));
        // Ends at the child's report or at its EOF, so a child that exits first fails here rather than hanging.
        let reported = stdout.lines().map_while(Result::ok).any(|line| line.contains("lane-held"));
        assert!(reported, "the holder child ended before it reported its lane");
        let parent_lane = lanes.acquire(Class::Ordinary, Instant::now()).expect("the parent takes the ordinary lane the child left");
        assert!(lanes.acquire(Class::Ordinary, Instant::now()).is_err(), "a third ordinary lane was granted while the child held one");
        holder.0.kill().expect("kill the holder child");
        holder.0.wait().expect("await the holder child's exit");
        let freed = lanes.acquire(Class::Ordinary, Instant::now());
        assert!(freed.is_ok(), "the killed holder's lane was not released: {:?}", freed.err());
        drop(parent_lane);
    }

    /// HAND-DERIVED: a data dir whose lane path is a plain file is unusable: no lane is taken and no temp lane folder appears.
    #[test]
    fn an_unusable_data_dir_takes_no_lane_and_creates_no_temp_lanes() {
        let scratch = Scratch::new("unusable");
        std::fs::create_dir_all(&scratch.0).expect("the scratch directory");
        std::fs::write(scratch.0.join("hook-lanes"), b"a file where the lane directory must be").expect("the blocking file");
        let temp_lanes = std::env::temp_dir().join("token-goat-hook-lanes");
        let existed = temp_lanes.exists();
        let lanes = Lanes::under(Some(scratch.0.display().to_string()));
        assert!(matches!(lanes.acquire(Class::Ordinary, Instant::now()), Err(LaneError::Unusable(_))), "an unusable data dir took a lane");
        assert_eq!(temp_lanes.exists(), existed, "an unusable data dir created a lane folder under the temp dir");
    }

    /// HAND-DERIVED: two ordinary acquires against one ready data dir hold both ordinary lanes, so a third with a passed end is busy.
    #[test]
    fn two_ordinary_lanes_in_one_ready_data_dir_leave_a_third_busy() {
        let scratch = Scratch::new("two-ordinary");
        let lanes = scratch.lanes();
        let held = hold_ordinary(&lanes);
        assert_eq!(held.len(), ORDINARY_LANES, "the two ordinary acquires did not both hold a lane");
        assert!(matches!(lanes.acquire(Class::Ordinary, Instant::now()), Err(LaneError::Busy)), "a third ordinary lane was granted while both were held");
    }

    /// Starts a holder child under the spawn lock every spawn and inheritance clear shares.
    fn spawn_holder(dir: &Path) -> Child {
        let _spawning = crate::capture::SPAWN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        Command::new(std::env::current_exe().expect("the test binary path"))
            .args(["--ignored", "--exact", "lanes::tests::hold_lane_child", "--nocapture"])
            .arg(format!("dir={}", dir.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the holder child")
    }

    /// HAND-DERIVED: holder children keep their stdio while another thread keeps clearing handle inheritance.
    #[test]
    fn a_holder_child_keeps_its_stdio_while_inheritance_is_being_cleared() {
        let stop = std::sync::atomic::AtomicBool::new(false);
        const HOLDER_REPORT_CEILING: std::time::Duration = std::time::Duration::from_secs(30);
        let mut silent = Vec::new();
        let mut dead = Vec::new();
        std::thread::scope(|scope| {
            let _stop_clearing = StopOnDrop(&stop);
            scope.spawn(|| {
                while !stop.load(std::sync::atomic::Ordering::Acquire) {
                    {
                        let _clearing = crate::capture::SPAWN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        crate::sys::stop_handle_inheritance();
                    }
                    std::thread::yield_now();
                }
            });
            for n in 0..60 {
                let scratch = Scratch::new(&format!("stdio-{n}"));
                let mut holder = Holder(spawn_holder(&scratch.0));
                match holder.0.stdout.take() {
                    Some(out) => {
                        let (report, reported) = std::sync::mpsc::channel();
                        std::thread::spawn(move || {
                            let held = BufReader::new(out).lines().map_while(Result::ok).any(|line| line.contains("lane-held"));
                            let _ = report.send(held);
                        });
                        match reported.recv_timeout(HOLDER_REPORT_CEILING) {
                            Ok(true) => {}
                            Ok(false) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => dead.push(n),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                silent.push(n);
                                break;
                            }
                        }
                    }
                    None => dead.push(n),
                }
                drop(holder);
            }
        });
        assert!(silent.is_empty(), "holder child wrote no report within {HOLDER_REPORT_CEILING:?}, the loop stopped there: {silent:?}");
        assert!(dead.is_empty(), "holder children started with dead stdio (exit 0, no report): {dead:?} of 60");
    }
}
