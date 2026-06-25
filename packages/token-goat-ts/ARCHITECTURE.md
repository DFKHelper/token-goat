# token-goat-ts Architecture

token-goat is a Claude Code companion CLI that reduces token burn during AI-assisted coding sessions. It intercepts tool calls via the harness hook system, injects surgical-read hints, compresses bash output, shrinks images, and maintains a per-project SQLite index so the agent can read one symbol or section instead of a whole file. This document describes the TypeScript port (`packages/token-goat-ts/`), which targets Claude Code, Codex CLI, and compatible harnesses.

The Python distribution is the production release; the TS port matches the observable behavior of the Python package's core features (hooks, CLI surgical reads, session tracking, indexing) under a Node.js runtime.

> **Canonical implementation:** The TypeScript port is now the primary codebase. All Python modules in `src/token_goat/` have been fully ported to this package. Future development targets TypeScript; the Python source is preserved only for the current release and will be removed in the next major version following structural cutover.

---

## Component Map

| File | Role |
|---|---|
| `main.ts` | Package entry point — thin shim that calls `run()` from `cli.ts` |
| `cli.ts` | Commander-based CLI: parses argv, dispatches all subcommands |
| `types.ts` | Pure type leaf: `HookOutput`, `HookEventName`, `HOOK_EVENTS`, `CANONICAL_TOOLS`, `GitResult` |
| `hook_registry.ts` | Runtime hook dispatch: `registerHook`, `runHook`, `serializeOutput` |
| `hooks_common.ts` | Shared accessor helpers for hook handlers: `getFilePath`, `passOutput`, `denyOutput`, `contextOutput` |
| `hooks_read.ts` | `pre_tool_use` handler for `Read`: re-read dedup and large-file hints |
| `hooks_edit.ts` | `post_tool_use` handler for `Write`/`Edit`: session record + dirty queue write |
| `hooks_index.ts` | Dirty queue management (`appendDirtyPath`, `getDirtyPaths`, `clearDirtyQueue`); `pre_compact` queue flush |
| `hooks_compact.ts` | `pre_compact` handler: builds and injects the session manifest |
| `image_shrink.ts` | `pre_tool_use` image handler: lazy `sharp` load, downscale + re-encode |
| `relay.ts` | `token-goat hook <event>` entry point: stdin JSON → `runHook` → stdout JSON |
| `session.ts` | In-memory session state: file read/edit tracking, hint dedup, web/bash output indexes |
| `reset.ts` | Module-reset registry: `registerReset`, `clearModuleCaches` |
| `db.ts` | SQLite connection management, schema (files/symbols/refs/FTS5/sqlite-vec), `getDb`/`closeDb` |
| `parser.ts` | Tree-sitter source indexer: symbol/ref extraction, `indexFile`, `indexFiles` |
| `parser_types.ts` | Shared index types: `SymbolEntry`, `RefEntry`, `FileIndexEntry`, `Language`, `detectLanguage` |
| `index_reader.ts` | Read side of the index: `querySymbols`, `queryRefs`, `searchSymbolsFts`, `getFileEntry` |
| `section_reader.ts` | Text-level section extraction: markdown, TOML, Python def/class, key-value |
| `worker.ts` | Background indexer: worker-thread and detached-process forms of the drain loop |
| `baseline.ts` | Project map (`token-goat map`): stack-based DFS walk, symbol summary, `formatProjectMap` |
| `install.ts` | Hook installer/uninstaller: reads and writes Claude Code `settings.json` atomically |
| `bash_compress.ts` | Bash output compression pipeline: ANSI strip, progress collapse, dedup, truncate |
| `bash_output_cache.ts` | In-memory bash output store: `storeBashOutput`, `getBashOutput`, SHA-keyed |
| `web_cache.ts` | In-memory web fetch store: `storeWebOutput`, `getWebOutputByUrl`, URL-keyed |
| `fingerprint.ts` | SHA-256 helpers: `fingerprintContent`, `fingerprintFile` |
| `filters.ts` | Ordered line-filter chain for bash compression: `FILTERS` array |
| `paths.ts` | Path normalization (`normalizePath`): backslash → slash, WSL `/mnt/c/` → `c:/`, drive-letter lowercase; `safeJoin` |
| `constants.ts` | Data-dir resolution (`dataDir`, `globalDbPath`, `configPath`), `ENV_KEYS` constants |
| `env.ts` | Env-var parsers: `envStr`, `envBool`, `envFloat`, `envInt` with safe fallbacks |
| `util.ts` | Cross-cutting: `runGit` (sole git spawn site), `atomicWriteText`, `atomicWriteBytes`, `sleepSync` |
| `version.ts` | Version constant: build-time `__TG_VERSION__` injection with runtime `package.json` fallback |
| `bridges/types.ts` | Bridge types: `HarnessName`, `BridgeConfig` |
| `bridges/registry.ts` | Harness detection: `detectHarness`, `getHarnessName` (memoized) |
| `bridges/claudecode.ts` | Claude Code bridge: `CLAUDECODE_HOOK_SCRIPT` shim source, `getClaudeCodeHookConfig` |
| `bridges/codex.ts` | Codex bridge: `CODEX_HOOK_SCRIPT` shim source (strips `_tg_*`, injects `hookEventName`) |
| `bridges/index.ts` | Barrel re-export for all bridge symbols |

