# Architecture Reference

token-goat is a TypeScript CLI bundled to `dist/token-goat.mjs` via esbuild. The source lives in `src/*.ts`; tests under `tests/`. Build, test, and release tooling is npm-based (`npm install`, `npm test`, `npm run typecheck`, `npm run lint`). The canonical contributor guide lives in [AGENTS.md](AGENTS.md) — this file is the deeper architecture reference it complements.

## Component Map

**Entry and dispatch**

| Module | Role |
|--------|------|
| [`src/main.ts`](src/main.ts) | Package executable shim — calls `run()` from `cli.ts`; lets the event loop drain (no `process.exit`) so buffered stdout flushes cleanly on Windows pipes |
| [`src/cli.ts`](src/cli.ts) | Commander CLI; `buildProgram()` registers every subcommand and wires it to a `cmd*` handler via `guard()`; `run()` is the exported entry point |
| [`src/read_commands.ts`](src/read_commands.ts) | **Single source of truth for surgical-read logic** — `runSymbol`, `runRead`, `runSection`, `runRefs`, `runSkeleton`, `runOutline`, `runChanged`, `runConfigGet`, `runExports`, `runImports`, `runFind`, `runGrep`; all CLI read subcommands delegate here |
| [`src/types.ts`](src/types.ts) | Wire-shape leaf: `HookOutput` union, `HOOK_EVENTS`, `CANONICAL_TOOLS`, `GitResult` — no local imports, safe for any layer to depend on |

**Indexer and worker (critical path)**

| Module | Role |
|--------|------|
| [`src/parser.ts`](src/parser.ts) | Tree-sitter orchestration and all symbol/ref/section extraction. Inline tree-sitter extractors for TypeScript/JavaScript, Python, Go, Rust, Ruby, Java, and C/C++; regex/pattern extractors (inline) for Markdown, JSON, YAML, TOML, CSS, and Dockerfile; regex adapters (from `src/languages/`) for C#, PHP, HTML, Liquid, Kotlin, GraphQL, SQL, INI, Makefile, Proto, and `.env`. Main entry points: `indexFileSync()` (sync, called by worker drain), `parseFile()` (async, calls `parseContent()` then `writeParseResult()`) |
| [`src/parser_types.ts`](src/parser_types.ts) | Shared types: `SymbolEntry`, `RefEntry`, `FileIndexEntry`, `Language` union (27 values plus `unknown`), `EXTENSION_LANGUAGE`, `FILENAME_LANGUAGE`, `detectLanguage()` |
| [`src/worker.ts`](src/worker.ts) | Dirty-queue consumer — `runWorkerLoop()` polls every `DEFAULT_POLL_INTERVAL_MS` (2000 ms); `drainOnce()` calls `processDirtyBatch()`, which SHA-checks each dirty file then calls `makeIndexer(dbPath)` (production default: `globalDbPath()`); can run as a Node.js Worker Thread or as a detached child process |
| [`src/worker_daemon.ts`](src/worker_daemon.ts) | Daemon lifecycle: PID file write/read/clear, `isDaemonRunning()`, `startDaemon()`, `killDuplicateDaemon()` |
| [`src/fingerprint.ts`](src/fingerprint.ts) | `fingerprintFile()` — fast SHA-check used by `processDirtyBatch` to skip unchanged files |

**Storage**

| Module | Role |
|--------|------|
| [`src/db.ts`](src/db.ts) | SQLite connection cache (`getDb()`/`closeDb()`/`closeAllDbs()`); `initConnection()` applies WAL, `SCHEMA_SQL` (files/symbols/refs/chunks), `FTS_SQL` (symbols_fts FTS5 virtual table plus sync triggers), and optional sqlite-vec `chunk_vectors` table |
| [`src/index_reader.ts`](src/index_reader.ts) | Query layer over the index DB: `querySymbols()`, `queryRefs()`, `getFileEntry()`, `searchSymbolsFts()` |
| [`src/section_reader.ts`](src/section_reader.ts) | Section/heading extraction (`readSection()`, `listAllSections()`) for `token-goat section` |
| [`src/constants.ts`](src/constants.ts) | `dataDir()` (platform-keyed data root), `globalDbPath()`, `configPath()`, `ENV_KEYS` |
| [`src/stats.ts`](src/stats.ts) | Stats aggregation from the `stats` table in `global.db`; `summarize()`, `renderStats()` |

**Embeddings and semantic search**

| Module | Role |
|--------|------|
| [`src/embeddings.ts`](src/embeddings.ts) | `@xenova/transformers` with model `Xenova/bge-small-en-v1.5` (384 dimensions); `chunkFile()` splits source into overlapping windows; `upsertChunks()` writes to `chunks` and `chunk_vectors`; `searchSemantic()` queries `chunk_vectors` via vec0 KNN |

**Paths and project detection**

| Module | Role |
|--------|------|
| [`src/paths.ts`](src/paths.ts) | `normalizePath()` (backslash to forward-slash, WSL `/mnt/` expansion, drive-letter lowercase); `resolveIndexPath()` (canonical WRITE==READ DB key); `safeJoin()` (colon-rejection to block Windows drive-letter escapes) |
| [`src/project.ts`](src/project.ts) | `findProject()` walks up for project markers; `makeProjectAt()` for marker-free dirs; `projectHash()` (SHA1 of canonical path) |
| [`src/repomap.ts`](src/repomap.ts) | `getTrackedFiles()` via `git ls-files`; `buildMap()` / `buildCompactMap()` / `formatMap()` for `token-goat map` |

**Hook subsystem**

