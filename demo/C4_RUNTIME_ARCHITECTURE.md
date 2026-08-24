# Token-Goat Runtime Architecture & Security Model (C4 Specification)

This document specifies the complete runtime architecture, hook processing flow, storage layout, background worker lifecycle, bridge integrations, and security trust boundaries of **Token-Goat**.

All standalone vector illustrations (`.svg`) and PlantUML models (`.puml`) live in `demo/diagrams/`.

---

## 1. System Context Diagram (C4 Level 1) & Trust Boundaries

Token-Goat sits between AI Agent Harnesses (Claude Code, VS Code Copilot, GitHub Copilot CLI, Codex) and the local operating system, filtering and narrowing context before it enters the model window.

```mermaid
flowchart TB
    classDef person fill:#08427B,stroke:#073B6F,color:#ffffff,font-weight:bold;
    classDef tgRuntime fill:#1168BD,stroke:#0B4884,color:#ffffff,font-weight:bold;
    classDef agent fill:#7C3AED,stroke:#5B21B6,color:#ffffff,font-weight:bold;
    classDef external fill:#475569,stroke:#334155,color:#ffffff;
    classDef untrusted fill:#DC2626,stroke:#991B1B,color:#ffffff,font-weight:bold;

    Developer["👤 Software Engineer / User<br/><small>[Person] Writes code, issues CLI commands, reviews tasks</small>"]:::person

    subgraph HarnessBoundary ["AI Coding Agent Runtimes"]
        ClaudeCode["🤖 Claude Code<br/><small>[Harness] Subprocess Hook Intercept</small>"]:::agent
        CopilotCLI["🤖 GitHub Copilot CLI<br/><small>[Harness] Direct Tool Calls & Aliases</small>"]:::agent
        VSCodeCopilot["🤖 VS Code Copilot Chat<br/><small>[Harness] stdio MCP Server</small>"]:::agent
        CodexHermes["🤖 Codex / OpenCode / Hermes<br/><small>[Harness] Hook & Execution Bridge</small>"]:::agent
    end

    subgraph TokenGoatRuntime ["Token-Goat Engine (Local Machine)"]
        TGCore["⚡ Token-Goat Runtime<br/><small>[TypeScript / Node.js]</small><br/>• Hook Relays & Normalization<br/>• SQLite Symbol & Ref Indexer<br/>• Structural Bash & Code Filters<br/>• Prompt Injection Fencing<br/>• MCP stdio Server"]:::tgRuntime
    end

    subgraph StorageBoundary ["Host Environment & Storage (Trust Boundary: Local User)"]
        LocalFS["📁 Workspace Filesystem<br/><small>Git Repo Source Trees & Fixtures</small>"]:::external
        AppDBs[("🗄️ Token-Goat Local Store<br/><small>global.db (WAL), Cache Blobs, Sessions</small>")]:::external
    end

    subgraph UntrustedZone ["Untrusted External Content (Trust Boundary: Untrusted Input)"]
        WebPages["🌐 External Web & APIs<br/><small>Arbitrary web pages, docs, issue trackers</small>"]:::untrusted
        ExternalFiles["📄 External Attachments<br/><small>PDFs, PPTX, Excel, Images, Archives</small>"]:::untrusted
    end

    Developer -->|Runs interactive commands| TGCore
    Developer -->|Prompts agent| ClaudeCode
    Developer -->|Prompts agent| VSCodeCopilot

    ClaudeCode -->|Fires lifecycle hooks via stdin/stdout| TGCore
    CodexHermes -->|Fires tool hooks| TGCore
    VSCodeCopilot -->|JSON-RPC over stdio| TGCore
    CopilotCLI -->|Executes surgical commands| TGCore

    TGCore -->|Reads/Indexes/Watches| LocalFS
    TGCore -->|Persists index & content-addressed blobs| AppDBs
    
    TGCore -->|Fetches requested URL/Doc| WebPages
    TGCore -->|Parses slices of| ExternalFiles
    TGCore -.->|Marks untrusted & sanitizes| ClaudeCode
```

Vector Asset: `demo/diagrams/c4_level1_system_context.svg`  
PlantUML Model: `demo/diagrams/c4_system_context.puml`