---

## Hook System

### Registration

`registerHook(eventName, handler, opts?)` pushes a `{ handler, toolName }` registration onto a `Map<HookEventName, Registration[]>`. The map key is the event name; the array preserves insertion order, which determines execution order.

```typescript
// Only fires for pre_tool_use events whose toolName === 'Read'
registerHook('pre_tool_use', preReadHandler, { toolName: 'Read' })

// Fires for all pre_compact events regardless of tool
registerHook('pre_compact', preCompactHandler)
```

When `opts.toolName` is set, the handler is skipped if the event's `toolName` does not match exactly (case-sensitive PascalCase; normalization happens in the bridge layer before the event reaches the registry).

Each module that owns handlers calls `registerHook` at module load time as a side effect. `relay.ts` imports all hook modules with bare side-effect imports (`import './hooks_read.js'` etc.) so the registry is fully populated before `relay` runs.

### Reset

`registerReset(fn)` in `reset.ts` accumulates cleanup callbacks in a module-global array. Every module with mutable state — `hook_registry.ts`, `session.ts`, `db.ts`, `bash_output_cache.ts`, `web_cache.ts`, `bridges/registry.ts` — calls `registerReset` at load time with a function that zeroes its state. Tests call `clearModuleCaches()` in `beforeEach` to restore a clean slate without restarting the process.

### Dispatch

`runHook(event: HookEvent): Promise<HookOutput>` iterates the handler list for `event.eventName`. For each registration it checks the `toolName` filter, calls the handler, and short-circuits on the first non-`pass` result. If no handler claims the event (all pass or no registrations), it returns `{ hookType: 'pass' }`.

### Hook Event Lifecycle

The five supported event names, defined in `HOOK_EVENTS` in `types.ts`:

| Event name | When fired | Registered handlers |
|---|---|---|
| `pre_tool_use` | Before a tool call executes | `preReadHandler` (Read), `preReadImageHandler` (Read) |
| `post_tool_use` | After a tool call completes | `postEditHandler` (Write, Edit) |
| `notification` | Agent notification events | none registered in this port |
| `stop` | Agent stop events | none registered in this port |
| `pre_compact` | Before conversation compaction | `preCompactHandler`, `preCompactIndexHandler` |

`HookEvent` carries:
- `eventName: HookEventName` — the event type
- `toolName: string | undefined` — `undefined` for non-tool events
- `toolInput: Record<string, unknown>` — the tool's raw input object
- `sessionId: string` — from the harness payload
- `raw: Record<string, unknown>` — the full unmodified payload

### HookOutput Union

`HookOutput` in `types.ts` is a discriminated union on `hookType`:

```typescript
type HookOutput =
  | { hookType: 'deny';    message: string }   // block the call, surface message
  | { hookType: 'context'; context: string }   // let call proceed, inject context
  | { hookType: 'update';  content: string }   // replace the tool result body
  | { hookType: 'pass' }                        // no-op pass-through
```

Adding a new variant is a compile error at every `switch` over `hookType` that is not exhaustive, including `serializeOutput`.

### Wire Format Serialization

`serializeOutput(output: HookOutput): string` converts a `HookOutput` to the Claude Code hook wire JSON that the harness reads from stdout:

| `hookType` | Wire JSON |
|---|---|
| `deny` | `{"decision":"block","reason":"<message>"}` |
| `context` | `{"context":"<content>"}` |
| `update` | `{"updatedInput":{"content":"<content>"}}` |
| `pass` | `{}` |

---

## Data Flow

