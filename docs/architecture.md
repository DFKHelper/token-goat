# Architecture

This file holds design notes and high-level patterns that drive token-goat's implementation. Detailed technical architecture has moved to `docs/plans/`.

For installation and usage, see the [README](../README.md).

## Design notes

Token-goat's approach to context-saving rests on four pillars.

### 1. Image compression

The image-shrink pipeline intercepts full-resolution screenshots and documents in the `PreToolUse(Read|Glob|WebFetch)` hook, re-encodes to WebP (or AVIF when libaom is available), and substitutes the compressed copy before it reaches the model. Typical compression: 97.4% smaller than PNG, 39% smaller than JPEG. The cache is keyed on content SHA so identical images reused across prompts hit once.

### 2. Surgical reads

Instead of reading entire files, `token-goat symbol`, `token-goat read`, and `token-goat section` extract one function, class, or Markdown section — typically 85–97% smaller. The `Pre-Read` hook emits hints suggesting surgical reads on large files, and the `post-edit` hook tracks which edits were made so a follow-up read can be answered with a unified diff instead of a full-file re-read.

### 3. Compaction manifest

Before Claude Code summarizes a long session, the `PreCompact` hook injects a structured manifest listing edited files, accessed symbols, recent test outcomes, and git diffs. The manifest stays under a configurable token budget (default 400) and includes a `### MUST_PRESERVE` sealed block so the compaction LLM treats critical context as load-bearing. Post-compaction, the `SessionStart` hook emits a recovery hint listing cached Bash outputs, WebFetch responses, and skill bodies so the agent can recall prior work without re-running or re-fetching.

### 4. Output caching and dedup

Every `Bash`, `WebFetch`, and `Skill` invocation is cached. On a repeat, the `Pre-*` hook emits a dedup hint pointing at `token-goat bash-output <id>`, `token-goat web-output <id>`, or `token-goat skill-body <name>` instead of re-executing. The cache is byte-capped with LRU eviction and oldest-first expiry.

## Recent improvements (22 iterations, May 2026)

The latest iteration (v0.9.0-unreleased) added 20 context-savings refinements:

- **Hint compaction.** Terse-mode substitution and 8-char output IDs cut injection overhead by ~40%.
- **Hint intelligence.** Curator pass skips dedup hints when ignored; fingerprinting prevents false-positive dedup across files; unchanged-file short-circuit avoids hint noise on stable content.
- **Hint budgeting.** Hard per-kind ceilings (files=5, bash=3, web=2, skills=4) prevent hint spam.
- **Structured-file hints.** CSV headers, JSON keys, and log formats summarized instead of full-file suggestion.
- **Manifest hygiene.** MUST_PRESERVE sealed block, What Worked section, inline git diffs, TODOs from TaskList, project-path stripping.
- **Image formats.** AVIF support via libaom; WebP fallback; codec auto-detection.
- **Recovery density.** Inline skill checklists, bash-snippet skip when cached, 3-item activity-aware bundling.
- **Semantic output.** Compact mode (one line per result) for map, compact-hint, and list-like outputs.
- **Benchmarking.** Token-savings regression suite locks in measured wins.

See `docs/plans/2026-05-23-context-savings-design.md` for the design rationale behind each feature.

#### 68-iter additions (May 2026)

- **Manifest bold-label format.** The manifest no longer uses H3 headers (`### Edited:`) for its internal sections; each section now opens with an inline bold label (`**Edited:**`, `**Syms:**`, `**Bash:**` etc.), saving ~4 tokens per heading while keeping the structure parseable by the compaction LLM.
- **Manifest SHA sidecar cache.** After emitting a manifest, `pre_compact` writes `sentinels/manifest_sha_<session_id>` containing the SHA of the serialised manifest. On the next invocation the manifest is rebuilt only when that SHA differs from the current session state, making redundant compaction calls near-zero cost.
- **`extract_image_summary` helper.** `image_shrink.py` exposes `extract_image_summary(path) -> dict` returning `{width, height, format, bytes, sha}`. The pre-read hook calls this to inject a lean alt-text block instead of redirecting to the raw (shrunk) path, enabling the model to reason about image metadata without loading pixels.
- **Cross-session grep dedup via `global.db`.** `hooks_read.py` records `(pattern, path_hash, session_id)` rows in a new `grep_patterns` table in `global.db`. On a repeat `Grep`, the pre-read handler checks this table for prior matches across all sessions and surfaces a dedup hint even when the current session has no prior record.
- **`hooks-stderr.log` crash sink.** A bootstrap wrapper in `hooks.py` routes unhandled hook subprocess exceptions to `data_dir()/hooks-stderr.log` (100 KB cap, `.prev` sibling rotation). The log path is reported by `token-goat doctor`.
- **Ruff filter.** `bash_compress.py` gained `RuffFilter` — groups `ruff check` output by rule code, keeps ≤3 examples per code, and formats a summary line matching the existing eslint/mypy filter shape.
- **AVIF support.** `image_shrink.py` probes for libaom at startup; when available, images are encoded as AVIF (~15% smaller than WebP). WebP remains the fallback.
- **Compact-speed cache fields.** `session.py` carries three private fields (`_disk_mtime`, `_pending_hint_save`, `_brief_cache`) that the PreCompact path reads without a disk round-trip. `_disk_mtime` tracks the last-written mtime to detect external changes; `_brief_cache` avoids recomputing the session-brief git fragment; `_pending_hint_save` batches hint-seen writes.