### Trust Boundaries & Threat Surfaces
1. **Harness Hook Boundary (Local IPC)**: Hook inputs arrive via standard I/O (JSON payloads over `stdin`). Token-Goat fails soft (`{ continue: true }`) on any parsing or processing error so agent operations never block.
2. **Untrusted Payload Boundary (Web/Documents)**: Web pages (`webfetch.ts`) and document attachments (`pdf_extract.ts`, `docx_extract.ts`) pass through `injection_scan.ts` heuristics. Detected adversarial instructions are marked untrusted and fenced before model exposure.
3. **Storage Boundary (Local User Isolation)**: All persistent databases and caches are stored in user-scoped directories (`%LOCALAPPDATA%\dfk-helper\token-goat` on Windows, `~/.token-goat` on POSIX) with no multi-tenant cross-talk.
4. **Child Process Execution Boundary**: Bash command compression wraps commands inside a controlled runner (`bash_runner.ts`) capturing output with stream bounds (32 MiB/stream cap) and preserves exit codes.

---

## 2. Container Diagram (C4 Level 2) & Storage Architecture

Token-Goat runs as a set of lightweight, ephemeral processes and an optional background worker daemon cooperating over SQLite and content-addressed disk files.

```mermaid
flowchart TB
    classDef process fill:#1E40AF,stroke:#172554,color:#ffffff,font-weight:bold;
    classDef shim fill:#2563EB,stroke:#1D4ED8,color:#ffffff;
    classDef storage fill:#0D9488,stroke:#115E59,color:#ffffff,font-weight:bold;
    classDef external fill:#64748B,stroke:#334155,color:#ffffff;

    subgraph AgentSpace ["Agent Execution Context"]
        Agent["AI Coding Harness (Claude Code / Codex)"]:::external
    end

    subgraph TGProcesses ["Token-Goat Runtime Containers"]
        HookShim["🪝 Hook Shim<br/><small>[~/.claude/hooks/token-goat-shim.js]</small><br/>In-process fast path / Subprocess launcher"]:::shim
        HookRelay["⚡ Hook Relay & Normalizer<br/><small>[dist/token-goat-hook.mjs]</small><br/>Normalizes Codex/Gemini/Claude schemas"]:::process
        CLIBinary["💻 CLI Tool & Command Suite<br/><small>[dist/token-goat.mjs]</small><br/>100+ surgical read, outline, pack commands"]:::process
        MCPServer["🔌 MCP stdio Server<br/><small>[token-goat mcp-serve]</small><br/>18 tools: symbol, read, retrieve, section"]:::process
        WorkerDaemon["🔄 Background Indexer Daemon<br/><small>[worker.ts / worker_daemon.ts]</small><br/>Polls dirty queue every 2s, reindexes changes"]:::process
    end

    subgraph DiskStorage ["Persistent Storage Model (%LOCALAPPDATA% or ~/.token-goat)"]
        GlobalDB[("🗄️ global.db (SQLite + WAL)<br/><small>• files, symbols, refs, chunks<br/>• symbols_fts (FTS5)<br/>• chunk_vectors (vec0 KNN)<br/>• stats</small>")]:::storage
        DirtyQueue[("📋 queue/dirty.txt<br/><small>Append-only list of edited file paths</small>")]:::storage
        SessionJSON[("📝 sessions/{session_id}.json<br/><small>Read/edit history, shown hints, cache indexes</small>")]:::storage
        BlobStore[("📦 Content Blob Store<br/><small>• bash_outputs/{id}.json<br/>• web_outputs/{id}.json<br/>• images/ & skills/</small>")]:::storage
    end

    Agent -->|Invokes hook| HookShim
    HookShim -->|Loads fast in-process| HookRelay
    HookRelay -->|Dispatches events to handlers| HookRelay
    
    Agent -->|Spawns tool CLI| CLIBinary
    Agent -->|Connects via stdio| MCPServer

    HookRelay -->|Appends edited file paths on PostToolUse(Edit)| DirtyQueue
    HookRelay -->|Loads & merges session state| SessionJSON
    HookRelay -->|Stores compressed output| BlobStore
    
    WorkerDaemon -->|Polls & drains| DirtyQueue
    WorkerDaemon -->|Writes updated symbols/chunks| GlobalDB
    
    CLIBinary -->|Queries symbols/sections| GlobalDB
    MCPServer -->|Queries index & retrieves blobs| GlobalDB
    MCPServer -->|Retrieves cached output by id| BlobStore
```

