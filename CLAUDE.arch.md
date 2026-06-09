# Architecture Reference

Reference material for the token-goat codebase. Use `token-goat section "CLAUDE.arch.md::<Heading>"` for surgical access.

## Component Map

```
src/token_goat/
├── cli.py              # Typer CLI — all user-facing and internal subcommands
├── cli_doctor.py       # `token-goat doctor` — install state + cache health report
├── cli_stats.py        # `token-goat stats` rendering (panels + JSON)
├── hooks_cli.py        # Hook dispatcher: PreCompact handler lives here; dispatches all other events to the split modules below
├── hooks_common.py     # Shared hook plumbing: payload normalize/denormalize, fail_soft decorator, record_hint_stat_pair
├── hooks_read.py       # Pre-Read / Pre-Grep / Pre-Bash handlers (session hint, diff hint, bash/grep dedup)
├── hooks_edit.py       # PostToolUse(Edit|Write|MultiEdit) — content snapshots for diff-aware re-read
├── hooks_fetch.py      # Pre-WebFetch + post-WebFetch (image shrink + web-output cache)
├── hooks_session.py    # SessionStart (with post-compact recovery hint)
├── hooks_skill.py      # PostToolUse(Skill) — capture loaded skill bodies for post-compact recall
├── hook_registry.py    # Single source of truth: HookEvent dataclasses; install._hooks_block, _codex_hooks_block, _HANDLER_LOOKUP, EVENTS, and the lazy __getattr__ event_map all derive from it. cli.py raises ImportError at load if any registered event is missing a @hook_app.command decorator
├── skill_cache.py      # skills/ disk store: skill bodies keyed by (session, name, content sha)
├── bridges.py          # In-process plugin bridges for openclaw and opencode (spawnSync('token-goat', ['hook', event]))
├── worker.py           # Background daemon — dirty-queue polling, maintenance, LRU eviction
├── worker_daemon.py    # Daemon process lifecycle helpers (cross-platform autostart, pid file)
├── db.py               # SQLite + sqlite-vec — global.db + per-project DBs, read-only fast path
├── parser.py           # Tree-sitter orchestration — index walk, symbol/ref/section extraction
├── embeddings.py       # Fastembed (BAAI/bge-small-en-v1.5, 384 dims) + sqlite-vec queries
├── read_replacement.py # Symbol/section extraction for `token-goat read` / `token-goat section`
├── read_commands.py    # CLI front-ends for the surgical read commands (symbol/read/section/semantic)
├── session.py          # Per-session JSON cache: tracks (file, ranges, symbols, read_count, edited_files, bash/web/grep history)
├── snapshots.py        # Per-session content snapshots used by diff-aware re-read
├── compact.py          # Compaction assist: build_manifest() for the PreCompact hook
├── config.py           # TOML config loader (paths.config_path()); per-feature [sections] + env overrides
├── hints.py            # Builds "already read" hint text injected by pre-read hook
├── image_shrink.py     # Pillow compression + image cache (LRU at 500 MB / 80% target)
├── gdrive.py           # Google Drive API — credentials, fetch, image cache integration
├── webfetch.py         # URL image download + web-output content cache (PostToolUse persistence)
├── web_cache.py        # web_outputs/ disk store: byte cap + oldest-first eviction + sidecar cleanup
├── bash_cache.py       # bash_outputs/ disk store: same shape as web_cache for cached Bash stdout/stderr
├── bash_compress.py    # PreToolUse(Bash) compression filters (pytest, npm, docker, ruff, …) + size caps
├── bash_runner.py      # `token-goat compress` shell runner: spawns the wrapped command, captures + filters
├── bash_parser.py      # Codex Bash tool read-equivalent detection (cat/head/tail/bat/…)
├── install.py          # One-time setup: HKCU Run registry, settings.json, CLAUDE.md, Codex config.toml + AGENTS.md, skill, plugin
├── cache_common.py     # Shared cache logic: `safe_cache_op` context manager, `store_blob`, `short_content_hash`, `evict_cache_dir` with LRU/byte-cap
├── paths.py            # All paths under %LOCALAPPDATA%\dfk-helper\token-goat\ (Win) or ~/.local/share/token-goat (Linux/WSL); claude_skills_dir(), claude_plugins_dir(), open_log_file(), safe_join(), hook_wrapper_path(), is_wsl()
├── project.py          # Project root detection; make_project_at() for marker-free directories
├── project_memory.py   # Reads CLAUDE.md / AGENTS.md memory blocks into the per-session cache
├── git_history.py      # Recent-git-history hints surfaced into the session/compact manifest
├── repomap.py          # PageRank-ranked, token-budgeted repo overview (token-goat map)
├── stats.py            # Cumulative token/byte savings tracking (read-only fast path via db.open_*_readonly)
├── util.py             # Cross-module helpers: run_git (canonical git subprocess), sanitize_surrogates (UTF-8 boundary), ellipsize, get_logger, utf8_bytes
├── render/             # Output renderers: ANSI text, stats panels, JSON renderers
└── languages/          # Indexers — tree-sitter adapters (python, typescript, go, rust, markdown, html, liquid,
                          php, cpp, csharp, java, kotlin, ruby) plus structured-config / regex adapters
                          (toml_idx, yaml_idx, json_idx, ini_idx, dockerfile_idx, css_idx, sql_idx,
                          graphql_idx, proto_idx, env_idx, makefile_idx);
                          common.py centralises decode/BOM-strip/end-line helpers shared by the latter group
```