### Recent perf work (speed iterations, May 2026)

The compaction hook subprocess is the most latency-sensitive path in token-goat because it fires on every `/compact` and blocks the compaction LLM from starting. Two complementary techniques cut cold-start cost from ~190 ms to ~110 ms:

**Lazy imports.** `hooks_session.py` and `compact.py` previously imported `cache_common`, `session`, and each other at module top-level. Moving those imports inside the handler functions that need them means the Python interpreter only pays the import cost on paths that actually execute, not on every subprocess spawn. The pattern is: `def pre_compact(payload): import compact; ...` — one line, no abstraction needed.

**Compact-skip sentinel.** After emitting a manifest, `pre_compact` writes a touch-file to `data_dir()/sentinels/compact_skip_{session_id}`. On the next subprocess spawn, a tiny early-exit check reads only that file: if it exists, is <5 min old, and the session's `edited_files` list is empty, the subprocess prints nothing and exits in <1 ms — the entire hook payload is skipped without loading SQLite, session JSON, or git. The sentinel is invalidated by any `PostToolUse(Edit|Write|MultiEdit)` event.

**Git ops guarded by repo check.** `compact.build_manifest()` calls `git diff` and `git log` unconditionally, which stalls ~60–100 ms when `cwd` is outside any git repo (common in scratch dirs and `/tmp`). A single upfront `git rev-parse --is-inside-work-tree` short-circuits all git calls when the check fails.

**Test-suite speed.** The test suite uses `pytest-xdist --dist=loadscope` so tests in the same module share a worker process, keeping module-scoped fixtures (DB state, parser caches) alive across the module without cross-worker contamination. A `make_fake_git_repo` conftest helper creates marker-only project dirs without `git init`, keeping git-dependent tests confined to the `slow` marker group. `pytest-randomly` seeds expose order-dependent flakes; `pytest-rerunfailures` retries once before failing to absorb transient OS timing issues.

### Hook event flow

| Event | Fired by | Handles |
|-------|----------|---------|
| `SessionStart` | Claude Code on every session open | Detect post-compaction recovery; inject git brief; start background worker |
| `PreToolUse(Read\|Grep\|Bash)` | Before read-like operations | Emit session hints; compress bash output; suggest surgical reads |
| `PreToolUse(WebFetch)` | Before URL fetch | Shrink images; suggest cached responses on repeat fetch |
| `PostToolUse(Edit\|Write\|MultiEdit)` | After file write | Mark file as edited; enqueue for incremental reindex; record content snapshot |
| `PostToolUse(Read\|Grep\|Glob)` | After read-like operations | Update session cache with file accesses; emit diff hints |
| `PostToolUse(Bash)` | After command execution | Cache stdout/stderr for later recall |
| `PostToolUse(WebFetch)` | After URL fetch | Cache response body; persist images to shrink cache |
| `PostToolUse(Skill)` | After skill invocation | Cache skill body for post-compaction recall without re-invoke |
| `PreCompact` | Before conversation summary | Build and inject structured manifest |

### Data flow

1. **Indexing** — `parser.py` walks the project, extracts symbols/refs/sections via tree-sitter language adapters, stores rows in the per-project SQLite DB. `embeddings.py` chunks content and stores 384-dim vectors (sqlite-vec).
2. **Incremental updates** — `post-edit` appends touched paths to `queue/dirty.txt`. `worker.py` drains this queue every 2–10 s (adaptive backoff), SHA-checks each file, and reindexes only changed files.
3. **Session cache** — `session.py` writes a JSON file keyed by Claude session ID. The pre-read hook reads this to emit "already read" hints. Post-read hook updates it; post-edit hook marks edits.
4. **Output cache** — `bash_cache.py`, `web_cache.py`, and `skill_cache.py` store outputs under `data_dir()` with byte caps and LRU eviction. On repeat operation, the pre-* hook surfaces `token-goat <type>-output <id>`.
5. **Compaction assist** — `PreCompact` hook calls `compact.build_manifest()` to emit <400 tokens of structured summary, injected as `systemMessage` before compaction LLM runs. Post-compaction recovery hint lists cached entries under `**Skills**:`, `**Bash:**`, `**Web:**`, so the agent can recall without re-invoke.
6. **CLI reads** — `token-goat symbol`, `token-goat read`, `token-goat section`, `token-goat semantic` query the indexed DBs and return narrow slices.

## Design documents

Internal design rationale for each pillar:

