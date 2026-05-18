# Changelog

All notable changes to Token-Goat are documented in this file. Format follows Keep a Changelog. Token-Goat follows Semantic Versioning starting at 1.0.

## [Unreleased]

### Added

- **Bash output compression — fourth interception point.** PreToolUse hook on Bash detects compressible commands (12 filters covering `pytest`, `jest` / `vitest`, `cargo`, `npm` / `pnpm` / `yarn` / `bun`, `docker` / `buildah` / `podman`, `kubectl` / `helm`, `aws`, `ruff` / `eslint` / `mypy` / `pyright` / `pylint` / `stylelint` / `biome` / `tsc`, `git`, `make` / `ninja` / `gradle` / `mvn` / `bazel` / `go`, `terraform` / `tofu`, `pip` / `pipx`) and rewrites them to flow through `token-goat compress`, which runs the original through the system shell, captures stdout + stderr, applies the per-tool filter, and emits a failures-first compressed view. Typical savings: pytest 80-97%, npm 88%, docker 75%, linters 80%. Each filter strips ANSI escapes, collapses `\r`-progress bars, dedupes consecutive lines, groups linter issues by rule (3 examples per code), keeps every error / warning block verbatim, and caps total output at 1000 lines / 64 KiB. The wrapper preserves the original exit code so shell chaining (`cmd && next`) still works, kills the entire process group on timeout (`SIGTERM` → `SIGKILL` grace period on POSIX), and caps stream capture at 32 MiB per stream to prevent OOM. Configurable via `[bash_compress]` in config.toml (`enabled`, `disabled_filters`, `max_lines`, `max_bytes`, `timeout_seconds`) or disabled entirely with `TOKEN_GOAT_BASH_COMPRESS=0`. Stats recorded per filter as `bash_compress:<name>`. New CLI subcommand `token-goat compress` for previewing compression on any command.

### Fixed

- **`paths.open_log_file` returned a `StreamHandler` instead of a `FileHandler` on POSIX.** The function's type hint and docstring claimed `FileHandler`, but the implementation wrapped `os.fdopen()` in a bare `StreamHandler` to apply 0o600 permissions, breaking `isinstance(handler, FileHandler)` checks (e.g. the `test_setup_logging_skips_console_handler_when_not_tty` worker test). Replaced with a proper `_OwnerOnlyFileHandler` subclass that overrides `_open` to apply the tighter mode at open time, preserving the type identity callers depend on.
- **`test_canonicalize_drive_case_collapsed` and `test_canonicalize_cross_shell_paths_produce_same_hash` failed on POSIX.** Both assert Windows-shell drive-letter normalisation invariants that only fire when `Path.resolve()` returns an absolute Windows path; on POSIX `Path("C:/Projects/foo").resolve()` becomes `cwd + "/C:/Projects/foo"` and the assertions test against synthesised POSIX paths instead. Now skipped on non-Windows with an explanatory message.

## [0.5.2] - 2026-05-17

### Fixed

- **"Did you mean?" suggestion paths no longer crash when the per-project DB has not been created yet.** The four suggestion code paths (`read_commands._close_symbol_matches`, `read_commands._close_section_matches`, `cli._project_close_symbol_matches`, `cli._global_close_symbol_matches`) caught `sqlite3.OperationalError` and `sqlite3.DatabaseError` but not `FileNotFoundError`. `db.open_project_readonly` raises `FileNotFoundError` when the project DB has not been indexed, so a `token-goat read` against an unindexed project that resolved via `find_in_all_projects` would surface a hard crash instead of a clean miss message. Suggestions are best-effort polish — they must always degrade silently.

## [0.5.1] - 2026-05-17

### Added

- **`token-goat --version` / `-V` flag.** Prints the installed version and exits. Required by SECURITY.md, which instructs vulnerability reporters to include this command's output; the flag did not previously exist and the command errored out, blocking the reporting flow.
- **`config` sub-Typer help string.** `token-goat --help` previously rendered the Config panel with an empty description; the group is now self-describing.

### Changed