Vector Asset: `demo/diagrams/c4_level2_containers.svg`  
PlantUML Model: `demo/diagrams/c4_containers.puml`

### Storage Model & Concurrency Guarantees
- **`global.db`**: Unified SQLite database opened with `journal_mode=WAL`, `synchronous=NORMAL`, and `busy_timeout=15000ms`. Writes use explicit transactions (`writeParseResult`).
- **Body Bounding Invariant**: Symbol bodies in `symbols` are bounded at `MAX_SYMBOL_BODY_CHARS` at the single `writeParseResult` choke point. Over-cap bodies are stored as `''` and sliced dynamically from source on read (`resolveBody`), preventing database bloating while preserving full symbol bounds.
- **Merge-on-Save Session State**: `sessions/{session_id}.json` is updated via atomic read-modify-write (`saveSessionState`) with set-union for seen hints and newest-wins for command indexes.
- **Content Blob Lifecycle**: `bash_outputs/` and `web_outputs/` store content-addressed JSON objects keyed by SHA-256 / random ID, pruned automatically by age (24h TTL) and count cap (200 / 4096 files).

---

## 3. Component Architecture (C4 Level 3)

Vector Asset: `demo/diagrams/c4_level3_components.svg`

### A. Hook Intercept & Context Optimization Subsystem

```mermaid
flowchart TB
    classDef router fill:#1D4ED8,stroke:#1E3A8A,color:#ffffff,font-weight:bold;
    classDef hook fill:#2563EB,stroke:#1D4ED8,color:#ffffff;
    classDef filter fill:#0284C7,stroke:#0369A1,color:#ffffff;
    classDef sec fill:#DC2626,stroke:#991B1B,color:#ffffff,font-weight:bold;

    PayloadIn["Raw Hook Payload (stdin)"] --> Normalizer["Harness Normalizer<br/><small>(hooks_cli.ts::normalizePayload)</small>"]:::router
    Normalizer --> Dispatcher["Hook Registry Dispatcher<br/><small>(hook_registry.ts::runHook)</small>"]:::router

    subgraph LifecycleHandlers ["Hook Lifecycle Handlers"]
        PreRead["preReadHandler<br/><small>(hooks_read.ts)</small><br/>Diff-on-reread, surgical hints"]:::hook
        PreBash["preBashHandler<br/><small>(hooks_bash.ts)</small><br/>Command rewrite to 'token-goat compress'"]:::hook
        PreFetch["preFetchHandler<br/><small>(hooks_fetch.ts)</small><br/>Image shrink & URL dedup hint"]:::hook
        PostEdit["postEditHandler<br/><small>(hooks_edit.ts)</small><br/>Append to queue/dirty.txt"]:::hook
        PreCompact["preCompactHandler<br/><small>(hooks_compact.ts)</small><br/>Adaptive session manifest"]:::hook
        PreMCP["preMcpHandler<br/><small>(hooks_mcp.ts)</small><br/>Read-only MCP output dedup"]:::hook
    end

    subgraph FilterPipeline ["158 Bash & Code Output Filters (tool_filters/)"]
        TestRunners["Test Runners (Vitest, Jest, Pytest, GoTest)"]:::filter
        PackageMgrs["Package Managers (npm, pnpm, uv, pip, cargo)"]:::filter
        Linters["Linters & Typecheckers (tsc, ruff, mypy, eslint)"]:::filter
        GitCloud["VCS & Cloud (git diff, kubectl, terraform, gh)"]:::filter
        GenericCompress["GenericFilter (ANSI/progress strip + line cap)"]:::filter
    end

    subgraph SecurityControls ["Security & Trust Layer"]
        InjectionCheck["Prompt Injection Scanner<br/><small>(injection_scan.ts)</small>"]:::sec
        SecretRedact["Secret Redaction<br/><small>(secret_redact.ts)</small>"]:::sec
        OverflowGuard["Overflow Guard<br/><small>(overflow_guard.ts)</small>"]:::sec
    end

    Dispatcher --> PreRead
    Dispatcher --> PreBash
    Dispatcher --> PreFetch
    Dispatcher --> PostEdit
    Dispatcher --> PreCompact
    Dispatcher --> PreMCP

    PreBash --> FilterPipeline
    PreFetch --> InjectionCheck
    PreRead --> OverflowGuard
    PreBash --> SecretRedact

    PreRead --> Serializer["Hook Output Serializer<br/><small>(relay.ts::serializeOutput)</small>"]:::router
    PreBash --> Serializer
    PreCompact --> Serializer
```