- **Context savings** — `docs/plans/2026-05-23-context-savings-design.md` (40 KB). Covers hint system, compaction manifest, output caching, dedup filtering, and benchmarking.
- **DRY refactoring** — `docs/plans/2026-05-23-dry-design.md` (23 KB). Documents shared patterns across install, languages, bridges, and hooks.
- **Reliability** — `docs/plans/2026-05-23-reliability-design.md` (23 KB). Covers fail-soft patterns, corruption recovery, and WAL management.
- **Speed** — `docs/plans/2026-05-23-speed-design.md` (17 KB). Latency budgets, adaptive backoff, and read-only fast paths.

### 55-iter loop (May 2026)

A subsequent loop produced 57 commits primarily around reliability, security, and recurring-bug elimination. The architectural additions:

- **`hook_registry.py` — single source of truth for hook events.** A new top-level module declares each event once (`HookEvent` dataclass with matcher, timeout, dispatcher, applicable harnesses, docstring). Five derived tables — `install._hooks_block`, `install._codex_hooks_block`, `hooks_cli._HANDLER_LOOKUP`, `hooks_cli.EVENTS`, and the lazy `__getattr__::event_map` — now read from the registry. A startup `_assert_hook_registry_aligned()` in `cli.py` raises `ImportError` at package-load time if any registry event lacks a matching `@hook_app.command` decorator, so drift cannot reach production silently. Two prior production incidents (e53d553, a71092b) were missing-handler regressions that this gate would have caught. `tests/test_bridges.py::TestBridgeEventRegistryAlignment` extends the gate to the opencode + openclaw TS shim event tables.
- **Persistent hook wrapper.** `paths.hook_wrapper_path()` writes a `.cmd` (Windows) / `.sh` (POSIX) at `data_dir/bin/tg-hook.cmd` outside the uv tool venv. The wrapper checks for `site-packages/token_goat/__init__.py` on disk before forwarding to pythonw; if absent (`uv tool install --reinstall` is mid-flight), the wrapper emits `{"continue":true}` and exits 0. The hook entry-points in `settings.json` point at the wrapper, so a reinstall never produces a transient `ModuleNotFoundError` window. The wrapper's existence, content drift, and invocation are audited by `cli_doctor`.
- **Boundary utility helpers.** Three new helpers in `util.py` centralize patterns that previously appeared 6-16 times across the codebase. `run_git(args, *, cwd, timeout, env_extra, check)` is the canonical git subprocess wrapper; it always prepends `--no-optional-locks` and sets `encoding="utf-8", errors="replace"`. `sanitize_surrogates(text)` re-encodes lone surrogate bytes (cp1252/cp437 Windows console output) to U+FFFD — applied at the `post_bash` boundary, this eliminated 1,311 production crashes/week. `ellipsize(s, max_chars)` replaces the 3-line truncation pattern at 6+ sites. A new `paths.safe_join(base, fragment, *, ext)` validates null bytes, `..`, absolute paths (POSIX + Windows), and Windows-illegal colons in user-controlled fragments.
- **Session schema versioning.** `session.SCHEMA_VERSION` is now checked at load time; cached files with a mismatched (or missing) `schema_version` field are dropped and a fresh empty cache is returned. Subtle field-shape changes in future cache schemas can no longer leak stale data into every reader of a session.
- **DNS-pinned httpx transport.** `webfetch._resolve_and_validate_ip()` resolves a hostname once via `socket.getaddrinfo`, validates the IP against SSRF prefixes, and pins the connection to that IP via a custom `_make_pinned_transport()` httpx subclass that stubs `getaddrinfo` for the duration of `handle_request()`. A previously-open DNS rebinding window (hostile DNS server returns public IP to the validation query, private IP to httpx's reconnect) is closed. 9 regression tests exercise the IP-pinning path including IPv4-mapped IPv6 private ranges.
- **Process-local LRU on `session.load()`.** mtime-keyed cache (cap 4) skips JSON parse for back-to-back hooks in the same Claude tool turn. user-prompt-submit and subagent-stop both fire near-instantly and both call `session.load()`; without the cache each was reading + parsing 2-50 KB from disk independently. The mtime check ensures cross-process writes invalidate correctly.
- **Worker maintenance: orphan project GC.** `_gc_orphaned_projects()` removes global.db rows + per-project `.db`/`.db-wal`/`.db-shm` files for projects whose root directory no longer exists. A 30-minute safety window blocks early eviction of in-progress test runs. The DELETE is race-safe via `WHERE hash = ? AND last_seen <= ?` to prevent TOCTOU loss of just-touched rows.
- **`session.save_locked()` honest about lock-acquisition failures.** Three consecutive `_acquire_session_lock` timeouts flip `cache.unavailable = True` and the writer short-circuits. Previously the merge proceeded without the cross-process serialization guarantee on timeout, risking lost updates from concurrent hooks.
- **New doctor sections.** `Hook wrapper` checks existence, content drift, and invocation. `DB contention` scans the worker stderr log for `session slow` warnings in the last 24 h and reports count + max latency with `<10` / `10-49` / `>=50` tier thresholds. Cache file-count overage flags when bash_outputs exceeds the new per-cache `max_file_count` (default 4096 bodies = 8192 dir entries including sidecars).

For installation and usage, see the [README](../README.md).
