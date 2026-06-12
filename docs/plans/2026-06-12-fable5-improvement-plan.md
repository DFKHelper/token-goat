# Fable 5 Context-Reduction Improvement Plan

**Date:** 2026-06-12
**Version:** 1.7.1 → 1.8
**Source:** Fable 5 strategic analysis of 22MB audit session + 69fb session context
**Requirement:** All improvements must work for Claude Code, Codex, AND Gemini-CLI (antigravity)

---

## Plan (ordered by impact×difficulty, easy wins first)

### Wave 1 — Small, pressure-scaling features (ship together)

**1. Pressure-scaled `pre_read` deny threshold** [S]
- Replace fixed 45KB gate with tier-scaled effective threshold
- Helper `_effective_redirect_threshold(session_id, cache) -> int` maps: cool→45K, warm→30K, hot→15K, critical→8K
- Express as multipliers on configured base so user overrides scale proportionally
- Reuse the `ContextPressure` fetched once per pre_read invocation; thread through (no double load)
- Files: `hooks_read.py`, `config.py`, tests
- Savings: 5–15K tokens/session in long sessions

**2. Pressure-scaled `post_bash` output cap** [S]
- Tier-scale the bash output token cap: cool→1.0×, warm→0.7×, hot→0.45×, critical→0.25×
- Pass into `bash_compress.cap_tokens()` at `bash_compress.py:701`
- Compressed-but-long outputs (helm template, kubectl describe) get truncated harder as context fills
- Files: `hooks_read.py::post_bash`, `config.py`
- Savings: 2–8K tokens/session

**3. WebFetch re-fetch: hint → pressure-gated deny** [S]
- `_handle_web_dedup` and `_handle_web_cache_hit` (`hooks_fetch.py:142, 163`) currently emit hints
- At warm+ pressure with valid SHA-matching cache: deny → `token-goat web-output <id> [--section/--grep]`
- Keep hint-only at cool; escape for "latest"/"refresh" in prompt
- Files: `hooks_fetch.py::pre_fetch`, `web_cache.py`, `hints.py`
- Savings: 3–10K per duplicate fetch

**4. Hint diet at high pressure** [S-M]
- Add `compact_mode` flag to hint builders: at hot/critical, every hint collapses to single line
- Command menus shrink to single best command; low-priority kinds suppressed at critical
- Pass the tier computed per-invocation through to builders
- Files: `hints.py`, call sites in `hooks_read.py`/`hooks_fetch.py`
- Savings: 1–3K tokens/session at high pressure (compounds)
- **Test caution:** hint wording changes cascade; assert concepts not exact strings, `rg` old text first

### Wave 2 — Independent features

**5. Deny-with-inline-skeleton** [S-M]
- When oversized-read deny fires on an indexed source file, embed skeleton (~600 tok) in deny reason
- Eliminates one tool round-trip (deny → skeleton → read file::symbol → targeted read)
- Skip inlining at critical tier (600 tokens matters there)
- Files: `hooks_read.py` (deny builder), `read_commands.py`/`repomap.py`, token estimate utils
- Savings: 500–2K per deny event

**6. Notebook (`.ipynb`) output stripping** [M]
- No .ipynb handling exists today; notebooks are JSON with base64 images and repeated outputs
- Type-specific `pre_read` handler: serve sidecar with code+markdown cells + one-line output summaries
- Cache sidecar keyed by file SHA like compact-doc sidecars
- Files: `hooks_read.py` (handler), new `notebook_compact.py` (~150 lines), `cache_common.py`
- Savings: 90–98% per notebook read (20–100K tokens)

**7. Cross-file duplicate-content dedup** [M]
- Session-level `content_sha → first_path` map in session cache
- When different path read matches already-read file's SHA: deny-redirect to first path
- Gate behind size > 2KB floor; honor on-disk SHA re-verification from 1.7.1
- Files: `session.py` (new content_hashes dict), `hooks_read.py` (pre_read check, post_read record)
- Savings: 1–40K tokens in monorepos with duplicated config/templates

### Wave 3 — Bash/grep dual-path features

