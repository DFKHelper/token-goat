window.tokenGoatFeatures = [
  {
    "category": "Debug and review",
    "name": "conflicts",
    "description": "unresolved git merge-conflict markers (<<<<<<< / ||||||| / ======= / >>>>>>>, two-way or diff3 three-way) instead of a raw Read or grep\n\npath may be a single file, a directory (scanned recursively), or omitted entirely (scans the whole project from the current directory); only files with at least one conflict region or malformed-marker warning are reported"
  },
  {
    "category": "Debug and review",
    "name": "coverage-report-gaps",
    "description": "uncovered lines/functions/branches from a code-coverage report instead of a raw Read\n\nsupports LCOV .info text and Istanbul/nyc JSON (coverage-final.json for per-line/function/branch detail, coverage-summary.json for file-level aggregate counts only); format is auto-detected from content, not the filename"
  },
  {
    "category": "Debug and review",
    "name": "dep-docs",
    "description": "extract one installed npm package's README, package.json metadata, and (if resolvable) a compact .d.ts signature outline instead of grepping node_modules"
  },
  {
    "category": "Debug and review",
    "name": "failures",
    "description": "extract failing test blocks from test runner output (pytest, Jest, Go, Cargo)"
  },
  {
    "category": "Debug and review",
    "name": "lockdeps",
    "description": "summarize a dependency lockfile (auto-detects package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, uv.lock, Pipfile.lock, Cargo.lock, requirements*.txt)"
  },
  {
    "category": "Debug and review",
    "name": "logfold",
    "description": "apply log-noise filters then fold consecutive duplicate lines"
  },
  {
    "category": "Debug and review",
    "name": "todo",
    "description": "scan source files for TODO/FIXME/HACK/XXX/NOTE markers"
  },
  {
    "category": "Debug and review",
    "name": "trace",
    "description": "condense a Python traceback to project frames only"
  },
  {
    "category": "Find and read code",
    "name": "brief",
    "description": "symbol body + callers + containing doc section in one call (spec: file::symbol)"
  },
  {
    "category": "Find and read code",
    "name": "exports",
    "description": "list exported (public) symbols in a file"
  },
  {
    "category": "Find and read code",
    "name": "find",
    "description": "find files containing a symbol matching a pattern"
  },
  {
    "category": "Find and read code",
    "name": "grep",
    "description": "regex search over files, caching nothing (session-aware grep)"
  },
  {
    "category": "Find and read code",
    "name": "imports",
    "description": "list the modules a file imports"
  },
  {
    "category": "Find and read code",
    "name": "outline",
    "description": "list symbols with line ranges and docstrings"
  },
  {
    "category": "Find and read code",
    "name": "read",
    "description": "read one symbol's full body (spec: file::symbol; disambiguate a name shared by several classes with file::Parent.symbol; comma-separated file::a,b for a merged multi-symbol view)"
  },
  {
    "category": "Find and read code",
    "name": "refs",
    "description": "find references to one or more symbols (spec: file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view). For an unambiguous TypeScript symbol, automatically type-resolves candidates via the TypeScript compiler API to drop same-named-different-symbol false positives; falls back to name-based matching when that is not possible."
  },
  {
    "category": "Find and read code",
    "name": "section",
    "description": "read one section from a file (spec: file::heading, or file::<unambiguous heading prefix> — e.g. \"Lesson 16\" resolves a longer unique heading), or list all sections with --list"
  },
  {
    "category": "Find and read code",
    "name": "semantic",
    "description": "semantic search (falls back to full-text search)"
  },
  {
    "category": "Find and read code",
    "name": "skeleton",
    "description": "list all symbols in a file without bodies"
  },
  {
    "category": "Find and read code",
    "name": "symbol",
    "description": "search for a symbol by name"
  },
  {
    "category": "Manage cached results",
    "name": "bash-history",
    "description": "list cached bash output entries, newest first"
  },
  {
    "category": "Manage cached results",
    "name": "bash-output",
    "description": "retrieve cached bash output by ID or file"
  },
  {
    "category": "Manage cached results",
    "name": "cache-audit",
    "description": "check settings.json hook installation and env-var gates that defeat token-goat caching"
  },
  {
    "category": "Manage cached results",
    "name": "clean-cache",
    "description": "prune all cache subdirs to default retention limits (200 entries, 24 h)"
  },
  {
    "category": "Manage cached results",
    "name": "history",
    "description": "show recent session history: bash commands and web fetches (current-session or recent cache)"
  },
  {
    "category": "Manage cached results",
    "name": "mcp-history",
    "description": "list cached MCP tool result entries, newest first"
  },
  {
    "category": "Manage cached results",
    "name": "mcp-output",
    "description": "retrieve a cached MCP tool result by ID (the id an MCP post_tool_use hook cached, or a `[token-goat: compressed, full via mcp-output <id>]` label points here)"
  },
  {
    "category": "Manage cached results",
    "name": "prune-cache",
    "description": "evict cache entries older than --max-age-hours or beyond --max-count (caller-specified bounds)"
  },
  {
    "category": "Manage cached results",
    "name": "reclaim-index",
    "description": "shrink an oversized symbol index: VACUUM, or --rebuild to drop derived rows so the next index run re-derives them"
  },
  {
    "category": "Manage cached results",
    "name": "web-history",
    "description": "list cached web-fetch output entries, newest first"
  },
  {
    "category": "Manage cached results",
    "name": "web-output",
    "description": "retrieve a cached WebFetch response body by ID"
  },
  {
    "category": "Measure and reduce context",
    "name": "budget",
    "description": "estimate the total token cost of a file set"
  },
  {
    "category": "Measure and reduce context",
    "name": "compact-doc",
    "description": "build/refresh an extractive compact sidecar for a document; pre_read serves it in place of the full file when fresh. --heading is a legacy mode that extracts one section via a `<!-- COMPACT_END -->` marker instead."
  },
  {
    "category": "Measure and reduce context",
    "name": "compact-hint",
    "description": "show compact manifest info and context pressure (reuses compact.ts — does not rebuild the manifest)"
  },
  {
    "category": "Measure and reduce context",
    "name": "compress",
    "description": "run a shell command and emit a compressed view of its output"
  },
  {
    "category": "Measure and reduce context",
    "name": "compress-text",
    "description": "compress arbitrary local text and print an opaque recovery ID plus compact payload"
  },
  {
    "category": "Measure and reduce context",
    "name": "cost",
    "description": "tokens-saved / cost breakdown (thin framing over stats; --session narrows to current session)"
  },
  {
    "category": "Measure and reduce context",
    "name": "map",
    "description": "project overview"
  },
  {
    "category": "Measure and reduce context",
    "name": "pack",
    "description": "bundle matched files into a single LLM-ready output (Markdown, XML, or plain text)"
  },
  {
    "category": "Measure and reduce context",
    "name": "retrieve",
    "description": "retrieve original text previously stored by token-goat compress"
  },
  {
    "category": "Measure and reduce context",
    "name": "tokens",
    "description": "per-file token footprint table, sorted largest-first"
  },
  {
    "category": "Read documents, data, and media",
    "name": "csv-profile",
    "description": "per-column type/null/distinct/range summary of a CSV instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "csv-query",
    "description": "project columns / filter rows from a CSV instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "docx-outline",
    "description": "heading tree of a Word document instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "docx-text",
    "description": "full body text of a Word document instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "gdrive-sections",
    "description": "fetch and list sections from a public Google Doc"
  },
  {
    "category": "Read documents, data, and media",
    "name": "json-outline",
    "description": "structural summary of a JSON document (array shape / object key types) instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "json-query",
    "description": "extract one value or a projected/filtered subset from a JSON document by dot-path instead of a raw Read\n\npath grammar: dot-separated keys with optional bracket segments -- [n] index, [*] wildcard (projects every element/value), [field=value] filter (keeps array elements whose field stringifies to value). Examples: data.items[3].name, items[*].id, items[status=active]"
  },
  {
    "category": "Read documents, data, and media",
    "name": "openapi-op",
    "description": "full detail (parameters, request body schema, response schemas, description) for exactly one OpenAPI operation instead of a raw Read\n\noperation may be an operationId (exact match) or a \"METHOD path\" spec, e.g. \"GET /users/{id}\""
  },
  {
    "category": "Read documents, data, and media",
    "name": "openapi-outline",
    "description": "per-operation listing (method, path, operationId, summary, tags) of an OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML) instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pdf-extract",
    "description": "extract plain text from a PDF (optionally --pages N or N-M) instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pdf-meta",
    "description": "page count, title/author, and whether a PDF has an extractable text layer"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pdf-outline",
    "description": "list a PDF's bookmark/outline tree with page numbers instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pptx-notes",
    "description": "speaker notes for one slide, or all slides, instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pptx-outline",
    "description": "per-slide title + body size + notes flag instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pptx-slide",
    "description": "full text of one slide instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pptx-text",
    "description": "find slides whose text matches a pattern instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "pr-slice",
    "description": "one slice of a GitHub PR (files / one file's diff / review comments / description) via `gh` instead of a full `gh pr view`/`gh pr diff` dump\n\npr is a PR number or URL. slice is one of: files (changed files with +/- counts), diff:<path> (one file's diff hunk), comments (review comments), description (title/body/metadata)"
  },
  {
    "category": "Read documents, data, and media",
    "name": "screenshot",
    "description": "capture a local headless-browser screenshot, shrunk the same way local image reads are"
  },
  {
    "category": "Read documents, data, and media",
    "name": "sharepoint-resolve",
    "description": "best-effort resolve a SharePoint/OneDrive sharing URL to a local synced file path (no network call)"
  },
  {
    "category": "Read documents, data, and media",
    "name": "sqlite-query",
    "description": "run a read-only SELECT against a SQLite database instead of a raw Read or shelling out to sqlite3 -- rejects any non-SELECT statement"
  },
  {
    "category": "Read documents, data, and media",
    "name": "sqlite-schema",
    "description": "tables/views, columns, indexes, foreign keys, and row counts of a SQLite database instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "transcript",
    "description": "slice a WebVTT/SRT transcript by speaker/time range/pattern instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "transcript-outline",
    "description": "speaker list, duration, and time-bucketed markers for a WebVTT/SRT transcript instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "video-chapters",
    "description": "list a video's embedded chapter markers and subtitle streams via ffprobe, instead of downloading/transcoding it"
  },
  {
    "category": "Read documents, data, and media",
    "name": "xlsx-head",
    "description": "preview the header + first N rows of one sheet instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "xlsx-query",
    "description": "project columns / filter rows from one sheet instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "xlsx-range",
    "description": "extract one cell range (e.g. A1:D50) from a sheet instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "xlsx-sheets",
    "description": "list sheet names + used range/dimensions in an Excel workbook instead of a raw Read"
  },
  {
    "category": "Read documents, data, and media",
    "name": "yaml-outline",
    "description": "structural summary of a YAML document (array shape / object key types) instead of a raw Read -- multi-document streams (---separated) outline as an array of documents"
  },
  {
    "category": "Read documents, data, and media",
    "name": "yaml-query",
    "description": "extract one value or a projected/filtered subset from a YAML document by dot-path instead of a raw Read (same grammar as json-query)\n\npath grammar: dot-separated keys with optional bracket segments -- [n] index, [*] wildcard (projects every element/value), [field=value] filter (keeps array elements whose field stringifies to value). Examples: spec.containers[0].image, items[*].name, items[kind=Service]"
  },
  {
    "category": "Read documents, data, and media",
    "name": "zip-list",
    "description": "entry paths and sizes inside a zip-format archive (.zip/.jar/.whl/.vsix/.nupkg are all zip containers under the hood) instead of a raw Read or an unzip -l shell-out"
  },
  {
    "category": "Read documents, data, and media",
    "name": "zip-read",
    "description": "extract and print exactly one entry's text content from a zip-format archive by its in-archive path instead of extracting the whole archive to disk"
  },
  {
    "category": "Remember and monitor work",
    "name": "bootstrap-audit",
    "description": "audit Claude Code startup-context contributors without reading prompt bodies"
  },
  {
    "category": "Remember and monitor work",
    "name": "context-stats",
    "description": "show context statistics"
  },
  {
    "category": "Remember and monitor work",
    "name": "hint-stats",
    "description": "per-category efficacy report for token-goat's discretionary hint hooks (emitted/acted-on/suppression)"
  },
  {
    "category": "Remember and monitor work",
    "name": "hot",
    "description": "show most-read files across all sessions (current session: use `recent`)"
  },
  {
    "category": "Remember and monitor work",
    "name": "mcp-audit",
    "description": "MCP server schema cost-vs-usage report: estimate per-server token cost from cached tool calls"
  },
  {
    "category": "Remember and monitor work",
    "name": "memory",
    "description": "analyze CLAUDE.md files for duplicate/overlapping content (--fix to apply safe mechanical fixes)"
  },
  {
    "category": "Remember and monitor work",
    "name": "note",
    "description": "per-project key-value notes (actions: set, get, unset, list, clear)"
  },
  {
    "category": "Remember and monitor work",
    "name": "note-add",
    "description": "attach a free-text architecture note to a file, or to one specific indexed symbol within it (--symbol NAME), fingerprinting what the note describes so `note-list --stale-only` can flag it once the code changes"
  },
  {
    "category": "Remember and monitor work",
    "name": "note-get",
    "description": "read back the note attached to a file, or to one indexed symbol within it (--symbol NAME); flags whether it has gone stale since it was written"
  },
  {
    "category": "Remember and monitor work",
    "name": "note-list",
    "description": "list every recorded architecture note; --stale-only shows just the notes whose attached file/symbol changed since they were written"
  },
  {
    "category": "Remember and monitor work",
    "name": "recall",
    "description": "search across every cached bash-output, web-output, and mcp-output entry (full-text)"
  },
  {
    "category": "Remember and monitor work",
    "name": "recent",
    "description": "show N most-recently read/edited files in the current session (cross-session: use `hot`)"
  },
  {
    "category": "Remember and monitor work",
    "name": "resume",
    "description": "print a recovery context packet for the given session id"
  },
  {
    "category": "Remember and monitor work",
    "name": "session-outline",
    "description": "turn-by-turn structure (role, preview, tool calls, approx size) of a Claude Code session JSONL transcript, instead of a raw Read; defaults to the current project's most recent session"
  },
  {
    "category": "Remember and monitor work",
    "name": "session-slice",
    "description": "full content of one turn range from a Claude Code session JSONL transcript (see session-outline for turn numbers), instead of a raw Read"
  },
  {
    "category": "Remember and monitor work",
    "name": "session-summary",
    "description": "one-screen summary of the latest cached session: file counts, top files, session id"
  },
  {
    "category": "Remember and monitor work",
    "name": "stats",
    "description": "show session statistics (bare = totals only; --full for the breakdown)"
  },
  {
    "category": "Remember and monitor work",
    "name": "waste",
    "description": "session spend-ledger: token cost per tool/file from the current Claude Code session transcript, plus waste signals"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "bridges-status",
    "description": "hook-event parity matrix across every AI-harness bridge (read-only static analysis, never invokes a real harness binary)"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "commands",
    "description": "machine-readable manifest of every registered command, its options, and its arguments"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "config",
    "description": "manage token-goat config (list|get|set|validate). Operates on the token-goat config.toml, not a project config file."
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "config-get",
    "description": "read one value from a config file (TOML/JSON/YAML/INI)"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "doctor",
    "description": "diagnose token-goat health"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "hook",
    "description": "hook relay entrypoint (reads JSON on stdin)"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "index",
    "description": "parse all git-tracked files and (re)build the symbol index"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "install",
    "description": "install hooks into Claude Code settings"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "mcp-serve",
    "description": "run token-goat as an MCP stdio server exposing surgical reads and local compression/handoff tools"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "project",
    "description": "manage indexed project roots (list|exclude|prune). list = active project + blocked roots; exclude <path> = add to block list; prune = remove stale entries."
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "statusline",
    "description": "render one line of terminal status text from a harness statusline payload on stdin (Claude Code statusLine.command)"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "uninstall",
    "description": "remove token-goat hooks from Claude Code settings"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "version",
    "description": "print the token-goat version"
  },
  {
    "category": "Run and maintain Token-Goat",
    "name": "worker",
    "description": "background indexer lifecycle"
  },
  {
    "category": "Share compact handoffs",
    "name": "handoff-create",
    "description": "create a project-local named compressed handoff"
  },
  {
    "category": "Share compact handoffs",
    "name": "handoff-resolve",
    "description": "resolve a project-local handoff compactly, or return it in full"
  },
  {
    "category": "Understand a change",
    "name": "arch",
    "description": "internal import graph analysis: hubs, entry points, cycles"
  },
  {
    "category": "Understand a change",
    "name": "ask",
    "description": "(experimental) find relevant code context; synthesize with an LLM if TOKEN_GOAT_ASK_BACKEND is set"
  },
  {
    "category": "Understand a change",
    "name": "baseline",
    "description": "emit the project baseline map (file count, languages, top symbols, recent files)"
  },
  {
    "category": "Understand a change",
    "name": "blame",
    "description": "git blame for the line range of a symbol (\"file::symbol\")"
  },
  {
    "category": "Understand a change",
    "name": "call-chain",
    "description": "transitive callers up toward entry points (BFS, cycle-safe)"
  },
  {
    "category": "Understand a change",
    "name": "callers",
    "description": "find all callers of a symbol, resolved to their enclosing function"
  },
  {
    "category": "Understand a change",
    "name": "changed",
    "description": "list files or symbols changed since a git ref"
  },
  {
    "category": "Understand a change",
    "name": "context-for",
    "description": "suggest token-goat read commands for symbols relevant to a task"
  },
  {
    "category": "Understand a change",
    "name": "coverage-gaps",
    "description": "functions and methods with no references in test files"
  },
  {
    "category": "Understand a change",
    "name": "dead",
    "description": "symbols with zero references (default kind: function)"
  },
  {
    "category": "Understand a change",
    "name": "deps",
    "description": "one-level imports: resolves relative imports to project files, groups others as external"
  },
  {
    "category": "Understand a change",
    "name": "diff",
    "description": "show only the git diff hunk(s) that fall within one symbol's line range, e.g. `token-goat diff \"file.ts::myFn\" HEAD~3..HEAD`"
  },
  {
    "category": "Understand a change",
    "name": "impact",
    "description": "transitive set of callers impacted by a change (with hop depth)"
  },
  {
    "category": "Understand a change",
    "name": "log",
    "description": "show git commit history scoped to one symbol's line range, e.g. `token-goat log \"file.ts::myFn\" HEAD~10`"
  },
  {
    "category": "Understand a change",
    "name": "scope",
    "description": "list symbols enclosing a file:line position, innermost first"
  },
  {
    "category": "Understand a change",
    "name": "similar",
    "description": "find symbols similar to a given \"file::symbol\" anchor using FTS"
  },
  {
    "category": "Understand a change",
    "name": "test-for",
    "description": "list test files that reference symbols defined in a source file"
  },
  {
    "category": "Understand a change",
    "name": "types",
    "description": "type-like declarations (type, interface, enum, struct, trait, and Python type classes)"
  },
  {
    "category": "Work with files and images",
    "name": "fetch-image",
    "description": "fetch an image URL and shrink it (saves to --out path or a temp file)"
  },
  {
    "category": "Work with files and images",
    "name": "ignores",
    "description": "report active file-exclusion settings (walk mode, built-ins, blocked_roots, exclude_tests)"
  },
  {
    "category": "Work with files and images",
    "name": "insert-section",
    "description": "insert content immediately after a matched section (spec resolved the same way as `section`: exact heading, or an unambiguous prefix), avoiding a stale byte-exact anchor for append-to-a-running-log edits"
  },
  {
    "category": "Work with files and images",
    "name": "replace",
    "description": "replace one string in a file; supply old/new text via --old-from/--new-from or --old-b64/--new-b64, and use --all to replace every occurrence"
  },
  {
    "category": "Work with files and images",
    "name": "write-file",
    "description": "write exact bytes to a file — handles backticks, quotes, $vars, CRLF without escaping\n\nModes: --b64 PAYLOAD (base64), --from SOURCE (copy file), or piped stdin"
  },
  {
    "category": "Work with skills",
    "name": "skill-body",
    "description": "retrieve a skill's cached body"
  },
  {
    "category": "Work with skills",
    "name": "skill-compact",
    "description": "regenerate and cache compact slice for a skill"
  },
  {
    "category": "Work with skills",
    "name": "skill-diff",
    "description": "show diff between two cached versions of a skill"
  },
  {
    "category": "Work with skills",
    "name": "skill-history",
    "description": "list cached skill versions newest-first"
  },
  {
    "category": "Work with skills",
    "name": "skill-list",
    "description": "list all cached skills with token counts"
  },
  {
    "category": "Work with skills",
    "name": "skill-section",
    "description": "extract a named section from a skill"
  },
  {
    "category": "Work with skills",
    "name": "skill-size",
    "description": "show body/compact token counts per skill"
  }
];