### On a `Read` tool call (pre_tool_use)

1. The harness fires `token-goat hook pre_tool_use` with the payload on stdin.
2. `relay.ts::relay` reads stdin (5 s timeout), builds a `HookEvent` via `buildEvent`.
3. `runHook` iterates `pre_tool_use` handlers in registration order:
   a. **`preReadImageHandler`** (registered first via `image_shrink.ts`): if the path is an image at or above 512 KB, reads the file, calls `shrinkImage`, and returns a `context` output with the re-encoded image as a base64 data URL. Otherwise `pass`.
   b. **`preReadHandler`** (registered via `hooks_read.ts`): extracts `file_path`, normalizes it, checks session state. If already read this session, returns a `context` hint with the re-read count. If file size ≥ 100 KB, returns a large-file hint. In both cases, records the read in session state. Otherwise records the read and returns `pass`.
4. `serializeOutput` writes the first non-`pass` result (or `{}`) to stdout.

### On a `Write`/`Edit` tool call (post_tool_use)

1. The harness fires `token-goat hook post_tool_use`.
2. `relay` dispatches to `postEditHandler` in `hooks_edit.ts`.
3. `getFilePath` extracts `file_path` from tool input.
4. `recordFileEdit(normalized)` in `session.ts` sets `wasEdited: true` on the file entry.
5. `appendDirtyPath(normalized)` in `hooks_index.ts` appends the path to `{dataDir}/queue/dirty.txt` (creates the directory on first use).
6. Returns `pass` — edit handlers never block.

### On bash tool calls (post_tool_use)

The bash output caching handlers are registered by the Python layer and partially ported here. `bash_compress.ts` implements the compression pipeline (ANSI strip → `\r` collapse → CRLF normalize → per-line `FILTERS` → length truncate → consecutive dedup → line-count cap). `bash_output_cache.ts` stores the compressed output keyed by `hashCommand(command)` (16-hex-char SHA-256 prefix). `session.ts::recordBashOutput` indexes the command hash to output id. The `token-goat bash-output <id>` CLI command retrieves entries from this cache.

### On compact (pre_compact)

Two `pre_compact` handlers fire in registration order:

1. **`preCompactIndexHandler`** (`hooks_index.ts`): snapshots the current dirty queue to `{dataDir}/queue/pending.txt` via `atomicWriteBytes`, then clears the live queue so the post-compact session starts fresh. Always returns `pass`.
2. **`preCompactHandler`** (`hooks_compact.ts`): calls `buildManifest()` which reads `getSessionFiles()` and `getSessionWebFetches()`, then renders a structured summary:
   - Files read count and edited count
   - Up to 40 read-file rows: `path (Xkb, N reads[, edited])`
   - Edited-files section when edits exist
   - Web-URL section with cache ids
   Returns a `context` output with this manifest so compaction preserves session context.

### CLI surgical reads

All surgical read commands (`symbol`, `read`, `section`, `skeleton`, `outline`, `semantic`) query the SQLite index:

1. `cli.ts` parses the command and calls the handler function.
2. Handlers call `querySymbols` / `searchSymbolsFts` / `queryRefs` in `index_reader.ts`, or `readSection` / `listSections` in `section_reader.ts`.
3. `index_reader.ts` calls `getDb(globalDbPath())` which opens and caches a `better-sqlite3` connection, applies pragmas and schema on first open, then runs a prepared statement.
4. Results are formatted and written to stdout via `out()` in `cli.ts`.

---

## Storage Layout

### Per-project SQLite DB

