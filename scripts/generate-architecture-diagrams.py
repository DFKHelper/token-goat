"""
Enterprise C4 Architecture Diagram Generator for Token-Goat
Generates production-grade SVGs and PlantUML (.puml) models for C4 Levels 1-4.
"""

import os
from pathlib import Path

DIAGRAMS_DIR = Path("demo/diagrams")
DIAGRAMS_DIR.mkdir(parents=True, exist_ok=True)

# -----------------------------------------------------------------------------
# 1. Level 1: System Context SVG
# -----------------------------------------------------------------------------
L1_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="100%" height="100%" style="background:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0f172a" flood-opacity="0.08"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569"/>
    </marker>
    <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#dc2626"/>
    </marker>
  </defs>

  <!-- Title & Legend Header -->
  <text x="40" y="45" font-size="24" font-weight="700" fill="#0f172a">Token-Goat System Context &amp; Trust Boundaries (C4 Level 1)</text>
  <text x="40" y="70" font-size="14" fill="#64748b">Describes runtime actors, AI coding harnesses, local boundaries, and untrusted input pipelines.</text>

  <!-- Top Actors -->
  <g transform="translate(480, 100)" filter="url(#shadow)">
    <rect width="240" height="90" rx="8" fill="#08427B" stroke="#073B6F" stroke-width="2"/>
    <text x="120" y="32" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle">👤 Software Developer</text>
    <text x="120" y="52" font-size="11" fill="#cbd5e1" text-anchor="middle">[Person / Local User]</text>
    <text x="120" y="72" font-size="11" fill="#e2e8f0" text-anchor="middle">Prompts agents &amp; runs tasks</text>
  </g>

  <!-- External AI Harnesses Box -->
  <g transform="translate(40, 240)" filter="url(#shadow)">
    <rect width="320" height="230" rx="8" fill="#faf5ff" stroke="#a855f7" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="16" y="28" font-size="13" font-weight="700" fill="#7e22ce">AI CODING HARNESSES [External Systems]</text>
    
    <!-- Claude Code -->
    <rect x="16" y="42" width="288" height="50" rx="6" fill="#7C3AED" stroke="#5B21B6"/>
    <text x="160" y="66" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">🤖 Claude Code (CLI)</text>
    <text x="160" y="82" font-size="10" fill="#e9d5ff" text-anchor="middle">Subprocess Lifecycle Hook Intercept</text>

    <!-- Copilot / Codex -->
    <rect x="16" y="102" width="288" height="50" rx="6" fill="#6D28D9" stroke="#4C1D95"/>
    <text x="160" y="126" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">🤖 VS Code Copilot &amp; Copilot CLI</text>
    <text x="160" y="142" font-size="10" fill="#e9d5ff" text-anchor="middle">stdio MCP Server &amp; Native Commands</text>

    <!-- Codex / OpenCode -->
    <rect x="16" y="162" width="288" height="50" rx="6" fill="#5B21B6" stroke="#3B0764"/>
    <text x="160" y="186" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">🤖 Codex / OpenCode / Hermes</text>
    <text x="160" y="202" font-size="10" fill="#e9d5ff" text-anchor="middle">Tool Bridges &amp; Payload Normalization</text>
  </g>

  <!-- Core System Boundary -->
  <g transform="translate(420, 240)" filter="url(#shadow)">
    <rect width="360" height="230" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
    <text x="16" y="28" font-size="13" font-weight="700" fill="#15803d">TOKEN-GOAT RUNTIME [Software System]</text>

    <rect x="20" y="45" width="320" height="165" rx="6" fill="#1168BD" stroke="#0B4884" stroke-width="2"/>
    <text x="180" y="78" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">⚡ Token-Goat Engine</text>
    <text x="180" y="98" font-size="12" fill="#bfdbfe" text-anchor="middle">[TypeScript / Node.js Engine]</text>
    
    <text x="40" y="130" font-size="11" fill="#ffffff">• Intercepts Pre/Post tool calls &amp; compresses output</text>
    <text x="40" y="150" font-size="11" fill="#ffffff">• SQLite AST symbols, refs &amp; semantic vector index</text>
    <text x="40" y="170" font-size="11" fill="#ffffff">• 158 deterministic filters for build/test/git</text>
    <text x="40" y="190" font-size="11" fill="#ffffff">• Prompt injection scanner &amp; untrusted content fence</text>
  </g>

  <!-- Untrusted Zone (Red Boundary) -->
  <g transform="translate(840, 240)" filter="url(#shadow)">
    <rect width="320" height="230" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="16" y="28" font-size="13" font-weight="700" fill="#b91c1c">UNTRUSTED ZONE [External Content]</text>

    <rect x="16" y="45" width="288" height="75" rx="6" fill="#ef4444" stroke="#b91c1c"/>
    <text x="160" y="72" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">🌐 Web Pages &amp; Remote APIs</text>
    <text x="160" y="90" font-size="11" fill="#fee2e2" text-anchor="middle">Arbitrary URLs, issues, docs, HTML</text>
    <text x="160" y="106" font-size="10" fill="#fecaca" text-anchor="middle">Threat: Indirect Prompt Injection</text>

    <rect x="16" y="135" width="288" height="75" rx="6" fill="#dc2626" stroke="#991b1b"/>
    <text x="160" y="162" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">📄 Documents &amp; Attachments</text>
    <text x="160" y="180" font-size="11" fill="#fee2e2" text-anchor="middle">PDF, PPTX, Excel, Word, Zip, SQLite</text>
    <text x="160" y="196" font-size="10" fill="#fecaca" text-anchor="middle">Threat: Oversized payload / malicious macros</text>
  </g>

  <!-- Local Storage & Workspace (Bottom) -->
  <g transform="translate(240, 530)" filter="url(#shadow)">
    <rect width="720" height="190" rx="8" fill="#f8fafc" stroke="#475569" stroke-width="2"/>
    <text x="20" y="28" font-size="13" font-weight="700" fill="#334155">LOCAL HOST &amp; PERSISTENT STORAGE [Trust Boundary: Local User]</text>

    <!-- Workspace Filesystem -->
    <rect x="20" y="45" width="325" height="125" rx="6" fill="#334155" stroke="#1e293b"/>
    <text x="182" y="75" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">📁 Local Workspace FS</text>
    <text x="182" y="95" font-size="11" fill="#94a3b8" text-anchor="middle">Git repositories, tracked files &amp; code</text>
    <text x="40" y="125" font-size="11" fill="#cbd5e1">• Read/written by developer &amp; agent</text>
    <text x="40" y="145" font-size="11" fill="#cbd5e1">• Sliced by Token-Goat surgical readers</text>

    <!-- SQLite & Cache -->
    <rect x="375" y="45" width="325" height="125" rx="6" fill="#0f766e" stroke="#115e59"/>
    <text x="537" y="75" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">🗄️ %LOCALAPPDATA% / ~/.token-goat</text>
    <text x="537" y="95" font-size="11" fill="#99f6e4" text-anchor="middle">Private, user-isolated storage</text>
    <text x="395" y="125" font-size="11" fill="#ccfbf1">• global.db (SQLite WAL + symbols/chunks)</text>
    <text x="395" y="145" font-size="11" fill="#ccfbf1">• Content-addressed bash &amp; web caches (24h)</text>
  </g>

  <!-- Relationship Arrows -->
  <path d="M 520 190 L 260 240" fill="none" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>
  <path d="M 600 190 L 600 240" fill="none" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>

  <!-- Harness <-> TG Core -->
  <path d="M 360 355 L 420 355" fill="none" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="390" y="345" font-size="10" font-weight="600" fill="#475569" text-anchor="middle">IPC</text>

  <!-- TG Core <-> Untrusted -->
  <path d="M 780 330 L 840 330" fill="none" stroke="#dc2626" stroke-width="2" marker-end="url(#arrow-red)"/>
  <path d="M 840 380 L 780 380" fill="none" stroke="#16a34a" stroke-width="2" stroke-dasharray="4 2" marker-end="url(#arrow)"/>
  <text x="810" y="322" font-size="10" font-weight="600" fill="#dc2626" text-anchor="middle">Fetch</text>
  <text x="810" y="398" font-size="10" font-weight="600" fill="#16a34a" text-anchor="middle">Fenced</text>

  <!-- TG Core -> Storage -->
  <path d="M 520 470 L 400 530" fill="none" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>
  <path d="M 680 470 L 680 530" fill="none" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>
