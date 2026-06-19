# Changelog

All notable changes to Token-Goat are documented in this file. Format follows Keep a Changelog. Token-Goat follows Semantic Versioning starting at 1.0.

## [Unreleased]

## [1.9.3] - 2026-06-18

### Added

- **`token-goat callers <symbol>` — show which functions call a given symbol.** Groups results by caller: for each function that references the symbol, shows the file, caller name, and every line where it invokes the symbol. Complements `refs` by showing the call chain rather than raw usage lines.

- **`.tokengoatignore` — per-project exclusion file at project root.** Add gitignore-style glob patterns (one per line, `#` comments supported) to skip files and directories from indexing, on top of built-in skip lists. Run `token-goat ignores` to see what's active.

- **`token-goat semantic --mode keyword|hybrid` — two new search modes.** `--mode keyword` runs BM25 keyword search over indexed chunk text — no embedding model needed. `--mode hybrid` combines BM25 and vector rankings via reciprocal rank fusion, which helps when a query has distinctive terms that pure semantic matching would drift past. The default (`--mode vector`) is unchanged.

- **`token-goat arch` — project-wide import graph summary.** Shows hub modules (sorted by how many files import them), entry-point files that nothing imports, and circular import chains — all derived from the existing `imports_exports` index with no extra indexing step. For per-file depth, use `token-goat deps <file>`.

- **`token-goat pack <patterns>` — bundle files into a single LLM-ready output.** Collects files matching glob patterns and writes them as Markdown (default), XML, or plain text, with a manifest table of per-file line and token counts. `--line-numbers` prefixes each line; `--instruction-file` appends a task prompt; `--output` writes to a file instead of stdout; `--no-ignore` bypasses `.tokengoatignore`. Reads file paths from stdin when no patterns are given and stdin is not a tty. Path traversal and symlink escape are both checked.

- **`token-goat budget <patterns>` — token-cost estimate for a file set.** Reads each matching file, calculates a rough token count (~4 chars/token), and prints results sorted by cost descending. `--context <N>` shows what percentage of an N-thousand-token window each file would fill. `--json` for machine-readable output. Run before `pack` to decide what to include.

- **`token-goat todo [--kinds K] [--group file|kind]` — scan indexed files for TODO-family markers.** Reads file paths from the project index and scans each for `TODO`, `FIXME`, `HACK`, `XXX`, and `NOTE` comment markers. Groups by file by default; `--group kind` to group by marker type; `--kinds` to filter to a subset; `--json` for machine output. Markers in string literals and non-comment lines are excluded.

- **`token-goat failures [src]` — extract failing test blocks from test runner output.** Parses pytest, Jest, Go, and Cargo output and returns each failure as a labeled block; passing tests and preamble are dropped. Reads stdin by default; pass a file path for saved output. `--json` emits a structured array.

- **`token-goat trace [src]` — condense Python exception tracebacks to project-owned frames.** Strips library, stdlib, and virtualenv frames, keeping only the frames in your code. Chained exceptions preserve their cause notes; bare exceptions without a message (e.g. `KeyboardInterrupt`) are handled. `--keep N` (default 5) caps the frame count. `--json` for structured output.

- **`token-goat lockdeps [path]` — summarize lock file dependencies as a compact table.** Reads poetry.lock, uv.lock, requirements.txt, Pipfile.lock, package-lock.json, Cargo.lock, and yarn.lock. Returns direct dependencies only — optional packages and nested transitive entries are excluded. `--json` for structured output.

- **`token-goat logfold [src]` — collapse consecutive duplicate log lines.** Consecutive runs of identical or structurally equivalent lines fold to a single `[Nx] line` entry. Normalizes ISO timestamps, UUIDs, IPs, and short hex IDs before comparing so the same event logged with different values folds correctly. `--tail N` keeps the last N lines after folding; `--no-normalize` disables normalization; `--json` for structured output.


### Fixed

- **Path traversal bypass in `_is_system_path()`.** `bash_parser.py` appended `..` even at root of an absolute path, letting `/../../etc/passwd` slip past the system-path block. Now discards `..` at root. Four regression cases: `/../etc/passwd`, `/../../etc/passwd`, `/etc/./../../etc/passwd`, `/sys/../../../sys/kernel`.

- **SQL identifier quoting in `db._count()`.** Table names are now `[bracket]`-quoted — defense-in-depth behind the existing allowlist.

### Changed

- **Hook dispatcher watchdog: `asyncio.wait_for` replaces `Thread.join` + `is_alive()`.** `Thread.join(timeout) + is_alive()` doesn't guarantee the watchdog fires at exactly the budget — OS thread scheduling introduces jitter. `asyncio.wait_for` raises `TimeoutError` precisely at the deadline. The handler's result comes back via `asyncio.Future` + `call_soon_threadsafe`; `threading.Lock` is gone. All handlers remain synchronous; external behavior is unchanged.

## [1.9.2] - 2026-06-18

### Changed

- **Default hook watchdog timeout reduced from 5000 ms to 700 ms.** `HooksConfig.watchdog_ms` and all fallback constants now default to 700 ms. The adaptive doubling-on-timeout mechanism (capped at 30 000 ms) is unchanged — slow CI machines or cold-cache environments will still recover automatically. A new `HOOKS_WATCHDOG_DEFAULT_MS` constant in `config.py` is the single source of truth used by `HooksConfig`, the TOML fallback path, and `hooks_common.py`, so the value only needs to change in one place.

### Performance

- **Surgical-read hint memoized by file path and mtime.** `_try_surgical_read_hint` now caches its DB query result keyed by `(abs_path, mtime_ns, req_start, req_end, limit_is_sentinel)`. Repeated reads of the same file range within a session skip the SQLite lookup entirely. The cache is invalidated automatically when the file changes (mtime differs). The per-session cache is also cleared between tests via the `tmp_data_dir` fixture to prevent cross-test contamination.

- **Symbol-not-found retry command.** When `token-goat read file::symbol` finds no exact match but exactly one close suggestion exists, the output now includes a ready-to-run `token-goat read "file::ClosestSymbol"` command rather than a plain name list, so the next attempt requires no manual editing.

## [1.9.1] - 2026-06-17

### Added

- **Prompt injection and exfiltration protection for web content.** `hooks_fetch.py` now runs `flag_external_content()` on every fetched page (head + tail window scan) before caching. When a pattern matches, a warning prefix is prepended to the cached body so every future recall inherits the flag without a re-scan. All fetched content is also wrapped in an `=== BEGIN/END UNTRUSTED WEB CONTENT ===` fence. The log line names the matched pattern (`ignore-all-instructions`, `exfil-api-key`, etc.).

- **Eight injection-detection improvements in `injection.py`.** NFKC normalisation + invisible-char stripping on a detection-only copy; Unicode Tag-block (U+E0000–E007F) detection as a smuggling signal; `_SEP = [\s\W]{1,4}` bounded separator that handles markdown bold and punctuation without bridging across words; named `(label, pattern)` tuples so every log line identifies which pattern fired; `_classify()` returning a 3-tuple `(inj, exf, label)`; `flag_external_content()` with head+tail windowing; `wrap_external_content()` for the deterministic fence; and `check_hint_for_injection()` which redacts only the matched span (never prepends a multi-line banner) and checks only exfil + Tag-block in hint text.

- **New exfiltration-to-URL pattern.** Catches `send/post/exfiltrate secrets … to https://…` and `… to webhook` phrases.

- **`InjectionConfig` config toggle.** `[injection] enabled = false` in config TOML or `TOKEN_GOAT_INJECTION_ENABLED=0` env var disables all injection scanning. Default: enabled.

- **pi-coding-agent extension bridge.** `token-goat install --pi` writes a TypeScript extension to `~/.pi/agent/extensions/token-goat.ts` that bridges pi's extension events (`session_start`, `tool_call`, `tool_result`, `session_before_compact`, `session_compact`) to token-goat's subprocess hook protocol. Read/grep/glob/bash/fetch tool calls fire pre- and post-hooks; arg names are remapped between pi's camelCase API and token-goat's snake_case wire format. Compaction is handled via pi's replace-only model: the token-goat manifest is captured at `session_before_compact` and injected as a `nextTurn` message after `session_compact` so it survives into the new context window. `token-goat uninstall --pi` removes the extension. Project-local installs are supported by passing a `target_dir` directly to `token_goat.bridges.install_pi_plugin`. Original implementation by [@eSaadster](https://github.com/eSaadster).

## [1.9.0] - 2026-06-16

### Added

- **`TerraformFilter` extended: `terraform show` compression and plan data-source detection.** `terraform show` output now strips noise attributes (id, arn, timeouts, tags blocks) per resource block and appends a suppression note; only meaningful fields survive. `terraform plan` unchanged-block detection now covers data-source read-during-apply blocks in addition to managed-resource no-op blocks.

- **`KubectlFilter` extended: event grouping and describe compression.** `kubectl events` output groups events by `REASON` with a per-group count and a field-selector hint. `kubectl describe` collapses label and annotation blocks to line counts, preserves the Conditions table in full, and retains container resource (requests/limits) fields.

- **`NpmInstallFilter` extended: warn collapsing and verbose line suppression.** `npm warn` lines after the first 3 are collapsed to a suppression note. Verbose timing, sill, http, and verb lines are suppressed entirely. Braille spinner reify progress lines are stripped.

- **Three-layer watchdog budget resolution.** `_resolved_watchdog_ms()` now reads `config.load().hooks.watchdog_ms` (default 5000 ms) when no `TOKEN_GOAT_HOOK_WATCHDOG_MS` env var is set. Previously it fell straight through to the 2000 ms compile-time constant, ignoring whatever `[hooks].watchdog_ms` was set to. Resolution order: (1) env var, (2) project config baseline (process-level mtime-cached, one `os.stat()` on the fast path), (3) `_HOOK_WATCHDOG_MS = 2000 ms` compile-time fallback. Values below the 100 ms floor are clamped regardless of layer.