- **Shipped routing tables refreshed for 0.5.0 features.** The blocks `token-goat install` writes to `~/.claude/CLAUDE.md`, the token-goat skill, and `~/.codex/AGENTS.md` now mention qualified `Class.method` reads, `Heading#N` section ordinals, `map --compact`, `gdrive-sections`, `--all-projects`, `semantic --max-distance` / `--no-rerank`, and the "Did you mean?" miss suggestion. Agents installed against 0.5.0 had no way to discover these from the shipped guidance.
- **`token-goat gdrive-sections` is no longer hidden in `--help`.** The 0.5.0 routing tables advertise it as a user-facing command; an agent verifying via `--help` would have concluded it did not exist.
- **`read` / `section` argument help now documents `Class.method` and `Heading#N` syntax** inline so the qualified-lookup and ordinal-disambiguation forms are discoverable from `--help` alone.
- **PyPI description tightened** to mention the surgical-read CLI (`symbol` / `read` / `section` / `semantic` / `map`), not only the automatic hook features.

### Fixed

- **`map --compact` help text said the threshold was ~200 tokens; the code constant is 300** (`repomap._AUTO_COMPACT_BUDGET`). Iteration 17 raised the threshold but missed the help string. Help now matches code.

## [0.5.0] - 2026-05-17

### Added

- **WebP encoding as the default image-shrink format** — ~39% smaller than the previous JPEG output on screenshots, ~97% smaller than raw PNG. Anthropic's Vision API natively supports `image/webp`. The cache key version was bumped so older shrunk artifacts are not served.
- **Install-time image-codec probe.** `token-goat install` now records `image codecs: ok|FAIL` as a normal install step and, when any codec is missing or WebP encode fails, prints a banner-delimited warning with platform-specific install commands (`apt-get` / `dnf` / `pacman` / `apk` / `brew`) plus the `uv tool install --reinstall token-goat` follow-up. AIs driving the install can resolve the gap as part of the same task instead of discovering it months later via missing savings.
- **New CLI flags and commands.** `token-goat install --dry-run` previews changes; `--verify` audits an existing install. `token-goat map --compact` fits a 300-token budget. `token-goat semantic` accepts `--max-distance <float>` and `--no-rerank`. `token-goat gdrive-sections <file-id>` lists the heading outline of a Google Doc without fetching the body.
- **Qualified `Class.method` lookups** in `token-goat read`, plus `Heading#N` ordinal disambiguation for `token-goat section` when a doc has duplicate headings.
- **"Did you mean…?" suggestions** on surgical-read misses — a typo costs one extra glance instead of a re-read.
- **`<details><summary>`, setext headings, h1-h6 with anchor IDs, and `__frontmatter__`** are all recognised as Markdown sections.
- **PowerShell read-then-filter pipelines** (`Get-Content | Select-String / Where-Object / Select-Object`, including `-First` / `-Tail` ranges) now surface to the image-shrink and session-hint paths via `bash_parser`. Also adds `xxd`, `od`, `wc`, `type`, and stdin-redirect (`cmd < FILE`) read detection.
- **Stats "By source" panel.** `token-goat stats` now shows a per-source rollup (image / hint / read / compact / other) with a distinct palette in the fancy renderer.
- **Regression benchmark suite** (`tests/test_savings_benchmarks.py`) locks in the measured wins: WebP ratio >=20%, repomap density >=20%, `write_file_index` <200 ms, hook cold-start <1.5 s, composite indexes present, markdown sections cover frontmatter / ATX / setext / `<details>`, and `package-lock.json` is excluded by default.

### Changed