</svg>
"""

# -----------------------------------------------------------------------------
# 2. Level 2: Container Diagram SVG
# -----------------------------------------------------------------------------
L2_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 850" width="100%" height="100%" style="background:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0f172a" flood-opacity="0.08"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569"/>
    </marker>
  </defs>

  <text x="40" y="45" font-size="24" font-weight="700" fill="#0f172a">Token-Goat Container &amp; Storage Architecture (C4 Level 2)</text>
  <text x="40" y="70" font-size="14" fill="#64748b">Shows process executables, shims, background indexer daemon, and the persistent SQLite/file storage layout.</text>

  <!-- Outer Subsystem Box -->
  <g transform="translate(30, 100)" filter="url(#shadow)">
    <rect width="1140" height="700" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>
    <text x="24" y="32" font-size="14" font-weight="700" fill="#334155">TOKEN-GOAT RUNTIME ECOSYSTEM</text>

    <!-- Top Processes Tier -->
    <g transform="translate(30, 50)">
      <!-- Hook Shim -->
      <g transform="translate(0, 0)">
        <rect width="240" height="130" rx="8" fill="#2563EB" stroke="#1D4ED8"/>
        <text x="120" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">🪝 token-goat-shim.js</text>
        <text x="120" y="48" font-size="10" fill="#bfdbfe" text-anchor="middle">[Node.js In-Process Fast Path]</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• ~/.claude/hooks/ entry point</text>
        <text x="15" y="93" font-size="10" fill="#ffffff">• In-process relay via dynamic import</text>
        <text x="15" y="111" font-size="10" fill="#ffffff">• Zero second-subprocess overhead</text>
      </g>

      <!-- Hook Relay Process -->
      <g transform="translate(280, 0)">
        <rect width="260" height="130" rx="8" fill="#1D4ED8" stroke="#1E40AF"/>
        <text x="130" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">⚡ token-goat-hook.mjs</text>
        <text x="130" y="48" font-size="10" fill="#bfdbfe" text-anchor="middle">[Hook Relay &amp; Split Chunks]</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• Payload normalization (Codex/Gemini)</text>
        <text x="15" y="93" font-size="10" fill="#ffffff">• Pre/Post event routing &amp; compression</text>
        <text x="15" y="111" font-size="10" fill="#ffffff">• Fail-soft { continue: true } wrapper</text>
      </g>

      <!-- CLI Executable -->
      <g transform="translate(580, 0)">
        <rect width="240" height="130" rx="8" fill="#0284C7" stroke="#0369A1"/>
        <text x="120" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">💻 token-goat.mjs (CLI)</text>
        <text x="120" y="48" font-size="10" fill="#bae6fd" text-anchor="middle">[Commander CLI Entry]</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• 100+ surgical read subcommands</text>
        <text x="15" y="93" font-size="10" fill="#ffffff">• Index, doctor, budget, pack tools</text>
        <text x="15" y="111" font-size="10" fill="#ffffff">• Synchronous drain &amp; query paths</text>
      </g>

      <!-- MCP Stdio Server -->
      <g transform="translate(860, 0)">
        <rect width="220" height="130" rx="8" fill="#7C3AED" stroke="#5B21B6"/>
        <text x="110" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">🔌 token-goat mcp-serve</text>
        <text x="110" y="48" font-size="10" fill="#e9d5ff" text-anchor="middle">[stdio MCP Server]</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• 18 read-only surgical tools</text>
        <text x="15" y="93" font-size="10" fill="#ffffff">• Native VS Code Copilot bridge</text>
        <text x="15" y="111" font-size="10" fill="#ffffff">• Direct cache &amp; index access</text>
      </g>
    </g>

    <!-- Background Worker Tier -->
    <g transform="translate(30, 230)">
      <rect width="1080" height="90" rx="8" fill="#047857" stroke="#065f46"/>
      <text x="20" y="35" font-size="16" font-weight="700" fill="#ffffff">🔄 Background Worker Daemon (worker.ts / worker_daemon.ts)</text>
      <text x="20" y="55" font-size="11" fill="#a7f3d0">Node.js detached process or Worker Thread • Polls queue/dirty.txt every 2000ms • Reindexes changed files incrementally</text>
      <text x="20" y="73" font-size="11" fill="#d1fae5">Invariant: Single choke point writeParseResult with MAX_SYMBOL_BODY_CHARS body bound and automatic orphan project GC.</text>
    </g>

    <!-- Persistent Storage Architecture (Bottom Tier) -->
    <g transform="translate(30, 360)">
      <rect width="1080" height="290" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
      <text x="20" y="30" font-size="14" font-weight="700" fill="#0f172a">PERSISTENT STORAGE LAYOUT (%LOCALAPPDATA%\\dfk-helper\\token-goat or ~/.token-goat)</text>

      <!-- Global DB -->
      <g transform="translate(20, 50)">
        <rect width="320" height="210" rx="6" fill="#0f766e" stroke="#115e59"/>
        <text x="160" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">🗄️ global.db (SQLite WAL)</text>
        <text x="160" y="48" font-size="10" fill="#99f6e4" text-anchor="middle">busy_timeout=15000ms • WAL Journal</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• files (path, sha, mtime, language)</text>
        <text x="15" y="95" font-size="10" fill="#ffffff">• symbols (name, kind, lines, bounded body)</text>
        <text x="15" y="115" font-size="10" fill="#ffffff">• refs (call sites with enclosing context)</text>
        <text x="15" y="135" font-size="10" fill="#ffffff">• chunks &amp; chunk_vectors (384d KNN)</text>
        <text x="15" y="155" font-size="10" fill="#ffffff">• symbols_fts (FTS5 text search)</text>
        <text x="15" y="175" font-size="10" fill="#ffffff">• stats (cumulative token savings)</text>
        <text x="15" y="195" font-size="10" fill="#ffffff">• known_roots (project sweep &amp; orphan GC)</text>
      </g>

      <!-- Session State -->
      <g transform="translate(370, 50)">
        <rect width="320" height="210" rx="6" fill="#0369a1" stroke="#075985"/>
        <text x="160" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">📝 sessions/{session_id}.json</text>
        <text x="160" y="48" font-size="10" fill="#bae6fd" text-anchor="middle">Merge-On-Save Atomic JSON</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• File read/edit access histories</text>
        <text x="15" y="95" font-size="10" fill="#ffffff">• Shown hint deduplication sets</text>
        <text x="15" y="115" font-size="10" fill="#ffffff">• Web &amp; Bash output cache index</text>
        <text x="15" y="135" font-size="10" fill="#ffffff">• Cap: 500 files (oldest-first LRU)</text>
        <text x="15" y="155" font-size="10" fill="#ffffff">• PreCompact manifest synthesis</text>
        <text x="15" y="175" font-size="10" fill="#ffffff">• Cross-process lock safety</text>
      </g>

      <!-- Content Blobs & Dirty Queue -->
      <g transform="translate(720, 50)">
        <rect width="340" height="210" rx="6" fill="#334155" stroke="#1e293b"/>
        <text x="170" y="30" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">📦 Disk Blobs &amp; Dirty Queue</text>
        <text x="170" y="48" font-size="10" fill="#cbd5e1" text-anchor="middle">Content-Addressed Cache Files</text>
        <text x="15" y="75" font-size="10" fill="#ffffff">• queue/dirty.txt (append-only sync)</text>
        <text x="15" y="95" font-size="10" fill="#ffffff">• bash_outputs/{id}.json (stdout/err, 24h)</text>
        <text x="15" y="115" font-size="10" fill="#ffffff">• web_outputs/{id}.json (web bodies, 24h)</text>
        <text x="15" y="135" font-size="10" fill="#ffffff">• images/ (shrunk webp/avif artifacts)</text>
        <text x="15" y="155" font-size="10" fill="#ffffff">• skills/ (body &amp; compact slices)</text>
        <text x="15" y="175" font-size="10" fill="#ffffff">• projects/{hash}_memory.toml (project mem)</text>
      </g>
    </g>
  </g>
</svg>
"""