- **Reread-deny hint shows real indexed symbols.** `_handle_reread_deny` now queries the project DB for up to 8 non-import, non-variable symbols in the denied file and emits exact `token-goat read "path::Symbol"` commands in the hint instead of the static `::SymbolName` placeholder. The lookup uses `find_project` from the file path, so no `cwd` parameter is required. If the file is not indexed or the query fails, the hint falls back to the generic placeholder silently.

- **`_handle_doc_compact` auto-spawns `compact-doc` in the background.** When the section-map path fires for a large markdown file, it now launches `compact-doc <file>` as a fire-and-forget subprocess so the compact sidecar is ready on the next read. A per-file session fingerprint (`compact_doc_spawned:<path>`) prevents re-spawning for the same file within a session. If `token-goat` is not on PATH or the spawn fails, the hook continues normally.

### Fixed

- **`TerraformFilter._compress_terraform_init` head/tail fallback.** When `terraform init` progress lines (e.g., `Installing plugin N`) did not match the provider-specific regex, all lines passed through unchanged. The method now applies head=5/tail=5 compression whenever `len(non_empty) > 12` after provider-line collapsing.

## [1.8.0] - 2026-06-13

### Added

- **Pressure-scaled `pre_read` deny threshold.** The oversized-read deny gate (`hints.large_read_redirect_bytes`, default 45 KB) now tightens automatically as the context window fills. A new `_pressure_scaled_threshold(base, tier)` helper applies tier multipliers — cool 1.0×, warm 0.67×, hot 0.33×, critical 0.18× — giving effective thresholds of ~45 KB / 30 KB / 15 KB / 8 KB on the 45 KB default. The tier is derived from the `ContextPressure` already computed once per `pre_read` invocation and threaded to the fallback deny call at no extra I/O cost. The catastrophic ≥10 MB early call (which passes `floor=_LARGE_FILE_HINT_SKIP_BYTES`) is never tier-scaled — `_handle_large_read_redirect` guards scaling behind `floor == 0`. Windowed reads, binary files, and a disabled threshold are all still exempt. Works identically across Claude Code, Codex CLI, and Gemini-CLI via the shared session JSON.

- **Pressure-scaled bash compress output token cap.** `bash_runner.py` now reads `ContextPressure` before running a filter and scales the per-command output token cap: cool 1.0×, warm 0.75×, hot 0.5×, critical 0.25×. At critical pressure a 20 000-token default cap drops to 5 000 tokens, protecting the context floor for commands like `pytest -v` or `cargo build` that can produce megabyte outputs. Scale factors apply after the filter's own cap, so the lower of the two wins. Config: `[bash_compress] output_token_cap` sets the cool baseline; the env var `TOKEN_GOAT_BASH_OUTPUT_TOKENS` overrides it per process.

- **WebFetch dedup deny at warm+ context pressure.** `hooks_fetch.py` now tracks fetched URLs in the session cache (`fetch_history`). When the same URL is re-fetched and `ContextPressure` is warm or above, `pre_fetch` denies the call and redirects the model to use `token-goat web-output <id>` to retrieve the prior result surgically. At cool pressure the hook emits an advisory hint instead, so fresh re-fetches still work when content may have changed. Config: `[hints] fetch_dedup = true` (default on).

- **Hint text trimmed to first paragraph at hot/critical pressure.** `hints.py` exposes a `trim_to_first_paragraph(text, tier)` helper that strips everything after the first blank line in a hint body when `tier >= HOT`. All advisory hints in `hooks_read.py` that carry multi-paragraph explanatory prose — the large-read redirect, bash-dedup, grep-dedup, and reread-deny hints — pass their output through the trimmer. At cool/warm the model gets the full hint; at hot/critical only the actionable first sentence does. The trimmer is a pure string op, zero I/O.

- **Inline symbol skeleton in large-read deny context.** When `_handle_large_read_redirect` denies a Read, it now appends a token-goat skeleton of the target file as `additionalContext` so the model can navigate to specific symbols without a follow-up round-trip. It uses the same indexed path as `token-goat skeleton`, capped at 2 000 tokens. If the file is not indexed or the skeleton call fails, the deny fires without it (fail-soft). Adds one DB read per deny but eliminates the near-certain follow-up symbol lookup.

- **Jupyter notebook output stripping.** `pre_read` now intercepts `.ipynb` reads and strips all code-cell `outputs` and `execution_count` fields via the new `notebook_compact.py` module before the content reaches the model. Cell source (code and markdown) and metadata are preserved. A typical notebook shrinks 60–95%; a 2 MB notebook with heavy matplotlib outputs becomes ~40 KB. The stripped JSON becomes the Read result; the notebook's path is recorded in session for reread-deny tracking. Binary files (non-UTF-8 notebooks) fall through unchanged.

- **Duplicate-content read denial via cross-file SHA fingerprinting.** `pre_read` maintains a `file_content_seen` ring in `SessionCache` (cap `FILE_CONTENT_SEEN_MAX = 256` entries, evict oldest on overflow). After each successful Read, `pre_read` records the content SHA-256 alongside the path. When a later Read of a different path has a matching hash, `pre_read` denies it and tells the model the content is a duplicate of an already-read file. This catches symlinks, copied configs, vendored files, and generated duplicates without re-reading. The hook fingerprints only files at or below `_CONTENT_DEDUP_MAX_BYTES` (default 500 KB); binary and very large files are exempt.

- **Glob-cache hybrid sample + directory rollup.** The previous Glob result handler truncated the file list to a fixed count when it exceeded the cache limit, silently dropping paths. The new handler switches to a two-part representation: a random sample of individual file paths (≤ 200 entries) followed by a per-directory rollup that shows `dir/ (N files)` for every directory with unsampled members. One `Counter` pass generates the rollup with no extra filesystem I/O. The model sees a representative sample plus a complete directory-level view, rather than a silent hard cutoff.

- **Grep result direct-serve on re-runs.** `_handle_grep_dedup` now tries to inline the prior Grep result as `additionalContext` before falling back to the advisory hint. On a repeat Grep where the prior output is within the staleness window and ≤ 8 KB, the result is embedded directly and the Grep tool doesn't re-run. On larger prior outputs the advisory hint ("retrieve via `token-goat bash-output`") fires as before. The size and staleness thresholds match the Bash direct-serve path.

- **Pytest failure delta injection.** After a `pytest` run, `post_bash` extracts the failure lines from stdout and merges them into `SessionCache.pytest_failures` (keyed by `cmd_sha`). On the next matching pytest invocation, `_handle_pytest_delta` diffs the current failure set against the last-seen set and injects only the **new** failures as `additionalContext` (prefixed `⚠ New failures:`) and resolved failures (`✓ Now passing:`). A run with no change emits a one-liner confirming parity. This eliminates re-reading the full test log to find what changed between two runs. The merge uses a CAS over a session-stored SHA so concurrent pytest shards don't drop each other's failures.

- **Directory-listing map inject after three listings.** After the third Glob/directory-listing command in a session, `pre_read` injects a `token-goat map --compact` snapshot of the project tree as `additionalContext`. The inject fires once per session (gated by a `map_injected` sentinel in `SessionCache`) so it doesn't repeat on every subsequent listing. The compact map is generated synchronously and capped at 4 000 tokens; if map generation fails the hook continues without it. Cuts repetitive `eza --tree` / `ls -R` calls once the agent knows the layout.

- **Bash output direct-serve for small cached commands.** `_handle_bash_dedup` now calls `_try_bash_dedup_serve` before the advisory hint path. On the first repeat (`run_count == 1`), if the cached output is within the staleness window and ≤ 8 192 bytes, it embeds directly as `additionalContext` — the command doesn't re-run. On `run_count > 1` the function yields to the advisory path so loop-detection warnings still fire for habitually repeated commands. The staleness and size thresholds mirror the Grep direct-serve path.

- **`PytestFilter` collapses `pytest -v` verbose PASSED lines.** `pytest --verbose` emits path-first progress lines (`tests/foo.py::test_bar PASSED [ 1%]`) that the existing `_PYTEST_FAIL_LINE_RE` (a status-first pattern) did not match, so every PASSED line fell through to `kept.append()` — a 1 000-test `-v` run retained ~1 000 otherwise-useless lines. A new `_PYTEST_VERBOSE_LINE_RE` (`^\S.+::\S+[ \t]+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:[ \t]|\Z)`) detects path-first verbose progress lines and counts PASSED into the existing `passed_count` accumulator; `FAILED`/`ERROR`/`SKIPPED`/`XFAIL`/`XPASS` verbose lines are kept for context. The `^\S` anchor prevents indented captured output (e.g. lines inside a traceback that happen to contain `::test PASSED`) from being misclassified; the `not in_failures and not in_errors` guard provides the same protection inside `= FAILURES =` / `= ERRORS =` sections.

- **`post_bash` compresses `curl -v` / `--verbose` output.** When `curl` exits zero and the output contains curl verbose markers (`* `, `> `, `< `), `post_bash` now strips TLS handshake noise, connection metadata, all request headers, and redundant response headers (date, cache-control, x-* etc.), keeping only the request line, HTTP status, content-type, and response body. The compressed output is emitted as `systemMessage`; the full original is cached so `token-goat bash-output <id>` can retrieve it. Fires only on 10+ line outputs to avoid false positives on short responses. Requires exit code 0 — errors pass through unmodified so the model sees the full curl error context.

- **`post_bash` compresses `jest`/`vitest` verbose PASS-suite lines.** When jest or vitest runs with `--verbose`, each passing test emits a `✓ test name` or `✔ test name` line. On large suites these can number in the thousands. The new `JestVerboseFilter` collapses consecutive passing-test lines under a `PASS <file>` banner into a single count line (`N tests passed`), while preserving all `FAIL`/`✕` lines, error output, and the final summary. Typical savings on a passing 500-test suite: 95%.

