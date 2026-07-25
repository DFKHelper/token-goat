# Context Efficiency Enhancements

Features identified as missing from token-goat that would meaningfully reduce token burn and improve context quality.

---

## 1. KV-cache prefix stabilization

**Problem:** When token-goat injects a compact manifest as a `systemMessage` before compaction, the injected text varies per session (it reflects current file state, hit counts, etc.). Varying prefixes prevent Anthropic's server-side KV cache from hitting on the prompt prefix, wasting latency and cost.

**Solution:** Normalize the manifest injection so the prefix is stable across sessions. Specifically:
- Sort file entries deterministically (by rel path, not insertion order)
- Strip session-specific timestamps from the manifest body
- Keep the directive block (which is static) at the very top of the system prompt

**Files:** `src/token_goat/compact.py`, `src/token_goat/hooks_compact.py`
**Effort:** S
**Tests:** assert manifest body is byte-for-byte identical across two identical sessions

---

## 2. Importance-weighted context trimming

**Problem:** When the compact manifest exceeds budget, the current trim logic drops the lowest-priority entries using a static importance tier (protected > recent > old). It doesn't use access-frequency or recency signals from the session.

**Solution:** Weight each manifest entry by: `score = hit_count × recency_decay`. Keep the top-scored entries, drop the rest. The `stats` table already tracks `hit_count`; add `last_access_epoch` column.

**Files:** `src/token_goat/compact.py`, `src/token_goat/db.py`
**Effort:** M
**Tests:** entry accessed 10× survives trim over entry accessed once

---

## 3. `token-goat stats` — compression metrics CLI command

**Problem:** There's no way to see how much token-goat has actually saved in a session or over time. Users can't validate ROI.

**Solution:** Add `token-goat stats [--session | --global | --json]` that prints:
- Tokens saved by bash-output compression (sum of `(original_size - compressed_size)` across all cached outputs)
- Reread denies this session
- Images shrunk + bytes saved
- Top 3 filters by token savings

**Files:** `src/token_goat/cli.py`, `src/token_goat/db.py`
**Effort:** S
**Tests:** stats command returns valid JSON; counts accumulate across invocations

---

## 4. JSON array deduplication in bash output

**Problem:** Commands like `npm ls --json`, `gh api`, `kubectl get pods -o json` produce JSON arrays with repeated structures (same keys, similar values). The existing bash filters work on line patterns; they don't understand JSON structure.

**Solution:** Add a `JsonArrayFilter` to `bash_compress.py` that:
- Detects JSON array output (starts with `[`, parses successfully)
- Deduplicates objects with identical keys (keeps first + count)
- Truncates arrays longer than 50 items with `[... N more items]` suffix
- Passes through non-array JSON unchanged

**Files:** `src/token_goat/bash_compress.py`, `src/token_goat/bash_detect.py`
**Effort:** M
**Tests:** array dedup, truncation, non-array passthrough, malformed JSON passthrough

---

## 5. Full-output retrieval for compressed bash results

**Problem:** After compression, the full output is cached but only accessible via `token-goat bash-output <id>`. There's no mechanism for Claude Code to get the full output back automatically when it needs it.

**Solution:** When `token-goat bash-output <id>` is called with `--full`, return the complete uncompressed output. Also expose a `--diff` flag that shows what was stripped. This makes the compression lossless from the user perspective.

**Files:** `src/token_goat/cli.py`, `src/token_goat/db.py`  
**Effort:** S (the cache already stores full outputs; just expose `--full` and `--diff` flags)
**Tests:** `--full` returns exact original; `--diff` shows stripped lines

---

## 6. `token-goat learn` — mine sessions for recurring miss patterns

**Problem:** When `token-goat symbol` or `token-goat read` misses repeatedly on the same file/symbol across sessions, there's no feedback loop. The user is frustrated; token-goat keeps emitting the same "not found" without learning.

**Solution:** Track miss patterns in the global stats DB. After 3+ misses for the same (file, symbol) pair across sessions, emit a proactive hint: "You've searched for X in Y multiple times. Consider adding a CLAUDE.md alias or adjusting your index config."

**Files:** `src/token_goat/db.py`, `src/token_goat/read_commands.py`
**Effort:** M
**Tests:** miss counter increments; threshold hit emits hint; counter resets on success

---

## 7. Cross-session context deduplication in compact manifest

**Problem:** When two Claude Code sessions run against the same project simultaneously, both inject their own manifests with overlapping file coverage. The overlap wastes tokens.

**Solution:** Write the compact manifest to a shared file (`<data_dir>/<project_hash>/manifest.json`) keyed by session ID. When injecting, merge manifests from all active sessions, dedup by file path (keep highest hit_count), and cap total size.

**Files:** `src/token_goat/compact.py`, `src/token_goat/hooks_compact.py`
**Effort:** L
**Tests:** two sessions merge without duplicate entries; file-level dedup keeps higher score

---

## Implementation order

1. `token-goat stats` (feature 3) — immediate value, easy to ship
2. `bash-output --full / --diff` (feature 5) — small add-on, no schema change
3. KV-cache prefix stabilization (feature 1) — high ROI, low risk
4. JSON array deduplication (feature 4) — extends existing compression pipeline
5. Importance-weighted trimming (feature 2) — requires DB schema change
6. `token-goat learn` miss patterns (feature 6) — requires stats schema additions
7. Cross-session deduplication (feature 7) — most complex; do last

Each feature gets: sonnet coder → 2 haiku reviewers → commit.
