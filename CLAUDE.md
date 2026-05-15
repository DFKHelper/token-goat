# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
uv sync --all-extras        # Install deps including dev extras
uv run pytest               # Run all tests
uv run pytest tests/test_worker.py::test_name  # Run a single test
uv run ruff check           # Lint (E, F, W, I, B, UP, SIM; E501 ignored; line length 100)
uv run ruff check --fix     # Auto-fix lint issues
uv run mypy src             # Type check
```

CI runs on Windows 2022 across Python 3.11, 3.12, and 3.13. All three must pass.

## Architecture

Token-goat is a Claude Code / Codex CLI companion that reduces token burn on Windows via three automatic mechanisms: **image shrinking** (intercept large images before they hit the model), **session-aware read hints** (nudge away from re-reading already-touched files), and **surgical reads** (CLI commands that extract one symbol or section instead of a whole file).

### Component Map

```
src/tokenwise/
├── cli.py              # Typer CLI — all user-facing and internal subcommands
├── hooks_cli.py        # Hook dispatcher: session-start, pre-read, pre-fetch, post-edit, post-read, pre-compact
├── worker.py           # Background daemon — dirty-queue polling, maintenance, LRU eviction
├── db.py               # SQLite + sqlite-vec — global.db + per-project DBs
├── parser.py           # Tree-sitter orchestration — index walk, symbol/ref/section extraction
├── embeddings.py       # Fastembed (BAAI/bge-small-en-v1.5, 384 dims) + sqlite-vec queries
├── read_replacement.py # Symbol/section extraction for tokenwise read / tokenwise section
├── session.py          # Per-session JSON cache: tracks (file, ranges, symbols, read_count, edited_files)
├── compact.py          # Compaction assist: build_manifest() produces session manifest for PreCompact hook
├── config.py           # TOML config loader (paths.config_path()); [compact_assist] section + env override
├── hints.py            # Builds "already read" hint text injected by pre-read hook
├── image_shrink.py     # Pillow compression + image cache (LRU at 500 MB / 80% target)
├── gdrive.py           # Google Drive API — credentials, fetch, image cache integration
├── webfetch.py         # URL image download + cache
├── install.py          # One-time setup: HKCU Run registry, settings.json, skill, CLAUDE.md
├── paths.py            # All paths under %LOCALAPPDATA%\Zelys\tokenwise\; also claude_skills_dir(), claude_plugins_dir()
├── project.py          # Project root detection; make_project_at() for marker-free directories
├── repomap.py          # PageRank-ranked, token-budgeted repo overview (tokenwise map)
├── bash_parser.py      # Codex Bash tool read-equivalent detection (cat/head/tail/bat/…)
├── stats.py            # Cumulative token/byte savings tracking
└── languages/          # Tree-sitter adapters: python, typescript, go, rust, markdown, liquid, html, json
```

### Data Flow

1. **Indexing** — `parser.py` walks the project, extracts symbols/refs/sections via tree-sitter language adapters, stores rows in the per-project SQLite DB. `embeddings.py` chunks the content and stores 384-dim vectors in a `vec0` virtual table (sqlite-vec).
2. **Incremental updates** — `hooks_cli.py::post-edit` appends touched paths to `queue/dirty.txt`. `worker.py` drains this queue every 2 s, SHA-checks each file, and reindexes only changed files.
3. **Hook intercept** — On every `Read`/`Grep`/`Glob`/`WebFetch` call, hooks fire before and after. Pre-read: image-shrink or emit session hints. Post-read: mark file in session cache. Post-edit: record edited files to session cache. Pre-compact: build and inject a session manifest as `systemMessage` before Claude Code compacts the conversation.
4. **CLI reads** — `token-goat symbol`, `token-goat read`, `token-goat section`, `token-goat semantic` query the indexed DBs and return narrow slices, typically 85–97% smaller than the full file.

### Storage Layout (`%LOCALAPPDATA%\Zelys\token-goat\`)

| Path | Contents |
|------|----------|
| `global.db` | Projects table, global symbols, cumulative stats |
| `projects/{hash}.db` | Per-project: files, symbols, refs, sections, chunks, embeddings, stats |
| `sessions/{session_id}.json` | Per-session read-tracking for hint generation |
| `images/` | Shrunk image cache (LRU-evicted) |
| `models/` | Fastembed ONNX model (~130 MB, downloaded once) |
| `logs/{YYYY-MM-DD}.log` | Daily rotating logs (7-day retention) |
| `locks/{hash}.lock` | Per-project writer locks (PID + timestamp) |
| `queue/dirty.txt` | JSON-lines dirty queue drained by worker |

Project hash = SHA1 of the canonical POSIX path with lowercase drive letter.

### Key Design Decisions

**Fail-soft hooks** — Every hook handler catches `BaseException`, always returns `{"continue": true}`, always exits 0. A broken token-goat must never interrupt the agent's work.

**GUI-subsystem entry points** — `token-goat-hook` and `token-goat-worker` are `[project.gui-scripts]` entries (same `main()` as the CLI). Windows won't allocate a console for GUI-subsystem `.exe` files, so hooks fire silently without flashing terminal windows. The worker registers itself in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` via `pythonw.exe -m tokenwise.cli worker --daemon` — no admin required.