| Module | Role |
|--------|------|
| [`src/hook_registry.ts`](src/hook_registry.ts) | `registerHook(eventName, handler, filter?)` — stores handlers in a `Map<HookEventName, Registration[]>`; `runHook()` dispatches by event name and optional tool-name filter |
| [`src/hooks_cli.ts`](src/hooks_cli.ts) | Entry point for `token-goat hook <event>`: `safeRun()` reads the JSON payload from stdin, calls `normalizePayload()` (harness-aware: maps Codex/Gemini tool names to canonical names), dispatches via `runHook()`, then `denormalizeResponse()` serializes the result back to the harness wire format |
| [`src/hooks_common.ts`](src/hooks_common.ts) | Shared hook helpers: `getToolName()`, `getToolInput()`, `getFilePath()`, `passOutput()`, `denyOutput()`, `contextOutput()` |
| [`src/hooks_read.ts`](src/hooks_read.ts) | `preReadHandler()` — session hint, diff-on-reread, image intercept, large-file gate, surgical-hint injection; `postReadHandler()` — snapshot update and session recording |
| [`src/hooks_edit.ts`](src/hooks_edit.ts) | `postEditHandler()` — calls `recordFileEdit()` and `appendDirtyPath()` to queue the file for re-indexing; fires on `Write` and `Edit` tool events |
| [`src/hooks_bash.ts`](src/hooks_bash.ts) | `preBashHandler()` — cat/wsl-cat/rg detection, bash output dedup, compression filters; `postBashHandler()` — caches bash stdout/stderr |
| [`src/hooks_fetch.ts`](src/hooks_fetch.ts) | `preFetchHandler()` / `postFetchHandler()` — image shrink for WebFetch responses, web-output cache |
| [`src/hooks_compact.ts`](src/hooks_compact.ts) | `preCompactHandler()` — builds a structured session manifest from `getSessionFiles()` and `getSessionWebFetches()` and returns it as `systemMessage` |
| [`src/hooks_index.ts`](src/hooks_index.ts) | `appendDirtyPath()` — atomic append to `queue/dirty.txt`; `preCompactIndexHandler()` — drains any remaining dirty queue before compaction |
| [`src/hooks_session.ts`](src/hooks_session.ts) | `sessionStartHandler()`, `userPromptSubmitHandler()` (branch and status context), `subagentStopHandler()` |
| [`src/hooks_skill.ts`](src/hooks_skill.ts) | `preSkillHandler()` / `postSkillHandler()` — capture and recall skill bodies across compaction |
| [`src/image_shrink.ts`](src/image_shrink.ts) | `preReadImageHandler()` — intercepts large image Read events, shrinks via system tools, injects the smaller bytes |
| [`src/install.ts`](src/install.ts) | `installHooks()` / `uninstallHooks()` — idempotently writes/removes `token-goat hook <event>` entries in `.claude/settings.json`; `HOOK_EVENT_MAP` registers `PreToolUse`, `PostToolUse`, `PreCompact` |

**Session and compaction**

| Module | Role |
|--------|------|
| [`src/session.ts`](src/session.ts) | In-memory per-session state for the current hook process: `recordFileRead()`, `recordFileEdit()`, `recordWebFetch()`, `recordBashOutput()`, `getSessionId()`; `exportSessionState()` / `importSessionState()` serialize it for cross-process persistence |
| [`src/session_store.ts`](src/session_store.ts) | Persists session state across the per-tool-call hook processes: `loadSessionState()` / `saveSessionState()` (one JSON per session under `sessions/`), wired into [`src/relay.ts`](src/relay.ts). Fail-soft + merge-on-save |
| [`src/disk_cache.ts`](src/disk_cache.ts) | Shared content-addressed blob store backing the bash/web caches: `tokenGoatHome()`, `storeBlob()` / `loadBlob()` / `pruneBlobs()` |
| [`src/snapshots.ts`](src/snapshots.ts) | Per-session content snapshots used by diff-aware re-read in `hooks_read.ts` |
| [`src/compact.ts`](src/compact.ts) | `buildManifest()` / `buildManifestAdaptive()` — load the session JSON cache and produce a structured PreCompact manifest; `computeAdaptiveBudget()` scales the token budget by session age and edit density |
| [`src/skill_cache.ts`](src/skill_cache.ts) | Skill body/compact cache on disk (`skills/`); `skill-body`, `skill-compact`, `skill-list`, `skill-size` commands draw from here |

**Harness bridges**

| Module | Role |
|--------|------|
| [`src/bridges/types.ts`](src/bridges/types.ts) | `HarnessName` (`claudecode` \| `codex` \| `opencode` \| `generic`), `BridgeConfig` |
| [`src/bridges/registry.ts`](src/bridges/registry.ts) | `detectHarness()` / `getHarnessName()` — env-variable-based harness detection |
| [`src/bridges/claudecode.ts`](src/bridges/claudecode.ts) | Claude Code hook script template and install config |
| [`src/bridges/codex.ts`](src/bridges/codex.ts) | Codex hook script template; `hookSpecificOutput: true` (Codex schemas use `additionalProperties: false`) |

**Language adapters (`src/languages/`)**

The adapters below are regex-based (no tree-sitter dependency). Tree-sitter inline extractors for TypeScript/JavaScript, Python, Go, Rust, Ruby, Java, and C/C++ live in `src/parser.ts`; inline regex extractors for Markdown, JSON, YAML, TOML, CSS, and Dockerfile also live there.

