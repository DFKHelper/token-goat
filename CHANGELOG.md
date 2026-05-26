# Changelog

All notable changes to Token-Goat are documented in this file. Format follows Keep a Changelog. Token-Goat follows Semantic Versioning starting at 1.0.

## [Unreleased]

Bundles the work from the 35-iter `/improve` run (six themed loops, 2026-05-25 → 2026-05-26): compaction hardening, doctor visibility, opt-in observability, four new bash-compress filters, and a stack of reliability fixes.

### Compaction

- **`compact-hint` mirrors live PreCompact gates.** The CLI preview now applies the same `enabled` flag, trigger membership, compact-skip sentinel fast-path, `min_events` gate, sidecar cache, and `auto_trigger_multiplier` boost as the live hook, so the previewed output matches what would actually be emitted. New `--trigger auto|manual` option simulates each trigger class (`4d0a618`).
- **Pressure-aware manifest sizing.** Auto-trigger compactions (Claude Code's context-pressure-fired `/compact`) get a `auto_trigger_multiplier`-scaled budget (default 2.0×). Manifests gain a `RESUME` pointer and a blocker-error preview block so the post-compact recovery hint can surface the in-progress work and the most recent error without a round-trip (`c827767`, `09d2dc5`).
- **Priority-aware safety trim.** When the per-section budget split is still over budget after row-level compaction, low-signal sections are dropped wholesale rather than soft-truncated mid-row (`305a650`).
- **Activity floor + configurable TTL on compact-skip sentinel.** `[compact_assist] compact_skip_ttl_secs` (default 300 s) replaces the hard-coded fast-path window; the sentinel is busted whenever session mtime > sentinel mtime, so an idle session can short-circuit aggressively while an active session always re-evaluates (`0c1beea`).
- **Manifest sidecar hardening.** Sidecars with future-dated `emit_ts` or corrupt headers are rejected and re-emitted from scratch rather than served as stale cache hits (`8f5c003`).
- **Opt-in decision log.** New `[compact_assist] decision_log` surfaces the agent's recent reasoning as a manifest section, so post-compact the LLM can pick up the why behind the last batch of edits (`0ffb741`).
- **Manifest budget telemetry.** Per-emit budget / actual-tokens / scaled-budget triples are recorded as stat kinds and surfaced in `doctor` (`48d477b`).

### Doctor

- **Installation-status section.** `doctor` now reports each of the four install targets (settings.json, CLAUDE.md, skill, autostart) with present / drift / missing, plus a fastembed ONNX model file check (`f2fa89c`).
- **Cold-import timing + cache hit rates.** Surfaces the first-call import budget for the heavy modules (`compact`, `session`, `parser`) and the cache hit rate per cache type, so degraded performance is visible at a glance (`fc19a1c`).
- **Opt-in flag inventory.** `doctor` lists every opt-in flag's current value (json_sidecar, decision_log, skill_preservation, …) with the durable hash format used to detect drift between runs (`008e937`).
- **`canonical_root` sanity.** Doctor confirms project root → canonical-root → project-hash round-trips cleanly, catching the cross-platform path-normalisation edge cases tested in `tests/test_paths.py::test_normalize_key_*` (`97a9af2`).

### Bash compression

- **Four new filters.** `gh` (GitHub CLI output, with progress-line and JSON-block awareness), `go test` (test result grouping with `--- FAIL` block preservation), `ansible` (play-recap + task summary), and `pre-commit` (hook-by-hook grouping with full diff preservation). Filter count: 18 → 22 (`22d501f`, `bb63b40`).
- **Filter base refactor.** Shared `_finalize` and `_emit_notes` helpers extracted onto `Filter` base; eliminates ~120 lines of per-subclass boilerplate (`a8db957`).

### Hints + recovery

- **Opt-in structured-JSON sidecar.** `[hints] json_sidecar` (or `TOKEN_GOAT_HINT_JSON_SIDECAR=1`) prepends a single-line JSON sidecar to every dedup / re-read / unchanged-file / structured-file hint. Prose lines are preserved verbatim — dedup fingerprints, curator metrics, and tests stay intact (`3a2b102`).
- **Post-compact recovery hint upgrades.** Surfaces current-blocker error preview, `RESUME` anchor, and per-file edit badges (`09d2dc5`).
- **Predictive snapshot attribution.** Predictive prefetched snapshots are tagged so diff-hint records can be attributed back to the prefetch path; new `predictive_prefetch_hit` stat kind captures the win (`c79aca5`). Snapshots also survive `TYPE_CHECKING` blocks and multi-line imports (`b8211a1`).

### Reliability

- **`paths.ensure_dir` on hot-path mkdirs.** Eliminates the residual race-tolerant-mkdir bug class on Windows under heavy disk pressure (`e0a34e4`).
- **`paths.has_windows_drive_prefix` promoted to public API.** Single canonical check used by `safe_join`, `canonical_root`, and doctor (`97a9af2`).
- **Snapshot SHA-verification before diff hint.** A corrupt snapshot file no longer fires a phantom diff hint; SHA is validated against the recorded hash before the bytes are trusted (`0192634`).
- **Orphan `json.lock` sidecar reaping.** `session.cleanup_stale` now also removes orphaned session lock sidecars; was leaking sidecars on hard process kills (`21fbdcf`).
- **`worker.heartbeat_stale_threshold()` derived from interval.** No more magic numbers — staleness threshold is `2× worker interval`. New `is_heartbeat_stale_for_nudge()` consumer for the session-start "worker is down" nudge (`42615e5`).
- **Operator-tunable hook watchdog.** `TOKEN_GOAT_HOOK_WATCHDOG_MS` overrides the hook deadline for slow CI / cold-cache machines (`0f6ee8f`).
- **Cache truncation respects UTF-8 boundaries.** Byte-bounded cache writes now truncate on a valid UTF-8 codepoint boundary; orphan-sweep gains an ownership guard so a foreign sidecar in the cache dir is never deleted (`a1a3990`).
- **Marketplace skill plugin path resolution.** `skill_cache` now also resolves the `~/.claude/plugins/<marketplace>/skills/...` layout, with a walk-based eviction fallback for skills that escaped the LRU index (`5d54b6d`).

### Stats

- **Surgical-read adoption surface.** New stat kinds (`<read>_lookup` and `<read>_overhead` per `symbol|read|section|semantic|map`) track each surgical-read command's adoption + per-call overhead. `doctor` now warns on unmapped kinds so silent stat drift is loud (`a775c11`, `bf8f45b`).
- **Bash + web telemetry.** `bash_dedup_stale`, `web_dedup_stale`, `bash_output_recall_miss`, `web_output_recall_miss` stat kinds added (`cecdb68`).
- **Repomap cache-pollution fix.** Filter cache pollution at the source; scale `compact_top_n` instead of using a flat constant; new `map_lookup` stat kind (`8a652f2`).
- **Format-aware image-shrink threshold.** Per-format byte thresholds (PNG vs JPEG vs WebP) prevent over-eager compression; new `image_shrink_skipped` stat kind tracks the bypass rate so the threshold can be tuned against data (`a47ad53`).

### Security

- **SSRF audit gaps closed.** WebFetch now blocks `172.16.0.0/12`, `127.0.0.0/8`, CLI-supplied bypass attempts, and a DNS-rebinding edge that previously slipped through the resolver pin (`8060f67`).

### Refactors

- **Shared pre-read hint pipeline.** Pre-read hint sequence + stats denominators extracted into a shared helper; eliminates the four near-duplicate pipelines (`37843fd`).
- **Install hooks merge/strip + color-stream helpers extracted** (`cccece1`).
- **`scan_flat_headers` unifies the flat-config index loop** across `toml_idx`, `yaml_idx`, `json_idx`, `ini_idx`, and `dockerfile_idx` (`517133e`).

### CI / test infra

- **Per-test timeout raised 30 → 60 s** for the lock-loop tests that trip Windows runner load (`3130f79`).
- **`xdist` stdio reconfigure removed.** A `sys.stdout.reconfigure(...)` call in `conftest.py` was corrupting the `execnet` pipe pytest-xdist uses to talk between controller and workers on Windows. Replaced with a worker-scoped skip + `contextlib.suppress` (`72fab20`, `136c983`, `4ef6e64`).
- **`MSYS_NO_PATHCONV` documented** for Git Bash `gh api /repos/...` calls (`4e43ab8`).

## [0.9.0] - 2026-05-25

Bundles three improvement loops landed since 0.8.0 (37-iter context/compaction on 2026-05-25, 68-iter reliability/perf on 2026-05-24, 55-iter context-savings baseline). Headlines: SSRF DNS-rebinding fix, hook registry single-source-of-truth with startup alignment gate, race-tolerant Windows `mkdir`, manifest format shortening + delta tracking, CI split into fast/slow tiers, and cross-harness wire-format compatibility coverage.

_From the 37-iteration loop (2026-05-25):_

### Security

- **DNS rebinding window closed in SSRF guard.** `webfetch.py` now resolves once via a new `_resolve_and_validate_ip()` and pins the connection to that IP via a custom `_make_pinned_transport()`. Previously a hostile DNS server could return a public IP to the validation query and a private IP (e.g. 169.254.169.254 IMDS) to httpx's reconnect (`22bcd56`).
- **`paths.safe_join()` promoted as canonical fragment joiner.** Two raw joins that took user-controlled session_ids now flow through it; sanitises null bytes, `..`, absolute paths, and Windows-illegal colons (`197acd9`).
- **`dispatch()` ensures `continue=true`.** Handlers returning `{}` or any dict missing `"continue"` would otherwise become harness-blocking responses. Crash-sink boundary now sanitises tracebacks before all three sinks (stderr, logger, file), not just the file write (`b04eee5`).

### Reliability

- **Surrogate-escape crash fix.** `post_bash` was crashing 1,311 times/week in production with `UnicodeEncodeError: 'utf-8' codec can't encode character '\udcXX'`. New `util.sanitize_surrogates` applied at the boundary in `post_bash` right after `_extract_bash_response` (`6fdba43`).
- **Hook registry consolidated to single source of truth.** New `hook_registry.py` declares each event once; five derived tables read from it. A startup `_assert_hook_registry_aligned()` raises `ImportError` if any registry event lacks a matching `@hook_app.command` decorator. Eliminates the recurring drift bug class. Bridge TS event tables get an alignment regression test (`930033c`, `1408673`).
- **Persistent hook wrapper survives `uv tool install --reinstall`.** A `.cmd` at `data_dir/bin/tg-hook.cmd` lives outside the uv tool venv; checks for `token_goat/__init__.py` on disk before forwarding to pythonw, otherwise emits `{"continue":true}` and exits 0. Drift surfaced in `doctor` (`e53d553`, `48193ad`).
- **Orphaned project GC.** Worker removes global.db rows + per-project `.db`/`.db-wal`/`.db-shm` for missing-root projects with 30-min safety window. Race-safe DELETE with `last_seen` predicate prevents TOCTOU loss (`ec60af0`, `009d2ba`). Reclaims 2.3 GB on the audited install.
- **`save_locked` no longer proceeds without lock on timeout.** After 3 consecutive `_acquire_session_lock` timeouts, `cache.unavailable = True` and the writer short-circuits (`6453310`).
- **Session schema version enforced on load.** Cached mismatch drops the cache and starts fresh (`e6f40b2`).
- **Worker SIGTERM handler.** Explicit `_graceful_shutdown` wired for SIGTERM + SIGINT on POSIX (`47a4faf`).
- **TOML config schema warning.** `config.py` warns on unknown top-level sections (catches `[compact_assit]` typos) (`479b763`).
- **`hooks-stderr.log` test isolation.** 230 KB / 316 crash blocks of test garbage were polluting the production crash sink. Autouse conftest fixture redirects test runs to `tmp_path` (`4e940d7`).

### Token Savings — hints / manifest / hot path

- **Manifest format shortening bundle.** `_format_ranges` emits `L:X-Y` not `lines X-Y`; cold/recent bash entries drop the `id=` label and shorten `exit=` to `e=`; `_MAX_TODO_SUBJECT_CHARS` lowered to 50. ~71 tokens/manifest (`f9b583f`).
- **Active-skills section collapsed.** Per-skill bullets with full recall → single `**Skills:** name1, name2, … — recall via token-goat skill-body <name>`. ~160 tokens/6-skill manifest (`3564410`).
- **Adaptive `_MAX_BASH_ENTRIES`.** Scales with bash_history length instead of fixed at 6 (`e60c867`).
- **Clean-repo session brief one-liner.** When in-sync on stable branch with no uncommitted, brief collapses to `"<branch> (clean)"` from a multi-line structured block (`3970702`).
- **status_lines cap.** 50 entries max + `(+N more files)` summary; dirty-tree SessionStart was emitting 3-5 KB (`e5347a8`).
- **Failed-tiny-bash signal.** Tiny output + exit ≠ 0 now appends to `bash_history` so manifest's Current Blockers picks it up (`70a3066`).
- **Single rev-list + adaptive git-log entry count.** Two rev-parse subprocesses collapsed into one `rev-list --left-right --count`; in-sync repos skip the git-log section entirely (`a234855`).
- **Glob-dedup cache capped at 20 paths + grep-after-edit hint capped at 5** (`08dd016`).
- **user-prompt-submit short-circuit on prompts <8 chars** (`022330a`).
- **Long grep patterns truncated in hints + micro-diff one-liner** (`3d13252`).
- **Basename in already-read hint prose + proximity check** to suppress false positives when the agent is reading a far section of a file (`076bacb`).
- **Snapshot-diff hint range-overlap check** suppresses the hint when read range doesn't overlap edited range (`71088db`).
- **Repomap collapses low-PageRank tail** to `(+N minor files)` in compact mode (`a7c90ad`).
- **Image alt-text drops `→ N KiB` when savings ratio < 4×** (`b71cf83`).
- **WebFetch HTML strip before caching** — 60-90% byte reduction for HTML pages (`2b4caea`).
- **web-output --grep recall hint once-per-session** (`a4e67c7`).
- **Process-local LRU on `session.load()`** mtime-keyed, cap 4 — skips JSON parse for back-to-back hooks (`5ea945f`).
- **Pytest banner + ruff success suppression in bash_compress** (`d0a29cd`).

### Performance

- **Test suite 22% faster.** Eviction tests were doing 200-500 real disk writes each. `patch.object(session, "save")` makes them in-memory; round-trip persistence covered separately (`9798981`).
- **Hot-path utf8 byte-length simplification** + **11 lazy session imports consolidated** in hooks_read.py (`e7f165b`).
- **`cli_doctor` global.db connection reuse** between sections 14/14b (`4c77089`).
- **Bash-outputs file-count cap + always-on orphan sweep.** `evict_cache_dir` gained `max_file_count=4096`; orphan-sidecar sweep moved before the early return. Doctor flags file-count overage (`09a527a`, `b64a714`).
- **DB contention metric in doctor.** Scans worker-stderr.log for `session slow` warnings in last 24 h (`1b11b49`).

### DRY

- **16 git subprocess sites → `util.run_git()`.** Always sets `--no-optional-locks` + UTF-8 with `errors="replace"`. Regression test asserts no other bare git subprocess calls remain (`2d18337`).
- **`cache_common.safe_cache_op` context manager** (`c4b9e54`) + **`cache_common.store_blob` for atomic blob writes** (`58306b9`).
- **`cache_common.short_content_hash()` unifies hash logic** across bash/web/skill caches (`47072d6`).
- **`paths.safe_join()` canonical fragment joiner** — sanitises null bytes, `..`, absolute paths, Windows-illegal colons (`197acd9`).
- **`paths.hook_wrapper_path()` persistent hook wrapper** survives `uv tool install --reinstall` (`e53d553`, `48193ad`).
- **`util.ellipsize` + `compact._render_cache_meta` helpers** (`a9f363a`).
- **`hints._require_cache`, `cli._lazy_import`, `cli_doctor._check_step`, `session._load_or_empty_json`** helpers (`9636d2d`, `fd10af4`, `582001d`).

### Tests

- **Hook registry alignment test class** asserts every event has a matching `@hook_app.command`; also checks codex and lazy-getattr table coverage (`930033c`).
- **bash_compress dispatch + golden-output tests** +151 tests across all 17 filters. Two dispatch bugs surfaced: `py.test` never dispatched and `uv pip install` was over-stripped (`d241f6e`, `1817f7e`).
- **Bridge TS event-table alignment.** Asserts every event in OPENCODE_PLUGIN_TS + OPENCLAW_PLUGIN_TS exists in `hook_registry.all_events()` (`1408673`).
- **`paths.safe_join` regression tests** (`197acd9`).
- **Hypothesis property tests for range-overlap arithmetic.** 300-500 cases per property, no violations (`f6b54a7`).
- **`test_extractor_crash_returns_none` flake fix** — `_RESULT_CACHE` shared mutable state across tests (`142fad0`).

### Docs

- **`docs/audit-2026-05-24-coupled-registries.md`** — catalog of 8 coupled-registry patterns ranked by silent-vs-loud break risk (`930033c`).
- **`docs/test-speed-deferrals.md`** — formally defers `test_compact.py` split and `test_read_replacement.py` fixture-scope flip with measurements (`ce53586`).

### Dependencies

- **`hypothesis>=6.0.0`** added to `[dependency-groups].dev`. Was missing — `tests/test_parser_malformed.py` erred at collection time. Unlocks 71 previously-uncollected tests (`2cad7f9`).

### Stats hygiene

- **Compact-recovery zero-value rows dropped** (`1e69346`, `ed43859`).
- **Bash-compress noise-threshold suppression.** `MIN_RECORD_STAT_BYTES = 32` skips `record_stat` for whitespace-only compressions that polluted stats with "0.0% savings" buckets (`d5cbd9a`).

**Suite at end of loop: 4965 pass (started at 4598; +367 tests added).**

_From the 68-iteration loop (2026-05-24):_

### Security

- **webfetch sidecar path-traversal fix.** `webfetch.py` now validates that `shrunk_path` resolves inside the cache roots before writing or serving the sidecar, closing a path-escape vector on redirect chains (`2bc071b`).

### Reliability

- **PIL decode-bomb cap.** `image_shrink.py` sets `PIL.Image.MAX_IMAGE_PIXELS` to prevent multi-gigapixel decompression bombs from crashing the hook subprocess (`608080f`).
- **Worker OSError broadening.** `psutil` calls in `worker.py` now catch `OSError` in addition to `psutil.NoSuchProcess` (`dc7b7ce`).
- **Session CAS re-applies size caps after merge.** `session.py` enforces byte caps after every optimistic-CAS merge so a race cannot inflate the JSON beyond limits (`040c36c`).
- **Windows console-ctrl handler.** `worker_daemon.py` installs a `SetConsoleCtrlHandler` callback (with `atexit` fallback) so the daemon flushes state cleanly on Ctrl-C / service stop (`08028c0`).
- **Hook crash log.** All hook subprocesses now persist uncaught exceptions to `hooks-stderr.log` (100 KB cap, `.prev` rotation), making silent failures diagnosable (`a6a7057`).
- **Concurrent dirty-queue write coverage.** New test covers cross-process `fcntl`/`msvcrt` lock contention on `dirty.txt` (`b96fbc8`).

### Token Savings — compaction / hints / manifest

- **Manifest bold-label bundle.** H3 headers inside the manifest (`### Edited:` etc.) replaced with inline bold labels (`**Edited:**`, `**Syms:**`), saving ~4 tokens per section heading (`de96cd1`, `0b632e3`).
- **Manifest SHA sidecar cache.** `pre_compact` writes a `sentinels/manifest_sha_<session>` sidecar; the manifest is rebuilt only when the session SHA differs, cutting redundant manifest work to near zero (`e1fcbb0`).
- **Manifest tightening bundles.** Two passes removed redundant framing tokens, collapsed multi-line stat rows, and tightened section separators (`04dd25d`, `825312b`).
- **Cross-session grep dedup.** `hooks_read.py` records grep patterns in `global.db::grep_patterns`; repeat patterns across sessions surface a dedup hint without a live session match (`803789b`).
- **`extract_image_summary` helper.** `image_shrink.py` gained `extract_image_summary(path)` returning a structured alt-text dict (dimensions, format, byte size, SHA) so hooks inject a lean summary instead of a raw path (`5ace3a9`, `272ab20`).
- **Ruff filter for bash compression.** `bash_compress.py` gained a `RuffFilter` compressing `ruff check` output to per-rule summaries (≤3 examples each), matching the eslint/mypy filter shape (`d3435d2`).
- **Web dedup `--grep` nudge.** Dedup hint for cached responses ≥5 KB appends a `--grep PATTERN` usage example (`98dbcc6`).
- **Session brief collapsed to one-liner.** Drops the `##` header and `Branch`/`Recent` labels, saving ~6 tokens per session start; git status + branch merged into a single `git status -z -b` call (`105ec45`, `4325849`).
- **Precision recall flags.** `bash-output`, `web-output`, `skill-body`, `read`, and `section` gained `--offset`/`--limit` flags for line-range recall (`3745514`).

### Performance

- **Compact-speed 5-item bundle.** Session JSON carries three new cache fields (`_disk_mtime`, `_pending_hint_save`, `_brief_cache`) eliminating redundant disk round-trips in the hot PreCompact path; manifest skipped when SHA sidecar matches (`dbd1244`).
- **`_resolve_file_rel_db` LIKE cap + suffix fast-path.** Caps LIKE query at 50 rows and adds basename-suffix index probe, cutting worst-case lookup from O(N) to O(log N) (`569b284`).
- **Embeddings chunk-hash scoped to file subset.** `_load_existing_chunk_hashes` filters by `file_id` before loading, avoiding a full-table scan on large DBs (`608080f`).
- **Zero-saving stat rows skipped.** `hooks_common.py` skips the SQLite write when both `tokens_saved` and `bytes_saved` are zero (`04dd25d`).

### DRY

- **`session.py` 6-item bundle.** Extracted `safe_load`, `_merge_lists`, `_cap_dict`, `_bump_read_count`, `_session_path`, and `_atomic_write` helpers from repeated inline patterns (`2f240d3`).
- **paths / config / cli / render / compact bundle.** Deduplicated `_data_root` resolution, `_config_singleton`, CLI option constants, render palette entries, and `_manifest_preamble` fragments (`6943b61`).

### Tests

- Aligned mock stubs and assertions to bold-label manifest format and `-z -b` session brief shape (`0b632e3`).

### Docs

- README top section rewritten for new-user readability; install-first flow and before/after comparison moved above the fold (`6d21153`).

---

_From the 55-iteration baseline:_

### Added

- **Terse-mode hint substitution.** All `session_hint`, `diff_hint`, `bash_dedup_hint`, `grep_dedup_hint`, and `web_dedup_hint` text is processed through terse-mode character replacements (logical units compacted to abbreviations) to reduce token overhead while preserving readability.
- **Output ID suffix in hints and manifest.** Bash, web, and skill cache IDs are rendered as 8-char suffixes in hints and manifest sections (e.g. `b4a2f7d1`) instead of full paths, 60% shorter without loss of clarity or discoverability.
- **Manifest MUST_PRESERVE sealed block.** The compaction manifest prepends a `### MUST_PRESERVE` section sealing critical context that must survive compaction — edited files, key symbols, recent test outcomes — so the summarizer LLM treats it as a load-bearing invariant.
- **Bash dedup-vs-hint filtering.** `token-goat compress` now acts as a filter between dedup hints and command execution: when a cached output exists, the filter surfaces `token-goat bash-output <id>` without re-running the command. One-call access to either cached copy or fresh output.
- **Inline skill checklist in recovery hint.** The post-compaction recovery hint now lists loaded skills inline with a checkbox-style format (🧠 skill_name) so the agent can quickly verify which skills are available for recall.
- **Skip bash snippet when recall available.** When a cached bash output qualifies for the recovery hint, the old bash-snippet copy is omitted and a single `token-goat bash-output <id>` reference is injected instead, cutting noise.
- **Pre-Read structured-file hint.** CSV, JSON, JSONL, and log files now produce a format-aware hint on re-read (e.g. CSV headers, JSON top-level keys, log entry count) instead of a full-file suggestion, ~70% smaller.
- **Pre-Read index-only file suppression.** Lockfiles (`package-lock.json`, `yarn.lock`, etc.), source maps (`*.map`), and build artifacts (`dist/*`, `build/*`) are flagged with a Pre-Read hint that skips file content unless explicitly edited.
- **AVIF image-shrink support.** When Pillow includes libaom, the image-shrink pipeline produces AVIF instead of WebP on suitable content (~15% smaller than WebP); WebP fallback for older builds.
- **Hint fingerprint includes file path.** Session-level dedup hints now incorporate the file path in the fingerprint, preventing false positives when the same range is accessed in different files.
- **What Worked section in manifest.** The compaction manifest gains a `### What Worked` section listing the most recent green test runs (up to 2), surface to the summarizer that prior turns succeeded and context should preserve recent successful patterns.
- **Curator pass skips dedup when ignored.** When the agent's preceding sequence of actions indicates it will ignore dedup hints (e.g., proceeding to re-read immediately after a warning), the curator pass suppresses the hint to save tokens.
- **3-item bundle for cold outputs.** The recovery hint aggregates three categories of activity: (1) activity floor (at least 1 per kind), (2) cap at 12 total items, (3) mature cold outputs (bash/web/skill cache entries with zero recent access). Bundles together related cache hits.
- **Session-level hint budget caps.** Hard per-kind ceilings on re-read hints (5 files max), bash dedup (3 max), web dedup (2 max), skill recalls (4 max). Prevents hint spam while prioritizing the highest-value hints.
- **Inline git diffs + skip git log on clean main.** The compaction manifest now embeds `git diff HEAD` output when files differ from the last commit; when on a clean main branch, git history is entirely skipped.
- **Token-savings benchmark.** A new regression test suite (`test_savings_benchmarks.py`, slow-marked) measures concrete wins: WebP compression ratio, repomap density, hook cold-start latency, DB reindex speed, and manifest coverage. Locks in evidence before release.
- **TODOs section from TaskList.** The compaction manifest now surfaces outstanding tasks from Claude Code's TaskList (`### TODOs`) so the summarizer knows which work is pending and can preserve context around in-flight tasks.
- **Semantic compact output mode.** `token-goat map` defaults to semantic mode (one result per line, ranked by importance) and preserves the old `--full` format for verbosity; applies to `compact-hint` and other list-like outputs for consistency.
- **Unchanged-file Pre-Read short-circuit.** When a file's content SHA matches the cached value, the Pre-Read hook skips hint generation entirely and lets the Read proceed without noise — saves tokens on stable working files.

### Reliability

- **`fail_soft` catches `BaseException` to match contract.** The decorator now catches all base exceptions including `MemoryError`, `SystemExit`, and `KeyboardInterrupt` (re-raised for process-control signals), ensuring the fail-soft invariant holds regardless of lazy-imported module behavior (commit 9c37736).
- **Session cache writes use optimistic CAS to prevent edit-count loss.** Concurrent hook processes can no longer lose mutations; save operations detect `mtime` changes and retry the load-mutate cycle up to 3 times (commit bf95c5a).
- **Dirty-queue append protected by OS file lock.** Concurrent `enqueue_dirty` calls now use `fcntl.flock` (POSIX) / `msvcrt.locking` (Windows) to prevent JSON line interleaving on concurrent writes (commit 30d0e24).
- **Worker claim file auto-recovers from crashes via mtime staleness.** A claim file empty/malformed for >60 seconds is reclaimed as stale, unblocking worker startup after a crash between `O_EXCL` create and `pid` write (commit f6b1dc3).
- **Cross-process contention dedup moved to disk.** The in-process `_REPORTED_CONTENTION` set (meaningless across hook processes) is replaced with touch-files under `contention_marks/`, preventing duplicate stat rows under disk pressure (commit 3d23f19).
- **`safe_run` splits output serialization into its own try block.** `denormalize_response` failures no longer lose the entire hook payload; worst case the harness receives camelCase keys it ignores but still gets the image redirect / hint (commit 3d11a4f).
- **Atomic write in `paths.py` finally-block guards against file clobbering.** The temp-file unlink only fires when rename fails, preventing accidental deletion of unrelated files (commit 3d11a4f).

### Performance

- **Lazy imports in `hooks_session.py`.** Heavy modules (`cache_common`, `compact`) are now imported inside the handler functions rather than at module top-level, cutting the cold-start cost of the PreCompact subprocess from ~190 ms to ~110 ms (~42% faster).
- **Deferred session import in `compact.py`.** `session.py` (which pulls in `sqlite3` and path helpers) is no longer imported at `compact` module load time; moved to the call site that actually needs it, shaving another ~15 ms off cold-start.
- **Compact-skip sentinel.** `hooks_session.pre_compact` writes a touch-file after emitting a manifest. On the next call, if the session file is <5 min old and no edits have been logged since the sentinel, the subprocess exits in <1 ms without loading any session or compact modules — skipping the subprocess entirely on fresh sessions.
- **Skip git ops when `cwd` is not a repo.** `compact.build_manifest()` now checks `git rev-parse --is-inside-work-tree` once and skips all `git diff` / `git log` calls when the working directory is outside any repo, saving 60–100 ms per hook fire in non-repo contexts.
- **Drop `ThreadPoolExecutor` from manifest build.** The two parallel `git diff` + session-load futures were serialised by the GIL anyway on CPython; removed the executor and ran the calls sequentially, eliminating thread-pool overhead.
- **`pytest-xdist --dist=loadscope`.** CI and local test runs now use `xdist` with `loadscope` distribution so tests in the same module share a worker, keeping module-scoped fixtures alive across their module without cross-contamination.
- **Module-scoped fixtures for read-only groups.** `conftest.py` promotes fixtures that set up read-only DB state (project index, parser caches) from function scope to module scope, amortising the 80× reindex cost across all tests in a module.
- **`make_fake_git_repo` helper.** A lightweight helper in `conftest.py` creates a marker-only fake repo directory (no actual `git init`) for tests that need a project root without triggering real git history indexing.
- **`pytest-randomly` + `pytest-rerunfailures`.** Random seed ordering exposes order-dependent flakes; `--reruns 1` retries a single failing test once before marking it failed, absorbing transient OS/filesystem timing issues without hiding real failures.

### DRY Consolidation

- **`extract_tool_response_text` unifies bash/web/skill response extraction.** The three PostToolUse handlers shared identical `payload["tool_response"] → text` walks; extracted into `hooks_common.extract_tool_response_text()` with sibling `extract_tool_response_pair()` for exit codes / status codes (commit 3d23f19, 3d11a4f).
- **Per-cache `_OutputStatDict` and `_safe_join` consolidated.** The bash/web/skill caches duplicated `class _OutputStatDict` byte-for-byte; exported from `cache_common` and reused via `functools.partial` (commit d24a5b4).
- **`cache_common.short_content_hash()` replaces triplicate hash helpers.** Bash, web, and skill caches each had their own `sha256(text)[:16]` logic; unified into a single `short_content_hash(text)` (commit 47072d6).
- **`_run_history_listing_command` unifies bash/web/skill history listing.** The three `list_outputs`→JSON/text rendering paths shared identical slicing, paging, and sidecar assembly (commit 985ea60).
- **`_run_output_recall_command` merges bash/web output recall.** The two `cmd_*_output` commands duplicated slicing, grep, head/tail, and recall stat recording; collapsed into a single dispatcher (commit a5c68d4).
- **`humanize_bytes` moved to `render/ansi.py` for cross-module reuse.** The compact/cli_doctor/stats modules each had their own bytes-formatter; canonical version now in `render/ansi` (commit 6e1ba74).
- **Language decorator walker extracted to `common.extend_starts_for_decorators()`.** Python and TypeScript adapters shared the same decorator-offset iteration skeleton (commit 8aa1c30).
- **`session.safe_load()` consolidates try/except for session loading.** Five hook locations had identical `try: load() except (OSError, ValueError): return None` blocks (commit 9c3d8d1).
- **`cache_common.get_cache_dir()` + `sidecar_path_for()` extracted.** Per-cache `_X_outputs_dir` and `sidecar_meta_path` wrappers unified (commit df41374).
- **`util.humanize_bytes()` canonical bytes formatter.** Replaces duplicates in compact.py, cli_doctor.py, stats.py (commit bcfe025).
- **`hooks_common.run_dedup_hint()` template collapses four dedup handlers.** Bash/grep/glob/web dedup handlers shared 35 lines × 4 of load-session-build-hint-record-stat glue (commit 809aed4).

## Improve loop summary — 2026-05-24

- **Scope.** 55 iterations across four design areas: context savings (20+ items), reliability (7 items), DRY refactoring (11 items), and compaction/test-suite speed (9 items). Design docs: `docs/plans/2026-05-23-{context-savings,reliability,dry,speed}-design.md`.
- **Commits landed.** ~30 commits from `c2db365` to `3ddf1ab`, covering fixes, refactors, perf improvements, and test infrastructure.
- **Token-savings claims.** Per design-doc estimates: hook cold-start 190 ms → 110 ms (−42%); pre-compact skipped entirely on fresh sessions (<1 ms); git ops skipped in non-repo dirs (60–100 ms saved); bash/grep/web dedup hints 40% shorter via terse-mode; hint budget caps prevent spam (5/3/2/4 per kind); structured-file hints ~70% smaller than full-file suggestion.
- **Reliability wins.** `fail_soft` now catches `BaseException`; session CAS prevents edit-count loss under concurrent hooks; OS file lock guards dirty-queue appends; worker claim auto-recovers from crash; cross-process contention dedup moved to disk.
- **DRY wins.** ~600 lines of duplication removed: unified tool-response extractor, consolidated cache helpers, single `humanize_bytes`, collapsed dedup-hint template, unified CLI output/history commands, shared language decorator walker, and `safe_load` session helper.

## [0.8.0] - 2026-05-23

### Added

- **Skill preservation through compaction.** Every `PostToolUse(Skill)` invocation captures the loaded skill body to a persistent on-disk cache (`data_dir() / "skills"`, 5 MB LRU-evicted) keyed by `(session, skill_name, content_sha)`. The compaction manifest gains an `### Active Skills` section listing every loaded skill with a `token-goat skill-body <name>` recall hint, and the post-compact recovery hint surfaces the same list under `**Skills**:`. Solves the "I forgot parts of the skill after compaction" problem — load-bearing prose (Ralph's DoD gates, /improve's iteration sequence, any multi-thousand-token protocol skill) is recoverable without re-invoking the skill, which would replay any side effects and pollute the conversation with a fresh tool-result block. Configurable via `config.toml [skill_preservation]` (`enabled`, `max_cache_bytes`) or disabled at runtime via `TOKEN_GOAT_SKILL_PRESERVATION=0`.

- **`token-goat skill-body <name>`** — retrieve a cached skill body by name. Defaults to a head+tail view for large bodies; pass `--full` for everything, or narrow with `--head N`, `--tail N`, `--grep PATTERN`. Falls back to reading the original `~/.claude/skills/<name>/SKILL.md` (or plugin-path equivalent) when the cache entry has been evicted but the source path was recorded.

- **`token-goat skill-history`** — list cached skill bodies (newest first) with their IDs, byte sizes, ages, and skill names.

- **Skill marker (🧠) in the compaction manifest legend** — joins `edited=✎`, `read=→`, `stale=⚠`, `cold=❄` so the compaction LLM has a stable glyph vocabulary for every section type.

- **4-section recovery hint allocator.** `_allocate_recovery_slots` now distributes 18 total slots across Files / Bash / Web / Skills with skill loads taking priority in the greedy expansion pass (they're the load-bearing protocol prose the feature exists to preserve — files/bash/web survive compaction better than skill bodies do).

## [0.7.0] - 2026-05-20

### Added

- **Grep output compression.** Large `grep`/`rg`/`ag`/`ack` results (>30 lines) are compressed to a file-level summary: top 20 files by match count, totals included, full output cached for `token-goat bash-output` recall. Typical savings: ~80%.

- **Bash loop-detection escalation.** The same command run twice triggers a "ran 2×" escalation; three or more repeats produce a "WARNING: ran N×" advisory. Stops runaway loops from burning context unnoticed.

- **Session-wide hint deduplication.** Identical hints are suppressed after their first injection within a session. SHA-256 fingerprinting with a JSON-persisted `hints_seen` set means the agent never gets nagged twice for the same file.

- **Session orientation brief.** At session start in a dirty git repository, a compact block (~50 tokens) is injected: current branch, modified/staged/untracked counts, and the five most-recent commits. Disable via `TOKEN_GOAT_SESSION_BRIEF=0` or `[session_brief] enabled = false` in config.toml.

- **Adaptive PreCompact manifest budget.** The manifest budget scales from 200 to 600 tokens based on edit count, symbol accesses, and bash activity. Sessions with little activity get a lean manifest; complex ones get the full picture.

- **Git diff --stat in PreCompact manifest.** A `git diff --stat HEAD` summary (capped at 8 lines / 200 chars) is now included in the compaction manifest. The compaction LLM always sees which files drifted from the last commit, even when the session cache doesn't list them as edited.

- **Symbol names in re-read hints.** Re-read hints now include up to three symbol names previously accessed in the flagged file (e.g., `[symbols: login, get_user, Session]`), so the agent can decide whether `token-goat read file::symbol` is sufficient.

- **Error-preserving smart truncation.** When bash output exceeds the size cap, the trimmed view keeps: first 10 lines + up to 10 error-signal lines with 2-line context + last 10 lines, separated by `--- N lines omitted ---`. Errors are never lost to truncation.

- **Loaded version in `token-goat stats`.** The stats report now shows the running token-goat package version: a header line in the ANSI renderer (`token-goat  v0.6.1`), the version in the rich fallback renderer's panel title, and a top-level `version` field in `--json` output. Confirms at a glance which build produced the numbers.

### Fixed

- **Git-history indexing batches its writes in one transaction.** `_index_history_inner` inserted up to 200 commit rows on an autocommit connection (`isolation_level=None`), so every `INSERT` committed on its own and the trailing `conn.commit()` was a no-op: 200 separate fsyncs and 200 writer-lock acquisitions per reindex sweep. The batch now runs inside a single `BEGIN`/`COMMIT`, acquiring the lock and committing once. The `last_indexed_at` staleness marker is also written only when at least one commit stored, so a batch that wholly failed (for example, a database that stayed locked throughout) no longer stamps itself "indexed" and suppresses the retry for an hour.

- **`project_writer_lock` acquisition is now atomic.** `_try_acquire` checked `lock_path.exists()` and then `write_text` — a check-then-write with a TOCTOU window: two callers that both observed the file absent each wrote the lock and each believed it held it, so two `index_project` runs could write the same per-project database concurrently. Acquisition is now a single `os.open(O_CREAT | O_EXCL)` create — the atomic-mutex pattern the worker slot claim already uses — and `_stale` falls back to the lock file's mtime so the brief create-then-write window can't be misread as a dead lock.

- **Git-history indexing moved to the background worker.** The SessionStart hook spawned `git_history.index_project_history` on a `daemon=True` thread inside the hook process, which exits within milliseconds — killing the thread before the indexing finished. Git-history hints are now refreshed by the worker's periodic reindex sweep, which runs in a durable process; `index_project_history` is idempotent and staleness-gated (1 h), so the move adds no measurable cost.

- **Worker claim-slot no longer wedges on a write failure.** If `os.write` failed after `_try_claim_worker_slot` created the claim file, the file descriptor leaked and an empty claim file was left on disk. `_worker_claim_is_stale` treats an empty claim as not-stale (to protect the create-then-write window), so that orphan could never be reclaimed and the single-worker slot stayed blocked. The fd is now closed and the empty file removed on a write failure. Separately, `run_daemon` wrapped its claim-file cleanup in a `finally` whose `try` began only after `_write_pid` / `_register_autostart` / `cleanup_on_startup`, so an exception in any of those skipped the cleanup — the `try` now covers all startup work.

- **Session-start git brief is capped by one shared deadline.** `_build_session_brief` ran three git subprocesses (`rev-parse`, `status`, `log`) sequentially, each with a fixed 2 s timeout, so a slow or pathological repository could stack a ~6 s pause onto session start. The three calls now share a single ~2.5 s wall-clock budget, and a call is skipped once the budget is spent.

- **A deferred dirty-queue drain no longer slows re-indexing.** On Windows a concurrent `enqueue_dirty` can hold `dirty.txt` open, making `os.replace` fail with a sharing violation; `drain_dirty_queue` retries and then defers. It returned `[]` for that case — indistinguishable from a genuinely empty queue — so the worker counted a deferred drain as an idle cycle and let adaptive back-off drift re-indexing toward its 10 s maximum while edits piled up. `drain_dirty_queue` now returns `None` on a deferral, and the worker resets the idle counter instead of incrementing it.

- **`token-goat doctor` no longer integrity-checks the production database.** The stats summary opened `global.db` through the read-write path, which runs `PRAGMA integrity_check` on connect — multi-second on a large `global.db`, and it created the database file as a side effect when one did not exist yet. The summary now reads through `open_global_readonly()`, so `doctor` stays fast regardless of database size and never mutates the database it is diagnosing.

- **`token-goat stats` breakdown rows now rank by share.** The "By kind", "By day", and "By project" tables emitted rows in byte-sorted order while the share column they display is token-derived, so the share percentage zig-zagged whenever bytes and tokens ranked rows differently (an image-heavy day saves bytes but ~0 tokens). Each section renderer now orders its rows by the same share metric it displays — "By source" already did this.

- **Unbounded `global.db` WAL growth.** Every hook writes stat rows to `global.db`, and under a heavy multi-agent burst its passive autocheckpoints were perpetually blocked by overlapping readers, so the write-ahead-log file only ever grew — one session reached an 11 GB `global.db-wal`, after which every hook (including the SessionStart hook that runs on `/compact`) stalled for minutes scanning it. Connections now set `PRAGMA journal_size_limit` so the WAL file is truncated after each checkpoint, and the worker force-runs a `wal_checkpoint(TRUNCATE)` on `global.db` every maintenance cycle. A `tests/test_wal_growth_guard.py` regression suite, wired into the pre-commit hook, locks both halves of the fix in place.

- **Temp files and automation artifacts excluded from PreCompact manifest.** Paths under `/tmp/`, Windows `%APPDATA%`, `.improve-state-*.json`, and `improve_commit_msg_*` are filtered before the manifest renders. Previously they leaked into "Files Edited" and wasted manifest budget on entries the compaction LLM couldn't use.

## [0.6.1] - 2026-05-19

### Changed

- **Token-savings tuning across the hint, compaction, and output surfaces.** Three internal improvement sweeps tightened the text Token-Goat injects into the conversation: shorter session read-hints and bash / grep / web dedup hints, leaner PreCompact manifest framing, a more compact post-compaction recovery hint, terser `token-goat map` output framing, and budgeted git-history and project-memory injections. The CLAUDE.md / SKILL.md / AGENTS.md directive blocks written by `token-goat install` were condensed without dropping any guidance. The result is the same hints for fewer tokens.
- **Command `--json` output is now compact single-line JSON.** `stats`, `map`, `config`, `bash-output`, `web-output`, `bash-history`, `web-history`, `compact-hint`, and the surgical-read commands emit `--json` with no indentation whitespace. JSON written to disk (settings.json and config files) stays pretty-printed for human editing.
- **`bash-output` and `web-output` recall now default to a smart head-and-tail view** for large cached outputs, with `--full` to retrieve the whole thing.
- **DRY pass on the output-cache layer.** `bash_cache` and `web_cache` were near-parallel implementations; their shared pieces (the cache-filename pattern, session-id sanitization, JSON-sidecar loading, and LRU disk-cap eviction) now live in one `cache_common` module. No user-visible behavior change. Regression tests were added across the token-savings, stat-accounting, and cache surfaces.

### Fixed

- **`compact_recovery` stat accounting.** The post-compaction recovery hint recorded no injection overhead and was bucketed under the `other` source instead of `compact`. It now records a `compact_recovery_overhead` row consistent with the `session_hint`, `diff_hint`, and `bash_dedup_hint` siblings, and both `compact_recovery` kinds map to the `compact` source bucket.
- **`bash-output` and `web-output` recalls were credited no savings.** Retrieving a cached output instead of re-running a command, or a cached response instead of re-fetching a URL, now records a `bash_output_recall` or `web_output_recall` stat. This closes a measurement gap where thousands of cache hits showed zero tokens saved.

## [0.6.0] - 2026-05-19

### Added

- **Bash output compression.** PreToolUse hook on Bash detects compressible commands and rewrites them to flow through `token-goat compress`, which runs the original through the system shell, captures stdout + stderr, applies a per-tool filter, and prints a compressed view that surfaces failures first. Twelve filters cover the noisiest dev commands: `pytest`, `jest` / `vitest`, `cargo`, `npm` / `pnpm` / `yarn` / `bun`, `docker` / `buildah` / `podman`, `kubectl` / `helm`, `aws`, `ruff` / `eslint` / `mypy` / `pyright` / `pylint` / `stylelint` / `biome` / `tsc`, `git`, `make` / `ninja` / `gradle` / `mvn` / `bazel` / `go`, `terraform` / `tofu`, `pip` / `pipx`. Typical savings: pytest 80-97%, npm 88%, docker 75%, linters 80%. Each filter strips ANSI, collapses `\r` progress bars, dedupes consecutive lines, groups linter issues by rule (3 examples per code), keeps every error and warning block verbatim, and caps total output at 1000 lines / 64 KiB. The wrapper preserves the original exit code, kills the process group on timeout (SIGTERM then SIGKILL after a grace period on POSIX), and caps each stream capture at 32 MiB. Configurable via `[bash_compress]` in config.toml (`enabled`, `disabled_filters`, `max_lines`, `max_bytes`, `timeout_seconds`) or disabled with `TOKEN_GOAT_BASH_COMPRESS=0`. Savings are recorded per filter as `bash_compress:<name>`. New CLI subcommand `token-goat compress` for previewing compression on any command.
- **Post-compaction recovery hint.** ``SessionStart`` now detects ``source == "compact"`` and emits a one-shot ``additionalContext`` block listing the most recently-read files, cached Bash outputs (``token-goat bash-output <id>``), and cached WebFetch responses (``token-goat web-output <id>``) from the *pre*-compaction session.  The cache is intentionally preserved across the compact so the recovery hint has data to draw from; the cache reset still fires on every other source value (startup / resume / clear / unknown).  When the prior session was empty, no hint is emitted — the recovery path is silent until it has something worth surfacing.
- **Grep dedup hint.** A repeat ``Grep`` invocation with the same ``(pattern, path)`` pair within the staleness window now produces a ``"this ran ~Ns ago and matched N lines"`` advisory.  Same mechanism as the bash and web dedup hints but pointed at the existing ``session.greps`` history — no new disk store is involved.  Suppressed when the prior result was below 50 matches (the hint preamble would approach the saving).
- **WebFetch result cache.** A new ``PostToolUse(WebFetch)`` hook persists non-image response bodies to ``data_dir() / "web_outputs"`` and records the ``(url_sha → output_id)`` mapping in the session cache.  On a repeat fetch of the same URL the pre-fetch hook emits a dedup hint pointing at ``token-goat web-output <id>``, mirroring the bash-cache pattern.  Two new CLI commands surface the cache: ``token-goat web-output`` (with the same ``--head`` / ``--tail`` / ``--grep`` slicers as ``bash-output``, plus ``numbered_lines`` in JSON mode) and ``token-goat web-history``.  Disk store is byte-capped (32 MB default) with oldest-first eviction + paired sidecar cleanup.
- **Dockerfile section extractor.** ``Dockerfile``, ``Containerfile``, and ``*.dockerfile`` now produce one ``Section`` per ``FROM`` build stage, so ``token-goat section Dockerfile::builder`` extracts a single stage instead of forcing a full-file read.  Multi-stage builds resolve by ``AS <name>`` alias when present; unnamed stages fall back to the image reference so they remain addressable.
- **Pre-Grep matcher + pre-Bash matcher in install.** ``PreToolUse`` now fires on ``Read|Grep|Bash`` (matcher widened from the prior ``Read|Bash``) so the new Grep dedup hint actually runs alongside the Bash compression rewriter from the prior entry.
- **``token-goat doctor`` cache visibility.** A new ``Caches`` section reports the size, file count, and oldest-entry age for ``bash_outputs/``, ``web_outputs/``, and ``session_snapshots/``.  Each row warns when the directory has grown more than 10% over its byte cap, surfacing potential eviction gaps without needing to grep the data directory by hand.
- **Close-match auto-redirect on ``token-goat symbol``.** When a symbol query returns zero results and the project has exactly one close-match candidate at high confidence (difflib ratio ≥ 0.85), the lookup is automatically re-run against that candidate.  The redirected response carries a ``redirected_from`` field in JSON output and a ``(redirected from: …)`` marker in plain-text output so the substitution is auditable.  Pass ``--strict`` to disable the redirect and get the previous "Did you mean: …?" suggestion list behaviour.
- **``bash`` and ``web`` source buckets in stats.** ``token-goat stats`` now attributes ``bash_*`` kinds to a visible ``bash`` bucket (orange in the fancy renderer) and ``web_*`` kinds to a new ``web`` bucket (yellow), so the new mechanisms get first-class lines in the by-source panel instead of falling into the ``other`` catch-all.  ``grep_dedup_hint`` lands in the existing ``hint`` bucket because it prevents a Read-equivalent burst (consistent with ``diff_hint``).
- **Bash output interception.** A new `PostToolUse(Bash)` hook persists large stdout/stderr to disk under `data_dir() / "bash_outputs"` and records the command in the session cache. When the same command is about to run again in the same session, the pre-Bash hint suggests `token-goat bash-output <id>` (optionally with `--head N`, `--tail N`, or `--grep PATTERN`) instead of re-executing — avoiding both runtime cost and duplicated tokens. The store is byte-capped (16 MB default) with oldest-first eviction; outputs above 2 MB are tail-preserved with a truncation marker. Two new CLI commands surface the cache: `token-goat bash-output` retrieves a sliced view, `token-goat bash-history` lists cached entries newest-first.
- **Diff-aware re-read.** `post_read` now writes a per-session content snapshot (under `data_dir() / "session_snapshots"`, capped at 256 KB per file and 150 snapshots per session) so a follow-up `Read` after a `Write`/`Edit`/`MultiEdit` can be answered with a unified diff hint instead of a `pre_read` blocking message that silently allowed the full re-read. The diff is bounded to 4 KB and only fires when the realised saving exceeds ~250 tokens; below that the existing session-cache hint path runs unchanged. Stats record both the realised saving (`diff_hint`) and the hint's injection cost (`diff_hint_overhead`) for honest accounting.
- **TOML, YAML, JSON, INI, CFG, and dotenv section extraction.** `token-goat section pyproject.toml::tool.ruff` (and equivalents for `.yaml`, `.yml`, `.json`, `.ini`, `.cfg`, `.env`, and `.envrc`) now extract a single table/key block instead of forcing a full-file read. The TOML scanner emits one `Section` per `[table]` and `[[array]]` header; the YAML scanner emits top-level keys plus one nested layer (`spec.replicas`-style) computed from the file's detected indent; JSON gains depth-1 section detection on pretty-printed files; INI/CFG indexes one section per `[name]` header; `.env`/`.envrc` index each `KEY=value` assignment as a symbol. None of the six pulls in an extra dependency — all use line-scanners and the existing stdlib parsers. The parser dispatcher gained a basename-keyed table (alongside the existing suffix table) so dotfiles with empty extensions (`.env`, `.envrc`) resolve correctly.
- **Stale-data sweeps in the background worker.** `cleanup_on_startup` now also drops snapshot directories older than 24 hours and enforces the bash-output byte cap, so a long-lived install does not accumulate per-session debris.
- **Compaction manifest gained a "Commands Run" section.** The PreCompact manifest now surfaces the most recent meaningful Bash invocations (cmd preview, exit code, byte size, cache ID) so the test/build context that drives the next agent turn survives compaction. Each entry includes the `token-goat bash-output <id>` cache key for surgical recall. `event_count` includes `bash_history` so a session whose only activity is a cached test run still clears the `min_events` threshold.
- **`token-goat bash-output --json` now surfaces line numbers.** The JSON shape adds `numbered_lines` (a 1-based, original-body-anchored `[{lineno, text}]` list) and `total_lines`, mirroring the surgical-read response shape elsewhere in the codebase. Agents can now `--head` / `--tail` / `--grep` filter and still map back to positions in the original output.
- **Hardened PostToolUse Bash payload extraction.** `_extract_bash_response` now tolerates every documented Bash result shape: dict-with-named-fields (Claude Code), MCP `CallToolResult` content arrays, bare-string blobs, top-level flattening (no `tool_response` wrapper), `tool_result`/`response` aliases, `returncode` and string-typed `exit_code` variants. Each shape is covered by a dedicated regression test in `test_post_bash_payloads.py`.

### Changed

- **`reset_session`** now also removes per-session content snapshots, matching the existing JSON-cache reset semantics.
- **Codex Bash matcher in `~/.codex/config.toml`** now points at the new `post-bash` hook instead of `post-read`; under Codex, `post-read` previously did nothing for `Bash` calls (no branch in the handler), so this is a strict gain.
- **`bash_cache.evict_old_entries`** removes body + sidecar pairs together, and runs a second pass to sweep any orphan sidecars left over from out-of-band deletion. Previously, manual `rm` of a body file or a write race could leave a `.json` sidecar with no matching body that lived forever.
- **README "Updating" subsection.** New `### Updating` block under `## Install` consolidates the three update paths (weekly auto-update via scheduled task/crontab, on-demand `uv tool upgrade`, force-reinstall via `uv tool install --reinstall --force`) plus how to disable the auto-update entry. The miss-suggestions feature row and the prose footnote previously implied "Did you mean?" was the only miss-handling path; both now name the `symbol` auto-redirect (with `--strict` opt-out) alongside the "Did you mean?" fallback on `read` / `section`.
- **Internal DRY pass across the install, languages, bridges, hooks, and CLI surfaces.** Routing-table rows (Claude / Codex / skill) now compose from one `_ROUTING_ROWS` list with per-harness "Not this" columns. The config-file language adapters (TOML, INI, YAML, Dockerfile) share `decode_source_text`, `bom_strip_first_line`, and `assign_flat_end_lines` helpers in `languages/common`. The openclaw and opencode TS bridges now both route post-tool events through the same `POST_HOOK` table shape, and the four `install_/uninstall_*` plugin functions delegate filesystem work to `_write_plugin_file` / `_remove_plugin_file`. The Windows registry path lives in one `_HKCU_RUN_PATH` constant and the open/close pairs are now context-managed. Typer's `--json` and `--context` options collapse to two module-level `_OPT_JSON` / `_OPT_CONTEXT_LINES` constants reused across 19 commands. `tests/conftest.py` now exports a single `patched_home` fixture replacing the per-file `_fake_home` / `_patch_home` boilerplate. No user-visible behavior changes; the rendered AGENTS.md / CLAUDE.md content is byte-identical to the previous output.

### Fixed

- **`paths.open_log_file` returned a `StreamHandler` instead of a `FileHandler` on POSIX.** The type hint and docstring claimed `FileHandler`, but the implementation wrapped `os.fdopen()` in a bare `StreamHandler` to apply 0o600 permissions, breaking `isinstance(handler, FileHandler)` checks (such as the `test_setup_logging_skips_console_handler_when_not_tty` worker test). Replaced with a private `FileHandler` subclass that overrides `_open` to apply the tighter mode at open time, preserving the type identity callers depend on.
- **`test_canonicalize_drive_case_collapsed` and `test_canonicalize_cross_shell_paths_produce_same_hash` failed on POSIX.** Both assert Windows-shell drive-letter normalisation invariants that only fire when `Path.resolve()` returns an absolute Windows path; on POSIX `Path("C:/Projects/foo").resolve()` becomes `cwd + "/C:/Projects/foo"` and the assertions test against synthesised POSIX paths. Now skipped on non-Windows with an explanatory message.
- **Latent winreg handle leak in `install_worker_task` and `uninstall_tasks`.** The manual `OpenKey` / `CloseKey` pairs left the registry key open if `SetValueEx` or `DeleteValue` raised before the `CloseKey` line. Switched to `with`-statement context managers so the handle releases on the unhappy path too.

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