# -----------------------------------------------------------------------------
# 3. Level 3: Component Diagram SVG
# -----------------------------------------------------------------------------
L3_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 850" width="100%" height="100%" style="background:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0f172a" flood-opacity="0.08"/>
    </filter>
  </defs>

  <text x="40" y="45" font-size="24" font-weight="700" fill="#0f172a">Token-Goat Component Architecture (C4 Level 3)</text>
  <text x="40" y="70" font-size="14" fill="#64748b">Internal pipeline structure for Hook Processing, 158 Bash Filters, and Parser / Indexing Engine.</text>

  <!-- Left: Hook Processing Pipeline -->
  <g transform="translate(30, 100)" filter="url(#shadow)">
    <rect width="560" height="710" rx="10" fill="#ffffff" stroke="#2563eb" stroke-width="2"/>
    <text x="20" y="32" font-size="15" font-weight="700" fill="#1e40af">HOOK PROCESSING &amp; OPTIMIZATION PIPELINE</text>

    <!-- Normalizer -->
    <rect x="20" y="55" width="520" height="60" rx="6" fill="#1e40af"/>
    <text x="280" y="80" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">Harness Normalizer (hooks_cli.ts::normalizePayload)</text>
    <text x="280" y="98" font-size="10" fill="#93c5fd" text-anchor="middle">Maps Codex 'shell' -> 'Bash', Gemini 'read_file' -> 'Read', etc.</text>

    <!-- Handlers Grid -->
    <g transform="translate(20, 130)">
      <rect x="0" y="0" width="250" height="70" rx="6" fill="#2563eb"/>
      <text x="125" y="26" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">preReadHandler</text>
      <text x="125" y="44" font-size="9.5" fill="#dbeafe" text-anchor="middle">Large-file gate &amp; diff-on-reread</text>
      <text x="125" y="58" font-size="9" fill="#bfdbfe" text-anchor="middle">Suggests token-goat read/section</text>

      <rect x="270" y="0" width="250" height="70" rx="6" fill="#2563eb"/>
      <text x="395" y="26" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">preBashHandler</text>
      <text x="395" y="44" font-size="9.5" fill="#dbeafe" text-anchor="middle">Rewrites command to 'compress'</text>
      <text x="395" y="58" font-size="9" fill="#bfdbfe" text-anchor="middle">Recalls prior run if cached</text>

      <rect x="0" y="80" width="250" height="70" rx="6" fill="#2563eb"/>
      <text x="125" y="106" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">preFetchHandler</text>
      <text x="125" y="124" font-size="9.5" fill="#dbeafe" text-anchor="middle">Image shrink (WebP/AVIF)</text>
      <text x="125" y="138" font-size="9" fill="#bfdbfe" text-anchor="middle">Prompt injection scan &amp; fence</text>

      <rect x="270" y="80" width="250" height="70" rx="6" fill="#2563eb"/>
      <text x="395" y="106" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">preCompactHandler</text>
      <text x="395" y="124" font-size="9.5" fill="#dbeafe" text-anchor="middle">Adaptive token manifest</text>
      <text x="395" y="138" font-size="9" fill="#bfdbfe" text-anchor="middle">Preserves edited files &amp; skills</text>
    </g>

    <!-- 158 Bash Filters Box -->
    <g transform="translate(20, 300)">
      <rect width="520" height="270" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
      <text x="16" y="26" font-size="13" font-weight="700" fill="#15803d">158 Bash Output Tool Filters (src/tool_filters/)</text>

      <rect x="16" y="38" width="488" height="42" rx="4" fill="#15803d"/>
      <text x="260" y="56" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">Test Runners (Batch A)</text>
      <text x="260" y="70" font-size="9" fill="#bbf7d0" text-anchor="middle">Vitest, Jest, Mocha, Pytest, GoTest (data race &amp; stack frame preservation)</text>

      <rect x="16" y="86" width="488" height="42" rx="4" fill="#15803d"/>
      <text x="260" y="104" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">Package Managers &amp; Linters (Batches B &amp; C)</text>
      <text x="260" y="118" font-size="9" fill="#bbf7d0" text-anchor="middle">npm, pnpm, uv, pip, cargo, tsc, ruff, mypy, eslint, oxlint, biome, swiftlint</text>

      <rect x="16" y="134" width="488" height="42" rx="4" fill="#15803d"/>
      <text x="260" y="152" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">VCS, Build &amp; Cloud (Batches D, E, F, G)</text>
      <text x="260" y="166" font-size="9" fill="#bbf7d0" text-anchor="middle">git log/diff/status/blame, make, cmake, gradle, docker, kubectl, terraform, aws</text>

      <rect x="16" y="182" width="488" height="42" rx="4" fill="#15803d"/>
      <text x="260" y="200" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">CI, Shell Utilities &amp; DB Clients (Batches H, J, K1, K2)</text>
      <text x="260" y="214" font-size="9" fill="#bbf7d0" text-anchor="middle">gh run/api, rg, tree, jq, psql, mysql, sqlite3, redis-cli, python, node</text>

      <rect x="16" y="230" width="488" height="30" rx="4" fill="#047857"/>
      <text x="260" y="250" font-size="10" font-weight="600" fill="#ffffff" text-anchor="middle">GenericFilter (ANSI &amp; progress strip + consecutive dedupe fallback)</text>
    </g>

    <!-- Security Guards -->
    <g transform="translate(20, 590)">
      <rect width="520" height="95" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
      <text x="16" y="24" font-size="12" font-weight="700" fill="#b91c1c">Security &amp; Integrity Controls</text>
      <text x="16" y="44" font-size="10" fill="#7f1d1d">• injection_scan.ts: Heuristic scanner marks adversarial prompts untrusted</text>
      <text x="16" y="62" font-size="10" fill="#7f1d1d">• secret_redact.ts: Bearer, AWS &amp; JWT redaction before cache persistence</text>
      <text x="16" y="80" font-size="10" fill="#7f1d1d">• paths.ts: safeJoin colon rejection blocks Windows drive-letter traversal</text>
    </g>
  </g>

  <!-- Right: Indexer, Parser & Query Subsystem -->
  <g transform="translate(610, 100)" filter="url(#shadow)">
    <rect width="560" height="710" rx="10" fill="#ffffff" stroke="#059669" stroke-width="2"/>
    <text x="20" y="32" font-size="15" font-weight="700" fill="#047857">INDEXER, PARSER &amp; QUERY SUBSYSTEM</text>

    <!-- Worker & Dirty Queue -->
    <rect x="20" y="55" width="520" height="70" rx="6" fill="#047857"/>
    <text x="280" y="82" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">Worker Loop &amp; Drainer (worker.ts)</text>
    <text x="280" y="102" font-size="10" fill="#a7f3d0" text-anchor="middle">Consumes queue/dirty.txt • SHA fingerprint check • Periodic dead-root GC</text>

    <!-- Parser Orchestrator -->
    <rect x="20" y="140" width="520" height="60" rx="6" fill="#059669"/>
    <text x="280" y="165" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">Parser Orchestrator (parser.ts)</text>
    <text x="280" y="183" font-size="10" fill="#d1fae5" text-anchor="middle">detectLanguage() • Routes to Tree-Sitter or Regex Extractors</text>

    <!-- Language Adapters -->
    <g transform="translate(20, 215)">
      <rect width="520" height="150" rx="6" fill="#ecfdf5" stroke="#10b981"/>
      <text x="16" y="24" font-size="12" font-weight="700" fill="#065f46">Parser Language Adapters (28 languages + formats)</text>

      <rect x="16" y="38" width="488" height="45" rx="4" fill="#10b981"/>
      <text x="260" y="58" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">Tree-Sitter Inline Extractors</text>
      <text x="260" y="73" font-size="9" fill="#064e3b" text-anchor="middle">TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C, C++</text>

      <rect x="16" y="93" width="488" height="45" rx="4" fill="#059669"/>
      <text x="260" y="113" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">src/languages/ Regex &amp; Pattern Adapters</text>
      <text x="260" y="128" font-size="9" fill="#d1fae5" text-anchor="middle">C#, PHP, Kotlin, GraphQL, SQL, HTML, Liquid, Proto, Apex, Markdown, JSON</text>
    </g>

    <!-- Choke Point -->
    <g transform="translate(20, 380)">
      <rect width="520" height="110" rx="6" fill="#0284c7" stroke="#0369a1" stroke-width="2"/>
      <text x="260" y="30" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">🛡️ Single Choke Point: writeParseResult (parser.ts)</text>
      <text x="20" y="55" font-size="10.5" fill="#e0f2fe">• Enforces single atomic transaction across files, symbols, and refs</text>
      <text x="20" y="73" font-size="10.5" fill="#e0f2fe">• Invariant: Bounds body at MAX_SYMBOL_BODY_CHARS; elides over-cap</text>
      <text x="20" y="91" font-size="10.5" fill="#e0f2fe">• Amplification Guard: Guarantees index bytes &lt;= 4x source file size</text>
    </g>

    <!-- Surgical & Non-Code Readers -->
    <g transform="translate(20, 505)">
      <rect width="520" height="180" rx="6" fill="#f8fafc" stroke="#64748b" stroke-width="1.5"/>
      <text x="16" y="25" font-size="13" font-weight="700" fill="#1e293b">Surgical Query &amp; Non-Code Readers (read_commands.ts)</text>

      <text x="20" y="52" font-size="11" fill="#334155"><tspan font-weight="700">Code Precision:</tspan> symbol, read, section, skeleton, outline, refs, diff, blame</text>
      <text x="20" y="74" font-size="11" fill="#334155"><tspan font-weight="700">Documents:</tspan> pdf-extract, pdf-outline, pptx-slide, docx-text, xlsx-query</text>
      <text x="20" y="96" font-size="11" fill="#334155"><tspan font-weight="700">Structured Data:</tspan> json-query, yaml-query, csv-query, sqlite-query, openapi-op</text>
      <text x="20" y="118" font-size="11" fill="#334155"><tspan font-weight="700">Semantic Discovery:</tspan> semantic (Xenova/bge-small-en-v1.5 + vec0 KNN)</text>
      <text x="20" y="140" font-size="11" fill="#334155"><tspan font-weight="700">Session Memory:</tspan> note-add, memory, recall, compact-hint, session-summary</text>
      <text x="20" y="162" font-size="11" fill="#334155"><tspan font-weight="700">Integrity:</tspan> All paths normalized via resolveIndexPath() (byte-identical key match)</text>
    </g>
  </g>
