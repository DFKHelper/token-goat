# Migration Plan: Python → TypeScript (token-goat)

Generated from codebase audit. The Python package (65 source files + 26 language adapters) is the current production release. The TypeScript package (`packages/token-goat-ts/`) replaces it completely. Python is not maintained after migration.

---

## Already Ported (TS baseline as of this plan)

| TS file | Python source | Notes |
|---|---|---|
| `main.ts` | `__main__.py` | Entry point |
| `cli.ts` | `cli.py` | Commander dispatch |
| `types.ts` | Shared types | |
| `hook_registry.ts` | `hook_registry.py` | |
| `hooks_common.ts` | `hooks_common.py` | |
| `hooks_read.ts` | `hooks_read.py` | **Simplified** — only re-read dedup + large-file hint; full hint logic not ported |
| `hooks_edit.ts` | `hooks_edit.py` | |
| `hooks_compact.ts` | `compact.py` (hook only) | Pre-compact registration; manifest build not ported |
| `hooks_index.ts` | Dirty queue | |
| `image_shrink.ts` | `image_shrink.py` | |
| `relay.ts` | `hook_relay.py` | |
| `session.ts` | `session.py` | |
| `reset.ts` | test utility | |
| `db.ts` | `db.py` | Schema: files/symbols/refs/FTS5/vec0 |
| `parser.ts` | `parser.py` | |
| `parser_types.ts` | shared types | |
| `index_reader.ts` | `read_commands.py` (read side) | querySymbols, queryRefs, FTS5 search |
| `section_reader.ts` | `read_commands.py` (section) | Markdown/TOML/Python/kv sections |
| `worker.ts` | `worker.py` | |
| `baseline.ts` | `baseline.py` | |
| `install.ts` | `install.py` | |
| `bash_compress.ts` | `bash_compress.py` | |
| `bash_output_cache.ts` | `bash_cache.py` (partial) | In-memory store only |
| `web_cache.ts` | `web_cache.py` | |
| `fingerprint.ts` | `util.py` (sha256) | |
| `filters.ts` | `bash_compress.py` (filters) | |
| `paths.ts` | `paths.py` | |
| `constants.ts` | `paths.py` / config | |
| `env.ts` | `config.py` (env vars) | |
| `util.ts` | `util.py` | |
| `version.ts` | `__init__.py` | |
| `bridges/` (4 files) | `bridges.py` | |
| **Languages:** `typescript`, `javascript`, `python` | adapters | 3 of 26 ported |

---

## Classification Key

- **PORT-REQUIRED** — Core feature with active users; TS package incomplete without it
- **PORT-NICE** — Useful but non-blocking; port after REQUIRED is done
- **PORT-SKIP** — Python-specific, trivially thin, or superseded in TS

---

## Unported Modules

### Tier 1: PORT-REQUIRED (core correctness)

| Module | Lines | Complexity | Depends on | TS target |
|---|---|---|---|---|
| `config.py` | 2,262 | High | nothing | `config.ts` |
| `bash_cache.py` | 1,124 | Medium | `util`, `paths` | extend `bash_output_cache.ts` |
| `mcp_cache.py` | 363 | Low | `paths` | `mcp_cache.ts` |
| `skill_cache.py` | 1,945 | High | `paths`, `session` | `skill_cache.ts` |
| `webfetch.py` | 1,000 | Medium | `image_shrink`, `web_cache` | `webfetch.ts` |
| `hints.py` | 4,776 | Very High | `session`, `config`, `index_reader` | `hints.ts` |
| `compact.py` | 7,151 | Very High | `session`, `config`, `hints` | `compact.ts` |
| `hooks_session.py` | 2,001 | High | `session`, `config`, `hints` | `hooks_session.ts` |
| `hooks_fetch.py` | 968 | Medium | `webfetch`, `web_cache`, `hints` | `hooks_fetch.ts` |
| `hooks_skill.py` | 849 | Medium | `skill_cache`, `hints` | `hooks_skill.ts` |
| `hooks_cli.py` | 1,425 | High | all hooks, `compact` | extend `relay.ts` |
| `read_commands.py` | 4,728 | High | `index_reader`, `section_reader`, `db` | extend `cli.ts` + `index_reader.ts` |
| `read_replacement.py` | 1,355 | High | `hooks_read`, `hints`, `config` | extend `hooks_read.ts` |

### Tier 2: PORT-NICE (feature completeness)

