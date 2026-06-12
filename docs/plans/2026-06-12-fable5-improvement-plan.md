# Fable 5 Context-Reduction Improvement Plan

**Date:** 2026-06-12  
**Source:** Fable 5 analysis of session ee9fd706 (dfkh-games, 807 Bash + 229 Read calls)  
**Key gaps found:** cat/head/tail bypassing hooks, 35-50 repeated MCP calls, git diff repeats

---

## Items (ordered easy → hard)

### 1. `cat`/`bat` file-read redirect [S]
Bash pre-hook detects `cat`/`bat`/`cat -n` on indexed source file → inject hint or deny + inline skeleton at warm+.  
Files: `bash_detect.py`, `hints.py`  
Savings: 2–8k tokens per intercepted full-file cat

### 2. `head`/`tail` slice serve-through [S]
Detect `head -N file`/`tail -n N file` → serve slice from disk, mark file touched in session cache.  
Files: `bash_detect.py`, `hooks_read.py` (bash branch)  
Savings: Closes session-cache blind spot for shell-read files

### 3. `git diff HEAD` repeat dedup [S]
Cache git diff/status output keyed by command + HEAD SHA + dirty mtime fingerprint; deny identical re-runs.  
Files: `bash_cache.py`, `bash_detect.py`  
Savings: 1–5k per repeated diff

### 4. `git log`/`git show` immutable cache [S]
Cache git show <sha>/git log over committed ranges forever (immutable per SHA); deny repeats unconditionally.  
Files: `bash_cache.py`, `bash_detect.py`  
Savings: 1–10k per repeat

### 5. Bash rg/grep dedup normalization [S]
Normalize parsed command (sorted flags, canonical quoting, resolved paths) before cache-key hash.  
Files: `bash_parser.py`, `bash_cache.py`  
Savings: 1–3k per dodged rg repeat

### 6. MCP read-only call cache (generic) [M]
Pre/post hook for `mcp__.*` tools; cache allowlisted read-only MCP tools (list_*/get_*) with 120s TTL; deny repeat → bash-output pointer.  
Files: new `mcp_cache.py`, `hook_registry.py` or `hooks_cli.py`, `config.py`  
Savings: 100k+ in session with repeated Vercel/GitHub MCP calls

### 7. MCP surgical recall: `token-goat mcp-output` [M]
CLI command mirroring bash-output/web-output with --grep, --head, --section (JSON path).  
Files: `cli.py`, `mcp_cache.py`, `read_commands.py`  
Savings: 200-token slice instead of 10k re-fetch

### 8. MCP list-response compaction [M]
Post-hook compressor for list_* responses: keep id/name/status/url, drop verbose metadata blobs; full body cached for recall.  
Files: `mcp_cache.py`, `bash_compress.py` (shared table renderer)  
Savings: 60–90% per list call even on first fetch

### 9. `sed -n 'X,Yp'` and `awk NR` range reads [M]
Extend slice detection to sed/awk line-range idioms, routing through serve-and-mark path.  
Files: `bash_parser.py`, `bash_detect.py`  
Savings: Closes last common shell-read bypass

### 10. MCP stale-state invalidation [M]
git push / vercel deploy Bash calls bust deployment caches; Edit/Write on tracked files shortens TTLs.  
Files: `mcp_cache.py`, `hooks_edit.py`, `config.py`  
Savings: Enables raising TTL from 120s to 10min, doubling hit rate

### 11. Bash read-streak → surgical-read injection [M]
After 3 consecutive shell file-reads, inject systemMessage teaching `token-goat read "file::symbol"` with concrete example.  
Files: `bash_detect.py`, `hints.py`, `session.py`  
Savings: Behavioral — bends 800-call sessions toward surgical patterns

### 12. Polling-loop detection and backoff hint [L]
Detect N≥5 identical calls (MCP or Bash) in window → inject Monitor/sleep-loop suggestion; per-tool cooldown denies at critical.  
Files: `mcp_cache.py`, `bash_cache.py`, `hints.py`, `session.py`  
Savings: Converts 35 deployment polls to ~5; potentially 100k+ in polled sessions