### B. Indexer, Parser & Worker Subsystem

```mermaid
flowchart TB
    classDef parser fill:#059669,stroke:#047857,color:#ffffff,font-weight:bold;
    classDef worker fill:#0D9488,stroke:#115E59,color:#ffffff;
    classDef adapter fill:#10B981,stroke:#047857,color:#ffffff;
    classDef db fill:#0284C7,stroke:#0369A1,color:#ffffff;

    DirtyQueue["queue/dirty.txt"] --> WorkerLoop["Worker Loop (worker.ts)<br/><small>Polls every 2000ms</small>"]:::worker
    WorkerLoop --> Fingerprint["fingerprintFile()<br/><small>Fast SHA check skips unchanged</small>"]:::worker
    Fingerprint --> Parser["Parser Engine (parser.ts)<br/><small>detectLanguage() & parseContent()</small>"]:::parser

    subgraph ParserAdapters ["Parser Language Adapters"]
        TreeSitter["Inline Tree-Sitter Extractors<br/><small>TS, JS, Python, Go, Rust, Java, C/C++, Ruby</small>"]:::adapter
        RegexInline["Inline Regex Extractors<br/><small>Markdown, JSON, YAML, TOML, CSS, Dockerfile</small>"]:::adapter
        LangAdapters["src/languages/ Adapters (28 languages)<br/><small>C#, PHP, Kotlin, GraphQL, SQL, Proto, Apex, etc.</small>"]:::adapter
    end

    Parser --> TreeSitter
    Parser --> RegexInline
    Parser --> LangAdapters

    TreeSitter --> ChokePoint["writeParseResult Choke Point<br/><small>Single atomic transaction<br/>MAX_SYMBOL_BODY_CHARS bound</small>"]:::parser
    RegexInline --> ChokePoint
    LangAdapters --> ChokePoint

    ChokePoint --> GlobalDB[("global.db<br/><small>files, symbols, refs, chunks</small>")]:::db
    
    Parser -.-> Embedder["Embedding Pipeline (embeddings.ts)<br/><small>Xenova/bge-small-en-v1.5 (384d)</small>"]:::parser
    Embedder -.-> VecDB[("chunk_vectors (vec0 KNN)")]:::db
```

---

## 4. Dynamic Execution Flows & Lifecycle Scenarios (C4 Level 4)

Vector Asset: `demo/diagrams/c4_level4_dynamic_flow.svg`

### Scenario 1: Pre-Tool / Post-Tool Hook Execution Flow

```mermaid
sequenceDiagram
    autonumber
    participant Agent as AI Agent (Claude Code)
    participant Shim as token-goat-shim.js
    participant Relay as relay.ts / hook_registry.ts
    participant Filter as ToolFilter (tool_filters/)
    participant Store as session_store.ts & disk_cache.ts

    Agent->>Shim: Invokes PreToolUse (e.g. tool=Bash, cmd="npx vitest run")
    Shim->>Relay: In-process relayInProcess(payload)
    Relay->>Store: loadSessionState(sessionId)
    Relay->>Filter: Match command -> VitestFilter
    Filter-->>Relay: Rewrite to "token-goat compress -f vitest -c 'npx vitest run'"
    Relay-->>Agent: Return updatedInput with wrapped command
    
    Agent->>Agent: Executes wrapped command in subprocess
    Note over Agent: Subprocess applies VitestFilter, strips progress,<br/>collapses passing tests, captures stderr on failure
    
    Agent->>Shim: Invokes PostToolUse (tool=Bash, output=...)
    Shim->>Relay: relayInProcess(postPayload)
    Relay->>Store: storeBashOutput(id, rawOutput) & recordBashOutput(cmd, id)
    Relay->>Store: saveSessionState(sessionId) [Merge-on-save]
    Relay-->>Agent: Return { continue: true }
```