- **DB reindex is ~80x faster** (84 s -> ~1 s for 100 files) - `parser.write_file_index` now wraps writes in an explicit `BEGIN`/`COMMIT` transaction and the schema picks up composite indexes (`idx_symbols_file_name`, `idx_sections_file_heading`).
- **Hook dispatch cold-start ~65% faster** (~86 ms -> ~30 ms) via lazy submodule imports in `hooks_cli` and PEP 562 `__getattr__` deferring `importlib.metadata.version()`. Unknown hook events return in <1 ms.
- **Repomap output ~30-40% denser** - short labels (`r=X.XXX`, `cls`/`fn`/`m`), tighter line composition, and an auto-compact mode that fits 300 tokens.
- **Semantic-search rerank pipeline.** `token-goat semantic` over-fetches `k*4`, boosts verbatim-token matches on camelCase / snake_case splits, demotes generated paths (`dist/`, `*.min.js`, sourcemaps, lockfiles), and applies a default distance threshold of 1.2.
- **Image cache is real LRU, not FIFO.** `os.utime()` bumps the cache file on every hit so eviction sorts by real access recency. Eviction is also lockfile-guarded (`O_CREAT | O_EXCL`) so concurrent workers cannot race.
- **Worker adaptive back-off.** Idle poll interval grows from 2 s -> 10 s after five consecutive empty drains.
- **Compact manifest noise filter and recency markers.** `compact.build_manifest` filters noise paths, prefixes activity markers (edited/read), recency-ranks symbols, and dedupes across sections so an edited file isn't repeated under "read."
- **Hint suppression smarter.** Already-read hints now suppress when the file was edited after the last read, when the prior read is >30 minutes old, and when the new read is a narrow explicit range.
- **Per-session and parser result caches.** `parser` keeps a 256-entry SHA-keyed LRU so unchanged content skips tree-sitter entirely; each session keeps a 100-entry FIFO so repeat `read`/`section` queries cost zero.
- **Webfetch content-hash dedup.** Different URLs that resolve to the same bytes share one shrunk artifact via a `web_cache_dir/by_content/<sha>.idx` pointer.
- **Cross-shell project hash unified.** `C:\Projects\foo`, `/mnt/c/Projects/foo` (WSL), `/cygdrive/c/Projects/foo` (Cygwin), and `/c/Projects/foo` (Git Bash) now hash to the same project ID, so the SQLite index is no longer split across shells.
- **Default exclude patterns.** Lockfiles (`package-lock.json`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `composer.lock`), minified bundles (`*.min.js`, `*.min.css`), and sourcemaps (`*.map`) are skipped at index time.
- **JSON indexer permissive fallback.** Minified JSON with no newlines now picks up keys via `_ANY_KEY_RE`, and large structured configs emit one nested layer of `parent.child` symbols plus `[].key` schema peeks on arrays of objects.
- **Config tuning.** `compact_assist.min_events` drops from 5 to 3 so short sessions still get a manifest.

### Fixed

- **Markdown setext / `<details><summary>` / HR disambiguation / blockquote prefixes** previously produced wrong section boundaries. The Markdown adapter now handles all four cases and emits one `__frontmatter__` section per YAML frontmatter block.
- **TypeScript decorator post-pass** walks bracket balance so multi-line `@Component({...})` no longer truncates the next symbol.
- **`gdrive-fetch` filename-hint routing** is now capped at 256 chars and sanitised so a hostile filename cannot inject prompt fragments.

### Security

- Tighter sanitisation on the Google Drive filename hint and the webfetch URL -> content-hash mapping; both surfaces now refuse oversized or malformed values rather than passing them through.

## [0.3.1] - 2026-05-16

### Added

- **Linux and WSL support.** The worker now registers as a `systemd --user` service (`~/.config/systemd/user/token-goat-worker.service`) when systemd is available, with an XDG autostart `.desktop` fallback elsewhere. On WSL without systemd, the SessionStart hook starts the worker at the beginning of every Claude Code session. Data directory: `~/.local/share/token-goat/`. The install/uninstall flow, doctor checks, weekly auto-update (via `crontab`), and hook entry-point are platform-aware end-to-end.
- **macOS support** (untested). The worker registers as a LaunchAgent at `~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist`, loaded via `launchctl`. Data directory: `~/Library/Application Support/dfk-helper/token-goat/`. Weekly auto-update uses the same crontab path as Linux.
- **PyPI Trusted Publishing.** A `Publish to PyPI` GitHub Actions workflow builds and publishes on GitHub Release via OIDC, replacing long-lived API tokens stored as repo secrets. PyPI's docs explicitly call out the security and usability advantages of OIDC-based publishing.
- **README `What gets installed?` and `Security, privacy, and uninstall` sections** enumerating every file, hook, autostart entry, scheduled task, and data path the installer writes — and how each is reversed.
- README badges for PyPI version and CI status (in addition to the existing Python version and license badges).
- Lefthook git hooks for local lint / type-check / test parity with CI.
- PyPI project URLs, classifiers, and keywords surfaced in `pyproject.toml`.

### Changed

- Data directory namespace renamed from `DFK Helper LLC` to `dfk-helper` for cross-platform path hygiene (matches the platformdirs convention on every OS). A reinstall will recreate the index at the new path; the old directory can be removed by hand.
- Author / namespace migrated to `DFK Helper LLC` across the project (replaces a personal username in metadata and packaging fields).
- CI slimmed to Python 3.13 on Windows for `ruff`, `mypy`, and `pytest`. The package itself still declares support for 3.11–3.13.
- README rewritten with a before/after comparison table and stat callouts.

### Fixed

- Python 3.13 changed how `stat()` reports paths that contain a null byte; existing tests and a defensive check in `paths.py` were updated to accommodate the new error type.
- Three Windows-runner CI test failures resolved.
- Ruff caught a handful of orphaned imports left over from the iteration sweeps — all removed.
- `token-goat stats` no longer charges suggestion-only hints with an overhead "saving" they did not earn.
- `token-goat stats` bar-scale and share-% now use separate denominators so a single dominant kind no longer flattens the rest of the chart.