</svg>
"""

# -----------------------------------------------------------------------------
# 4. Level 4: Dynamic Flow SVG
# -----------------------------------------------------------------------------
L4_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="100%" height="100%" style="background:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb"/>
    </marker>
  </defs>

  <text x="40" y="45" font-size="22" font-weight="700" fill="#0f172a">Token-Goat Dynamic Hook &amp; Storage Lifecycle (C4 Level 4)</text>
  <text x="40" y="70" font-size="13" fill="#64748b">End-to-end trace of PreToolUse command rewriting, subprocess execution, output compression &amp; dirty-queue sync.</text>

  <!-- Lifeline Headers -->
  <g transform="translate(60, 100)">
    <rect x="0" y="0" width="160" height="40" rx="6" fill="#7C3AED"/>
    <text x="80" y="25" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">AI Agent (Claude)</text>
    <line x1="80" y1="40" x2="80" y2="650" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="4 4"/>
  </g>

  <g transform="translate(280, 100)">
    <rect x="0" y="0" width="180" height="40" rx="6" fill="#2563EB"/>
    <text x="90" y="25" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">token-goat-shim.js</text>
    <line x1="90" y1="40" x2="90" y2="650" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="4 4"/>
  </g>

  <g transform="translate(520, 100)">
    <rect x="0" y="0" width="180" height="40" rx="6" fill="#1D4ED8"/>
    <text x="90" y="25" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">relay.ts &amp; ToolFilter</text>
    <line x1="90" y1="40" x2="90" y2="650" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="4 4"/>
  </g>

  <g transform="translate(760, 100)">
    <rect x="0" y="0" width="180" height="40" rx="6" fill="#0D9488"/>
    <text x="90" y="25" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">bash_runner.ts</text>
    <line x1="90" y1="40" x2="90" y2="650" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="4 4"/>
  </g>

  <g transform="translate(980, 100)">
    <rect x="0" y="0" width="160" height="40" rx="6" fill="#047857"/>
    <text x="80" y="25" font-size="12" font-weight="700" fill="#ffffff" text-anchor="middle">Worker &amp; DB Store</text>
    <line x1="80" y1="40" x2="80" y2="650" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="4 4"/>
  </g>

  <!-- Sequence Messages -->
  <!-- 1. PreToolUse Trigger -->
  <g transform="translate(0, 170)">
    <line x1="140" y1="0" x2="360" y2="0" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="250" y="-8" font-size="11" font-weight="600" fill="#1e40af" text-anchor="middle">1. PreToolUse(tool=Bash, cmd="npx vitest run")</text>
  </g>

  <!-- 2. Relay In-Process -->
  <g transform="translate(0, 210)">
    <line x1="370" y1="0" x2="600" y2="0" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="490" y="-8" font-size="11" font-weight="600" fill="#1e40af" text-anchor="middle">2. relayInProcess(payload)</text>
  </g>

  <!-- 3. ToolFilter Rewrite -->
  <g transform="translate(0, 250)">
    <rect x="540" y="-15" width="220" height="30" rx="4" fill="#eff6ff" stroke="#3b82f6"/>
    <text x="650" y="5" font-size="10" font-weight="600" fill="#1d4ed8" text-anchor="middle">Select VitestFilter &amp; rewrite input</text>
  </g>

  <!-- 4. Return Rewritten Command -->
  <g transform="translate(0, 295)">
    <line x1="600" y1="0" x2="150" y2="0" stroke="#2563eb" stroke-width="2" stroke-dasharray="4 2" marker-end="url(#arrow)"/>
    <text x="375" y="-8" font-size="11" font-weight="600" fill="#1e40af" text-anchor="middle">3. Return updatedInput: "token-goat compress -f vitest -c 'npx vitest run'"</text>
  </g>

  <!-- 5. Subprocess Execution -->
  <g transform="translate(0, 350)">
    <line x1="140" y1="0" x2="840" y2="0" stroke="#0d9488" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="490" y="-8" font-size="11" font-weight="600" fill="#0f766e" text-anchor="middle">4. Spawns wrapped command in child process</text>
  </g>

  <!-- 6. Stream Compression -->
  <g transform="translate(0, 395)">
    <rect x="760" y="-15" width="240" height="40" rx="4" fill="#f0fdfa" stroke="#0d9488"/>
    <text x="880" y="3" font-size="10" font-weight="600" fill="#0f766e" text-anchor="middle">Captures stdout/stderr (32MB cap)</text>
    <text x="880" y="18" font-size="9" fill="#115e59" text-anchor="middle">Collapses passing tests, extracts failures</text>
  </g>

  <!-- 7. Compressed Output to Model -->
  <g transform="translate(0, 455)">
    <line x1="840" y1="0" x2="150" y2="0" stroke="#0d9488" stroke-width="2" stroke-dasharray="4 2" marker-end="url(#arrow)"/>
    <text x="495" y="-8" font-size="11" font-weight="600" fill="#0f766e" text-anchor="middle">5. Returns clean compressed test summary to model window</text>
  </g>

  <!-- 8. PostToolUse Cache -->
  <g transform="translate(0, 515)">
    <line x1="140" y1="0" x2="600" y2="0" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="370" y="-8" font-size="11" font-weight="600" fill="#1e40af" text-anchor="middle">6. PostToolUse(tool=Bash, output=...)</text>
  </g>

  <!-- 9. Save Cache Blob & Merge Session -->
  <g transform="translate(0, 560)">
    <line x1="610" y1="0" x2="1050" y2="0" stroke="#047857" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="830" y="-8" font-size="11" font-weight="600" fill="#065f46" text-anchor="middle">7. storeBlob(bash_outputs/{id}.json) &amp; saveSessionState()</text>
  </g>

  <!-- 10. Background Worker Sync -->
  <g transform="translate(0, 610)">
    <rect x="960" y="-15" width="200" height="35" rx="4" fill="#f0fdf4" stroke="#047857"/>
    <text x="1060" y="3" font-size="10" font-weight="600" fill="#065f46" text-anchor="middle">Worker polls dirty.txt (2s)</text>
    <text x="1060" y="17" font-size="9" fill="#047857" text-anchor="middle">Reindexes touched files to global.db</text>
  </g>
</svg>
"""