Location: platform-dependent data directory.

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\dfk-helper\token-goat\global.db` |
| macOS | `~/Library/Application Support/token-goat/global.db` |
| Linux/WSL | `$XDG_DATA_HOME/token-goat/global.db` (fallback: `~/.local/share/token-goat/global.db`) |

Schema (defined in `db.ts::SCHEMA_SQL`):

- **`files`** — `path TEXT PRIMARY KEY, sha TEXT, mtime REAL, language TEXT, indexed_at REAL`
- **`symbols`** — `id, file_path, name, kind, line_start, line_end, body, docstring`; indexes on `name`, `file_path`, `(name, kind)`
- **`refs`** — `id, file_path, name, line, col, context`; indexes on `name`, `file_path`
- **`symbols_fts`** — FTS5 external-content table mirroring `symbols(name, body, docstring)`, kept in sync via `INSERT/DELETE/UPDATE` triggers. Falls back gracefully when FTS5 is not compiled into the SQLite build.
- **`chunk_vectors`** (optional) — `vec0` virtual table with `embedding float[384]` for semantic search via `sqlite-vec`. Created only when the `sqlite-vec` package is installed and the extension loads successfully.

One `Database` handle is cached per resolved absolute path in a module-global `Map<string, BetterSqlite3Database>`. `closeAllDbs()` is registered with `registerReset` so tests start from a clean connection pool.

### Session State

All session state is process-local in-memory Maps/Sets in `session.ts`. Nothing is written to disk.

- `_files: Map<string, FileEntry>` — normalized path → `{ path, readCount, lastReadAt, wasEdited, sizeBytes }`. Populated by `recordFileRead` and `recordFileEdit`.
- `_hintsShown: Set<string>` — hint dedup keys.
- `_webFetches: Map<string, string>` — URL → cache id.
- `_bashOutputs: Map<string, string>` — command hash → output id.
- `_sessionId: string | null` — resolved once from `CLAUDE_SESSION_ID` or generated via `crypto.randomUUID`.

### Bash Output Cache

In-memory: `bash_output_cache.ts` keeps `_byId: Map<string, BashOutputEntry>`. Each entry stores the full command string, output text, exit code, timestamp, and byte size. The key is `hashCommand(command)` — a 16-hex-char SHA-256 prefix of the trimmed command string, making the id deterministic and stable for re-runs.

### Web Output Cache

In-memory: `web_cache.ts` keeps `_byId: Map<string, string>` (cache id → body) and `_urlIndex: Map<string, string>` (URL → cache id). The cache id is a 16-hex-char SHA-256 prefix of the URL, so the same URL always maps to the same id. Re-storing a URL overwrites the body.

### Dirty Queue

File: `{dataDir}/queue/dirty.txt`

One absolute normalized path per line, appended by `appendDirtyPath`. The file is read and deduplicated by `getDirtyPaths` / `getDirtyPathsFor`. Cleared by `clearDirtyQueue` / `clearDirtyQueueFor` after a drain cycle. On `pre_compact`, any pending paths are atomically snapshotted to `{dataDir}/queue/pending.txt` before the live queue is cleared, so the indexer can pick up the work after compaction.

### Worker Lock File

File: `{dataDir}/worker.pid`

Contains the PID of the running detached worker process (integer, newline-terminated). `isWorkerRunning` reads this file and probes the PID with `process.kill(pid, 0)`. `stopWorker` sends SIGTERM and removes the file. A stale file (process gone) is treated as not-running and is cleaned up.

---

## Indexing Pipeline

### `parser.ts`: Tree-sitter grammar loading, language detection, symbol extraction

Language detection (`parser_types.ts::detectLanguage`) first checks the basename against `FILENAME_LANGUAGE` (e.g. `Dockerfile` → `bash`, `package.json` → `json`), then falls back to the extension via `EXTENSION_LANGUAGE`. Returns `'unknown'` for unrecognized files.

Tree-sitter loading is lazy and cached per language:

```
loadParserCtor()          → tries require('tree-sitter'), caches result
loadGrammar(lang)         → tries require('tree-sitter-<lang>'), caches result
isTreeSitterAvailable()   → both must be non-null AND lang in {typescript,javascript,python}
```

The `_parserCtor` and `_grammarCache` module-globals use `null` to mean "tried and unavailable" and `undefined` to mean "not yet attempted", so the native binding is loaded at most once per process.

Extraction dispatches by language:
- **TypeScript/JavaScript**: `extractTsJsSymbols` walks the tree collecting `function_declaration`, `class_declaration`, `method_definition`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, `generator_function_declaration`, and `const`/`let`/`var` declarators whose initializer is a function or arrow expression.
- **Python**: `extractPythonSymbols` walks the tree, promoting `function_definition` inside a `class_definition` to `method` kind, and captures the first string-literal expression as a docstring.
- **Fallback (any language without a grammar)**: `extractWithRegex` applies `FALLBACK_PATTERNS` — a set of language-agnostic regexes covering Python, TS/JS, Rust, Go — line by line. Produces single-line body entries (no end-line span).

`parseFile(filePath)` reads the file asynchronously, detects language, and dispatches. Unknown language (`'unknown'`) returns an empty symbol list without attempting extraction.

### `indexFile` and transaction strategy

`indexFile(filePath, dbPath)` wraps the full write in a `db.transaction(...)` callback:
1. DELETE existing `symbols`, `refs`, and `files` rows for the path.
2. INSERT a new `files` row with SHA, mtime, language, and timestamp.
3. INSERT each symbol row; rows with an empty name or kind are skipped.
4. INSERT each ref row (currently always empty in this port).

The FTS5 triggers on `symbols` maintain `symbols_fts` automatically inside the same transaction.

### `worker.ts`: dirty queue drain

`drainOnce(dir, index?)` reads the queue, calls `processDirtyBatch`, and clears the queue. `processDirtyBatch` fingerprints each path and calls the `index` callback (which in the full implementation calls `indexFile`). The current TS port stubs the callback with a stderr log line.

The worker runs in one of two modes:
- **Worker thread** (`startWorker`): passes `fileURLToPath(import.meta.url)` as the worker script — when the module loads off the main thread, the `workerEntry()` call at the bottom detects `isMainThread === false` and calls `runWorkerLoop`. The caller receives a `WorkerHandle` with a `stop()` method.
- **Detached process** (`startDetachedWorker`): spawns `node <thisFile> --worker-daemon` with `detached: true` and `stdio: 'ignore'`, passing config via `TG_WORKER_POLL_MS` and `TG_WORKER_DATA_DIR` env vars. The child is `unref`'d so the launching CLI exits immediately. The PID is written to the pid file.

`runWorkerLoop` sleeps between drain cycles using `await new Promise(resolve => setTimeout(resolve, pollIntervalMs))` — a true async sleep that does not burn CPU and keeps the thread responsive to termination.

---

## CLI Commands

All commands are registered in `buildProgram()` in `cli.ts` using Commander.

| Command | Handler function | Description |
|---|---|---|
| `symbol <name>` | `cmdSymbol` | Query symbols by name; `--file`, `--kind`, `--limit` filters |
| `read <file::member>` | `cmdRead` | Read one function/class/method body from the index |
| `section <file::heading>` | `cmdSection` | Extract one named section from a file |
| `semantic <query>` | `cmdSemantic` | FTS5 full-text search over symbol names and bodies |
| `skeleton <file>` | `cmdSkeleton` | List all symbol signatures (no bodies) from the index |
| `outline <file>` | `cmdOutline` | List symbols with line ranges and docstrings |
| `map` | `cmdMap` | Project overview: file counts, language histogram, top symbols; `--compact` flag |
| `hook <event>` | `cmdHook` | Stdin → runHook → stdout relay (harness entry point) |
| `install` | `cmdInstall` | Write token-goat hooks into Claude Code `settings.json`; `--project` for project scope |
| `uninstall` | `cmdUninstall` | Remove token-goat hooks from `settings.json`; `--project` flag |
| `worker start` | `cmdWorkerStart` | Start the background indexer as a detached process |
| `worker stop` | `cmdWorkerStop` | Stop the detached indexer and remove the pid file |
| `worker status` | `cmdWorkerStatus` | Report whether the indexer is running |
| `stats` | `cmdStats` | (reserved; reports session statistics) |
| `version` | inline | Print `VERSION` and exit 0 |

`run(argv?)` wraps `buildProgram().parseAsync(argv)` and sets `process.exitCode` on `CliError` — it never calls `process.exit()` (see Key Design Decisions below).

`splitFileSpec(spec)` parses a `file::member` spec into `{ file, member }`. The `::` separator is used by `read` and `section` to name the target within a file.

---

## Harness Bridges

### Supported harnesses

| `HarnessName` | Detection signal | Bridge file |
|---|---|---|
| `claudecode` | `TERM_PROGRAM === 'claude-code'` or `CLAUDE_CODE_VERSION` set | `bridges/claudecode.ts` |
| `codex` | `CODEX_SESSION_ID` set | `bridges/codex.ts` |
| `opencode` | `OPENCODE_SESSION_ID` set | *(config only, no dedicated bridge file)* |
| `generic` | none of the above | fallback |

`detectHarness()` checks these in priority order (more specific first). `getHarnessName()` memoizes the result for the process lifetime.

### Bridge pattern

Each harness bridge exports:
- A `*_HOOK_SCRIPT` constant: the complete source text of a small CommonJS Node.js shim script. This shim is written to disk by the installer (e.g. `.claude/token-goat-hook.cjs`) and referenced from the harness settings file.
- A `get*HookConfig()` function returning a `BridgeConfig: { harness, hookScriptPath, hookSpecificOutput }`.

The shim's job is simple: read stdin, `spawnSync('token-goat', ['hook', eventName])`, relay stdout. On any error it prints `{}` so the tool call is never blocked by a hook failure.

`install.ts` writes the shim by interpolating the script text to disk. `BridgeConfig.hookScriptPath` names where the file lives.

### Wire format differences per harness

**Claude Code** (`hookSpecificOutput: false`):
- Receives the hook payload as JSON on stdin.
- Reads `{}` as pass-through, `{"decision":"block","reason":"..."}` as block, `{"context":"..."}` as context injection.
- Does not require a `hookEventName` field.
- Installed hook settings entry: `{ "type": "command", "command": "token-goat hook <event>" }`.

**Codex** (`hookSpecificOutput: true`):
- Identical stdin/stdout protocol, but its JSON schemas declare `additionalProperties: false`.
- Requires `hookSpecificOutput.hookEventName` in every response.
- The Codex shim (`CODEX_HOOK_SCRIPT`) post-processes the output: strips any top-level and nested `_tg_*` keys (which would trip `additionalProperties`), and injects `hookEventName` into `hookSpecificOutput` when absent.
- The `stripTg` helper walks the parsed JSON recursively, skipping any key starting with `_tg_`.

**Install wiring**: `install.ts::HOOK_EVENT_MAP` maps Claude Code PascalCase event keys (`PreToolUse`, `PostToolUse`, `PreCompact`) to internal snake_case args (`pre_tool_use`, `post_tool_use`, `pre_compact`). The installer adds a matcher group `{ matcher: '', hooks: [{ type: 'command', command: 'token-goat hook <event>' }] }` for each. Uninstall removes only entries matching the `'token-goat hook'` substring, leaving user-authored hooks untouched.

---

## Image Processing

### Lazy `sharp` loading

`loadSharp()` is async and caches the result in `_sharpCache`:
- `undefined` — not yet attempted (first call will import).
- `null` — import failed; logged once to stderr, all subsequent calls return null immediately.
- `SharpFactory` — the resolved `sharp` default export.

The one-shot log (`sharp unavailable: <err>`) fires on the first failed import. The hot path (every subsequent image or non-image hook call) is a single null check with no `try/catch`.

### Shrink thresholds and algorithm

`shrinkImage(input, opts?)` defaults:
- `sizeThresholdBytes`: 512 KB — files below this are returned unchanged (no net win from encode overhead).
- `maxDimension`: 1568 px — Claude Vision's optimal edge length; `withoutEnlargement: true` keeps smaller images at native size.
- `quality`: 85 — visually lossless at reading distance for both JPEG and WebP.

The algorithm runs two independent encoding pipelines from the same input buffer (sharp instances are single-shot): JPEG via mozjpeg (`{ quality, mozjpeg: true }`) and WebP (`{ quality }`). It picks whichever is smaller. If neither output is smaller than the original, it returns `null` (no shrink).

EXIF orientation is baked in via `.rotate()` before any resize, so portrait images encoded sideways appear correctly without metadata.

`preReadImageHandler` emits a `context` output containing a `data:image/<format>;base64,...` data URL plus a one-line savings summary when a shrink succeeds. The model sees the cheaper image rather than the original file.

---

## Project Map (`baseline.ts`)

`buildProjectMap(rootDir, opts)` produces a `ProjectMap` containing file count, language histogram, top symbols, and recent files.

### Walk algorithm

`walkProject(rootDir)` uses an explicit stack (DFS, iterative) to avoid call-stack depth limits on deep trees. At each directory it calls `readdirSync` with `{ withFileTypes: true }`:
- Directories named in `SKIP_DIRS` (node_modules, .git, dist, build, out, coverage, .next, .nuxt, .venv, venv, `__pycache__`, .mypy_cache, .pytest_cache, .ruff_cache, target, .idea, .vscode) are skipped entirely.
- Hidden directories (names starting with `.`) other than the root are skipped.
- Files with `detectLanguage` returning `'unknown'` are skipped (only source files are counted).
- `MAX_FILES_SCANNED = 20000` caps the total; the walk stops once this is reached.

### Compact vs full output

`formatProjectMap(map, compact)`:
- **Compact** (`--compact`): fetches 10 top symbols, 5 recent files, emits one language summary line and a short symbol list with `name (kind)`.
- **Full**: fetches 30 top symbols, 15 recent files, adds per-symbol file locations (`name (kind) — file.ts:start-end`) and a `## Recent files` section.