| Module | Lines | Complexity | Depends on | TS target |
|---|---|---|---|---|
| `stats.py` | 1,388 | Medium | `session`, `paths` | `stats.ts` |
| `cli_stats.py` | (part of cli) | Medium | `stats` | extend `cli.ts` |
| `cli_doctor.py` | 2,567 | High | many | extend `cli.ts` |
| `cli_context_stats.py` | 276 | Low | `session` | extend `cli.ts` |
| `git_history.py` | 744 | Medium | `db`, `util` | `git_history.ts` |
| `repomap.py` | 1,528 | High | `db`, `parser`, `index_reader` | `repomap.ts` |
| `gdrive.py` | 666 | Medium | `image_shrink`, `paths` | `gdrive.ts` |
| `code_compress.py` | 295 | Low | nothing | `code_compress.ts` |
| `doc_compact.py` | 315 | Low | `section_reader` | `doc_compact.ts` |
| `notebook_compact.py` | 58 | Low | nothing | `notebook_compact.ts` |
| `render/` (4 files) | ~1,100 | Medium | `stats` | `render/` |
| `pack.py` | 476 | Medium | `parser`, `baseline` | extend `cli.ts` |
| `ask.py` | 590 | Medium | `config` | extend `cli.ts` |
| `resume.py` | 254 | Low | `session` | extend `cli.ts` |
| `snapshots.py` | 574 | Medium | `session`, `paths` | extend `cli.ts` |
| `memory_prune.py` | 396 | Low | `paths` | `memory_prune.ts` |

### Tier 3: PORT-SKIP

| Module | Lines | Reason |
|---|---|---|
| `lockdeps.py` | 267 | Python package management; no TS equivalent needed |
| `arch.py` | — | Replaced by `ARCHITECTURE.md` |
| `entropy.py` | 56 | Thin wrapper over `secrets`; use Node `crypto.randomBytes` inline |
| `logfold.py` | 109 | Debug tool; low ROI |
| `injection.py` | 267 | Prompt injection detection; can add later |
| `overflow_guard.py` | 103 | Compact guard; subsume into compact.ts |
| `todo.py` | 126 | Session todo; low priority |
| `trace.py` | 210 | Debug trace; low priority |
| `bash_detect.py` | 318 | Heuristics largely covered by bash_compress.ts |
| `bash_parser.py` | 1,363 | Covered by filters.ts + bash_compress.ts |
| `bash_runner.py` | 467 | Covered by existing Bash tool interaction model |
| `cache_common.py` | 950 | Common cache utilities; inline into per-module cache files |

---

## Language Adapters

All adapters extend `parser.ts`'s `LanguageAdapter` interface (already defined in `parser_types.ts`). Each adapter: regex/tree-sitter symbol extraction, section detection, language detection by extension.

### Already Ported
- `typescript.py` → `adapters/typescript.ts` (embedded in parser.ts)
- `javascript.py` → (covered by typescript adapter)
- `python.py` → (embedded in parser.ts)

### PORT-REQUIRED
| Adapter | Lines | Key symbols |
|---|---|---|
| `markdown.py` | 480 | H1–H6 sections, code fences, link refs |
| `json_idx.py` | 317 | Top-level keys |

### PORT-NICE (all remaining)
| Adapter | Lines |
|---|---|
| `cpp.py` | 265 |
| `css_idx.py` | 260 |
| `go.py` | 251 |
| `graphql_idx.py` | 247 |
| `php.py` | 226 |
| `sql_idx.py` | 209 |
| `proto_idx.py` | 197 |
| `yaml_idx.py` | 196 |
| `makefile_idx.py` | 194 |
| `csharp.py` | 191 |
| `kotlin.py` | 181 |
| `ruby.py` | 180 |
| `java.py` | 166 |
| `rust.py` | 153 |
| `ini_idx.py` | 141 |
| `toml_idx.py` | 125 |
| `liquid.py` | 109 |
| `html.py` | 104 |
| `dockerfile_idx.py` | 97 |
| `env_idx.py` | 52 |

---

## Implementation Batches (strict serial order — never parallel)

Each batch: implement → tests → `npm run typecheck && npm run lint && npm run test` → commit.