## Storage Layout

**Windows:** `%LOCALAPPDATA%\dfk-helper\token-goat\`
**Linux / WSL:** `~/.local/share/token-goat\` (via `platformdirs.user_data_dir("token-goat", "dfk-helper")` — note: platformdirs omits the app-author component on Linux, so the path is shorter)

| Path | Contents |
|------|----------|
| `global.db` | Projects table, global symbols, cumulative stats |
| `projects/{hash}.db` | Per-project: files, symbols, refs, sections, chunks, embeddings, stats |
| `sessions/{session_id}.json` | Per-session read-tracking for hint generation |
| `images/` | Shrunk image cache (LRU-evicted) |
| `skills/` | Cached skill bodies (5 MB cap, LRU-evicted) |
| `models/` | Fastembed ONNX model (~130 MB, downloaded once) |
| `logs/{YYYY-MM-DD}.log` | Daily rotating logs (7-day retention) |
| `logs/hooks-stderr.log` | Hook-subprocess crash sink (1 MB cap + `.prev` rotation) |
| `locks/{hash}.lock` | Per-project writer locks (PID + timestamp) |
| `queue/dirty.txt` | JSON-lines dirty queue drained by worker |
| `bin/tg-hook.cmd` | Persistent hook wrapper outside the uv tool venv (Windows; `tg-hook.sh` on POSIX). Bridges `uv tool install --reinstall` race — emits `{"continue":true}` and exits 0 when the venv's `token_goat` module is briefly absent. |
| `sentinels/manifest_sha_{session_id}` | `sha256(manifest_text)\|fingerprint\|emit_ts` from PreCompact; manifest re-emit short-circuits when unchanged |
| `sentinels/recovery_pending_{session_id}` | SessionStart-with-source-compact writes here; pre-read hook injects + deletes on first tool call |
| `sentinels/compact_skip_{session_id}.sentinel` | Activity-floor sentinel; pre-compact short-circuits without importing token_goat when present + recent |
| `web_outputs/` | WebFetch body cache (byte-capped, LRU-evicted) |
| `bash_outputs/` | Bash stdout/stderr cache (byte cap + 4096 file-count cap, oldest-first eviction) |

Project hash = SHA1 of the canonical POSIX path with lowercase drive letter.

## Key Design Decisions

**Fail-soft hooks** — Every hook handler catches `BaseException`, always returns `{"continue": true}`, always exits 0. A broken token-goat must never interrupt the agent's work.

**GUI-subsystem entry points** — `token-goat-hook` and `token-goat-worker` are `[project.gui-scripts]` entries (same `main()` as the CLI). Windows won't allocate a console for GUI-subsystem `.exe` files, so hooks fire silently without flashing terminal windows. On Linux the distinction has no effect (no GUI subsystem). The worker registers itself for autostart via `install._register_autostart()`, which dispatches by platform: HKCU Run registry key on Windows (`pythonw.exe -m token_goat.cli worker --daemon`), systemd user service on Linux with systemd available, XDG `.desktop` autostart fallback otherwise. No admin required on any platform.

**Corruption auto-recovery** — `db.py` distinguishes a busy/locked DB (transient, retry) from a genuinely corrupt DB (quarantine + rebuild). `PRAGMA integrity_check` runs on connection open. Stale locks (PID gone or >10 min old) are auto-cleared.

**Session cache** — `session.py` writes a JSON file keyed by Claude session ID. The pre-read hook reads this to emit "you already read lines X–Y of this file" nudges. Post-read hook updates it after every Read/Grep/Glob. Post-edit hook records every Write/Edit/MultiEdit to `edited_files`.

**Compaction assist** — Before Claude Code compacts the conversation, the `PreCompact` hook calls `compact.build_manifest()` to build a structured `<400-token` summary (edited files first, then symbols accessed, then key files read) and returns it as `systemMessage`. The compaction LLM receives the manifest in context and preserves the most important details. Auto-compactions (context-pressure-triggered) get a multiplied budget — `[compact_assist] auto_trigger_multiplier` defaults to 2.0× because preserving more context at the moment the harness is forced to compact is net-positive. The no-op fast path is gated by a configurable `compact_skip_ttl_secs` sentinel (default 300 s) plus an activity floor (session mtime > sentinel mtime busts the cache). Configurable via `config.toml` (`[compact_assist]`) or disabled via `TOKEN_GOAT_COMPACT_ASSIST=0`. Inspect what would be emitted — applying every live-hook gate — with `token-goat compact-hint --session-id <id> [--trigger auto]`.

**Skill preservation** — `hooks_skill.post_skill` fires on every `PostToolUse(Skill)` and captures the loaded skill body to `skills/` keyed by `(session, skill_name, content_sha)`. The compaction manifest gains an `### Active Skills` section listing every loaded skill with a `token-goat skill-body <name>` recall hint, and the post-compact recovery hint surfaces the same list under `**Skills**:`. Solves the "I forgot parts of the skill after compaction" problem — load-bearing prose (Ralph's DoD gates, /improve's iteration sequence) is recoverable without re-invoking the skill (which would replay side effects). Configurable via `config.toml` (`[skill_preservation]`) or disabled via `TOKEN_GOAT_SKILL_PRESERVATION=0`. Recall commands: `token-goat skill-body <name>` (full body, default head+tail slice), `token-goat skill-body <name> --section <heading>` (one H2/H3/H4 section, typically 90%+ savings), `token-goat skill-body <name> --compact` (auto-extracted ~400-token summary with `--- compact form (N tokens) ---` header), `token-goat skill-compact <name>` (regenerate + store compact). Compact extraction prefers an author-curated `<!-- COMPACT_END -->` marker in the skill body (everything above the marker is the compact section); falls back to heuristic extraction of frontmatter description, headings, CRITICAL/MUST/NEVER/RULE lines, and bold directives. The pre-read hook (`hooks_read._handle_skill_file_read`) intercepts direct Read calls to skill body files when the skill is already cached this session and emits a fingerprint-deduplicated hint redirecting to `token-goat skill-body` instead.