| Module | Role |
|--------|------|
| [`src/languages/common.ts`](src/languages/common.ts) | Shared helpers: `buildLineIndex()`, `offsetToLine()`, `makeSymbolEmitter()`, `assignFlatEndLines()`, comment-strip utilities |
| [`src/languages/csharp.ts`](src/languages/csharp.ts) | C# extractor (`extractCsharp`) — namespace, class, method, property, constructor, delegate |
| [`src/languages/php.ts`](src/languages/php.ts) | PHP extractor (`extractPhp`) |
| [`src/languages/html.ts`](src/languages/html.ts) | HTML extractor (`extractHtml`) |
| [`src/languages/liquid.ts`](src/languages/liquid.ts) | Liquid template extractor (`extractLiquid`) |
| [`src/languages/kotlin.ts`](src/languages/kotlin.ts) | Kotlin extractor (`extractKotlin`) — class, fun, const |
| [`src/languages/graphql_idx.ts`](src/languages/graphql_idx.ts) | GraphQL extractor (`extractGraphql`) |
| [`src/languages/sql_idx.ts`](src/languages/sql_idx.ts) | SQL extractor (`extractSql`) |
| [`src/languages/ini_idx.ts`](src/languages/ini_idx.ts) | INI/properties extractor (`extractIni`) |
| [`src/languages/makefile_idx.ts`](src/languages/makefile_idx.ts) | Makefile extractor (`extractMakefile`) |
| [`src/languages/proto_idx.ts`](src/languages/proto_idx.ts) | Protobuf extractor (`extractProto`) |
| [`src/languages/env_idx.ts`](src/languages/env_idx.ts) | `.env` extractor (`extractEnv`) |

**Output rendering**

| Module | Role |
|--------|------|
| [`src/render/`](src/render/) | ANSI text, stats panels, JSON renderers (`ansi.ts`, `common.ts`, `stats_renderer.ts`, `types.ts`) |

**Configuration and utilities**

| Module | Role |
|--------|------|
| [`src/config.ts`](src/config.ts) | TOML config loader; `loadConfig()` returns a typed `Config` object; env-var overrides applied on top |
| [`src/util.ts`](src/util.ts) | `runGit()` (canonical git subprocess), `sanitizeSurrogates()`, `estimateTokens()`, `get_logger()` |
| [`src/env.ts`](src/env.ts) | Platform and env detection helpers |
| [`src/version.ts`](src/version.ts) | `VERSION` string constant |
| [`src/reset.ts`](src/reset.ts) | `registerReset()` / `runResets()` — teardown registry for tests |

**Caches and output stores**

| Module | Role |
|--------|------|
| [`src/bash_output_cache.ts`](src/bash_output_cache.ts) | Bash stdout/stderr disk store (byte cap plus 4096 file-count cap, oldest-first eviction) |
| [`src/web_cache.ts`](src/web_cache.ts) | WebFetch body disk store (byte-capped, LRU-evicted) |
| [`src/mcp_cache.ts`](src/mcp_cache.ts) | MCP tool output cache |
| [`src/gdrive.ts`](src/gdrive.ts) | Google Drive fetch and image cache integration |
| [`src/webfetch.ts`](src/webfetch.ts) | URL download and content cache persistence |
| [`src/git_history.ts`](src/git_history.ts) | Recent git history hints surfaced into session and compact manifest |
| [`src/project_memory.ts`](src/project_memory.ts) | Project-scoped key-value memory (TOML, per-project hash) |

**Other CLI commands and filters**

| Module | Role |
|--------|------|
| [`src/ask.ts`](src/ask.ts) | `token-goat ask` command |
| [`src/bash_compress.ts`](src/bash_compress.ts) | Bash output compression filters (vitest, npm, docker, ruff, and others) |
| [`src/code_compress.ts`](src/code_compress.ts) | Code-block compression for large tool outputs |
| [`src/cli_doctor.ts`](src/cli_doctor.ts) | `token-goat doctor` — install state and cache health |
| [`src/filters.ts`](src/filters.ts) | Shared output-filter helpers |
| [`src/hints.ts`](src/hints.ts) | Session-hint text builder |
| [`src/hints/`](src/hints/) | Hint submodules: `file_type_handler.ts`, `lang_patterns.ts`, `markdown_hints.ts` |
| [`src/pack.ts`](src/pack.ts) | `token-goat pack` — pack source files for context |
| [`src/resume.ts`](src/resume.ts) | Post-compact recovery resume logic |

## Storage Layout