Top symbols are ordered by kind priority (class → interface → function) then by body length descending (a rough proxy for significance).

---

## Key Design Decisions

### Why `process.exitCode` not `process.exit()`

`run()` in `cli.ts` sets `process.exitCode` and returns, allowing the Node.js event loop to drain naturally. `process.exit()` can truncate buffered stdout on Windows pipes before the OS flushes the buffer — a real failure mode for hook shims that write JSON to stdout. `main.ts` is a one-liner that calls `void run()` with no forced exit.

### Why `better-sqlite3` (synchronous) over async alternatives

The hook handlers run synchronously in the relay process. An async DB client (e.g. `@databases/sqlite`, `sql.js`) would require `await` everywhere in the handler chain and complicate the `serializeOutput` path. `better-sqlite3` is synchronous and battle-tested; WAL journal mode means readers and writers don't block each other, which is the only concurrency that matters (CLI reads while the worker writes).

### Why `pool: 'forks'` in vitest

Vitest's default `threads` pool shares a Node.js process, so module-global state bleeds between test files even when `clearModuleCaches()` is called. `forks` spawns a fresh subprocess per test file, giving each file an isolated module registry. The `singleFork: false` setting runs all forks concurrently for speed.

### Why `NodeNext` module resolution (`.js` extensions on local imports)