**Opt-in hint sidecars and watchdog tuning** — `[hints] json_sidecar` (or `TOKEN_GOAT_HINT_JSON_SIDECAR=1`) prepends a single-line JSON sidecar to every dedup / re-read / unchanged-file / structured-file hint, so downstream tooling can parse hints without scraping prose. The prose line is preserved verbatim — dedup fingerprints, curator metrics, and existing assertions are unaffected. `TOKEN_GOAT_HOOK_WATCHDOG_MS` overrides the hook subprocess deadline (operator-tunable for slow CI / cold-cache machines); the default budget is loaded by `hooks_common.py`.

**Read-only DB path** — `db.open_global_readonly()` / `db.open_project_readonly()` open SQLite with `?mode=ro` URI flag, skipping `PRAGMA integrity_check`, DDL `executescript`, WAL activation, and sqlite-vec loading. Used by `stats.py` to avoid the N×integrity_check overhead that previously caused `token-goat stats` to take ~10 s.

**Marker-free indexing** — `project.make_project_at(root)` creates a `Project` with `marker="manual"` for any directory, bypassing detection. `token-goat index --root <path>` uses this so directories like `~/.claude/skills/` and `~/.claude/plugins/` can be indexed without any project marker. Cross-project file resolution: `token-goat section` and `token-goat read` fall back to `read_replacement.find_in_all_projects()` when a file is not found in the current project, so skills are reachable from any working directory.