**8. Glob result rollup compression** [M]
- Post-hook on Glob: when results >40 paths, collapse to directory rollups
- Keep first 15 literal paths + "full list: token-goat bash-output <id>"
- Rollup kicks in at 20 paths when hot; register `fd`/`find`/`ls -R` in `bash_detect.py` too
- Files: `hooks_read.py` (Glob branch of post_read), `bash_compress.py` (rollup helper)
- Savings: 1–4K per large glob

**9. Identical rg/Grep re-run deny via cached output** [M]
- Records `(pattern, path, flags) → (result_hash, cache_id)` + repo-state fingerprint
- On exact-match re-run with unchanged fingerprint: hint at cool, deny→bash-output at warm+
- Dual entry: Grep tool (claudecode) + `rg`/`grep` shell commands (codex/gemini)
- Files: `hooks_read.py` (`_handle_grep_dedup` upgrade), `session.py` (extend grep history), `bash_detect.py`
- Savings: 0.5–3K per duplicate search; hits cross-agent via shared session cache

**10. Repeated test-run failure delta** [M-L]
- Store last-run failure-identifier set (test ids + first error line) per command signature
- On next run: emit only delta — "Same 4 failures (unchanged). NEW: test_c. FIXED: test_d."
- Implement in `Filter` base/mixin; failure lists are already parsed in each filter
- Files: `bash_compress.py` (PytestFilter, JestFilter, VitestFilter, CargoFilter), `session.py`
- Savings: 1–5K per repeated run; 10-iteration fix loop saves 10–40K

### Wave 4 — Larger features

**11. Directory-recon streak breaker** [M]
- When Nth (default 5) full-file read under same directory prefix in sliding window: deny
- Redirect to `token-goat map <dir>` / `skeleton` — one repomap < cost of next 3 files
- Streak threshold scales with pressure (5 cool → 3 hot); reset on surgical commands or edits
- Files: `hooks_read.py::pre_read` (handler, before generic fallback), `session.py` (dir_read_streaks dict), `hints.py`
- Savings: 5–20K per recon burst

**12. Delta re-read serving (edited and appended files)** [L]
- When `deny_reread` would block but file SHA changed: serve delta instead of deny
- For append-mostly files: tail since last-read line count
- For edited source: unified diff against last-read snapshot
- Files: `hooks_read.py`, `cache_common.py` (snapshot store), `session.py` (snapshot ref on FileReadState)
- Savings: 70–95% per verify-after-edit read; 5–25K/session in active coding

**13. Screenshot perceptual-hash dedup** [M]
- Compute dHash at shrink time; Hamming distance ≤4 → deny/annotate as duplicate frame
- Advisory strength at cool (allow); deny at warm+
- Files: `image_shrink.py` (hash), `hooks_read.py::pre_screenshot`, `session.py` (recent hash ring buffer ~20 entries)
- Savings: 1–2K per duplicate frame; frontend sessions take dozens

**14. Compact-doc sidecar prewarm in worker** [M]
- Worker auto-generates sidecars for eligible docs (>15KB, low churn) during reindex
- `generate_if_eligible(path)` in `doc_compact.py`; throttled in worker drain loop
- Files: `worker.py`, `doc_compact.py`, config knob
- Savings: 2–10K per session opening large stable docs cold

---

## Invariants to never violate

1. Generic size-gated deny MUST stay a fallback AFTER type-specific handlers (skill/index/structured/diff/notebook). The ≥10MB catastrophic floor is the one early-preempt exception.
2. Hint wording: assert concepts not exact strings in tests; `rg` old text across tests/ before committing.
3. Multi-line code comments must collapse to one `#` line (E501 off).
4. No Co-Authored-By or Claude attribution in commits.
5. `atomic_write_bytes` for any content with hand-baked `\r\n` (CRLF-doubling on Windows).
6. `Path.mkdir(parents=True, exist_ok=True)` → use `paths.ensure_dir` pattern (Windows race).
7. Pin `TOKEN_GOAT_HARNESS_OVERRIDE` in any manifest/hint-content test.
8. Cross-harness: no new harness-specific wire-format shapes; pure additive session JSON fields.

---

## Aggregate savings estimate

All 14 improvements: **40–120K tokens/session** with #6, #10, #11, #12 carrying most of the ceiling and #1–#4 providing automatic scaling as context fills.