**Corruption auto-recovery** — `db.py` distinguishes a busy/locked DB (transient, retry) from a genuinely corrupt DB (quarantine + rebuild). `PRAGMA integrity_check` runs on connection open. Stale locks (PID gone or >10 min old) are auto-cleared.

**Session cache** — `session.py` writes a JSON file keyed by Claude session ID. The pre-read hook reads this to emit "you already read lines X–Y of this file" nudges. Post-read hook updates it after every Read/Grep/Glob. Post-edit hook records every Write/Edit/MultiEdit to `edited_files`.

**Compaction assist** — Before Claude Code compacts the conversation, the `PreCompact` hook calls `compact.build_manifest()` to build a structured `<400-token` summary (edited files first, then symbols accessed, then key files read) and returns it as `systemMessage`. The compaction LLM receives the manifest in context and preserves the most important details. Configurable via `config.toml` (`[compact_assist]`) or disabled via `TOKENWISE_COMPACT_ASSIST=0`. Inspect what would be emitted with `token-goat compact-hint --session-id <id>`.

**Read-only DB path** — `db.open_global_readonly()` / `db.open_project_readonly()` open SQLite with `?mode=ro` URI flag, skipping `PRAGMA integrity_check`, DDL `executescript`, WAL activation, and sqlite-vec loading. Used by `stats.py` to avoid the N×integrity_check overhead that previously caused `token-goat stats` to take ~10 s.

**Marker-free indexing** — `project.make_project_at(root)` creates a `Project` with `marker="manual"` for any directory, bypassing detection. `token-goat index --root <path>` uses this so directories like `~/.claude/skills/` and `~/.claude/plugins/` can be indexed without any project marker. Cross-project file resolution: `token-goat section` and `token-goat read` fall back to `read_replacement.find_in_all_projects()` when a file is not found in the current project, so skills are reachable from any working directory.

**Codex compatibility** — Hook handlers accept unknown CLI options (`ignore_unknown_options=True`) because Codex passes harness-specific flags. `bash_parser.py` detects read-equivalent Bash commands (cat/head/tail/bat/…) inside Codex's Bash tool and synthesizes a Read payload so image-shrink and session-hint logic applies identically.

**mypy suppressions** — Tree-sitter language adapters duck-type `.name`/`.kind`/`.span` on node objects (typed as `object`); `attr-defined` and `arg-type` errors are suppressed at `tokenwise.languages.*`. Fastembed's `.embed()` duck-type suppresses `attr-defined`/`union-attr` in `tokenwise.embeddings`.

### Adding a New Language

1. Create `src/tokenwise/languages/{lang}.py` following the pattern of an existing adapter (e.g., `go.py`). Implement `extract_symbols()`, `extract_refs()`, and optionally `extract_sections()`.
2. Register the language in `parser.py`'s language dispatch table.
3. Add the file extension → language mapping in `project.py` (or wherever file-type detection lives).
4. Add mypy overrides in `pyproject.toml` if the tree-sitter adapter generates attr/arg errors.

### Adding a New Hook Event

Hook handlers live in `hooks_cli.py`. Each is a Typer subcommand of the `hook` group. Input arrives as JSON on stdin; output is JSON on stdout. Use `normalize_payload()` / `denormalize_response()` to handle Claude vs. Codex wire-format differences. Register the new hook in `install.py` so it appears in `settings.json` after `token-goat install`.