### Batch 1: Config Foundation
**Files:** `config.ts`
**Python source:** `src/token_goat/config.py`
**Complexity:** High — 25 config classes + TOML/env loading
**Test file:** `tests/test_config.ts`
**Key notes:**
- Config is a singleton loaded once; all other modules call `getConfig()`
- Env vars override TOML values
- Config classes: CompactAssistConfig, BashCompressConfig, HintsConfig, HooksConfig, ImageShrinkConfig, WorkerConfig, IndexingConfig, etc.
- Write as plain typed objects (no class hierarchy); use `loadConfig(): Config` function
- Store in `~/.token-goat/config.toml` (same path as Python)
- TOML parsing: use `@iarna/toml` (already in package.json?) or `toml` npm package

### Batch 2: Cache Infrastructure
**Files:** extend `bash_output_cache.ts` with disk persistence; new `mcp_cache.ts`
**Python sources:** `bash_cache.py`, `mcp_cache.py`
**Key notes:**
- `bash_cache.py` has extensive command fingerprinting: `is_git_mutable_command`, `git_state_fingerprint`, `normalize_command_for_cache_key`, `command_hash`
- `mcp_cache.py`: sidecar JSON metadata for MCP tool results; keyed by `mcp_hash(tool_name, tool_input)`
- Both write to the token-goat data dir

### Batch 3: Skill Cache
**Files:** `skill_cache.ts`
**Python source:** `skill_cache.py`
**Complexity:** High — 30 symbols
**Key notes:**
- Stores skill body + compact slice keyed by `(session_id, skill_name, content_sha)`
- Extraction helpers: `extract_compact_from_marker`, `extract_h2_headings`, `extract_named_section`
- Cross-session lookup: `find_cross_session_entry`
- SQLite backend (existing schema in `db.ts`)

### Batch 4: Web Fetch
**Files:** `webfetch.ts`
**Python source:** `webfetch.py`
**Key notes:**
- Fetches URLs to disk, deduplicates via `web_cache.ts`
- Image URL detection via content-type header + URL extension
- Integration with `image_shrink.ts` for image responses
- Use `fetch` (Node 18+) or `undici`; honor `timeout_sec` and `max_size_bytes`

### Batch 5: Hints System
**Files:** `hints.ts`
**Python source:** `hints.py` (4,776 lines — largest in Tier 1)
**Complexity:** Very High — 24 symbols
**Key notes:**
- `HintItem` + `ReadHint` types
- Build functions: `build_read_hint`, `build_bash_dedup_hint`, `build_web_dedup_hint`, `build_grep_dedup_hint`, `build_glob_dedup_hint`, `build_diff_hint`, `build_symbol_stale_hint`, `build_high_frequency_hint`, `build_doc_compact_hint`, `build_test_file_hint`
- `dedup_hints` + `apply_hint_priority_limit`
- `stale_threshold` based on session age
- Most hints are built by reading session cache + config; no file I/O
- hooks_read.ts currently has a simplified 73-line version; replace with full version

### Batch 6: Compact Manifest
**Files:** `compact.ts`
**Python source:** `compact.py` (7,151 lines — largest overall)
**Complexity:** Very High
**Key notes:**
- `build_manifest(session_id, {max_tokens})` — main entry point
- `build_manifest_adaptive` — context-pressure-aware variant
- `compute_adaptive_budget` — adapts token budget to session age + pressure
- `ContextPressure` + `get_context_pressure`
- `infer_session_goal` — extracts session goal from recent events
- `is_noise_path` — filters noise from file list
- `merge_session_manifests` — merges multiple manifests
- `write_session_manifest` / `read_all_session_manifests` — sidecar files
- hooks_compact.ts currently registers the hook but calls a stub; replace with real `build_manifest`

### Batch 7: Hook Handlers (session, fetch, skill)
**Files:** `hooks_session.ts`, `hooks_fetch.ts`, `hooks_skill.ts`
**Python sources:** `hooks_session.py`, `hooks_fetch.py`, `hooks_skill.py`
**Key notes:**
- `hooks_session.ts`: `session_start`, `user_prompt_submit`, `subagent_stop` — wire into `hook_registry`
- `hooks_fetch.ts`: `pre_fetch` (dedup hint), `post_fetch` (store to web_cache)
- `hooks_skill.ts`: `pre_skill` (check skill_cache), `post_skill` (store output)

### Batch 8: Hook CLI + Read Replacement
**Files:** extend `relay.ts` with `hooks_cli.py` logic; `read_replacement.ts`
**Python sources:** `hooks_cli.py`, `read_replacement.py`
**Key notes:**
- `normalize_payload` / `denormalize_response` — harness-specific normalization
- `safe_run` — fail-soft hook dispatcher (catches errors, still emits pass)
- `fail_soft` decorator pattern → TS wrapper function
- `read_replacement.py` extends `hooks_read.py` with full replacement machinery