- **`post_bash` parses JUnit XML and emits a structured summary.** When a command writes JUnit XML to a file path printed in its stdout (`--junit-xml=path`, `--junitxml=path`, `PYTEST_JUNIT_XML=path`), `post_bash` now parses the XML and emits a compact summary: total tests, passed, failed, error, skipped, and elapsed time, followed by the names and messages of every failed/errored test case. The XML file is not read via the Read tool — it is parsed directly from disk so it never enters the model's context as raw XML. Fires only when the XML exists and parses successfully; any failure falls through to the normal output path.

- **`pre_read` detects Claude task-output temp files and redirects to `bash-output`.** Claude Code writes async-task output to temp files like `claude/…/<sha>.output`. When `pre_read` sees a Read targeting one of these paths, it redirects the model to `token-goat bash-output <id>` (which supports `--head`, `--tail`, `--grep`, `--section` for surgical recall) rather than dumping the full file. Saves the typical 10–200 KB raw output from entering context on every task-completion check.

- **`post_bash` elides long lines from `grep`/`rg` hits on minified JS/CSS.** When grep or ripgrep returns a match from a `.min.js`, `.min.css`, `.bundle.js`, or `.map` file, the matching line can be hundreds of kilobytes (entire minified bundle on one line). `post_bash` now detects these and truncates each matching line to 200 characters, appending `… [minified, truncated]`. The filename and line number are preserved so the model still knows where the match is.

- **`pre_read` suppresses redundant re-read hints after conversation compaction.** After Claude Code compacts the conversation, the compaction summary injected into the new context already lists recently-touched files. Previously `pre_read` would still fire re-read deny hints for those files as if they were repeat reads, adding noise without value. The hook now checks whether the current session started with a compacted context (detected via the `isCompactSummary` marker in the session JSON) and suppresses re-read hints for a configurable grace period (`[hints] post_compact_grace = 3`, default 3 reads) so the model can re-orient without being blocked.

- **`post_bash` compresses `go test -v` clean PASS lines.** `go test -v` emits one `--- PASS: TestName (Ns)` line per passing test. On a large Go module with hundreds of tests these lines dominate the output. The new `GoTestVerboseFilter` collapses `--- PASS:` lines under each package header into a count, while preserving `--- FAIL:`, `FAIL`, panic output, and the final per-package timing lines. `--- SKIP:` lines are also collapsed into a count. Typical savings: 90% on a clean run.

- **`post_bash` compresses `make`/`cmake`/`ninja` build progress output.** Long builds emit hundreds of `[N%] Building …` / `[ N%] Linking …` progress lines that are pure noise when the build succeeds. The new `MakeBuildFilter` collapses these progress lines into a single count, while preserving compiler warnings, errors, linker errors, and the final `Built target` / `make: *** Error` lines. `cmake --build` and `ninja` output is covered by the same filter (both produce `[N%]`-prefixed progress). Typical savings on a clean build: 85%.

- **`post_bash` compresses Python script crash tracebacks.** When a Python script or `python -c` invocation raises an unhandled exception, the full traceback can run to dozens of lines. The new `PythonTracebackFilter` collapses intermediate `File "…", line N, in …` / `    code_line` frame pairs into a count, keeping the outermost frame, the exception type and message, and any `During handling…` chained-exception context verbatim. The model sees the root cause immediately rather than scrolling through a deep frame chain.

- **`post_bash` compresses `tsc` (TypeScript compiler) output.** `tsc --noEmit` or `tsc --build` on a large project can emit hundreds of type-error lines. The `TscFilter` groups errors by file, emits a representative sample (up to 3 per file), and appends a per-file count for files with more errors. The summary line shows total-error and file counts. Build-info progress lines (`… emitted`, `… unchanged`) are dropped on success. Typical savings: 70–90% on a project with widespread type errors.

### Fixed

- **Pytest suffix regex tightened; failure merge uses session CAS.** The regex that identifies pytest output lines was matching non-pytest commands whose filenames contained `test_`. The pattern now requires the pytest binary name at the start of the command string. `post_bash`'s failure-merge previously overwrote `SessionCache.pytest_failures` blindly; it now does a compare-and-swap over the stored SHA so concurrent pytest shards don't drop each other's failures.

## [1.7.1] - 2026-06-11

### Fixed

- **Bash-compress disable hint is now shell-neutral.** The `TOKEN_GOAT_BASH_COMPRESS=0` form shown in the hint is POSIX-shell `VAR=value` prefix assignment — valid only when prefixing a command, and broken in PowerShell and cmd.exe. All 34 runtime hint strings in `bash_compress.py` and both in `hooks_read.py` now read `disable via TOKEN_GOAT_BASH_COMPRESS` (set it to `0`, `false`, `no`, or `off`). Env-var semantics are unchanged; only the hint text changed.

- **Bash pre-hook fast-path via `bash_detect` (Code-10 / P2-3).** The Bash pre-hook previously imported `bash_compress` (~75 ms) on every invocation to identify which filter to apply, even for commands that match no filter. A new `bash_detect` module contains a 227-entry binary→filter-name dict; the pre-hook now does a `<1 ms` dict lookup first and only imports `bash_compress` when `detect()` returns a filter name or the command contains `&&`. Unrecognized commands skip the import entirely.

- **`enqueue_dirty` is now append-only with a byte-based cap (P1-1 / P2-5).** The previous implementation read the full queue file, filtered duplicate entries, and rewrote it on every Edit/Write hook — O(queue size) per call and vulnerable to a POSIX rename race. `enqueue_dirty` now does a single `stat()` to check the queue size against `DIRTY_QUEUE_MAX_BYTES` (2 MB) and appends the new entry atomically. When the queue is at cap, new entries are silently dropped until the worker drains it; no read, no rewrite, no race.

- **Corrupt `.draining` file is quarantined instead of raising (P1-2).** When `drain_dirty_queue` could not read its renamed `.draining` file (e.g. another process renamed it after the check), it raised an `OSError` and left the worker in a broken state. The file is now renamed to `.corrupt-<timestamp>` and the drain cycle continues with an empty result; if the rename also fails the cycle is deferred silently without data loss or crash.

- **`post_bash` uses a single session load/save round-trip (P2-4).** The previous implementation called `session.load()` / `session.save()` up to four times per `post_bash` invocation — once per `mark_*` helper. All helpers now accept a `cache=` kwarg and share the single object returned by `session.safe_load()` at the top of the function; one `session.save()` at the end writes the merged result.

- **Output size cap applied before payload work in `post_bash` (P2-6).** `_apply_output_size_cap` was previously called after grep filtering and session writes, so a 4 MB stdout triggered the full expensive pipeline before being truncated. It now runs immediately after `_sanitize_surrogates`, before any downstream processing.

- **Cache eviction is throttled to at most once per 60 seconds (P2-7).** `store_output` previously called `evict_old_entries` on every write, triggering an O(n) `iterdir` + `lstat` scan of the cache directory (up to 4 096 entries × 2 for body + sidecar). A module-level `_last_eviction_ts` timestamp gate now skips eviction when called within `_EVICTION_THROTTLE_SECONDS` (60 s) of the last run.