**Windows:** `%LOCALAPPDATA%\dfk-helper\token-goat\`
**macOS:** `~/Library/Application Support/token-goat/`
**Linux / WSL:** `$XDG_DATA_HOME/token-goat/` (or `~/.local/share/token-goat/` when XDG is unset)

Logic lives in [`src/constants.ts::defaultDataDir`](src/constants.ts).

### SQLite: global.db

All index data and stats live in a single `global.db`. [`src/db.ts`](src/db.ts) opens, initializes, and caches connections. [`src/stats.ts`](src/stats.ts) applies its own schema extension on first open.

| Table | Schema source | Purpose |
|-------|--------------|---------|
| `files` | [`src/db.ts` SCHEMA_SQL](src/db.ts) | One row per indexed source file (`path`, `sha`, `mtime`, `language`, `indexed_at`) |
| `symbols` | [`src/db.ts` SCHEMA_SQL](src/db.ts) | Extracted definitions (`id`, `file_path`, `name`, `kind`, `line_start`, `line_end`, `body`, `docstring`) |
| `refs` | [`src/db.ts` SCHEMA_SQL](src/db.ts) | Call-site references (`id`, `file_path`, `name`, `line`, `col`, `context`) |
| `chunks` | [`src/db.ts` SCHEMA_SQL](src/db.ts) | Semantic search chunk metadata (`id`, `file_path`, `start_line`, `end_line`, `text`, `kind`) |
| `symbols_fts` | [`src/db.ts` FTS_SQL](src/db.ts) | FTS5 external-content virtual table mirroring `symbols` (`name`, `body`, `docstring`); INSERT/DELETE/UPDATE triggers keep it in sync |
| `chunk_vectors` | [`src/db.ts` initConnection](src/db.ts) | `vec0` virtual table (`embedding float[384]`); rowid matches `chunks.id`; created only when sqlite-vec is available |
| `stats` | [`src/stats.ts` GLOBAL_SCHEMA_SQL](src/stats.ts) | Cumulative token/byte savings (`id`, `ts`, `kind`, `tokens_saved`, `bytes_saved`, `detail`) |

### File-system layout

| Path | Contents |
|------|----------|
| `global.db` | Single index and stats SQLite database (tables above) |
| `sessions/{session_id}.json` | Per-session state persisted across hook processes by [`src/session_store.ts`](src/session_store.ts) (loaded/saved in [`src/relay.ts`](src/relay.ts)): file reads, edits, web-fetch index, bash-output index, curl downloads, shown hints |
| `projects/{hash}/sessions/` | Session manifest JSON files written by [`src/compact.ts`](src/compact.ts) for the PreCompact hook |
| `projects/{hash}_memory.toml` | Project-scoped key-value memory written by [`src/project_memory.ts`](src/project_memory.ts) |
| `queue/dirty.txt` | Append-only list of edited file paths; drained by `worker.ts` every 2 s |
| `queue/pending.txt` | Dirty-queue snapshot written by [`src/hooks_index.ts::preCompactIndexHandler`](src/hooks_index.ts) before compact |
| `images/` | Shrunk image cache (LRU-evicted, written by [`src/image_shrink.ts`](src/image_shrink.ts)) |
| `skills/` | Skill body/compact cache keyed by `(session, name, content_sha)` ([`src/skill_cache.ts`](src/skill_cache.ts)) |
| `bash_outputs/{id}.json` | Content-addressed bash stdout cache for cross-process `bash-output <id>` recall ([`src/bash_output_cache.ts`](src/bash_output_cache.ts) via [`src/disk_cache.ts`](src/disk_cache.ts)); pruned by age (24h) and count (200) |
| `web_outputs/{id}.json` | Content-addressed web body cache for cross-process `web-output <id>` recall ([`src/web_cache.ts`](src/web_cache.ts) via [`src/disk_cache.ts`](src/disk_cache.ts)); same prune policy |

Project hash = `crypto.createHash('sha1').update(canonicalRoot)` from [`src/project.ts::projectHash`](src/project.ts).

## Data Flow

### (a) Initial indexing

`token-goat index [path]` calls `getTrackedFiles()` (via `git ls-files`) to enumerate files, then calls `indexFileSync(absPath, dbPath)` for each. `indexFileSync` in [`src/parser.ts`](src/parser.ts) calls `detectLanguage()` then `parseContent()` (tree-sitter or regex extractor) then `writeParseResult()`, which runs a single transaction: DELETE existing rows for the file, then INSERT new `files`, `symbols`, and `refs` rows. Embeddings are written separately by `embeddings.ts::upsertChunks()`.

### (b) Incremental updates (background worker)

1. Every `Write` or `Edit` tool event fires `postEditHandler()` in [`src/hooks_edit.ts`](src/hooks_edit.ts), which appends the normalized absolute path to `queue/dirty.txt` via `appendDirtyPath()` in [`src/hooks_index.ts`](src/hooks_index.ts).
2. The background worker (`worker.ts::runWorkerLoop`) polls `queue/dirty.txt` every **2 seconds** (`DEFAULT_POLL_INTERVAL_MS = 2000`).
3. `drainOnce()` reads the queue and calls `processDirtyBatch()`, which SHA-fingerprints each file (`fingerprintFile()`), skips unchanged files, and calls `makeIndexer(globalDbPath())(absPath, sha)` which resolves to `indexFileSync()`.
4. The worker runs either as a Node.js `Worker` thread (in-process, started by `startWorker()`) or as a detached child process with the `--worker-daemon` flag (`worker_daemon.ts::startDaemon()`).

### (c) Hook intercept

Installed hook events (`PreToolUse`, `PostToolUse`, `PreCompact`) call `token-goat hook <event>` as a subprocess. `hooks_cli.ts::safeRun()` reads the JSON payload from stdin, calls `normalizePayload()` (translates Codex/Gemini tool name aliases to canonical names), dispatches via `hook_registry.ts::runHook()`, and serializes the result back to the harness wire format via `denormalizeResponse()`.

Registered handlers by event:

- **PreToolUse / Read** — `preReadHandler` (session hint, diff-on-reread, large-file gate, surgical hint), `preReadImageHandler` (image shrink)
- **PreToolUse / Bash** — `preBashHandler` (cat detection, bash output dedup, compression)
- **PreToolUse / WebFetch** — `preFetchHandler` (image shrink for web content)
- **PreToolUse / Skill** — `preSkillHandler` (skill cache dedup)
- **PostToolUse / Read** — `postReadHandler` (snapshot, session record)
- **PostToolUse / Edit, Write** — `postEditHandler` (dirty queue append)
- **PostToolUse / Bash** — `postBashHandler` (cache stdout/stderr)
- **PostToolUse / WebFetch** — `postFetchHandler` (web-output cache)
- **PostToolUse / Skill** — `postSkillHandler` (capture skill body to disk)
- **PreCompact** — `preCompactHandler` (build session manifest), `preCompactIndexHandler` (flush dirty queue)

### (d) CLI surgical reads

Commands such as `symbol`, `read`, `section`, `skeleton`, `outline`, `refs`, and `semantic` query `global.db` via `index_reader.ts` (`querySymbols()`, `queryRefs()`, `searchSymbolsFts()`) or `section_reader.ts` (`readSection()`). Every path argument passes through `resolveIndexPath()` before the DB query so the lookup key matches the write key byte-for-byte.

## Key Design Decisions

**Absolute-normalized index key (`resolveIndexPath`)** — Every symbol and file row is keyed by `normalizePath(path.resolve(base, file))` at write time. Every reader (`skeleton`, `outline`, `read`, `refs`, `imports`, `changed`) routes the user-supplied path through the same `resolveIndexPath()` helper in [`src/paths.ts`](src/paths.ts) before querying. Without this, a relative path (`src/worker.ts`), a backslash path (`src\worker.ts`), or a WSL mount path all produce a key that never matches an absolute forward-slashed lowercase-drive key and the query silently returns nothing. Routing every query site through this one helper guarantees the lookup key matches the write key byte-for-byte across platforms.

**Real-default-path wiring in the worker** — `processDirtyBatch` in [`src/worker.ts`](src/worker.ts) defaults the indexer to `makeIndexer(globalDbPath())`, which calls the real `indexFileSync` from `parser.ts`. A previous release shipped with the worker calling a stub callback, which meant nothing was ever written to the `symbols` table and the parser was tree-shaken out of the built bundle — yet the test suite was green because every worker test injected its own callback. See [AGENTS.md](AGENTS.md) for the full injected-seam trap analysis. Any change touching the worker or indexer must include an end-to-end test on the real default path (drain → index → `symbols` populated → a known symbol resolves) plus a smoke test against the built bundle.

**FTS5 query must name the virtual table directly** — `searchSymbolsFts()` in [`src/index_reader.ts`](src/index_reader.ts) references `symbols_fts` directly in the `FROM` clause and in `MATCH`/`bm25()`. An alias (e.g. `FROM symbols_fts f … WHERE f MATCH ?`) resolves as a bare column reference, raises `no such column: f`, and the catch block silently returns empty results — which is indistinguishable from a search miss. The correct form is `… FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ? ORDER BY bm25(symbols_fts) LIMIT ?`.

**Refs via enclosing-scope resolution** — `extractRefs()` in [`src/parser.ts`](src/parser.ts) tracks the enclosing function/method/class during the tree walk and stores it in `refs.context`, enabling `refs --callers` to group usages by the containing symbol.

**Two-tier testing model** — A fast pre-commit guard tier (`npm run test:guards`, ~2 s, no bundle, no DB, no git fixtures) lives in `tests/guards/`. The pre-push/CI tier runs the full suite plus the built-bundle command matrix (`tests/command_matrix_e2e.test.ts`), which indexes a real fixture against `dist/token-goat.mjs` and runs every registered command. Both tiers derive their command set from [`tests/registry.ts::allCommandNames()`](tests/registry.ts), so a newly registered command is automatically in scope for both — there is no second list to maintain. A registered command with no matrix case fails the coverage gate by design. See [AGENTS.md](AGENTS.md) for the full two-tier description.

**Fail-soft hook handlers** — Every handler wrapped by `hooks_cli.ts::failSoft()` catches any exception, logs to stderr, and returns `{ continue: true }`. A broken token-goat must never interrupt the agent's work.

**Session persistence (cross-process)** — The installer wires each hook as `{ type: "command", command: "token-goat hook <event>" }`, so **every tool call spawns a fresh token-goat process** — there is no long-lived server. The session state in [`src/session.ts`](src/session.ts) (file-read/edit tracking, shown-hint dedup, and the web/bash/curl recall indexes) and the bash/web *content* caches are therefore meaningless if kept only in memory: the maps die when the hook process exits. Three on-disk layers under `tokenGoatHome()` (`TOKEN_GOAT_HOME`, else `~/.token-goat`, mirroring [`src/snapshots.ts`](src/snapshots.ts)) restore the behavior the Python original's `SessionCache` JSON provided:

- **Session state** — [`src/relay.ts`](src/relay.ts) calls `loadSessionState(sessionId)` immediately after building the event and `saveSessionState(sessionId)` after the handler returns, each in its own `try/catch` so a persistence failure can never suppress the handler's real output. Save is **merge-on-save**: it re-reads the on-disk JSON and unions it with the in-memory state (set-union for hints, field-wise for files keeping every read/edit/truncation signal, newest-wins for the indexes), then atomic-writes. Combined with the atomic rename, two overlapping same-session hook processes (e.g. background-task hooks) can at worst drop a hint — never corrupt the file. File entries are capped at 500 (oldest by last-read evicted). An empty `sessionId` skips persistence entirely (no shared `anon` file bleeding across sessions).
- **Bash/web content** — `storeBashOutput()` / `storeWebOutput()` also write a content-addressed blob (`bash_outputs/<id>.json`, `web_outputs/<id>.json`) via [`src/disk_cache.ts`](src/disk_cache.ts); `getBashOutput()` / `getWebOutput()` fall back to a disk read on an in-memory miss, so the session-less CLI (`token-goat bash-output <id>`, `web-output <id>`) and a later hook process resolve a value cached by an earlier one. Blobs are pruned by age (24h) and count (200) on each write.
- **Honest recall hints** — the three bash recall sites in [`src/hooks_bash.ts`](src/hooks_bash.ts) (monitoring, curl GET, build) guard on the *content entry* existing, not just the session index, so a pruned/evicted blob never yields a `bash-output <id>` hint that would error.

All three layers are fail-soft: a disk error never throws into a hook.

**Compaction assist** — Before Claude Code compacts, `preCompactHandler()` in [`src/hooks_compact.ts`](src/hooks_compact.ts) calls `compact.ts::buildManifest()` / `buildManifestAdaptive()` to build a structured, token-budgeted summary (edited files, files read, web fetches, skills) and returns it as `systemMessage`. The budget scales with session age and edit density via `computeAdaptiveBudget()`. Configurable via `config.toml` (`[compact_assist]`) or `TOKEN_GOAT_COMPACT_ASSIST=0`.

**Skill preservation** — `postSkillHandler()` in [`src/hooks_skill.ts`](src/hooks_skill.ts) captures every loaded skill body to `skills/` keyed by `(session, name, content_sha)`, enabling `token-goat skill-body <name>` recall after compaction without re-invoking the skill.

**Codex/Gemini compatibility** — `hooks_cli.ts::normalizePayload()` maps Codex tool-name aliases (`shell` to `Bash`) and Gemini aliases (`read_file` to `Read`, `write_file` to `Write`, and others) to canonical names before dispatching, using `CODEX_TOOL_NAME_MAP` and `GEMINI_TOOL_NAME_MAP`. The same `registerHook('pre_tool_use', handler, { toolName: 'Bash' })` registrations fire identically across harnesses.

**Bash output compression framework** — Build/test/tooling commands emit far more output than the agent needs (progress bars, ANSI, repeated lines, passing-test noise). The framework in [`src/tool_filters/`](src/tool_filters/) compresses that output structurally, per tool, before it reaches the model. The pre-bash hook recognizes a command, rewrites it to run through `token-goat compress -f <name> -c '<orig>'`, and the wrapped subprocess captures stdout/stderr, applies the matching filter, and re-emits a compressed view with a one-line savings marker. Layers:

- **`helpers.ts`** — the shared, dependency-free helper layer every filter builds on: normalisation (`normalise` = CRLF→LF + ANSI strip + progress-line collapse), `safeDecode`/`sanitizeControlChars`, run-collapsing (`dedupeConsecutive`, `dedupeNumericRuns` with a high-entropy bypass so UUID/hash/JWT lines are never merged), error-preserving truncation (`truncateMiddleSmart`), byte/token caps (`capBytes`, `capTokens`), and command parsing (`shlexSplit`, `stripPrefixes` resolving `sudo`/`env`/`python -m`/`uv run`/`npx`-style launchers). Family factories and bespoke filters compose these rather than re-implementing them — the DRY foundation that keeps the ported filters small.
- **`base.ts`** — `CompressedOutput` (the result type: text + byte accounting + `withMarker()`) and the abstract `ToolFilter` with the universal 10-step `apply()` pipeline (sanitise → per-stream input cap → normalise → early-exit when normalisation alone suffices → structural `compress()` → line cap → byte cap → notes prepend). Subclasses declare `binaries`/`subcommands` and override `compressBody`; `errorPassthrough` short-circuits to raw combined output on a non-zero exit with stderr; a `postNormalise` hook lets the git family strip CRLF warnings without per-family checks in `apply`.
- **`generic.ts`** — `GenericFilter`, the catch-all the hook selects when it wraps a command no per-tool filter matches: ANSI/progress strip + consecutive-line dedupe, capped at ~2000 tokens.
- **`families.ts`** — filter *family factories*: shared compression skeletons that several per-tool filters configure instead of reimplementing. `makeNodeTestRunnerFilter(cfg)` powers the Node test-runner batch. `makePackageManagerFilter(cfg)` is the package-manager factory — a single line-walk loop (keep if ERROR_SIGNAL_RE, keep if `keepRe` matches, drop by ordered `DropRule` array, emit per-rule collapsed notes) used by BundlerFilter and PubFilter; filters with richer structural logic (npm/pip/uv/conda/gem/composer/nuget/conan/vcpkg) subclass `ToolFilter` directly. Both factories are concurrency-safe (all state is per-call with no shared mutable fields).
- **`test_runners.ts`** (batch A) — `jestFilter` (also covers mocha/ava/tap) and `vitestFilter`, both built from `makeNodeTestRunnerFilter`, exported as `TEST_RUNNER_FILTERS` and spread into `TOOL_FILTERS` at the head. Faithful ports of the Python `JestFilter`/`VitestFilter`; golden tests in [`tests/tool_filters_test_runners.test.ts`](tests/tool_filters_test_runners.test.ts) assert the ported behaviour, and [`tests/bash_compress_rewrite.test.ts`](tests/bash_compress_rewrite.test.ts) has a built-bundle e2e proving `npx vitest run` rewrites to `compress -f vitest` (the registration survives esbuild and `detectFromCommand` prefers the specific filter over `generic`).
- **`pytest.ts`** (batch A) — `PytestFilter`, bespoke (too structured for the Node family): strips pytest-xdist `[gwN]` prefixes, collapses pytest-cov tables to `TOTAL`, trims `slowest N durations` to five, dedupes the warnings summary, drops banner/preamble/`test session starts` lines, and collapses `PASSED` (default + verbose) to a count while keeping `FAILURES`/`ERRORS` + the final tally verbatim. Matches `pytest`/`py.test` (and `python -m pytest` / `uv run pytest` via `stripPrefixes`).
- **`go_test.ts`** (batch A) — `GoTestFilter`, bespoke: collapses `--- PASS:`/`=== RUN` to counts, drops `go: downloading`, counts `--- SKIP:` separately, passes `go test -json` through untouched, and keeps `WARNING: DATA RACE` blocks verbatim with goroutine stacks collapsed to five frames. Overrides `matches` to fire only when `test` is the first positional (so `go build`/`go run` fall through), and is registered ahead of any future `go` build filter.
- **`package_managers.ts`** (batch B) — 15 filters for the full package-manager landscape, faithful port of the Python `bash_compress.py` filter family: `NpmInstallFilter` (npm/yarn/pnpm install paths with per-manager sub-pipelines), `PnpmFilter` (richer install collapse + `pnpm run <script>:` label + exec/dlx passthrough), `YarnFilter` (classic v1 fetch-phase collapse + warning dedup; berry v2+ per-package progress collapse), `PipFilter` (download/cache-hit/build-wheel/metadata drop, Collecting cap at 5, progress-bar `━` drop), `UvFilter` (Download/Fetch drop, `+/-` diff drop, freeze/list truncation at 50 → show first 20), `CondaFilter` (install: download-section collapse + package-install lines collapse; list: truncate at 50; env export: dep truncation at 50), `GemFilter` (Fetching/doc-noise drop, `Successfully installed` collapse to head-2+count+tail-1 when >4), `BundlerFilter` (factory: Using-gem and Fetching/Installing-gem collapse), `ComposerFilter` (install/download collapse, `%`-progress drop, funding-notice drop, warning dedup), `NuGetFilter` (Installing/OK-https/already-installed/Successfully-installed collapse, 1-project vs N-project Restoring aggregate), `PubFilter` (factory: pkg-line and downloading collapse with PUB_KEEP_RE passthrough), `ConanFilter` (errorPassthrough + per-package lifecycle + download collapse via `compressBody`), `VcpkgFilter` (errorPassthrough + Building/Installing/sub-step/timing collapse via `compressBody`), `NodePackageFilter` (general npm/pnpm/yarn audit + spinner/progress + deprecated map), `DepListFilter` (errorPassthrough; matches pip/pip3/uv/poetry directly + npm/pnpm/yarn/cargo via custom PKG_MGR_STEMS check on list/freeze/tree/show/ls subcommands; truncates at 30 lines with a `'<cmd>' to see full output` hint). Golden tests in [`tests/tool_filters_package_managers.test.ts`](tests/tool_filters_package_managers.test.ts); e2e smoke in [`tests/bash_compress_rewrite.test.ts`](tests/bash_compress_rewrite.test.ts).
- **`dispatch.ts`** — `TOOL_FILTERS` registry (ordered; specific filters precede the package-manager handlers they overlap; batch A test-runners at the head, batch B package managers after), `selectFilter`/`detectFromCommand` (reject compounds, pipes, `;`, command-substitution, and redirects — the wrapper only intercepts a single command), `tryWrapCompoundSegments` (wrap each `&&` segment independently), `compressOutput` with profiles (`aggressive` 50 / `balanced` 200 / `minimal` 500 lines; `minimal` skips progress collapse), and `filterByName`.
- **`linters.ts`** (batch C) — 16 filters for the linter/type-checker/formatter landscape, faithful port of the Python `bash_compress.py` linter family. Dispatch order mirrors Python `FILTERS` registration:  (custom `matches()` covering bare/npx/yarn/pnpm tsc, three compression modes: typecheck dedup by TS error code, watch-cycle collapse, build up-to-date collapse), `RuffFilter` (check: per-code cross-file summary for codes with ≥3 occurrences in ≥2 files; format: reformatted/would-reformat sample), `MypyFilter` (error/note dedup by normalised message with quote/trailing-code stripping, standalone  drop, See-https drop), `PylintFilter` (module-header defer, E/F always-keep, C/W/R dedup by code at 3), `OxlintFilter` (per-file per-rule dedup with location-block suppression for elided issues), `ESLintFilter` (stanza-based: always keep errors; dedup warnings by rule within each file stanza), `BiomeFilter` (custom `matches()`; ≤40-line pass-through; rule-stanza collapse to first 3 with ≤2 source lines), generic `LinterFilter` (pyright/pylint via `dedupeByKey`; stylelint/rome via ESLint-stanza), `GolangciLintFilter` (per-file/linter dedup with placeholder-replacement for accurate extra counts; structured-log noise drop), `PhpStanFilter` (dispatches by stem: phpstan per-file row dedup; psalm progress drop + error-type dedup), `swiftlintFilter` (produced by `makeLinterFilter` factory; always-keep error/serious; warning dedup by rule with summary-last), `BlackIsortFilter` (black: reformatted/would-reformat sample at 5; isort: Fixing sample at 5), `PrettierFilter` (custom `matches()`; changed-file sample at 5; unchanged drop counted), `KtlintFilter` (plain-text error/warning dedup; checkstyle XML: rule dedup via `<error source=`), `CppcheckFilter` (Checking/progress/config drop with count notes), `ClangTidyFilter` (warnings-generated aggregate; include-chain drop; context-block keep-first). PylintFilter is registered BEFORE generic LinterFilter in `LINTER_FILTERS` so  always dispatches to the specific filter. Golden tests in [`tests/tool_filters_linters.test.ts`](tests/tool_filters_linters.test.ts); e2e smoke (eslint) in [`tests/bash_compress_rewrite.test.ts`](tests/bash_compress_rewrite.test.ts).
- **`bash_runner.ts`** — the subprocess wrapper behind the `token-goat compress` CLI command (`run`/`runRaw`). It shell-runs the original command, captures stdout/stderr (32 MiB/stream cap), maps the exit code (124 on wrapper timeout, `128 + signum` on signal kill, otherwise the child's own status), applies the resolved filter via `compressOutput`, prints the compressed view, records the savings stat, and re-exits with the *wrapped* command's code so `cmd && next` chaining is preserved. `--no-compress` streams raw for debugging; `--max-tokens` caps the body before the marker so the marker survives. The hook (`pre_bash`) is the only producer of wrapped commands; the command is also runnable by hand to preview compression.
- **Hook wiring (`hooks_bash.ts`)** — `preBashHandler` makes the rewrite decision: for a recognized single command with no cached prior run it returns a `rewriteInput` HookOutput, which [`hook_registry.ts::serializeOutput`](src/hook_registry.ts) emits as the `PreToolUse` wire shape `{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput}}`. `updatedInput` replaces the *entire* `tool_input`, so the hook spreads `{...event.toolInput, command: wrapped}` to keep `description`/`timeout`. Filter selection runs on the cd-*stripped* command (`detectFromCommand`, falling back to the `generic` filter for build/test commands no specific filter matches yet — per-tool filters land in batches, batch A (test-runners) and batch B (package-managers) registered), but the wrapper quotes the *full* original command including any `cd … &&` prefix so it still runs in the right cwd. A cached prior run wins over a fresh rewrite (recall is cheaper than re-running and re-compressing). Because the rewrite changes the command the post-hook then sees, `postBashHandler` unwraps `token-goat compress … -c <orig>` back to `<orig>` before keying its output cache — so recall stays keyed on the original command and round-trips across runs. Compounds, pipes, and redirects are never wrapped (`isCompressibleSingleCommand` mirrors `detectFromCommand`'s single-command rule). Honored opt-outs: `TOKEN_GOAT_BASH_COMPRESS=0` and per-filter `[bash_compress] disabled_filters`.

Disable globally with `TOKEN_GOAT_BASH_COMPRESS=0`. The framework is independent of the `src/filters.ts` line-level `Filter`/`FILTERS` (a separate, simpler post-read line filter) — this one is keyed `ToolFilter`/`TOOL_FILTERS` to avoid the name collision.

## Adding a New Language

Two adapter styles exist:

**Tree-sitter adapters (inline in `src/parser.ts`)** — for TypeScript/JavaScript, Python, Go, Rust, Ruby, Java, and C/C++. These require a `tree-sitter-<lang>` npm package.

**Regex adapters** — no tree-sitter dependency. Two locations:
- Inline in `src/parser.ts` (Markdown, JSON, YAML, TOML, CSS, Dockerfile)
- Separate files in `src/languages/` (C#, PHP, HTML, Liquid, Kotlin, GraphQL, SQL, INI, Makefile, Proto, `.env`)

Prefer a separate file in `src/languages/` for any new language. Use `src/languages/kotlin.ts` as a template for class/function extraction, or `src/languages/ini_idx.ts` for flat key-value formats.

Steps:

1. **Add the language name** to the `Language` union in [`src/parser_types.ts`](src/parser_types.ts).
2. **Map file extensions** — add entries to `EXTENSION_LANGUAGE` in `parser_types.ts`, or `FILENAME_LANGUAGE` for files identified by basename (e.g. `Makefile`, `.env`).
3. **Write the adapter** — create `src/languages/{lang}.ts`. Implement a function `extractXxx(content: string, filePath: string): { symbols: SymbolEntry[]; ... }`. Use `makeSymbolEmitter` from `src/languages/common.ts` to deduplicate symbols. Export the function from [`src/languages/index.ts`](src/languages/index.ts).
4. **Wire into the dispatcher** — add a branch to `extractSymbolsNoTreeSitter()` in `src/parser.ts`:
   ```ts
   if (language === 'yourlang') return extractYourlang(content, filePath).symbols
   ```
   For a tree-sitter language, add a grammar load branch in `loadGrammar()` and a symbol-extraction branch in `parseContent()`.
5. **Add a matrix case** — add at least one assertion to [`tests/command_matrix_e2e.test.ts`](tests/command_matrix_e2e.test.ts) to prove the new extractor works in the shipped bundle.

## Adding a New Hook Event

1. **Add the event name** to `HOOK_EVENTS` in [`src/types.ts`](src/types.ts). TypeScript will enforce that every switch on `HookEventName` handles the new value.
2. **Implement the handler** in the appropriate `src/hooks_*.ts` module. Return a `HookOutput` value (`passOutput()`, `contextOutput(text)`, `denyOutput(msg)`).
3. **Register the handler** at module level:
   ```ts
   registerHook('your_event', yourHandler)
   ```
   Module-level registration runs when the module is imported on `token-goat hook <event>`.
4. **Wire into install** if the event needs to be added to `settings.json`: add a `['YourEvent', 'your_event']` entry to `HOOK_EVENT_MAP` in [`src/install.ts`](src/install.ts) and re-run `token-goat install`.
5. **Test** — add a unit test for the handler, and a hook integration test if the event fires in a hook subprocess context.

## Adding a New Command

1. **Implement the logic** — if the command reads from the index, add a `runXxx(opts: XxxOptions): number` function to [`src/read_commands.ts`](src/read_commands.ts). Otherwise implement directly in a new or existing module.
2. **Write a `cmd*` handler** in [`src/cli.ts`](src/cli.ts):
   ```ts
   function cmdXxx(opts: XxxOptions): number {
     return runXxx(opts)
   }
   ```
3. **Register in `buildProgram()`** — call `program.command('xxx').description('...').option(...)...action(guard(cmdXxx))`. The guard in [`tests/guards/cli_registration.test.ts`](tests/guards/cli_registration.test.ts) checks that every `cmd*` function appears in an `.action(...)` call and that every command in `allCommandNames()` appears in `--help` output — it will fail immediately if the handler is declared but not wired.
4. **Add a matrix case** — add an entry to [`tests/command_matrix_e2e.test.ts`](tests/command_matrix_e2e.test.ts). The coverage gate at the bottom of that file fails automatically if a registered command has no case, using [`tests/registry.ts::allCommandNames()`](tests/registry.ts) as the single source of truth shared with the guard.