# -----------------------------------------------------------------------------
# 5. PlantUML C4 Models
# -----------------------------------------------------------------------------
PUML_L1 = """@startuml C4_System_Context
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Context.puml

LAYOUT_WITH_LEGEND()

title System Context Diagram for Token-Goat (C4 Level 1)

Person(developer, "Software Developer", "Uses AI coding harnesses and inspects deterministic output.")

System_Boundary(harness_boundary, "AI Coding Assistants") {
    System_Ext(claude, "Claude Code", "Agent harness executing tools via subprocess hooks.")
    System_Ext(copilot, "VS Code Copilot / Copilot CLI", "Agent harness using stdio MCP server & CLI tools.")
    System_Ext(codex, "Codex / OpenCode / Hermes", "Agent harness communicating via tool bridges.")
}

System(token_goat, "Token-Goat", "Local context optimization engine, SQLite AST/vector indexer, and hook relay.")

System_Ext(workspace, "Local Workspace FS", "Git-tracked repositories, source files, and test fixtures.")
System_Ext(untrusted, "Untrusted External Content", "Web pages, external docs, PDFs, PPTX with potential prompt injection.")

Rel(developer, claude, "Prompts and instructs", "UI/CLI")
Rel(developer, copilot, "Prompts and instructs", "UI/CLI")
Rel(developer, token_goat, "Executes surgical commands", "CLI")

Rel(claude, token_goat, "Fires Pre/Post lifecycle hooks", "JSON over stdin/stdout")
Rel(copilot, token_goat, "Calls surgical tools", "JSON-RPC stdio MCP")
Rel(codex, token_goat, "Dispatches tool events", "Bridge shims")

Rel(token_goat, workspace, "Reads, indexes, and monitors", "File I/O")
Rel(token_goat, untrusted, "Fetches, sanitizes, and fences", "HTTP/Doc extract")
@enduml
"""