- **`normalize_path` handles WSL paths with embedded Windows backslashes (P3-8).** A WSL path like `/mnt/c/foo\bar` was returned as-is because the WSL branch only replaced the `/mnt/<drive>/` prefix and left `\` separators intact. The function now replaces `\` with `/` after the prefix substitution, so `/mnt/c/foo\bar` normalizes to `c:/foo/bar` and collides with the same file accessed via a Windows path.

- **`pre_read` Bash branch uses `session.safe_load()` instead of `session.load()` (P3-9).** A corrupt or partially-written session file caused the Bash pre-hook to raise, blocking the tool call. The branch now calls `safe_load()`, which returns `None` on any error, and the hook proceeds with no-op recovery hints rather than crashing.

- **`_index_spawn_active` guards against PID recycling.** The function checked only `psutil.pid_exists(pid)` to decide whether an indexing spawn was still running. Within the 10-minute `INDEX_SPAWN_TTL` the OS can reuse a finished indexer's PID for an unrelated process, blocking fresh indexing spawns for up to 10 minutes. The check now reads the running process's cmdline and returns `False` when it lacks `token_goat`, falling back to trusting the PID when the cmdline is unreadable (permission denied / sandboxed).

- **`kill_duplicate_daemon` now unlinks the stale PID file after a successful kill.** The "already dead" early-exit path already removed the file; the success path did not, leaving `--check` and `is_worker_alive()` reporting stale state until the next `ensure_running` cleanup pass.

- **`get_context_pressure` avoids a redundant `safe_load` when a cache is already in scope.** Both `build_manifest_adaptive` and `post_read` loaded `SessionCache` before calling `get_context_pressure`, which performed a second `safe_load` from disk. The function now accepts an optional `cache=` kwarg; callers that already hold a loaded cache pass it in and skip the extra I/O.

- **`normalize_path` docstring corrected.** The step-by-step description had steps 2 (backslash replacement) and 3 (WSL detection) listed in the wrong order relative to the actual execution order. Inline comments had the same transposition.

## [1.7.0] - 2026-06-10

### Fixed

- **Skill dedup permanently disarmed after first compaction.** `post_skill`'s early-return path (duplicate body already in session) returned without calling `session.mark_skill_loaded()`, leaving `skill_ts` frozen at the initial load time. After any compaction sidecar update, `_compaction_occurred_after(skill_ts)` returned `True` permanently, so `pre_skill` passed every subsequent load through without deduplication. Fix: `mark_skill_loaded` is now called before the early return, advancing `skill_ts` past the current sidecar mtime so the next load is correctly deduped. The early-return is also gated on a `content_sha` equality check — if the skill body changed between loads, the code falls through to the normal `store_output` path so the new body is cached with a correct `output_id`/`content_sha`.

### Added

- **`post_compact_full_loads` config knob** (`[skill_preservation] post_compact_full_loads`, default `false`). With the default, `pre_skill` serves the cached compact even after a compaction event (dedup stays armed for the whole session). Set to `true` to restore the pre-1.7 behaviour of allowing one full body reload per compaction epoch. When `false` and no compact is cached for the skill (new install, no `<!-- COMPACT_END -->` marker, and auto-extract hasn't run yet), the hook falls back to allowing the full reload so the model is never left without operative rules.

- **Stable-doc compact serving** (`token-goat compact-doc`). Large reference markdown documents (`.md`/`.markdown`) can now be pre-compacted into a sidecar summary that `pre_read` serves in place of the full file, saving 80–95% of context tokens on the first read of each new session. The compact is built extractively (headings + first N lines per section, no LLM) and stored in the token-goat data dir as a SHA-keyed sidecar. On reads, `pre_read` checks for a fresh sidecar (source hash match) and deny-redirects to it when found; stale sidecars (emitted when the source file is edited) trigger an advisory instead. `skill_cache.invalidate_for_path` automatically marks the sidecar stale after an edit so the model is never silently served an outdated compact. Config: `[hints] stable_doc_compacts = true` (default on). CLI: `token-goat compact-doc <path> [--force] [--sentences N] [--show]`.

- **MCP screenshot deny-redirect.** `pre_screenshot` hook (new `PreToolUse` matcher `mcp__.*take_screenshot|mcp__.*browser_take_screenshot`) denies chrome-devtools and playwright screenshot calls that don't include a `filePath`/`file_path` argument, redirecting the model to re-issue with `filePath` and then Read the saved file. The subsequent Read flows through the existing image-shrink pipeline, which compresses the result before it reaches the model (~39K tokens/call raw). Calls that already provide `filePath` pass through unchanged. Config: `[images] screenshot_redirect = true` (default on).

- **Baseline v2: skill listing cost + per-server MCP rows + `--usage` flag.** `token-goat baseline` now costs the skill listing injected on every session start and subagent spawn (estimated at ~71 tok/entry from SKILL.md frontmatter where available), replacing the single aggregate "MCP instruction blocks" row with one row per configured server so each appears as an individually removable line item. The new `--usage` flag streams project transcripts to annotate each skill and MCP row with historical call counts, flagging zero-use entries as removal candidates. New public API: `scan_transcript_usage(projects_root)` → `({skill: count}, {mcp_prefix: count})`.

- **Session window denial for in-context file reads.** `pre_read` now denies re-reads of file content already present in the current context window, redirecting the model to use the already-loaded text or a surgical `token-goat read` command instead. Triggered when a file's post-read record is present in the session cache. Config: `[hints] deny_reread = true` (default on).

## [1.6.0] - 2026-06-09

Three changes, all aimed at the fixed context floor a spawned subagent inherits before it does any work: a deny-redirect guard that stops oversized reads and content-mode greps at the tool boundary before they overflow the window, a new `token-goat baseline` command that measures and attributes that floor source by source, and an opt-in SessionStart advisory that surfaces it once when it crosses a configured budget.

### Oversized-read deny-redirect guards subagent context windows

A spawned subagent inherits a large fixed baseline before it does any work — the full CLAUDE.md, the memory index, every loaded skill body, the MCP instruction blocks, and any SessionStart hook dumps from other plugins. That baseline alone can nearly fill the window, so the first attempt to Read a 47–86 KB recon dump, or to grep a 73 KB transcript in `content` mode, overflows the window and kills the agent. An advisory hint is too weak to prevent it; the read has to be stopped at the tool boundary.

`pre_read` now denies a full Read whose on-disk size is at or above `hints.large_read_redirect_bytes` (default 45000 / ~45 KB) and redirects to the surgical alternatives — `token-goat skeleton`/`section`/`semantic`/`symbol` — or to re-issuing the Read with `offset`/`limit` to window it. The guard runs in two tiers so it never preempts a richer, type-specific redirect: a catastrophic ≥10 MB tier fires early (these files are dropped wholesale by the hint pipeline and reach no handler, and the early position also covers sessionless and cache-load-failure reads), while the 45 KB–10 MB band fires as a fallback only after the skill-body, index-only, structured-file, and serve-diff/diff handlers have had first claim. A Read that already sets `offset` or `limit` is exempt — it is deliberately windowed, and exempting it also prevents a redirect loop since the deny itself points there. Binary files are exempt (surgical reads cannot help). Setting the threshold to 0 disables the guard; `TOKEN_GOAT_LARGE_READ_BYTES` overrides it per environment.

The same threshold gates a content-mode Grep over a single oversized file: `output_mode=content` with no `head_limit` over one file at or above the threshold is denied and redirected to a bounded search (`head_limit`, an `offset`/`limit` window, or `token-goat semantic`/`section`). The cheap `files_with_matches` default, an explicit `head_limit`, directory targets, and small files all pass through unchanged.

### `token-goat baseline` — the session expense report

The deny-redirect above treats the symptom (the fatal read) but leaves the cause — the large fixed baseline a session inherits — invisible and unattributed, so "why did that subagent overflow at hello?" stays a guess. The new `token-goat baseline` command makes that baseline a measured, attributed report. It scans the four source classes token-goat can see on disk — every plugin's persisted SessionStart/UserPromptSubmit hook dump (`hook-*-stdout.txt`), both CLAUDE.md files, the project's MEMORY.md, and the configured MCP servers — costs each at `bytes // 4` so the totals reconcile with `token-goat doctor` rather than contradicting it, and renders a table ranked by token cost. Each row is tagged by owner (`you` / `harness` / `plugin:<name>` / `plugin:unknown`), a concrete fix (`slim` / `disable-hook` / `disable-mcp` / `lazy-load` / `none`), and kind (`fixed`, recurring every session start, vs `variable`, a one-off prompt-driven push). Identical hook dumps re-fired across compactions are deduped by content hash and shown once with a `xN fires` note, because a fresh subagent pays that cost only once. Every scanner is fail-soft: a missing or unreadable source becomes a note, never an exception. Flags: `--json` for the machine-readable view, `--subagent` to show only the fixed sources a freshly spawned agent inherits (framed as its starting fill), `--window` to set the pct-of-window denominator (default the 200k model window), and `--session-id` to override session detection. Skill-catalog cost is deliberately not re-measured here — `token-goat doctor` already does that well — so the report points there instead of drifting.

### Opt-in SessionStart baseline advisory

A new `[hints] baseline_budget_tokens` knob (default `0` = off; `TOKEN_GOAT_BASELINE_BUDGET_TOKENS` overrides it; clamped to `[0, 10_000_000]`) gates a one-line SessionStart advisory. When the budget is positive and the cheap fixed baseline exceeds it, `session_start` appends a single quiet line pointing at `token-goat baseline` for the per-source breakdown. Only the fixed/recurring total is gated on — a variable one-off push never trips it — and the line fires at most once per session via a sentinel written only when the advisory actually emits, so an under-counting cold start (hook dumps not yet on disk) can still trip on a later resume. The whole path is fail-soft; any error leaves the session start untouched.

## [1.5.3] - 2026-06-08

Four improvements: compact directives that tell the compaction LLM to suppress regenerated noise, compound-command bash compression, repetitive-JSON diff hunk compression, and a new `indexing.skip_dirs` config option.

### Compact directives suppress skill_listing and hook_success reproduction

After compaction, the conversation often refills quickly because the compaction LLM faithfully reproduces the `skill_listing` blob (the full skills catalog, ~14–28K tokens) and every `hook_success`/`hook_error` telemetry event. These are autoregenerating noise — `skill_listing` is re-injected fresh at every session start and hook events are ephemeral status lines — but the compaction LLM has no way to know that without being told.

`build_manifest()` now appends a `### Compact Directives` footer after the sidecar SHA write (so the fingerprint is unaffected) instructing the compaction LLM to replace each `skill_listing` message with `[skill_listing: auto-injected]` and collapse all `hook_success`/`hook_error` events to a single `[N hook events]` line. A `_DIRECTIVE_TOKEN_RESERVE` is subtracted from `max_tokens` before building the manifest body, so the total output stays within the caller's budget.

### Compound `&&` command bash compression

The bash compress hook previously skipped commands it couldn't recognize as a single filter — a compound like `git diff && git log` matched no single `detect_from_command` rule, so both halves ran uncompressed. The hook now falls back to `bash_compress.try_wrap_compound_segments`, which splits the command on `&&` boundaries and wraps each recognizable segment with its own filter. Segments that don't match any filter pass through unchanged. Unrecognized compound commands are skipped as before, so there are no false positives.

### Repetitive-JSON diff hunk compression

`_compress_git_diff_body` now detects diff hunks where ≥75% of added lines parse as JSON dicts and all parsed objects share ≤5 distinct key-sets — the signature of machine-generated JSONL (audit logs, test fixtures, mutation records). These hunks are replaced with a one-line summary (`[token-goat: N repetitive JSON-object lines omitted]`) instead of head+tail truncation, so a 500-line JSONL diff becomes one line rather than 60 lines.

### `indexing.skip_dirs` config option

`config.toml` now supports `[indexing] skip_dirs = ["dir1", "dir2"]`. These basenames are merged with the built-in `SKIP_DIRS` frozenset during `iter_source_files`, so project-specific generated directories — temporary venvs, build sandboxes, unusual artifact directories — can be excluded without touching token-goat source. The list is validated at load time; non-string entries are silently dropped with a warning.

## [1.5.2] - 2026-06-08

Three fixes: Codex hook wire-format compatibility, and two Windows coarse-`mtime` correctness issues in the cache and session layers.

### Codex hook responses now pass schema validation

Codex 0.137.0 validates every hook response against embedded JSON schemas with `additionalProperties: false`, so any unrecognised key causes "hook returned invalid … JSON output" for the entire response — including `SessionStart`, `PreToolUse`, and `PostToolUse`. The root cause was `_tg_elapsed_ms` (and sibling `_tg_handler`/`_tg_error` fields) added by the internal `dispatch()` function and then emitted verbatim. The `denormalize_response` Codex branch now strips all `_tg_*` keys before output. The same path also injects the required `hookEventName` const field into `hookSpecificOutput` — Codex requires it on every `hookSpecificOutput` shape and token-goat was not emitting it because Claude Code does not require it. A `_codex_hook_event_name()` helper resolves the correct value (e.g. `"pre-read"` → `"PreToolUse"`) from the hook registry. The old camelCase→snake_case key conversion (`_translate_hso_to_codex`) is no longer applied — Codex 0.137.0+ uses camelCase throughout `hookSpecificOutput`.