### Batch 9: Read Commands (CLI)
**Files:** extend `cli.ts` + `index_reader.ts`
**Python source:** `read_commands.py` (4,728 lines)
**Key notes:**
- Commands: `symbol`, `read`, `section`, `semantic`, `refs`, `changed`, `config-get`, `skeleton`, `outline`, `map`, `bash-output`, `web-output`, `gdrive-sections`, `skill-body`, `skill-compact`, `skill-list`, `skill-size`
- Most read side already in `index_reader.ts`; add missing commands + CLI wiring
- `changed --symbol`: tree-sitter parse of git diff hunks → symbol names
- `bash-output`, `web-output`: read from `bash_output_cache.ts`, `web_cache.ts`

### Batch 10: Language Adapters (REQUIRED)
**Files:** `adapters/markdown.ts`, `adapters/json_idx.ts`
**Python sources:** `markdown.py`, `json_idx.py`

### Batch 11: Language Adapters (NICE — 20 adapters)
**Files:** one file per adapter in `adapters/`
**Python sources:** all remaining adapters
**Note:** these are independent of each other; write them in sequence within one agent pass

### Batch 12: Stats + Render
**Files:** `stats.ts`, `render/`
**Python sources:** `stats.py`, `render/*.py`
**Key notes:**
- Stats events: Read savings, Lookups, Hints, Bash, Web, Compact/Skills
- ANSI rendering for `stats show` and `stats reset` commands
- Category grouping: By-event + by-command breakdown

### Batch 13: Git History + Repomap
**Files:** `git_history.ts`, `repomap.ts`
**Python sources:** `git_history.py`, `repomap.py`
**Key notes:**
- `git_history.ts`: index commit messages + file paths; `find_commits_for_file`; `get_changed_symbols`
- `repomap.ts`: PageRank-based repo map; `compute_ranks`; `render_summary`

### Batch 14: CLI Commands (Tier 2)
**Files:** extend `cli.ts` with: `ask`, `pack`, `resume`, `snapshots`, `todo`, `memory-prune`
**Python sources:** `ask.py`, `pack.py`, `resume.py`, `snapshots.py`, `todo.py`, `memory_prune.py`
**Key notes:**
- `pack`: bundles a set of files/symbols into a paste-able context block
- `ask`: interactive question with context injection
- `resume`: shows session summary + next action hint
- `snapshots`: capture/restore session snapshots
- `memory-prune`: auto-prune memory files

### Batch 15: Doctor + Context Stats
**Files:** extend `cli.ts` with `doctor` and `context-stats`
**Python sources:** `cli_doctor.py`, `cli_context_stats.py`
**Key notes:**
- `doctor`: checks install integrity, DB health, worker status, config validation
- `context-stats`: token usage estimates for current context

### Batch 16: Google Drive
**Files:** `gdrive.ts`
**Python source:** `gdrive.py`
**Key notes:**
- OAuth2 flow; credentials stored in `~/.token-goat/gdrive_credentials.json`
- `fetch_file`, `list_drive_files`, `extract_section_index`
- Use `googleapis` npm package

---

## Testing Strategy

Every batch requires tests that:
1. Mock file I/O and SQLite where needed
2. Test each exported function in isolation
3. Include at least one integration test per hook handler
4. Mark any test using `git` or real SQLite with `@slow`

Run after each batch:
```bash
cd packages/token-goat-ts
npm run typecheck && npm run lint && npm run test
```

---

## Commit Convention

- One commit per batch
- Message format: `feat(ts): <area> (<N> files)`
- Never add Co-Authored-By or Claude attribution

---

## Status Tracking

| Batch | Status | Commit |
|---|---|---|
| 1: Config | pending | — |
| 2: Cache infrastructure | pending | — |
| 3: Skill cache | pending | — |
| 4: Web fetch | pending | — |
| 5: Hints system | pending | — |
| 6: Compact manifest | pending | — |
| 7: Hook handlers | pending | — |
| 8: Hook CLI + read replacement | pending | — |
| 9: Read commands | pending | — |
| 10: Language adapters (required) | pending | — |
| 11: Language adapters (nice) | pending | — |
| 12: Stats + render | pending | — |
| 13: Git history + repomap | pending | — |
| 14: CLI commands | pending | — |
| 15: Doctor + context stats | pending | — |
| 16: Google Drive | pending | — |