### Security

- Continued hardening of input validation in `paths.py` (`is_safe_rel_path`, hash-traversal guards in `project_db_path` and `session_cache_path`) so no rel-path can escape the data directory under any caller.

### Removed

- Legacy `tokenwise` launcher binaries (`tokenwise`, `tokenwise-hook`, `tokenwise-worker`) are now removed during install and uninstall when they sit alongside the current `token-goat` launchers.
- Provisional application number stripped from the patent notice.

## [0.2.3] - 2026-05-14

### Changed

- **`token-goat stats` reorders its table columns.** In the by-kind, by-day and by-project tables the `share` percentage now sits directly after `tokens saved`, ahead of the raw `events` count. The share is the at-a-glance "how much of the total is this" number; the event count is supporting detail — so the eye lands on share first and the column order matches that priority.
- **The worker now restarts on a same-version reinstall.** Its version-self-restart compared only the installed version *string*, so `uv tool install --reinstall` without a version bump — the common case during development — left the worker running stale code until something restarted it manually. `run_daemon` now also compares a content fingerprint of the installed package (a hash over the size and mtime of every `.py` file in the package directory), captured at boot and re-read on the same once-a-minute cadence. A change in either the version string or the fingerprint triggers the graceful slot-release-and-respawn. Fails soft: a fingerprint that can't be computed falls back to the version-string check.
- **Daily log files are now size-capped.** The `worker.log` and hook daily logs used a plain `FileHandler` with no size bound — they were bounded in *count* (date-named, 7-day retention sweep) but a single pathological day, e.g. a worker stuck in a fast error loop, could still bloat one file. Both handlers, and the `worker-stderr.log` crash sink, now share `paths.roll_log_if_oversized()`, which rolls a log over to a `.prev.log` sibling once it passes its cap (5 MB for daily logs, 1 MB for the crash sink) before the handler is attached. Best-effort under Windows multi-process contention — the roll is suppressed if another process holds the file and retried by the next opener — and `.prev.log` ends in `.log` so the retention sweep still reaps it.

## [0.2.2] - 2026-05-14

### Added

- **Skills and plugins indexing.** `token-goat index --root <path>` indexes any directory — no `.git` or project marker required. Shorthand flags: `--skills` indexes `~/.claude/skills/`, `--plugins` indexes `~/.claude/plugins/`. After indexing, `token-goat section "superman/SKILL.md::Plan Gate"` and `token-goat read "ralph/SKILL.md::symbol"` work from any directory, and `token-goat symbol --all-projects` picks up symbols defined in skills. Run once and forget — incremental re-indexing keeps skills current as you update them.
- **Cross-project file resolution.** `token-goat section` and `token-goat read` now fall back to searching all indexed projects when the file is not found in the current project. This means `token-goat section "superman/SKILL.md::Plan Gate"` works from inside any project directory, not just from inside `~/.claude/skills/`.

- **Compaction assist.** Before Claude Code compacts the conversation, a new `PreCompact` hook builds a structured session manifest and injects it as `systemMessage` so the compaction LLM can preserve edited files, accessed symbols, and frequently read files in its summary. The manifest stays under a configurable token budget (default 400 tokens). Configure via `[compact_assist]` in `config.toml` or set `TOKEN_GOAT_COMPACT_ASSIST=0` to disable entirely.
- `token-goat compact-hint --session-id <id>` debug command shows exactly what the `PreCompact` hook would emit for any session.
- `session.py` now tracks which files were edited this session (`edited_files: dict[str, int]`). The `post_edit` hook (previously a no-op) now calls `session.mark_file_edited()` on every Write/Edit/MultiEdit. Edited files are listed first in the compaction manifest — they are the most critical context to preserve.
- `token-goat doctor` now reports worker-watchdog state: the single-worker claim file (held / stale / absent), any index-spawn markers (`locks/{hash}.indexing`) and whether they are active or stale, and the dirty-queue depth (flagged when a backlog suggests the worker is down or behind). These cover the failure modes introduced with the worker claim file and index-spawn deduplication.
- `token-goat doctor --fix` clears the stale `.indexing` spawn markers doctor flags — the on-demand counterpart to the worker's startup reaping, for when the worker is down. It only ever removes markers `spawn_index_detached` already reads as inactive, so an in-flight indexer is never disturbed.