Two Windows coarse-`mtime` correctness fixes. Both reproduce only when two writes land close enough together to share a filesystem timestamp — common on NTFS under load — which is why they surfaced as intermittent CI flakes rather than deterministic failures. Each ships with a deterministic regression test that fails on the pre-fix code and passes on the fixed code.

### Freshest cache entry survives its own store call's eviction

`evict_cache_dir` sorts eviction candidates oldest-first by `float(st_mtime)` with a stable sort. When the just-written (MRU) entry shares a coarse `st_mtime` with older siblings, the stable sort falls back to arbitrary `iterdir` order, which on NTFS can place the newest file first and evict it — so a `store_output` call could delete the very entry it had just written. `evict_cache_dir` now accepts a `protect_ids` set that is excluded from the victim list regardless of timestamp, and `skill_cache.store_output` passes the id it just wrote. Protected bytes still count toward the cap, so other candidates keep evicting; if only protected entries remain over cap the loop stops best-effort rather than deleting the fresh entry or looping forever. This is correct MRU policy and deterministic independent of `mtime` granularity.

### save() refreshes the process-local load cache

`session.load()` caches `(object, mtime)` per session and serves the cached object whenever `cached_mtime == current_mtime`. When a later `save()`'s post-write timestamp aliased the mtime a previous `load()` had cached, the proc-cache kept serving the stale pre-save object on the next in-process `load()` even though the on-disk JSON was correct and complete. `save()` now overwrites an existing proc-cache entry with the object it just persisted on every successful write, so the freshest state always wins. Only existing entries are refreshed — inserting new keys here would bypass `load()`'s LRU-cap accounting. The concurrency test that exercised this path also drops the proc-cache entry before its final assertion so it reads authoritative disk truth, and its barrier/join timeouts were widened so heavy xdist CPU contention cannot misread thread-scheduling latency as a lost edit.

## [1.5.1] - 2026-06-08

A round of correctness fixes for the cache size accounting, surgical reads, path normalization, and the Gemini hook bridge, plus two documentation corrections. No behavior changes to the happy path — these close gaps that surfaced under mixed-case names, uppercase WSL drives, compressed cache entries, and the Gemini wire format.

### Cache size accounting counts compressed bodies

Compressed cache entries store a zero-byte `<id>.txt` stub next to the real payload in an `<id>.gz` sibling. The size-accounting paths that iterate over `.txt` stubs — `evict_cache_dir`, `list_cache_outputs`, and the metadata stat loader — were measuring only the stub, so a cache full of compressed entries reported a near-zero footprint and never tripped LRU eviction. A single `gz_companion_size()` helper now lstats the `.gz` sibling and is added wherever iteration is filtered to `.txt` stubs, so the byte cap and oldest-first eviction see the true on-disk size. The whole-directory `iterdir()` sums in `doctor`, `clean-cache`, and `prune-cache` deliberately do not call it — they already count the `.gz` file as its own entry, and adding the companion there would double-count.

### Surgical reads cap oversized docstrings

`truncate_symbol_body` leaked an un-capped docstring through its small-body guard: a symbol with a short code body but a 60-plus-line docstring skipped the line cap entirely and returned the whole thing. The guard now applies the cap to the docstring independently of the code body, and the signature-boundary tuple it returns is corrected so the trailing class/def line is preserved rather than dropped.

### Uppercase WSL drive letters normalize

`normalize_path` converted `/mnt/c/...` to `c:/...` but its WSL regex matched only a lowercase `[a-z]` drive, so an uppercase `/mnt/C/...` matched neither the WSL branch nor the Windows drive-lowercasing branch and was returned fully unnormalized — fragmenting the session and cache key for the same physical file depending on how WSL reported the mount. The regex now accepts `[a-zA-Z]` and lowercases the captured drive, so `/mnt/C/foo` and `/mnt/c/foo` collapse to one canonical key.

### Compacts purge for mixed-case skill names

`invalidate_for_path` rebuilt the compact-file purge suffix from the raw skill name, but `_compact_file_id` lowercases the safe-name segment when it writes the file. A mixed-case skill such as `userSettings:brainstorming` was stored under `...-usersettings_brainstormingn-compact` while the purge suffix kept the original casing, so the `endswith` match missed and a stale compact survived the edit — `--compact` recall then served pre-edit content. The purge path now lowercases the segment the same way the writer does.

### Gemini hook bridge preserves systemMessage

The Gemini wire-format response handling dropped the hook `systemMessage` and folded everything into one channel. It now preserves `systemMessage` and routes `additionalContext` to Gemini's native channel, so compaction manifests and read hints reach the model the way they do under Claude Code and Codex.

### Documentation

- Install docs advertised a phantom `--gemini` flag; the supported path is `install --target gemini`, and the docs now say so.
- The worked example in the README referred to `shrink-image`; the command is `image-shrink`.

## [1.5.0] - 2026-06-07

Context-pressure awareness: one source of truth for how full the window is, and hints that get terser as it fills. Ships alongside three install fixes that restore hook forwarding under editable installs and silence a recurring `doctor` warning.

### Centralized context-pressure model

`get_context_pressure(session_id)` in `compact.py` is now the single place that answers how close a session is to autocompaction. It returns a frozen `ContextPressure` — a `fill_fraction` paired with a `tier` of `cool`, `warm`, `hot`, or `critical`. The estimate sums the known context contributors (loaded skill bodies, the ~10,800-token skills catalog, and per-event costs for bash history, web history, and read files) and divides by the fixed 660,000-token autocompact budget rather than the model's raw window, so the fraction carries the same meaning no matter which model is driving the session. The old `_estimate_context_fill` helper and the inline calculation in the session hook both defer to it, retiring the copies of the 660 K constant that had spread across half a dozen call sites in favor of one shared `CONTEXT_AUTOCOMPACT_TOKENS`.

### Named tier boundaries

The fraction-to-tier mapping lives in `tier_for_fraction()`, backed by three named constants: `CONTEXT_TIER_WARM` (0.50), `CONTEXT_TIER_HOT` (0.70), and `CONTEXT_TIER_CRITICAL` (0.85). The bands are cool below 0.50, warm up to 0.70, hot up to 0.85, and critical at or above it. With the magic numbers pulled out of the band checks, the boundaries are defined once and the tests pin them directly.

### Pressure-aware surgical-read hints

The pre-read hook tightens its large-file threshold as the window fills. A file earns a surgical-read suggestion past 500 lines while the session is cool, 350 when warm, 200 when hot, and 50 when critical. It also folds a single per-tier note into the read's additional context: "Context warming" at warm, "Context pressure" at hot, "CONTEXT CRITICAL" at critical. The note is fingerprinted by tier, so it fires once per band rather than on every read. Cool sessions get no note.

### Smaller manifests under pressure

`compute_adaptive_budget` now weighs context pressure when it sizes the compaction manifest. Once the window runs hot the budget is capped at 500 tokens, and at critical it drops to 300, so the manifest stops adding to the very problem it exists to summarize.

### Install robustness

**Hooks no longer silently disable themselves under an editable install.** The `tg-hook` wrapper carries an `if not exist "<sentinel>"` gate that short-circuits to a bare `{"continue":true}` during the `uv tool install --reinstall` race, when the venv's `token_goat` module is briefly absent. The sentinel used to be a hardcoded `site-packages/token_goat/__init__.py` path, which never exists under an editable install (`uv sync`, the project `.venv`), so the gate stayed permanently true and every hook no-op'd — the whole tool went dark with no error. The wrapper now resolves the sentinel through `importlib.util.find_spec("token_goat").origin`, which points at `src/token_goat/__init__.py` for editable installs and `site-packages/...` for regular ones, and falls back to an ungated wrapper when no sentinel resolves. A live handler emits `{"continue": true, "_tg_elapsed_ms": N}`; the `_tg_elapsed_ms` field is the tell that forwarding actually ran.

**Re-install purges orphaned `tokenwise` entries.** After the `tokenwise` → `token-goat` rename, a re-install left the old hook and permission lines stranded in `settings.json` and the Codex `config.toml`, so both harnesses kept invoking a binary that no longer existed. `patch_settings_json` and `patch_codex_config` now strip any pre-rename `tokenwise` command and permission entry before writing the current ones.

**Hook wrapper is written as bytes to stop CRLF doubling.** `hook_wrapper_content()` hand-bakes platform-correct line endings — `\r\n` on Windows — then was written through `atomic_write_text`, whose text-mode handle translated every `\n` to `\r\n` a second time, doubling each line ending to `\r\r\n` on disk. `cmd.exe` tolerated the stray carriage return so forwarding still worked, but `doctor` does a byte-exact compare of the on-disk wrapper against the regenerated content and warned `differs from expected — run token-goat install to refresh` on every run, a nag that reinstalling could never clear because it rewrote the same doubled bytes. The wrapper now goes through `atomic_write_bytes`, preserving the authored endings verbatim.

### Session-cache integrity

**Concurrent session saves no longer drop an edit.** The `save()` fast path skipped its compare-and-swap re-read and merge whenever the on-disk `(st_mtime, st_size)` fingerprint still matched the one captured at load. That fingerprint aliases: two caches whose keys are the same length serialize to byte-identical JSON sizes, and a float `st_mtime` rounds two sub-microsecond writes to the same value. When two writers collided on both fields the second skipped the merge and overwrote the first, losing exactly one edit — the 200-edit concurrency stress test intermittently saw 199. The fast path now consults an in-process version registry so a same-process writer that already advanced the version forces the stale save back through the merge, and the fingerprint is taken from integer `st_mtime_ns` instead of the rounded float, so a cross-process skip now requires a true nanosecond-and-size collision rather than a rounding coincidence.

