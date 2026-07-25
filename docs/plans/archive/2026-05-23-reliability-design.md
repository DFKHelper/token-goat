> **STATUS (2026-05-24):** Items 1–7 DONE (iter 41–45). Items 8–12 PENDING.

# Reliability Design — 2026-05-23

## Problem

Token-goat sits inside Claude Code's hook hot path. Every Read, Write, Edit, Grep, Glob, Bash, WebFetch, Skill, and SessionStart spawns a hook process that must answer with `{"continue": true}` and exit 0 within hundreds of milliseconds, or the agent's experience degrades. The codebase has invested in fail-soft semantics (`fail_soft` decorator, `safe_run` wrapper, atomic writes, lock self-healing), but reviewing `hooks_common.py`, `hooks_cli.py`, the five hook submodules, `db.py`, `worker.py`, `worker_daemon.py`, and `session.py` surfaces a set of small but load-bearing gaps where the invariant "a broken token-goat must never interrupt the agent's work" still leaks. The most consequential is a guarantee mismatch: the `fail_soft` decorator promises in its docstring that no exception escapes, but it catches `Exception`, not `BaseException` — a `SystemExit` raised by an inner subprocess wrapper, a `KeyboardInterrupt` mid-handler, or a `MemoryError` will skip the safe-return path. Beyond that, the dirty queue uses unlocked append (Windows can interleave writes >4 KB or partial UTF-8 sequences); session-cache writes are load-modify-save with no cross-process compare-and-swap, so two concurrent post-edits can lose one of their updates; the per-process `_REPORTED_CONTENTION` dedup set is meaningless given one process per hook; and several lockfile reclaim paths use mtime as the tie-breaker for "stale" without `flock` on POSIX, leaving a small but real window for two workers to both think they hold the slot. Each is individually mitigated by retry or higher-layer guards; together they are the long-tail of "broke once and we never figured out why."

## Wild Ideas (SCAMPER + Field Transplant)

1. **Linux `inotify` / Windows `ReadDirectoryChangesW` as the dirty source of truth** (Substitute / Field Transplant from filesystem watchers). Replace the dirty-queue file entirely with an OS-level fs-watcher inside the worker. The hook's only job becomes "ensure the worker is running"; concurrency and atomicity of the queue stop being our problem. Risk: filesystem watchers are expensive on monorepos and miss events under load — the queue file is more reliable than it looks. Treat as a future, not now.

2. **Per-session SQLite for cache instead of JSON** (Substitute, from how mature editors store user state). A single SQLite file per session with WAL gives us proper concurrent compare-and-swap via `UPDATE … WHERE last_activity_ts = ?` and removes the load-modify-save race entirely. We already ship sqlite-vec for embeddings; the dependency is paid. The cost is a schema migration for every existing user's on-disk JSON.