### Changed

- `token-goat stats` now reports the **net** token impact of the pre-read hook, not just its upside. Injecting a hint as `additionalContext` costs tokens in the conversation; the `session_hint` event now records `realized_saving − injection_cost`. Dedup hints (re-read warnings) stay net-positive; pure suggestion hints record a small negative — the honest signal that they cost tokens now and pay off later via the `read_replacement` stat `token-goat read` records if the agent acts on them. Summing the kind answers "is the pre-read hook net-positive?" directly.
- Pre-read hints are leaner. The purely-informational "FYI, you read this file earlier, proceeding" note — emitted on a non-overlapping re-read — is suppressed entirely: it carried nothing actionable and only cost tokens. The "large file, use `token-goat read`" suggestion no longer enumerates every indexed symbol; it carries one example command and lets `token-goat symbol`/`map` provide the full list on demand.

- Incremental indexing is now O(N × stat) instead of O(N × file-read + SHA) for unchanged projects. The previous path called `index_file()` — reading file bytes and computing SHA256 — for every file in the project just to determine nothing had changed. The incremental path now loads `(rel_path, mtime, content_sha256)` from the DB, checks `stat().st_mtime` first, and skips `index_file()` entirely when mtime is unchanged. The SHA check is preserved as a secondary guard for same-mtime content changes (e.g., `touch` + overwrite). This makes the 10-minute worker sweeps over skills and plugins near-instant when nothing has changed.

- `token-goat stats` startup time reduced from ~10 s to ~2 s. Root cause was N `PRAGMA integrity_check` + N DDL `executescript` calls per registered project on every invocation. `stats.py` now uses new read-only DB openers (`db.open_global_readonly()` / `db.open_project_readonly()`) that open SQLite with `?mode=ro` URI flag, skipping integrity checks, DDL, WAL activation, and sqlite-vec loading.
- `token-goat stats` bar widths and share percentages now reflect token savings rather than bytes saved. Event kinds that cannot produce a token estimate (webfetch and Drive image downloads, which report raw bytes with no token equivalent) fall back to bytes for their bar, with visual distinction.
- `image_shrink` events now correctly show token savings in `token-goat stats`. The tokens column was hardcoded to `—` despite the data being present in the DB.
- The worker's periodic reindex now sweeps every recently-active project, not just `marker='manual'` skills and plugins. Previously, normal git projects only reindexed when a file was edited *through Claude Code* (via the `post_edit` hook → dirty queue); a file edited in an IDE or by another tool would never be picked up, so `token-goat read`/`symbol`/`map` returned stale results indefinitely. The sweep is bounded to projects seen within the last 7 days, and `last_seen` is now bumped by the `SessionStart` hook so the window tracks real usage rather than the worker's own reindex cadence.

### Fixed