## [1.4.1] - 2026-06-06

Three bug fixes surfaced by the pre-push WSL test suite.

### Bug fixes

**Compact file ID case normalization on Linux.** `_compact_file_id` and `get_compact_any_session` now both lowercase the skill name before constructing the compact file path suffix (`-freshskill-compact` rather than `-freshSkill-compact`). On case-sensitive Linux/WSL filesystems the mismatch caused `compact_coverage_score` to return 0 for mixed-case skill names (store wrote the file; lookup missed it) and the stale-fraction calculation in `_compute_stale_compact_fraction` to return 1.0 (cross-session glob matched nothing). Both code paths are now consistent with `store_compact`'s write path.

**`type: ignore` error code correction in `cli.py`.** Two `# type: ignore[arg-type]` comments on `int(compact_quality["score"])` and `list(compact_quality.get("issues", []))` suppressed the wrong error code. mypy reports `[call-overload]` for `int(object)`, not `[arg-type]`, so the annotations were no-ops and the errors surfaced when `warn_unused_ignores` is active. Changed to `# type: ignore[call-overload]`. Two parallel defaults in `hooks_skill._gen_compact_bg` were also corrected from `str | None` to `str` to clear `[assignment]` and `[union-attr]` errors.

**psutil `[import-untyped]` suppression.** `psutil` is now listed in the `[[tool.mypy.overrides]]` `ignore_missing_imports = true` group in `pyproject.toml`, clearing `[import-untyped]` errors in the five source files that import it.

## [1.4.0] - 2026-06-06

Forty-iteration self-improvement pass across four focus areas: context tracking depth, compact quality, output efficiency, and DRY/test hygiene.

### Context tracking depth (10 iterations)

`doctor --context` gains a richer, more actionable context footprint report. Fill is now shown as a visual bar with severity color (ok / warn / high / URGENT). The per-component breakdown lists every token source (skills catalog, loaded skill bodies, CLAUDE.md+MEMORY.md, conversation estimate) so the dominant cost is immediately visible. Session-to-session growth trends are derived from precompact sentinels: the report projects how many sessions remain until URGENT fill and shows the growth rate per session. Tiered compaction recommendations (Tier 0–4) surface the exact commands to run, ordered by impact. A Tier 0 over-capacity warning fires immediately when fill exceeds 100%. Conversation estimate is now tool-output-aware, incorporating bash and web history bytes for a more realistic fill figure. Edge cases (zero-byte sentinels, empty skill catalogs, missing sentinel files) are handled with graceful degradation and per-field error annotations.

### Compact quality and trigger improvements (10 iterations)

`score_compact()` — a new quality scorer — evaluates each compact on coverage density, heading structure, goal-marker presence, and rule-line signals. Scores are exposed in `skill-list --json` (`compact_quality_score`, `compact_coverage_score`, `compact_coverage_pct`) and in `skill-list` output via `[poor]`/`[fair]` flag annotations. SHA-staleness detection warns when the cached compact was built from a superseded body version; `skill-list --json` now includes a `compact_stale` boolean. Lazy injection falls back to cross-session compacts when the current-session compact is absent. `compact_age_secs` is added to skill-list output via a new `get_compact_mtime()` helper. Corrupted and empty compact files are guarded with explicit fallbacks in `get_compact` and `get_compact_any_session`. The skills directory listing inside `get_compact_any_session` is cached to eliminate redundant `glob()` calls per render. The stale compact fraction feeds an adaptive budget calculation for skill-degraded sessions.

### Output efficiency (10 iterations)

High-frequency output strings are compressed throughout the codebase. `tokens est.` → `~N tok` (saves ~6 chars per read header); `Referenced by:` → `Refs:` (saves 10 chars per symbol footer); `tokens` → `tok` normalized across all hint strings and the `_TERSE` substitution table. The `lang_breakdown` footer is suppressed for single-language projects and when the summary line already encodes language info, eliminating a redundant line in the vast majority of `map` outputs. Skeleton/outline savings accounting eliminates a double-format pass. Bash/web cache hint text is compressed. Manifest hint-telemetry shortened (`(N hints emitted)` → `(N hints)`). Unchanged-file and no-symbols-indexed hint text trimmed.

### DRY and test hygiene (10 iterations)

Repeated helper patterns extracted to shared modules: `make_bash_entry`, `make_bash_history`, `make_file_entry`, `make_cache` in compact test helpers; `apply_filter` from `filter_test_helpers` replaces 8 local `_compress` definitions; `_reset_cfg_cache` (9×) and `make_fake_session_cache` (2×) consolidated in test_config; `_call` (7×) and `_write_sentinel` (6×) hoisted to module-level in `test_context_growth_changes`; `FilterTestMixin` (9× `test_empty_input`, 4× `test_empty_output`) and `clear_process_guard` (4×) added to test infrastructure; `_strip_comments` (3×) extracted to `common.strip_cstyle_comments` in language adapters; `post_edit_sync` extracted to `hook_helpers`, `SkillPathsMixin` for 7 isolate copies; `make_symbol_emitter` factory eliminates 3× `_emit` closures in language adapters; `DataDirMixin` eliminates 35× `_isolate` fixture across 8 compact test files; `DirListingMixin` eliminates 5× `_isolate` in dir-listing tests.

## [1.3.0] - 2026-06-05

Context growth audit — four changes that cut session context size and make overhead visible.

### Context footprint in `doctor`

`token-goat doctor --context` now prints a **Context footprint** section measuring every token source that pads the context window each turn: the skills catalog (~10,800 tokens/turn for a typical install), loaded skill bodies accumulated in `system-reminder` injections, `CLAUDE.md` + `MEMORY.md` meta-files, and the rolling conversation estimate. The section shows fill % against the 660,000-token autocompact threshold, an ETA in turns at the current growth rate, and an **Actions** block naming the exact commands to run when any loaded skill above 2,000 tokens is missing a compact.

Auto-shown when estimated fill exceeds 40 % or any loaded skill > 2 K tokens lacks a compact; always shown with `--context`.

### Compact pre-generation at install time

`token-goat install` now runs `skill-compact --all` as a final step, so compacts are ready before the first session — no post-install warm-up turn required. A sentinel file (`skill_pregen_sentinel.json`) records the catalog count; the doctor section uses it to detect skills added after the last pre-gen pass.

### Per-skill compact advisory in `post_skill`

When a skill body lands in context, the `post_skill` hook now reports the compact's token savings inline (pre-generated compacts, sync-generated compacts for bodies < 40 KB, background-generated for larger bodies, info-only when no worker is running). Advisory fires only for bodies above 8 KB to stay silent for tiny skills.

### Threshold-crossing context advisory in `user_prompt_submit`

A lightweight ETA advisory fires the first time estimated context fill crosses 50 % and again at 70 %. The message is appended to the existing status line (bracket-joined, not a separate injection) and references `/compact now` at 70 %. Resets after each compact. Configurable via `hints.context_threshold_advisory = false`.

## [1.2.0] - 2026-06-05

14 commits since v1.1.0. Output overflow guard, cross-platform path normalization fixes, and a reliability pass.

### Output Overflow Guard

Surgical-read commands (`symbol`, `read`, `section`, `bash-output`, `web-output`, and the rest) now cap oversized output before it reaches the model. When estimated tokens exceed the cap, the output is head-truncated on a line boundary. A marker line is appended naming the cap, the truncation ratio, and the narrowing action — `symbol` users get directed toward `file::Class.method` lookups, `section` users toward sub-headings, cached-output users toward `--grep`/`--tail`.

Default cap: 25,000 tokens. Configure via `[overflow_guard] max_tokens` in `config.toml`, override with `TOKEN_GOAT_OVERFLOW_MAX_TOKENS=<n>`, or disable with `TOKEN_GOAT_OVERFLOW_GUARD=0` / `[overflow_guard] enabled = false`.

The estimator is deliberately conservative — 3 chars/token, same rate as the compaction manifest — so the cap is never under-applied. ANSI escapes are stripped before estimation since color codes inflate length without adding model-visible tokens. A single-line blob (no internal newlines) is sliced at the char budget so it cannot pass through whole.

### Cross-Platform Path Normalization

Two fixes that make path-keyed caches work correctly across Windows, WSL, and Linux:

**`normalize_path` / `paths.normalize_key`** — Drive-letter lowercasing (`C:` → `c:`) is now unconditional. The previous guard `sys.platform == "win32"` meant a WSL process that emits a Windows-format path (`C:/Users/…`) produced a different cache key than a native Windows process reading the same file. Both now produce `c:/users/…`.

**`hooks_skill.post_skill`** — Windows-style backslash paths like `C:\Users\user\.claude\skills\ralph` were not stripped on Linux because the inline guard used `_os.sep` (`/` on Linux) instead of the string literal `"\\"`. The inline block is now a call to `_normalize_skill_name`, which hardcodes `"\\"` and handles both separator styles on every platform.

### Reliability

- **Worker dirty-queue torn writes.** Concurrent `_append_dirty` calls could produce truncated or concatenated JSON lines under write contention. An OS-level file lock (`fcntl` on POSIX, `msvcrt` on Windows) now serializes appends, same as the session cache.
- **SQLite WAL checkpoint mode.** Changed from `RESTART` to `PASSIVE` on connection open. `RESTART` waited for all readers to drain, blocking hook subprocesses for hundreds of milliseconds during active indexing. `PASSIVE` checkpoints cooperatively and does not wait.

## [1.1.0] - 2026-06-04

57 commits since v1.0.1. Six new language indexers, twenty-plus new CLI commands and flags, a pre-skill hook that cuts repeat skill loads from 40–65k tokens to ~400, pnpm/yarn/bun compress filters, rg/grep dedup hints, double-daemon prevention, and a reliability pass with 400+ new tests.