### Scenario 2: Surgical Read vs Full Read Resolution

```mermaid
sequenceDiagram
    autonumber
    participant Agent as AI Coding Agent
    participant CLI as token-goat read / MCP tool
    participant Resolver as paths.ts::resolveIndexPath
    participant Reader as index_reader.ts
    participant DB as global.db (SQLite)
    participant FS as Local Source File

    Agent->>CLI: Request "src/parser.ts::writeParseResult"
    CLI->>Resolver: resolveIndexPath("src/parser.ts")
    Resolver-->>CLI: "c:/projects/token-goat/src/parser.ts" (canonical key)
    CLI->>Reader: querySymbols(file="c:/...", name="writeParseResult")
    Reader->>DB: SELECT * FROM symbols WHERE file_path=? AND name=?
    DB-->>Reader: { line_start: 2420, line_end: 2473, body: "" (elided) }
    Reader->>FS: Slices lines 2420-2473 dynamically (resolveBody)
    FS-->>Reader: Exact function source code
    Reader-->>Agent: Returns 54 lines (vs 2,800 lines of parser.ts)
```

### Scenario 3: Untrusted Web/Document Ingestion & Injection Fencing

```mermaid
sequenceDiagram
    autonumber
    participant Agent as AI Agent
    participant WebFetch as hooks_fetch.ts / webfetch.ts
    participant Scanner as injection_scan.ts
    participant Redactor as secret_redact.ts
    participant Cache as web_outputs/{id}.json

    Agent->>WebFetch: Fetches external doc/URL
    WebFetch->>Scanner: scanForInjection(content)
    alt Injection Heuristics Triggered
        Scanner-->>WebFetch: Match: "Ignore previous instructions", "System Prompt Override", etc.
        WebFetch->>WebFetch: Wrap content in <untrusted_content> fence and inject safety caveat
    else Content Clean
        Scanner-->>WebFetch: Clean content
    end
    WebFetch->>Redactor: Redact sensitive tokens (Bearer, AWS keys, JWTs)
    Redactor->>Cache: Persist to content-addressed cache
    WebFetch-->>Agent: Returns safe, token-compressed extract
```

---

## 5. Security & Threat Model Summary Matrix

| Threat / Attack Surface | Risk | Token-Goat Architectural Mitigation |
|-------------------------|------|-------------------------------------|
| **Prompt Injection via Web/Docs** | Malicious instructions in external pages hijack the AI agent. | `injection_scan.ts` scans all ingested external content; wraps matches in explicit `<untrusted_content>` fences; enforces that documents are reference data, not directives. |
| **Path Traversal / UNC Attacks** | User-controlled paths escaping project directory via `..`, Windows drive letters, or NTFS streams. | `paths.ts::safeJoin()` unconditionally rejects components with colons (`:`); `normalizePath()` canonicalizes separators and drive letters; `resolveIndexPath()` strictly anchors keys. |
| **SQLite Lock Contention / DoS** | Concurrent hooks & background indexer stalling agent execution. | `db.ts` enforces `busy_timeout=15000ms`, `WAL` journal mode, and fast in-memory retry. Single write transactions prevent reader starvation. |
| **Index Database Bloat / Amplification** | Huge files or minified JSON inflating DB to gigabytes. | Choke point `writeParseResult` strictly caps symbol body at `MAX_SYMBOL_BODY_CHARS`; over-cap bodies are elided (`''`) and sliced from disk on demand. Amplification guard ensures stored bytes $\le 4\times$ source size. |
| **Secret Exfiltration in Cache** | API keys or tokens in command stdout persisted to disk. | `secret_redact.ts` sanitizes known credential patterns before storing to `bash_outputs/` and `web_outputs/`. Blobs have strict 24-hour TTL and user-only file permissions. |
| **Hook Subprocess Failure Impact** | Crash in Token-Goat blocking agent prompt workflow. | All hook handlers are wrapped in `failSoft()`. Any exception outputs to stderr and immediately emits `{ continue: true }` to allow unhindered agent execution. |