- **The worker-stderr crash sink grew without bound.** `spawn_detached` opens `logs/worker-stderr.log` in append mode on every worker spawn (one per `SessionStart` hook), and the daily-log retention sweep never catches it — each append refreshes the file's mtime, so it never ages past the 7-day cutoff. An actively-written crash log therefore grew forever. `spawn_detached` now rolls the file over to `worker-stderr.prev.log` once it passes `STDERR_LOG_MAX_BYTES` (1 MB), bounding the crash sink at ~2 MB while still retaining recent crash output.
- **Edits made while a project was first being indexed were silently dropped.** `index_project` registered the project in the global `projects` table only *after* the full file walk and index completed. For a large tree that window is minutes long — and never closes if the index spawn hangs or crashes. During it, the worker's dirty-queue drain looked up the project hash, found nothing, logged `dirty queue refers to unknown project hash`, and discarded the entry — so any file edited mid-index was never reindexed. The project is now registered in the global registry up front, before the walk; the final registry update still fills in the real `file_count`/`languages` once indexing finishes, and a crashed initial index now self-heals via the normal incremental drain and periodic reindex. (Surfaced in the field by a stray `.git` at a directory that is a container of repos, which made the entire supertree index as one project.)
- **The test suite deleted the user's real worker-autostart Run key.** `test_install_uninstall_round_trip` exercises `install_all()`/`uninstall_all()` — which call `winreg.SetValueEx`/`DeleteValue` on `HKCU\...\Run` directly — without mocking `winreg`, despite its "hermetic round-trip" docstring. Every `pytest` run therefore wrote and then *deleted* the real `token-goat-worker` autostart entry, so `token-goat doctor` reported `NOT INSTALLED` after any test run (which looked like an autostart bug but was the tests eating their own machine's registry). A new `isolate_registry` autouse fixture replaces `winreg` with an in-memory fake for the whole suite, so no test — present or future — can touch the real registry.
- **The worker had no autostart after `uv tool install --reinstall`.** The HKCU Run key that launches the worker at logon was only ever written by `token-goat install`; a `uv tool install --reinstall` — the normal way to deploy code changes — never touches it, and nothing else does either. Once the key was absent or cleared, the worker survived only as long as a Claude Code hook kept respawning it, and never came back after a reboot. `run_daemon` now self-registers the Run key on every startup (the claim-winning worker only), so autostart is self-healing and the registered command stays current. Fail-soft: a registry error is logged and ignored, never crashing the worker.
- **A worker that crashed during startup left no trace.** `spawn_detached` wired the spawned worker's stderr to `DEVNULL`, so any failure before the logging `FileHandler` was attached — an import error, a crash in `_setup_logging` — vanished completely, which is what made silent worker deaths impossible to diagnose. The worker's stderr now goes to `logs/worker-stderr.log`. The console `StreamHandler` — pointless for a detached daemon with no console, and now just routine-log noise in that file — is dropped for non-interactive runs, so the crash log captures only genuine escaped tracebacks.
- **The image cache missed for re-used images.** `image_shrink._cache_key` hashed `(absolute_path, mtime, size)`, so the cache entry was tied to one exact path at one exact mtime. Claude Code stages prompt-attached images to a fresh temp filename every prompt — so the same image re-used across prompts, or even referenced twice in one prompt, was re-shrunk from scratch each time and stored as a separate cache file. The key is now the sha256 of the image's *content*: identical bytes share one cache entry regardless of path, a re-used image is a cache hit, and a bare mtime touch no longer invalidates the entry while a real content change still does.
- **The first edit in a never-indexed project was silently dropped.** When the worker drained the dirty queue and the project's hash was not yet in `global.db` — the normal state for a project edited before it was ever indexed — `_process_dirty_entries` logged `dirty queue refers to unknown project hash` and discarded the entry. Nothing else triggered an initial index, so the edit was lost and the project stayed unindexed. The dirty-queue entry now carries `project_root` and `project_marker`, making it self-sufficient: on an unknown hash the worker reconstructs the project from the entry and runs a first full index (which self-registers it) instead of dropping the edit. Legacy entries with no recorded root still drop, but now with an explicit reason in the log.
- **A stray `.git` could make an entire directory of repos index as one project.** `find_project` walks up looking for a project marker; an accidental `git init` at a container directory (e.g. `C:\Projects` holding a dozen unrelated checkouts) made it return the whole supertree, and everything underneath indexed as a single giant project. `find_project` now skips a candidate root that looks like a *container* of repos — three or more immediate child directories with their own `.git` — and keeps walking up. A real project, including a monorepo whose packages share one root `.git`, does not match the container signature. This was the environmental trigger behind the field report of the mid-index-drop bug above.
- **Dirty-queue drain dropped entries appended mid-drain.** `drain_dirty_queue` read `dirty.txt` and then truncated it; a `post_edit` hook calling `enqueue_dirty` in the window between the read and the truncate had its line truncated away, so that file was never reindexed. The drain now atomically renames `dirty.txt` to a private `.draining` file before reading it — a concurrent append either travels in `.draining` or lands in a fresh `dirty.txt` for the next cycle, and can never be lost. A `.draining` file left behind by a worker that crashed mid-drain is recovered on the next call.
- **A reinstalled worker kept running stale code.** `uv tool install --reinstall` replaces the on-disk package but cannot touch an already-running worker process, so the daemon kept executing the old code until something external restarted it. The daemon now checks the installed version once a minute and, on a change, releases its single-worker slot and respawns — the successor loads the new code fresh from disk and claims the slot cleanly.
- **Stale `.indexing` spawn markers were never reaped.** `spawn_index_detached` writes a `locks/{hash}.indexing` marker and treats a present, *active* marker as "an index is already running" — but the marker was only ever cleared implicitly, via the PID-liveness + TTL check in `_index_spawn_active`. A marker whose indexer finished or crashed without its PID being recycled lingered on disk indefinitely (16 were found in the field). The worker's `cleanup_on_startup` — run on startup and every maintenance cycle — now reaps them with the exact predicate `spawn_index_detached` uses, so it can never remove a marker still doing its job.
- `post_edit` hook was registered but never called any session-tracking logic. It now records file edits, which feeds both the compaction manifest and future session-aware features.
- Double `@fail_soft` decorator on `post_edit` (applied twice, causing the decorator to wrap itself). Reduced to a single application.
- **Incremental reindex never ran for normal projects.** `post_edit` recorded edits to the session cache but never appended them to the dirty queue, and `enqueue_dirty()` — the function meant to do this — was defined but called from nowhere. The entire incremental-reindex path was dead code for git-detected projects: a project's symbol index went stale the moment you edited a file, so `token-goat read "file::symbol"` returned the wrong function body and the pre-read hint showed stale line numbers. `post_edit` now resolves the edited file's project and enqueues it; the worker drains and reindexes within ~2 s.
- **Runaway `index --full` pileup.** `spawn_index_detached` (called by every `SessionStart` hook) had no deduplication. Its `file_count == 0` guard was racy — concurrent indexers contended on the 30 s writer lock, timed out, exited *without writing*, so `file_count` stayed 0 and the next session spawned yet another. Observed in the field as 44 concurrent processes holding ~41 GB of paged memory. The spawn is now idempotent via a per-project marker (PID + timestamp, with a TTL and PID-liveness check).
- **Duplicate worker daemons.** `run_daemon`'s `is_worker_alive()` → `_write_pid()` sequence was a check-then-act race; two workers starting in the same window both passed the check and both ran the main loop, draining the same dirty queue. Replaced with an atomic `os.open(O_CREAT | O_EXCL)` claim keyed on the process's create-time, so exactly one worker can hold the slot and a crashed worker's claim is correctly reclaimed.
- **Deleted files lingered in the index forever.** `index_project` walked the files on disk but never pruned rows for files that had been removed or renamed. It now prunes them after indexing (the foreign-key cascade cleans up the file's symbols, refs, sections, and chunks).
- **Every token-goat command crashed under Codex's unelevated sandbox.** The sandbox cannot create the WAL shared-memory file, so `PRAGMA journal_mode = WAL` and the first real query failed with `unable to open database file`. `_connect()` and `_connect_readonly()` now fall back to an immutable read-only connection that bypasses WAL coordination entirely; schema-ensure and `record_stat` tolerate read-only connections; `conn.close()` errors in `finally` blocks are suppressed (the WAL checkpoint on close also fails); and the hook logger falls back to a `NullHandler` when the log directory is read-only. Fallback notices are logged at `INFO` so CLI and hook stderr stay clean.
- **`token-goat stats` overstated savings.** The pre-read hook recorded a `session_hint` saving for *every* hint it emitted — including pure suggestions like "this file is large, consider `token-goat read`" — at a flat "25 % of the file" estimate, whether or not the agent acted on it. Hints now carry the genuine avoided cost: suggestion hints record nothing (if followed, `token-goat read` records the real `read_replacement` saving itself), and only dedup hints that warn about re-reading already-cached content record a saving, sized to the actual overlapping lines.
- **A worker that crashed or hung mid-session was never replaced until the next session.** `SessionStart` starts the worker, but nothing noticed a death *during* a session — the dirty queue would silently stop draining. The `post_edit` hook (which feeds the queue) now runs a cheap mid-session watchdog: a single `stat()` on the heartbeat file, and only on the rare stale path does it import `worker` and call `ensure_running()`. `ensure_running()` itself now distinguishes a crashed worker (process gone — respawn), a hung worker (alive but heartbeat stale beyond any plausible busy period — reap, then respawn), and a merely-busy worker (alive, moderately stale — left untouched, since a duplicate would just lose the claim race and clearing its pid file would orphan it). Hung-worker reaping verifies the process command line first, so a recycled PID is never killed.

## [0.2.0] - 2026-05-12

### Added

- Session hint events in `token-goat stats`. When the agent tries to re-read a file already pulled into the current session, Token-Goat now records the savings estimate alongside the existing reminder. The hints show up in the stats output next to image-shrink and read-replacement counts.
- Automatic first-time indexing at session start. The first time Token-Goat sees a new project, it kicks off a background symbol index so the next `token-goat symbol`, `token-goat read`, and `token-goat section` calls return data instead of an empty result.
- "Project not yet indexed" hint in `token-goat symbol`, `ref`, `read`, and `section`. The old response was "No matches", which made it look like Token-Goat was broken when the index was still warming up.
- Token-Goat logo (`assets/logo.png`) and a Windows multi-size icon (`assets/token-goat.ico`). README now opens with the logo centered.
- Availability line in the README footer for engineering inquiries.

### Changed

- Hook commands and the worker auto-start command now invoke `pythonw.exe -m token_goat.cli ...` directly from Token-Goat's uv tool venv. The previous launcher .exe approach tripped behavioral heuristics in several major antivirus and EDR products; the signed Python interpreter plus module invocation does not. See Security below.
- `token-goat stats` redesigned. A one-line headline summary at the top, unicode bar charts proportional to bytes saved, and separate breakdowns by event kind, day, and project below.
- Image-shrink events now include a token-savings estimate at one token per four bytes saved, so the headline counter reflects token impact and not just bytes on disk.
- License changed from MIT to PolyForm Noncommercial 1.0.0. Token-Goat stays free for personal and noncommercial use; commercial use requires a separate license. See LICENSE for full terms.
- CLAUDE.md, Codex AGENTS.md, and SKILL.md directives sharpened. Imperative phrasing, before-and-after tables that show the token-cost difference between `token-goat symbol` and `grep`, and a verification cue at the bottom.
- Python version pin widened to support 3.14.
- Continuous integration now runs `mypy` alongside `ruff` and `pytest`.

### Fixed

- "hook exited with code 1" errors in Codex and Claude Code. Hook entry points now eat unknown arguments, catch every exception class including `SystemExit`, and always exit zero with valid JSON on stdout, even when the harness passes arguments the typer entry point did not expect.
- Database integrity check no longer treats a locked or busy SQLite file as corruption. The previous behavior tried to quarantine the file, failed because Windows held the file lock, and surfaced as `token-goat map` or `token-goat stats` exiting 1.
- Test runs no longer write to the production hook log file. An autouse fixture isolates the hook logger for the duration of each test.
- `read_payload` coerces non-dict JSON (`null`, lists, scalars) to an empty dict so hook handlers can safely call `payload.get(...)` regardless of what the harness sends on stdin.
- Pillow `Image.LANCZOS` replaced with `Image.Resampling.LANCZOS` to remove the deprecation warning on Pillow 10 and newer.
- Rust and Go extractor error fallbacks now return the four-tuple the extractor protocol requires. The previous three-tuple return crashed downstream and was caught by fail-soft, so Go and Rust files never indexed when extraction failed.
- Variable-name shadowing in `embeddings.py` chunk extraction. Caught by mypy, not a runtime bug, but cleaner now.

### Security

- Hook and worker spawn pattern reworked so antivirus and EDR products do not behavior-flag Token-Goat. The previous design spawned a small PyInstaller-style launcher .exe from a user-writable directory (`~/.local/bin/`), which matched the textbook payload-drop signature those products monitor for. Hooks now invoke the Python Software Foundation signed `pythonw.exe` from Token-Goat's uv tool venv directly, with `-m token_goat.cli`. This is the most boring spawn pattern on Windows and gets treated as benign by Bitdefender, Defender, Norton, McAfee, Kaspersky, Sophos, and ESET.

## [0.1.0] - 2026-05-12

First public release.

### Added

- Image shrinking on local file reads. When the agent opens a large PNG or JPEG, Token-Goat returns a compressed copy in place of the original. A 3.3 MB screenshot from one test session arrived at 84 KB.
- Image shrinking on Google Drive image downloads. Activates only when the user has already authorized Google Drive through Claude Code's built-in connector. Token-Goat never asks for its own Drive auth.
- Session-aware read hints. When the agent tries to read a file already pulled into the current session, it gets a short reminder of the prior read and a nudge to grab a narrower slice instead.
- Targeted symbol reads via `token-goat read "file.py::function_name"`. Pulls one function or class, not the whole file.
- Targeted section reads via `token-goat section "doc.md::Heading"`. Pulls one Markdown section by heading.
- Semantic search via `token-goat semantic "<query>"`. Find code by meaning, not by filename. First call downloads a small embedding model into `%LOCALAPPDATA%\dfk-helper\token-goat\models\`.
- Repo orientation via `token-goat map`. A compact, ranked overview of the most important files in a repository.
- Cumulative savings tracking via `token-goat stats`.
- Install and uninstall flow for Claude Code, with `--codex` flag to patch Codex CLI in the same pass.
- Diagnostic command `token-goat doctor` confirms the install is healthy.
- Background worker that auto-starts at logon, runs without a console window, and survives reboots.

### Notes

- Licensed under PolyForm Noncommercial 1.0.0. See LICENSE for full terms.
- Windows 10 and 11 only.
- Python 3.11, 3.12, 3.13, and 3.14 supported.