**Codex compatibility** — Hook handlers accept unknown CLI options (`ignore_unknown_options=True`) because Codex passes harness-specific flags. `bash_parser.py` detects read-equivalent Bash commands (cat/head/tail/bat/…) inside Codex's Bash tool and synthesizes a Read payload so image-shrink and session-hint logic applies identically.

**mypy suppressions** — Tree-sitter language adapters duck-type `.name`/`.kind`/`.span` on node objects (typed as `object`); `attr-defined` and `arg-type` errors are suppressed at `token_goat.languages.*`. Fastembed's `.embed()` duck-type suppresses `attr-defined`/`union-attr` in `token_goat.embeddings`.

## Adding a New Language

Two adapters styles exist in `src/token_goat/languages/`:

- **Tree-sitter adapters** (e.g. `go.py`, `python.py`, `typescript.py`) — use `common.collect_symbols_and_refs` and require the `tree-sitter-language-pack` grammar binary.
- **Structured-config / regex adapters** — no tree-sitter dependency; use `common.scan_flat_headers`, `common.decode_source_text`, and `common.assign_flat_end_lines`. Current examples: `toml_idx.py`, `yaml_idx.py`, `json_idx.py`, `ini_idx.py`, `dockerfile_idx.py`, `css_idx.py`, `sql_idx.py`, `graphql_idx.py`, `proto_idx.py`, `env_idx.py`, `makefile_idx.py`. Prefer this style for any format where pure-regex extraction is sufficient — it avoids platform-specific C extension dependencies.

Steps to add a new language:

1. Create `src/token_goat/languages/{lang}.py`. For tree-sitter adapters, follow `go.py`; for regex adapters, follow `dockerfile_idx.py` or `makefile_idx.py`. Implement `extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]`.
2. Register the language in `parser.py`'s `_EXTRACTOR_REGISTRY` using `_language_importer("{lang}")`.
3. Add file extension → language key entries to `LANG_BY_EXT` in `parser.py`, or basename → language key entries to `LANG_BY_BASENAME` for files identified by full basename (e.g. `Makefile`, `Dockerfile`, `.env`).
4. Add mypy overrides in `pyproject.toml` if the tree-sitter adapter generates attr/arg errors.

## Adding a New Hook Event

The single source of truth is `hook_registry.HOOK_EVENTS` — a list of `HookEvent` dataclasses. Adding an entry there automatically derives the five aligned tables (settings.json entries, Codex config entries, bridge event lists, etc.) that `_assert_hook_registry_aligned()` in `cli.py` validates at startup. You must still add the `@hook_app.command` handler by hand in `hooks_cli.py` (input arrives as JSON on stdin, output as JSON on stdout; use `normalize_payload()` / `denormalize_response()` for Claude vs. Codex vs. Gemini wire-format differences). Cross-bridge alignment is regression-tested in `tests/test_bridges.py::TestBridgeEventRegistryAlignment`; run it after any registry change. `install.py` is no longer the place to register hooks — the registry drives install automatically.