`"module": "NodeNext"` + `"moduleResolution": "NodeNext"` makes TypeScript follow Node's native ESM resolution, which requires explicit `.js` extensions on local imports (e.g. `import { foo } from './bar.js'` — even though the source file is `bar.ts`). This means the compiled output requires no extension rewriting, and `tsx` can run the source directly without a build step.

### `noUncheckedIndexedAccess` implications

All array/object index accesses return `T | undefined` rather than `T`. This is why code throughout the codebase guards with `if (item === undefined) continue` inside loops and checks `lines[i]` before use. The payoff is that out-of-bounds reads are caught at compile time rather than producing mysterious runtime `undefined` errors.

### `exactOptionalPropertyTypes` implications

An optional property `{ foo?: string }` cannot be set to `undefined` — it must be omitted. This prevents `{ foo: undefined }` from passing where the property is optional, tightening the boundary between "not provided" and "explicitly undefined". Interfaces use `foo?` only for truly optional fields, not as a backdoor `undefined` union.

### `worker_threads` for daemon isolation

`startWorker` passes `fileURLToPath(import.meta.url)` to the `Worker` constructor. The same `worker.ts` file is re-imported in the thread context; `workerEntry()` at the bottom detects `isMainThread === false` and starts `runWorkerLoop`. This avoids a separate entry-point file while keeping the daemon logic co-located with the host-side API. Config is passed via `workerData` (in-process) or env vars (detached process) because a detached process cannot receive `workerData`.