### Skill Re-load Prevention

The most wasteful thing a long session does is load the same large skill twice. `/ralph`, `/superman`, `/improve` — each injects 40–65k tokens every time. By the third invocation you've paid for three full copies of the same rules.

A new `PreToolUse(Skill)` hook now fires before every Skill invocation. When a skill was already loaded in the current session and no compaction has fired since, the reload is blocked. The cached compact form (~400 tokens) is served via `additionalContext` instead. Falls back to a recall-pointer message when no compact is available.

Compaction awareness: the manifest-SHA sidecar's mtime is compared against the skill's session load timestamp. If compaction fired more recently, the hook allows the reload rather than blocking it — the skill may have been evicted from context.

An opt-in `first_load_compact` flag (default: off) extends this to first loads for skills with a `<!-- COMPACT_END -->` marker. Only the curated compact section is served; the full body stays accessible via `token-goat skill-body <name>`. Enable only after verifying your skill compacts are functional standalones.

Config: `[skill_preservation] pre_skill_enabled = true` (default on), `first_load_compact = false`. Disable via `TOKEN_GOAT_PRE_SKILL=0`.

### New CLI Flags

- **`symbol --context N`** — emit N lines of surrounding source around each match in both text and JSON output.
- **`symbol --json`** — structured `{file, line, kind, snippet}` output for downstream tooling.
- **`outline --min-lines N`** — filter sections by minimum body size; skip stub headings.
- **`outline --max-depth N`** — cap tree depth.
- **Outline line counts** — each section header now shows its line span.
- **`web-output --list`** — show all cached web responses with size, age, and URL.
- **`map --filter GLOB` / `--since-minutes N`** — focus map output to recently-changed or name-matched files.
- **`stats --since DAYS`** — alias for `--window`.
- **`token-goat recent`** — session-aware file recency: edited → read this session → git history, with cross-tier deduplication.
- **Bash history exit codes** — non-zero exits now show `[exit:N]` in the history entry; commands truncated to 100 chars.

### Package Manager Filters

pnpm, yarn, and bun bash compress filters added. `pnpm run`/`yarn run` now route through their own filters instead of falling through to the generic handler. `pnpm exec`/`dlx` pass through unchanged (were incorrectly matching the install filter).

### Context Savings

- **`rg`/`grep`/`ag` dedup.** Bash `rg` and `grep` invocations now fire dedup hints and record to `session.greps` the same way the native Grep tool does. Repeat searches return a cached match-count hint instead of re-running.
- **Top-5 file guarantee.** The five most-accessed files always appear in the compaction manifest, in a protected section that survives the safety trim.
- **Scope for new file types.** CSS, SQL, GraphQL, and Makefile symbols now participate in scope resolution via `token-goat scope`.
- **Web content-type stored.** The sidecar now carries content type so `web-output --section` can route heading-based lookups correctly.
- **Session hint min-savings threshold** configurable — suppress hints that would save fewer than N tokens.
- **Glob tracking.** File paths from Glob calls are tracked in session history for dedup hints.
- **Pre-read skips binary/large files** to avoid wasted processing on non-text content.
- **HTML stripping** for web output before section extraction.

### Reliability

- **Stale .flock sidecar eviction.** `.flock` and `.tmp` files left by crashed hook processes are now swept during session cleanup.
- **WSL path guards in bash_parser.** Backslash normalization and Windows system path detection work correctly on WSL-mounted paths (`/mnt/c/windows/`, `/mnt/c/program files/`).
- **BOM stripping.** `decode_source_text` strips UTF-8 BOM for all new indexers.
- **Worker stale PID cleanup.** `kill_duplicate_daemon` now removes the stale PID file rather than leaving it for the next startup to trip over.
- **CI harness detection.** `TOKEN_GOAT_HARNESS_OVERRIDE` env var lets CI runners force `detect_harness()` to return a specific value, fixing 113 test failures that appeared when running without a Claude Code session.
- **sqlite3.Row end_line fix.** `symbol --json` was using `.get()` on `sqlite3.Row` objects, which don't support attribute-style access; fixed with a proper column-name key lookup.

### Quality and Tests

- **400+ new tests** across all changed modules.
- Session fixture isolation: `tmp_data_dir` prevents the 5-9s WAL checkpoint overhead per test that appeared when tests touched the production global.db.
- `uv --version` subprocess mocked in doctor tests: eliminates the 6s overhead per invocation.
- Synthetic image dimensions reduced from 1600×1200 to 1100×825 in image tests: long edge still exceeds `MAX_LONG_EDGE` so all shrink behavior is exercised, but pixel generation drops ~60%.
- `uv` dependency caching added to CI: `enable-cache: true` + `cache-dependency-glob: uv.lock` eliminates 2–5 min of package install per run.

### New Language Indexers

- **CSS/SCSS.** Extracts class, id, keyframe, mixin, function, and variable selectors; emits `@import`/`@use`/`@forward` as refs.
- **SQL.** Extracts `CREATE TABLE/VIEW/INDEX/PROCEDURE/FUNCTION/TRIGGER` symbols; identifies DML refs.
- **GraphQL.** Extracts type, interface, union, enum, input, fragment, and directive definitions; emits field and argument refs.
- **Protobuf.** Extracts message, enum, service, rpc, and option definitions; emits field and import refs.
- **`.env` files.** Extracts variable names as symbols for surgical reads.
- **Makefile.** Extracts rule targets as symbols; emits prerequisite refs.
- **`.mts`/`.cts` extensions.** Registered as TypeScript variants for tree-sitter dispatch.

### New CLI Commands and Flags

- **`token-goat refs --callers`** — resolves the enclosing function for each reference site via a SQL JOIN on the symbols table, so a single call gives you "called from `foo()` at line N" context.
- **`token-goat changed --symbol`** — shows which symbols changed between HEAD and working tree.
- **`token-goat config-get FILE KEY`** — dot-notation value extraction from TOML/YAML/JSON/INI (e.g. `config-get pyproject.toml project.version`).
- **`token-goat version`** — shortcut showing installed version.
- **`token-goat install --check`** — shows autostart registration status and whether the entry matches the current interpreter.
- **`token-goat stats --by-command`** — per-command-type savings breakdown (`symbol`, `refs`, `changed`, etc.).
- **`token-goat index --ext`** — selective re-indexing by file extension (repeatable: `--ext py --ext ts`).
- **`token-goat bash-output/web-output --section HEADING`** — retrieve one section from a cached output by heading rather than reading the whole blob.
- **`token-goat worker --kill-duplicate`** — kills a running worker whose interpreter path differs from the current Python executable (handles the cross-interpreter double-daemon case).
- **`token-goat worker --status`** — shows running worker PID, interpreter path, uptime, and pool size.
- **`--quiet` flag on `symbol`, `refs`, `changed`, `outline`** — suppress prose preamble, emit JSON only.
- **Unified `{"query":…,"results":[…],"total":N}` JSON envelope** across `symbol`, `refs`, `outline`, `changed`, `exports` — downstream tooling parses a consistent shape.

### Double-Daemon Prevention

- **JSON PID file format.** `_write_pid()` now writes `{"pid":N,"started_at":"…","interpreter":"…","version":"…"}` instead of a bare integer. `_read_pid_info()` parses both the new JSON format and the legacy plain-integer format for backward compatibility.
- **Cross-interpreter startup guard.** When `_try_claim_worker_slot()` returns `None`, `run_daemon` reads the PID file to surface the competing worker's interpreter path in a `WARNING` log entry. Users can immediately identify a multi-interpreter collision via `token-goat doctor` or the log file.
- **Post-write PID verification.** After `_write_pid()`, `run_daemon` re-reads the file and compares the PID to `os.getpid()`. If another process raced and overwrote it (theoretically impossible with the O_EXCL claim file but defensively guarded), the daemon exits before entering the main loop.
- **`install --check` and autostart dedup.** Re-installs detect an existing autostart entry pointing to a different interpreter and replace it, preventing multi-interpreter accumulation in the registry/systemd/XDG layer.
- **11 new regression tests** covering each prevention path: claim-slot held, WARNING log with interpreter, PID race window exit, normal startup when PID matches, and the full PID file format round-trip.

### Cross-AI and Harness Improvements

- **OpenCode bridge error guards.** `spawnSync` failures and non-zero exit codes are handled gracefully in both the opencode and openclaw bridges.
- **Gemini WebFetch key-map fix.** Gemini harness passes `url` instead of `input`; remapped at the hook boundary.
- **Codex unknown-tool WARNING.** Unrecognized Codex tool names now emit a single WARNING instead of silently dropping the hook event.
- **`UnicodeDecodeError` in hook payloads.** Non-UTF-8 hook payloads previously propagated the exception; now treated as `{}` at the read boundary.
- **Install docs updated.** `CLAUDE_MD_CONTENT`, `SKILL_MD_CONTENT`, and `CODEX_AGENTS_MD_CONTENT` document the new commands added this cycle.

### Reliability