3. **Crash-loop watchdog inside the hook itself** (Adapt, from systemd's `RestartBurst` policy). The hook records crash counts in `crash_counter.txt`. If a handler crashes 5 times in 60 s, the hook short-circuits to bare CONTINUE for that handler for the next 5 minutes — token-goat self-disables features that are reliably breaking instead of forcing the user to set an env var. Adjacent to today: needs one new file + one decorator change.

## Pre-Mortem

**Failure 1 — `SystemExit` from a lazy import escapes `fail_soft`.**
A future refactor in `hooks_read.py` imports a module whose `__init__.py` calls `sys.exit(1)` on a config error (legitimate-looking pattern). `fail_soft` only catches `Exception`, so the `SystemExit` propagates to `safe_run`, which *does* catch `BaseException` — but the dispatcher's diagnostic fields (`_tg_error`, `_tg_handler`) are lost because they live in the decorator's branch. Worse, any callable that uses `fail_soft` directly (tests, future entry points) gets the unmediated crash.
**Fix:** Widen the `fail_soft` `except` clause to `BaseException` with explicit re-raise of `KeyboardInterrupt` and `SystemExit` only if a `_TG_PROPAGATE` env var is set. Idea #1 in backlog.

**Failure 2 — Two `post-edit` hooks race; one edit count is lost.**
Agent issues `MultiEdit` that touches `file.py` and then immediately a `Write` to the same file. Two hook processes fire in sequence; the second's `load()` happens before the first's `save()` lands. Both read `edited_files[file.py] = 3`, both write `4`, final value is `4` instead of `5`. The compaction manifest under-reports edit pressure on that file.
**Fix:** Add a per-session optimistic CAS via `last_activity_ts` token: on save, if the on-disk file's `last_activity_ts` doesn't match the loaded value, retry the load-mutate cycle. Idea #2 in backlog.

**Failure 3 — Worker claim file becomes a permanent zombie.**
A worker is killed by Windows Task Manager between `os.open(O_EXCL)` and the `os.write(pid)` call. The claim file exists, empty. `_worker_claim_is_stale` returns False for empty/malformed content (treats it as "owner mid-startup"). On the next `_try_claim_worker_slot`, the file is treated as held by a live worker forever (until 10 min mtime ageout — but that branch is gated by `_worker_claim_is_stale`, which only checks the *content*, not the mtime, for malformed files). No worker ever starts again.
**Fix:** Add mtime-based stale check (>60 s old AND empty/malformed → reclaim). Idea #5 in backlog.

## Improvement Backlog (ranked, adjacent-possible)

### 1. `fail_soft` must catch `BaseException` to match its contract — Score 1
**STATUS:** DONE (iter 44, commit 9c37736)

**File(s)**: `src/token_goat/hooks_cli.py` (line 287)
**Problem**: The docstring promises "Returns {'continue': True} even if handler raises/crashes" but the `except` clause is `Exception`. A `SystemExit`, `KeyboardInterrupt`, `MemoryError`, or `GeneratorExit` from a buggy lazy-imported module bypasses the safe path. `safe_run` catches it at the outer layer, but the decorator's diagnostic record (`_tg_handler`, `_tg_error`) is lost, and any test or future caller using `fail_soft` standalone gets the raw crash.
**Fix**: Change to `except BaseException as exc` with an explicit re-raise of `KeyboardInterrupt` and `SystemExit` (same pattern as `safe_run`) so process-control signals still terminate cleanly but every other base exception is captured with diagnostics. Add a comment cross-referencing `safe_run` so the two stay in sync.
**Risk if wrong**: A future Ctrl+C handler change could swallow the signal. Mitigated by keeping the explicit re-raise of `KeyboardInterrupt`/`SystemExit`.
**Test**: Add `test_fail_soft_catches_base_exception` in `test_hooks_dispatcher.py` — handler raises `SystemExit(1)`, decorated handler must return a dict with `continue: True` and `_tg_error` populated. Handler raises `KeyboardInterrupt`, must re-raise.

### 2. Session cache writes need optimistic CAS to prevent edit-count loss — Score 1
**STATUS:** DONE (iter 44, commit bf95c5a)

**File(s)**: `src/token_goat/session.py` (`save`, `load`, `mark_file_edited`, `mark_file_read`, `mark_bash_run`, etc.)
**Problem**: Two concurrent hook processes load the same `last_activity_ts`, mutate, and save. The second `os.replace()` wins; the first's mutation is lost. Today's `_FILE_LOCK` is in-process only; atomic_write_text only protects against torn writes, not against logical lost updates.
**Fix**: On `save()`, before the atomic rename, stat the on-disk file. If `mtime_ns` differs from the snapshot taken at `load()`, reload, replay the mutation closure, and retry up to 3 times. Mutations are idempotent on `edited_files[k] = prev + 1`-style accumulators if we pass the closure as a callable. Simpler alternative: increment a `version` integer in the JSON, compare-and-swap on it. Apply to the four mutating functions called by post-edit / post-bash / post-fetch / post-skill.
**Risk if wrong**: CAS retry storms under heavy contention could slow hooks. Cap retries at 3; on exhaustion, log + accept the lost write (degraded but correct).
**Test**: Spawn two threads that each call `mark_file_edited("/x.py")` 50 times. Final count must equal 100, not <100.

### 3. Dirty-queue append needs `fcntl.flock` / `msvcrt.locking` to prevent line interleaving — Score 1
**STATUS:** DONE (iter 45, commit 30d0e24)

**File(s)**: `src/token_goat/worker.py` (`enqueue_dirty`, lines 421–442)
**Problem**: `open("a")` + `f.write(line + "\n")` is only atomic if the line fits in the OS pipe buffer (PIPE_BUF, 4096 on Linux, smaller on Windows). A dirty entry with a long path + project_root + marker can exceed this. Two concurrent hooks writing simultaneously can produce a line like `{"path":"/a.py","proj{"path":"/b.py","project_hash":...}ect_hash":...}` — `drain_dirty_queue` will log it as a malformed entry and silently lose both edits.
**Fix**: Wrap the `f.write()` with an OS file lock — `fcntl.flock(f.fileno(), fcntl.LOCK_EX)` on POSIX, `msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)` on Windows. The lock is released on `close()`. Holds for microseconds; never blocks more than one peer at a time.
**Risk if wrong**: A locked file on a network volume (rare for `%LOCALAPPDATA%`) could hang the hook. Wrap the lock acquire in a 200 ms timeout via `LK_NBLCK` retry loop; fall through unlocked on timeout (worst case we corrupt one line, which is what the status quo already does).
**Test**: Spawn 50 threads that each call `enqueue_dirty` with a 6 KB path. Drain the queue. Assert all 50 entries parsed cleanly with no JSON decode errors.

### 4. `_record_cache_contention` per-process dedup is meaningless — promote to disk — Score 1
**STATUS:** DONE (iter 45, commit 3d23f19)

**File(s)**: `src/token_goat/session.py` (lines 109, 1279–1296)
**Problem**: `_REPORTED_CONTENTION` is a module-level `set` in a process that lives ~50 ms. Every hook process starts with an empty set, so the "dedup" emits one stat row per `(session_id, phase)` per hook process — that is, every single contended hook call. Under disk pressure the stats table fills with thousands of identical `session_cache_unavailable` rows.
**Fix**: Replace the in-memory set with a touch-file at `data_dir() / "contention_marks" / f"{session_hash}_{phase}.mark"`. Check existence before recording; create after. Worker's `cleanup_on_startup` sweeps marks older than 1 hour. Adds one stat() per contention event but eliminates the duplicate-row flood.
**Risk if wrong**: A contention burst across many sessions could create many mark files. Cap with the existing `_CONTENTION_MAX` check, sweep on every worker maintenance cycle.
**Test**: Simulate 10 consecutive `_record_cache_contention(s1, "load", err)` calls in separate processes. After the first, `db.record_stat` is called zero times until the touch-file is swept.

### 5. Worker claim file needs mtime-stale check for empty/malformed content — Score 1
**STATUS:** DONE (iter 45, commit f6b1dc3)

**File(s)**: `src/token_goat/worker.py` (`_worker_claim_is_stale`, lines 350–374)
**Problem**: `_worker_claim_is_stale` returns `False` for empty/malformed claim files (treats them as "owner mid-startup"). That branch is correct for the microsecond window between `O_EXCL` create and `os.write(pid)`, but if the worker was killed in that window the empty file is permanent — `_try_claim_worker_slot` will keep seeing it as held, no new worker can ever start, and the user has to manually delete the claim file.
**Fix**: When `read_text()` produces empty/malformed content, also check `stat().st_mtime`: if older than 60 seconds (much longer than the legitimate write window of <1 ms), treat as stale and reclaim. The existing `_eviction_lock_is_stale` and `db.project_writer_lock._stale` use the same pattern; align this one.
**Risk if wrong**: A slow boot on a heavily-loaded VM could exceed 60 s. Bump to 120 s if observed; still well under the 10-min stale-PID threshold.
**Test**: Create an empty claim file, set its mtime to 70 s ago, call `_worker_claim_is_stale` — must return True. Same call with mtime 5 s ago — must return False.

### 6. `safe_run` should also wrap `denormalize_response` in a try/except — Score 1
**STATUS:** DONE (iter 45, commit 3d11a4f)

**File(s)**: `src/token_goat/hooks_cli.py` (lines 210–238)
**Problem**: `safe_run`'s try block contains `read_payload`, `normalize_payload`, `dispatch`, and `denormalize_response`. The first three are well-tested; `denormalize_response` is a thin dict rewrite. But a future addition (e.g. a new field that triggers a `TypeError` in `_translate_hso_to_codex`) would abort *after* a successful dispatch, replacing the real hook output with a bare CONTINUE. The agent loses the image redirect / dedup hint without an explanation.
**Fix**: Split the try block into two: keep `read_payload` + `normalize_payload` + `dispatch` in one try (recoverable to CONTINUE), wrap `denormalize_response` in its own try whose `except` returns the un-denormalized `dispatched` result. Worst case the harness sees camelCase Codex keys it doesn't understand and ignores them — still better than dropping the hint entirely.
**Risk if wrong**: Codex harness receiving camelCase could log a benign warning. Acceptable trade vs. dropping the whole hook payload.
**Test**: Monkeypatch `_translate_hso_to_codex` to raise `RuntimeError`. `safe_run("pre-read", ..., harness="codex")` must emit a dict whose `hookSpecificOutput` is still present (in camelCase).

### 7. `paths.atomic_write_text` finally-block can clobber the renamed file — Score 1
**STATUS:** DONE (iter 45, commit 3d11a4f)

**File(s)**: `src/token_goat/paths.py` (`_atomic_write_core`)
**Problem**: The `finally` block runs `tmp.unlink(missing_ok=True)`. On POSIX `os.rename()` removes the source name atomically, so `tmp` no longer exists — `missing_ok=True` swallows the error. On Windows, however, `_rename_with_retry` may *fail* (after exhausting retries) and the function re-raises — but on success the temp file is gone too. The finally is safe today but fragile: any future code path that constructs a path equal to `tmp` (e.g. another concurrent writer that picks the same `threading.get_ident()` + `monotonic_ns()` — vanishingly unlikely but not impossible across multiple processes with similar TIDs) would have its file deleted.
**Fix**: Track success/failure explicitly: `renamed = False; try: ...; _rename_with_retry(tmp, path); renamed = True; finally: if not renamed: tmp.unlink(missing_ok=True)`. The unlink only fires when the rename failed and `tmp` actually still exists with our content.
**Risk if wrong**: Tiny — current code is mostly correct. This is hardening.
**Test**: Monkeypatch `_rename_with_retry` to raise after writing tmp; assert tmp file is unlinked. Monkeypatch to succeed; assert no unlink call happens (use a wrapped Path mock or `os.unlink` patch).

### 8. `_proc_create_time` swallows `Exception` types beyond psutil's — Score 1
**File(s)**: `src/token_goat/worker.py` (lines 342–348)
**Problem**: The function catches `psutil.NoSuchProcess` and `psutil.AccessDenied`. On Windows, `psutil.Process(pid).create_time()` can also raise `OSError` (handle closed during call) or `WindowsError`. If those escape, the surrounding `_worker_claim_is_stale` propagates the exception, and `_try_claim_worker_slot` calls it inside an attempt loop that doesn't catch it — the entire worker startup fails.
**Fix**: Widen the except to `(psutil.NoSuchProcess, psutil.AccessDenied, OSError)`. Mirror to `_is_token_goat_worker` and `_is_process_recent` for consistency.
**Risk if wrong**: Swallows a legitimate OS error that should be logged. Add `_LOG.debug` so the failure is visible without breaking the worker.
**Test**: Monkeypatch `psutil.Process` to a class whose `create_time()` raises `OSError`. `_proc_create_time(1)` must return None, not raise.

### 9. `hooks_session._build_session_brief` git subprocess can leak file handles on timeout — Score 2
**File(s)**: `src/token_goat/hooks_session.py` (lines 397–462)
**Problem**: Three `subprocess.run()` calls with timeouts. On `TimeoutExpired`, `subprocess.run` kills the child but the parent's pipe file descriptors aren't always closed promptly on Windows — they wait for the GC. Under a hook-per-tool-call model these accumulate during a long session.
**Fix**: Wrap each `subprocess.run` in `with`-statement-driven `Popen` + explicit `terminate`/`wait`, or pass `capture_output=False` and redirect to `subprocess.DEVNULL` so pipes don't exist. Alternatively, switch to a single `git --git-dir=… --no-optional-locks status -z -b` call that returns branch + status in one round-trip, eliminating two of the three subprocesses.
**Risk if wrong**: A different git status output format means parsing changes. The `-z -b` form is documented and stable.
**Test**: Mock `subprocess.run` to raise `TimeoutExpired`; assert `_build_session_brief` returns None without leaving open file objects (use `gc.get_referrers` or `tracemalloc` snapshot).
**Prerequisite**: requires verifying the `-z -b` parsing covers the same fields the current parser extracts. One refactor to land it.

### 10. Cross-process session cache write needs a lockfile, not just `atomic_write_text` — Score 2
**File(s)**: `src/token_goat/session.py` (`save`)
**Problem**: `_FILE_LOCK` only protects same-process threads. Two hook processes both `load() → mutate → save()` simultaneously: process A writes `tmp.A`, renames → file is v2. Process B (started at v1) writes `tmp.B`, renames → file is v3 with A's mutation lost. `atomic_write_text` guarantees no torn write but not the absence of lost updates. Idea #2 addresses this with CAS; this is an alternative or complementary lockfile approach.
**Fix**: Add a `.lock` sidecar acquired via `os.open(O_CREAT|O_EXCL)` with a 200 ms timeout. Stale lockfiles (>30 s old, mtime check) are reclaimed. Combine with Idea #2 for full correctness — the lock makes the load+save into a critical section; CAS handles the rare case where the lock isn't acquired in time.
**Risk if wrong**: Lock contention under a burst of edits. Cap waiters; on timeout, accept the write may collide and let CAS handle it.
**Test**: Two subprocess workers each running 100 `mark_file_edited` calls in parallel. Final session JSON shows 200 edits, no torn writes, no JSON parse errors during the run.
**Prerequisite**: Idea #2 (CAS) is the foundation; lockfile is the bounded waiter on top.

### 11. Hook-process crash sink to `worker-stderr.log` doesn't roll on size for hooks — Score 2
**File(s)**: `src/token_goat/paths.py` + `src/token_goat/hooks_cli.py` (`safe_run`)
**Problem**: `spawn_detached` rolls `worker-stderr.log` (worker.py:1039), but hook processes that crash before `_setup_logging` succeeds print to stderr — and stderr in a hook context is normally `nul:`/`/dev/null` (set by Claude Code), so the trace is lost entirely. There's no equivalent crash sink for hooks. Hook crashes are currently undebuggable except by re-running with `2>>file` manually.
**Fix**: In `safe_run`'s outer `BaseException` handler, after the `print(msg, file=sys.stderr)`, also append `msg` + traceback to a `hooks-stderr.log` in `logs/`, rolled at the same `STDERR_LOG_MAX_BYTES` threshold the worker uses. Reuses `paths.roll_log_if_oversized` and `paths.open_log_file`.
**Risk if wrong**: A flooded crash log under a broken plugin. Roll-on-write keeps it bounded.
**Test**: Run `safe_run("invalid-event")` (handler raises) and verify `hooks-stderr.log` has a one-line entry; run 1 MB worth of crashes and verify rollover to `.prev.log`.
**Prerequisite**: Decide on log filename and confirm `paths.logs_dir()` is writable from the GUI-subsystem hook entry point (it already is in practice).

### 12. Worker daemon's `_install_signal_handlers` is no-op on Windows — Score 2
**File(s)**: `src/token_goat/worker_daemon.py` (lines 50–57)
**Problem**: Windows Python doesn't deliver SIGTERM to console-less processes the way POSIX does. The worker's only graceful-shutdown path is the `stop_event`, but `stop_event` is None when the worker is spawned by the SessionStart hook (not by test code). A user killing the daemon via Task Manager bypasses the `finally` block in `run_daemon`, leaving the claim file and PID file behind. `cleanup_on_startup` clears them next launch, but in the meantime any session-start hook sees a "stale" pid and may attempt redundant spawns.
**Fix**: Register a Windows console-control handler via `ctypes.windll.kernel32.SetConsoleCtrlHandler` to catch CTRL_CLOSE_EVENT and CTRL_SHUTDOWN_EVENT — the only signals delivered to detached processes. On callback, set `stop_event` (or call `_clear_pid` directly) and return. Provides a 5-second window before forced termination.
**Risk if wrong**: ctypes calls are platform-fragile. Wrap in try/except and fall back to current behavior (no handler) on any error.
**Test**: Skip on POSIX. On Windows, spawn the daemon, send CTRL_CLOSE_EVENT via `GenerateConsoleCtrlEvent`, assert PID file is cleaned up within 5 s.
**Prerequisite**: Verify pythonw.exe (GUI subsystem) can install a console-control handler. If not, fall back to a process-exit hook via `atexit` (less reliable but still better than nothing).

## Out of scope

- Replacing the JSON session cache with SQLite (Wild Idea #2). Big migration, two orders of magnitude more work than the in-place fixes above. Park for a future iteration.
- Filesystem watchers replacing the dirty queue (Wild Idea #1). Conceptually appealing, but the queue file is performing well enough that the migration cost outweighs the safety gain at current scale.
- Crash-loop watchdog with auto-disable (Wild Idea #3). Would change user-visible behavior (features silently turning off); user research first, then maybe.
- Multi-machine concurrency (e.g. token-goat data dir on a shared network drive). Documented as unsupported; not worth designing for.
- Refactoring `safe_run` to use an `async` event loop. The fork-per-hook model is fine on Windows; async would only matter if we batched hooks, which we don't.
- Adding integration tests that spawn real Claude Code. Too brittle; the in-process tests + smoke tests already catch the regressions we care about.

## Hypothesis (Riskiest Bet)

**Hypothesis**: The single most consequential reliability improvement is widening `fail_soft`'s `except` to `BaseException` (Idea #1), because every other reliability improvement in this design assumes that handler crashes are caught and converted to `{"continue": true}`. If a `SystemExit` from a future lazy import escapes `fail_soft`, the entire fail-soft contract is silently broken for that handler path — and Items 2–12 all assume that contract holds.

**Falsification**: Add `import sys; sys.exit(1)` at the top of `hooks_read.py`'s `pre_read` function (in a feature branch). Run the test suite. If the hypothesis is right, the *current* test suite passes (because `safe_run`'s outer guard catches it), but `test_fail_soft_swallows_exceptions` style tests calling `pre_read` directly fail. After Idea #1 ships, both layers pass and any future direct-caller (a plugin, an MCP bridge, a CLI subcommand re-entrant into a handler) is safe.

**Measurement**: Compile-time grep `rg "except Exception" src/token_goat/hooks_*.py` should show zero matches in any `fail_soft`-equivalent wrapper after the change. Runtime: a handler raising `MemoryError` returns a dict with `continue: True`. A handler raising `KeyboardInterrupt` re-raises (process control still works).

**Confidence**: High. The fix is 4 lines. The risk is bounded by the existing `safe_run` outer net. The cost of being wrong is one line of test cleanup; the cost of not doing it is "we've spent a year telling ourselves the fail-soft invariant holds when it doesn't quite."