---

## Extension Guide

### Adding a new language adapter (tree-sitter + regex fallback pattern)

1. Add the new language to the `Language` union in `parser_types.ts` and wire its file extensions in `EXTENSION_LANGUAGE` (and special filenames in `FILENAME_LANGUAGE` if needed).
2. Add the optional grammar package to `package.json::optionalDependencies` (e.g. `tree-sitter-rust`).
3. In `parser.ts::loadGrammar`, add a branch for the new language:
   ```typescript
   } else if (lang === 'rust') {
     grammar = _require('tree-sitter-rust') as Grammar
   }
   ```
4. Update `isTreeSitterAvailable` to include the new language in its guard.
5. Write an `extractRustSymbols(root, filePath)` function (following the TS/JS or Python pattern) and dispatch to it in `parseContent`.
6. Add regex fallback patterns in `FALLBACK_PATTERNS` (the existing Rust patterns cover `fn` and `struct`; extend as needed).
7. Add section-reader support in `section_reader.ts::findHeaders` if the language has a recognizable section structure.

### Adding a new hook handler

1. Create a new module `hooks_<name>.ts` (or add to an existing one for the same event).
2. Implement a `HookHandler` function: `(event: HookEvent) => HookOutput | Promise<HookOutput>`.
3. Use `getFilePath`, `getToolName`, `passOutput`, `contextOutput`, `denyOutput` from `hooks_common.ts`.
4. At module load time, call `registerHook('pre_tool_use', myHandler, { toolName: 'Read' })` (or omit `toolName` for all tools on an event).
5. Add a side-effect import `import './hooks_<name>.js'` in `relay.ts` so the handler is registered when the relay runs.
6. Write a test in `tests/hooks_<name>.test.ts` using `clearModuleCaches()` in `beforeEach`.