- **Atomic sentinel writes.** All sentinel files in `hooks_cli.py` now use `paths.atomic_write_text()` (temp + `os.replace`) to eliminate partial-write corruption.
- **Worker pool size cap.** `[worker] max_pool_workers` config key (default 4, ceiling 8, `TOKEN_GOAT_WORKER_MAX_POOL` env override) prevents runaway thread spawning on large repos.
- **WAL checkpoint on DB close.** Non-fatal `PRAGMA wal_checkpoint(TRUNCATE)` added to write-session close; bounds WAL file growth between worker cycles.
- **`with_timeout` row factory fix.** `sqlite3.Row` row_factory was missing from the `with_timeout` connection path; affected callers got plain tuples instead of named-column rows.
- **Snapshot truncation at 50 KB.** Large-file snapshots are capped at `SNAPSHOT_TRUNCATE_BYTES` (50 KB) to bound disk use; SHA integrity check added to `symbol_changed_since_read()` so corrupt snapshots are treated as missing rather than emitting phantom diff hints.
- **Multi-file `cat`/`Get-Content` detection.** `bash_parser.py` now returns all paths from a multi-file `cat a b c` or `gc f1 f2` command, not just the first one. `post_bash` marks every file in session history so the "already read" dedup hint fires on repeat access of any file in the batch.
- **PowerShell `Get-Content` extended.** `bash_parser` now handles `Sort-Object`, `ForEach-Object`, `Tee-Object`, `Measure-Object`, `Group-Object`, and `ConvertTo-*` as passthrough cmdlets; `Where-Object -notmatch`/`-notlike`; `-Wait` flag (tail -f equivalent); `-Include`/`-Exclude`/`-Filter`/`-Stream`/`-ReadCount` as unconditional arg-consumers so glob patterns and stream names are never mistaken for file paths. Install content (CLAUDE_MD, SKILL_MD, CODEX_AGENTS_MD) and routing table now include `Get-Content` as a read-equivalent alongside `cat`/`bat`.
- **`_enforce_char_budget` off-by-one fix.** Budget counted N newlines for N kept lines instead of N-1, overcounting by 1 character per line. On tight budgets this caused manifest sections to be truncated earlier than necessary.
- **Dirty-queue `UnicodeDecodeError` fix.** Binary or truncated `dirty.txt` entries no longer crash the worker; `errors="replace"` applied on read.
- **macOS `LaunchAgent` `KeepAlive`.** Changed from `true` (always restart) to `{SuccessfulExit: false}` (restart only on crash).
- **WSL detection helper.** `is_wsl()` extracted to `util.py`; crontab availability pre-checked on POSIX before attempting CronCreate hook.

### Context Savings

- **Session-aware `recent` tier.** `token-goat recent` now shows a "read this session" tier between edited and git-history tiers, with cross-tier deduplication.
- **Branch name in compact manifest.** Manifest header includes `branch: <name>` via `git symbolic-ref`; detached HEAD handled gracefully.
- **Surgical-read hints for new indexers.** `hints.py` emits per-type hints for CSS/SCSS, SQL, GraphQL, Proto, `.env`, and Makefile files with per-type size thresholds.
- **Fuzzy file matching with did-you-mean.** `read_commands.py` falls back to fuzzy basename matching when a file is not found; suggests candidates in both text and JSON output.
- **Manifest section ordering.** Fixed to `edited → recent_commits → symbols → key-files → skills`; cross-section symbol dedup regression guard added.

### Quality and Tests

- **200+ new tests** across all changed modules.
- **Parametrized indexer dispatch tests.** 22 individual dispatch tests converted to `@pytest.mark.parametrize` in `test_parser_*.py`.
- **Cross-platform compat tests extended.** `test_cross_platform_compat.py` now covers the `languages/` directory (26 files) with type-alias-statement, deprecated-stdlib, and `tomllib` fallback checks.
- **Unified JSON schema consistency tests.** `test_json_schema_consistency.py` verifies the `{"query":…,"results":…,"total":…}` envelope across all affected commands.
- **Per-language index breakdown.** `token-goat index` shows a per-language file count when multiple types are present.
- **Config type validation.** Numeric config values are validated with actionable error messages; `doctor` shows the config file path.

## [1.0.1] - 2026-06-02

Bundles two 50-commit improvement runs: a skill-cache / context-savings accuracy loop (source_sha stale-compact detection, separate compact/body eviction buckets, sidecar schema v2, lazy skill injection, gzip web-cache compression, serve-diff-on-reread, session-hint cooldown) and a general quality loop (type safety, error handling, performance, security, test coverage, code clarity, DRY, docs, observability, imports). Also fixes broken stats accounting for `bash_output_cached`, `skill_cached`, `web_output_cached`, `symbol`, `map`, and `semantic` lookup savings, and adds RuffFilter and MypyFilter bash-compress support.

### Bash compression

- **Nine new filters (22 → 31 total).** `eza` / `exa` / `ls` (directory listings trimmed to header + 25 + 5 entries; `--tree` mode keeps 40 + 10), `tree` (50 + 10 + final summary line), `fd` / `fdfind` (path lists trimmed to 35 + 5), `bat` / `batcat` (strips ANSI chrome and box-drawing borders, caps at 50 lines), `delta` (strips decorative separators, caps at 80), `jq` (caps at 200 preserving closing brackets), `yq` (caps at 150), `fzf` (compact selection output, caps long upstream pipes at 50), `lazygit` (detects TUI mode and returns an actionable note instead of raw control sequences).
- **GhFilter list truncation.** `gh pr list`, `gh run list`, and `gh issue list` tabular output is now capped at 30 rows with a count summary.
- **`_head_tail_compress` helper.** Shared head + tail + marker slicing extracted from 8 filter classes, eliminating repeated boilerplate.
- **RuffFilter and MypyFilter.** New filters compress ruff check and mypy output, stripping redundant context lines and capping verbose diagnostic blocks.

### Reliability

- **`project not yet indexed` diagnosis.** `spawn_index_detached` now routes stderr to `index-spawn.log` instead of `DEVNULL`, making silent AV/import failures visible. `_not_indexed_hint` distinguishes three states: *indexing in progress* (PID alive), *spawn failed* (marker exists, PID dead), and *not yet started*. `_auto_index_if_needed` now warns in logs when the spawn returns no PID.
- **Consistent LRU eviction for `hints_seen` cap.** `mark_hint_seen` and `_merge_session_caches` now apply the same LRU strategy (evict lowest-count entries) when `hints_seen` exceeds the 500-entry cap, preventing dedup state thrashing.
- **Type annotation shadow fix.** Variable shadowing in `compact._allocate_manifest_budgets` eliminated; `no-redef` mypy error resolved.
- **Hook dispatcher error logging.** Clarified the top-level exception safety net in `hooks_cli` dispatcher to log via `_LOG.exception()` instead of silently swallowing errors.

### DRY

- **`load_session_safe` helper in `hooks_common`.** Centralises the repeated `try/except(OSError, ValueError)` session-load pattern from `hooks_read`, `hooks_edit`, and `hints` into a single fail-soft helper.
- **`hints.py` dedup guard helpers.** `_check_dedup_preconditions`, `_check_entry_staleness`, `_check_dedup_min_threshold`, and `_record_dedup_hint_emitted` extracted from the four dedup builders, eliminating ~150 lines of duplicated guard logic.

### Compaction

- **Clearer manifest section headers.** `Syms` → `Symbols Accessed`, `Ran` → `Recent Commands`, `Web` → `Web Fetches`, `Grep` → `Patterns Searched`.

### Tests

- **~20% test suite wall-time reduction.** Eviction tests reduced from 4098 to 100 files; session-cache parameter added to manifest-trim and line-range loops to avoid repeated disk I/O.
- **Integration tests for new filters.** Nine integration tests verify each new filter family dispatches correctly through the hook pipeline.
- **Edge case coverage for `_not_indexed_hint`.** Tests cover malformed marker files and missing locks directory.

### Skill cache

- **`source_sha` in compact headers.** Embedded SHA enables stale-compact detection: the pre-read hook emits an advisory when a skill body changes on disk after the compact was cached.
- **Separate eviction buckets.** Compact slices (1 MB cap) and full bodies (5 MB cap) evict independently so a large body cannot push out all compact entries.
- **Sidecar schema v2.** Forward-compatible sidecar metadata with graceful migration for v1 entries.
- **Lazy skill injection.** The compaction manifest emits a `token-goat skill-body --compact` recall pointer instead of the full compact text; reduces manifest token cost for sessions with many loaded skills. Opt-out via `TOKEN_GOAT_LAZY_SKILL_INJECTION=0`.
- **Gzip body compression for skills ≥ 16 KB.** Transparent decompression on read; reduces eviction pressure.

### Context savings

- **Stats accounting fixed.** `bash_output_cached`, `skill_cached`, and `web_output_cached` now record actual `bytes_saved`; previously always 0. `symbol`, `map`, `section`, and `semantic` lookup stats record `estimated_full_size − slice_size` as savings.
- **Serve diff on re-read (opt-in).** `[read_hints] serve_diff_on_reread = true` intercepts re-reads of changed files and returns a unified diff instead of the full content.
- **Gzip compression for web-cache bodies ≥ 16 KB.** Same pattern as skill body compression; reduces disk footprint and eviction churn.
- **Session-hint cooldown.** Each file's session hint is suppressed after first emission within the session; `session_hint_suppressed` stat tracks the bypass rate.
- **Unified token formula.** `max(1, bytes // 3 + 1)` replaces inconsistent `bytes // 4` across all accounting sites.
- **Stats category grouping.** `token-goat stats` groups kinds by Read / Bash / Cache / Hints / Skills / Other.

### Quality

- **Type signatures strengthened.** `Any` parameters replaced with concrete types; `_lookup_in_cache` and `_render_section` made generic with `TypeVar`.
- **Exception chaining.** `raise ... from e` added at key error propagation points; bare `except` clauses replaced.
- **Regex patterns hoisted.** 16 in-function `re.compile()` calls in `bash_compress.py`, `compact.py`, and `bash_cache.py` moved to module/class level (pre-bash and pre-compact hot paths).
- **File permission hardening.** Lock files and session contention marks set to `0o600` (previously `0o644` or implicit umask).
- **DRY helpers.** `path_mtime_key()` added to `cache_common`; `_extract_grep_args()` and `_get_bash_command_from_payload()` extracted in `hooks_read`.
- **Debug log coverage.** Silent decision points in `bash_compress`, `cache_common`, `compact`, and `hooks_cli` now emit DEBUG records.
- **55 new tests** covering coverage gaps, error-handling paths, permission modes, and DRY helper contracts.

## [1.0.0] - 2026-05-29

Bundles the work from the 35-iter `/improve` run (six themed loops, 2026-05-25 → 2026-05-26): compaction hardening, doctor visibility, opt-in observability, four new bash-compress filters, and a stack of reliability fixes. First stable release under Semantic Versioning.

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