PUML_L2 = """@startuml C4_Containers
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml

LAYOUT_WITH_LEGEND()

title Container Diagram for Token-Goat (C4 Level 2)

Person(user, "Developer / Agent Harness")

System_Boundary(tg_boundary, "Token-Goat System") {
    Container(shim, "Hook Shim", "JavaScript (~/.claude/hooks/token-goat-shim.js)", "Provides in-process fast path relay for Claude Code hooks.")
    Container(relay, "Hook Relay & Dispatcher", "TypeScript (dist/token-goat-hook.mjs)", "Normalizes multi-harness payloads and runs 158 compression filters.")
    Container(cli, "CLI Application", "TypeScript (dist/token-goat.mjs)", "Exposes 100+ surgical read, outline, pack, and doctor commands.")
    Container(mcp, "MCP stdio Server", "TypeScript (token-goat mcp-serve)", "Serves 18 tools to VS Code Copilot over stdio.")
    Container(worker, "Background Worker Daemon", "TypeScript (worker.ts)", "Consumes dirty queue every 2000ms and reindexes changed files.")

    ContainerDb(global_db, "Global Index Database", "SQLite (global.db)", "Holds files, symbols, refs, chunks, symbols_fts, and chunk_vectors.")
    ContainerDb(sessions, "Session State Store", "Atomic JSON (sessions/{id}.json)", "Maintains per-session read/edit histories and hint deduplication.")
    ContainerDb(blobs, "Content Blob Cache", "File Store (bash_outputs/, web_outputs/)", "Stores raw tool outputs for 24h with content-addressed IDs.")
    ContainerDb(dirty_queue, "Dirty Queue", "Append-only text (queue/dirty.txt)", "Synchronizes file edits between hooks and the worker daemon.")
}

Rel(user, shim, "Invokes hook", "CLI/stdio")
Rel(shim, relay, "Executes in-process", "dynamic import")
Rel(user, cli, "Runs command", "Shell")
Rel(user, mcp, "Calls tool", "stdio JSON-RPC")

Rel(relay, dirty_queue, "Appends touched path on Edit", "File append")
Rel(relay, sessions, "Loads and merges session state", "Atomic read/write")
Rel(relay, blobs, "Persists output bodies", "File I/O")

Rel(worker, dirty_queue, "Polls & drains", "File read/truncate")
Rel(worker, global_db, "Writes parsed symbols & vectors", "SQLite WAL transaction")

Rel(cli, global_db, "Queries symbols & headings", "SQLite read")
Rel(mcp, global_db, "Queries index", "SQLite read")
Rel(mcp, blobs, "Retrieves cached text", "File read")
@enduml
"""

def main():
    (DIAGRAMS_DIR / "c4_level1_system_context.svg").write_text(L1_SVG, encoding="utf-8")
    (DIAGRAMS_DIR / "c4_level2_containers.svg").write_text(L2_SVG, encoding="utf-8")
    (DIAGRAMS_DIR / "c4_level3_components.svg").write_text(L3_SVG, encoding="utf-8")
    (DIAGRAMS_DIR / "c4_level4_dynamic_flow.svg").write_text(L4_SVG, encoding="utf-8")

    (DIAGRAMS_DIR / "c4_system_context.puml").write_text(PUML_L1, encoding="utf-8")
    (DIAGRAMS_DIR / "c4_containers.puml").write_text(PUML_L2, encoding="utf-8")

    print("Generated 4 SVG diagrams and 2 PlantUML files in docs/diagrams/")

if __name__ == "__main__":
    main()