### Adding a new CLI command

1. Add a handler function `cmdFoo(arg, opts)` in `cli.ts`. It should call `out(text)` for output and throw `new CliError(msg, code)` for user-facing errors.
2. Register it in `buildProgram()`:
   ```typescript
   program
     .command('foo <arg>')
     .description('...')
     .option('--bar', 'description')
     .action((arg, opts) => cmdFoo(arg, opts))
   ```
3. If the command needs DB access, call `querySymbols` / `readSection` / `getDb` from `index_reader.ts` or `section_reader.ts`.
4. Document the command in `CLAUDE.md` under the token-goat command table.

### Adding a new harness bridge

1. Create `bridges/<harness>.ts`. Export:
   - A `HARNESS_HOOK_SCRIPT` constant with the shim source text (CommonJS, no build step).
   - A `get<Harness>HookConfig(): BridgeConfig` function returning `{ harness, hookScriptPath, hookSpecificOutput }`.
2. Add `'<harness>'` to the `HarnessName` union in `bridges/types.ts`.
3. Add detection in `bridges/registry.ts::detectHarness` (check a harness-specific env var).
4. Re-export from `bridges/index.ts`.
5. Wire the shim install into `install.ts` if the harness uses a settings-file mechanism. If it uses a different mechanism (TOML config, JSON config), implement the read/write/idempotency logic following the `installHooks`/`uninstallHooks` pattern.
6. If the harness has a strict output schema (like Codex), implement a post-processing step in the shim (strip internal keys, inject required fields) rather than in the relay — the relay always emits the same wire format.

---

## Testing

### Test file layout

Tests live in `tests/` alongside source. Each source file has a corresponding `tests/<name>.test.ts`. Bridge tests live in `tests/bridges/`. All tests run with Vitest using `pool: 'forks'` (one subprocess per test file).

### `registerReset` + `clearModuleCaches()` pattern for hook isolation

Every test file that exercises code with module-global state (`hook_registry.ts`, `session.ts`, `db.ts`, etc.) calls `clearModuleCaches()` in `beforeEach` (and optionally `afterEach`):

```typescript
import { clearModuleCaches } from '../src/reset.js'

beforeEach(() => {
  clearModuleCaches()
})
```

This runs every registered reset callback in order — clearing the hook registry, session Maps, DB connections, and any other stateful modules. Because the module registry itself is not cleared (ESM module cache is process-scoped under `pool: 'forks'`), `registerReset` callbacks accumulate from module load, and `clearModuleCaches` resets only the *data*, not the *registrations*. After `clearModuleCaches`, all handlers remain registered but the session state is empty.

When a test file registers hooks directly (via `registerHook`), it must call `clearModuleCaches()` before each test to avoid handler accumulation across tests.

### `node --import tsx` for CLI integration tests

`tests/cli.test.ts` invokes the CLI via `spawnSync(process.execPath, ['--import', 'tsx', MAIN, ...args])`. This runs the TypeScript source directly under the `tsx` ESM loader without a build step, so CLI tests always exercise the current source. The 30 s timeout per test accounts for the tsx startup cost.

The pattern avoids the `.cmd` shim problem on Windows: passing the Node executable path directly with `--import tsx` instead of invoking a shell-resolved `token-goat` binary means there is no shell-escaping or `.cmd` extension issue.

### Structural integrity: `git_chokepoint.test.ts`

`tests/git_chokepoint.test.ts` recursively reads every `.ts` file under `src/` and checks that none — except `src/util.ts` — match the bare git-spawn patterns `exec('git`, `spawn('git`, `execSync('git`, `spawnSync('git`. This enforces the invariant that `runGit` in `util.ts` is the sole git spawn site, preventing scattered subprocess calls with inconsistent behavior (no `core.fsmonitor=` disable, no `windowsHide`, inconsistent error handling).

### Equivalent of `make_git_repo` in TS

There is no direct equivalent of the Python `make_git_repo` conftest helper in this port. Worker and dirty-queue tests that need a real directory use `fs.mkdtempSync` in `beforeEach` and `fs.rmSync(DIR, { recursive: true })` in `afterEach`. DB tests pass a temp-directory path to `getDb` directly. No test in this port requires a real git repo.
