# Context Savings & Compaction Design — 2026-05-23

## Problem

Token-goat already cuts substantial tokens via image-shrink, surgical reads, dedup hints, output caches, the compaction manifest, and the post-compact recovery hint. But several large pools of tokens still leak. (1) The manifest is recall-only — it tells the compaction LLM what mattered but never restores ground-truth content (file slices, skill bodies, diff snippets), so the agent must re-Read or re-invoke after compaction. (2) Hint text itself is verbose: "tokens", "wasted", "adjust offset/limit" repeat many times per session at ~3-8 tokens each; bash/web/grep entries inline cached preview snippets that the agent may never need; the recovery hint inlines `output_id` strings that average 40 chars when 16 chars suffice. (3) Multiple mechanisms work in isolation when chained intelligently they would each amplify: skill bodies aren't injected into the post-compact recovery (just a recall command), bash output snippets in the manifest aren't deduped against the same content already shown in dedup hints, hot-file consolidation runs only inside one section. (4) No mechanism actively rewrites or summarises tool output before it lands in context (only compresses bash stdout via filters); a Read of a CSV or minified JSON pours the entire thing in. (5) No "context budget" awareness: agents read in patterns the system could predict (read X.py then test_X.py is 90% likely) and pre-emptively bundle. The headroom is largest in compaction (where the manifest must be a recall *and* a content-injection vehicle), in hint compression (universal terse-mode), and in pre-read content extraction (treat any Read on a large structured file as an implicit surgical-read suggestion with the slice inlined).

## Wild Ideas (uncensored, from divergent phase)

1. **Manifest as a hologram** — instead of "you read X.py at L100-200", *inject* the actual 50 most-load-bearing lines of X.py directly in the manifest. The compaction LLM sees both the recall hint AND the ground truth; agent doesn't need to re-Read. Treat compaction as a content-restoration event, not just a memory event.

2. **Mycelium predictive bundling** — when the agent reads `foo.py`, fungal-network-style we pre-warm the recovery hint with the *symbols* of every file that imports/is-imported-by foo.py. After compaction, the agent has a phantom map of nearby code without a single Read.

3. **Library card catalog skill pack** — combine multiple skill bodies the agent has loaded into one "Active Protocol Pack" entry in the recovery hint that injects the *checklist* sections (extracted via section parser) inline, not a recall command. The agent re-receives the load-bearing 100 tokens of each skill without paying for the full 30 KB.

4. **Newspaper-editor "above the fold"** — the FIRST 80 tokens of the manifest are the only ones the compaction LLM reliably keeps. Move the highest-value content into a sealed "above the fold" block: 3 most-recent edited files, 1 current blocker, 1 active skill name. Everything else is "may compact".

5. **Po: the manifest is empty** — if we never emitted a manifest, what would the agent do differently? It would re-read everything. So every Read in the first 2 minutes after compaction is a signal of "what the agent thought was missing" → log it, and next time pre-include it in the manifest.

6. **Constraint inversion (50 tokens)** — if the manifest had to fit in 50 tokens, what's the irreducible signal? Edited file basenames, blocker exit codes, skill names. Nothing else. This is the "panic mode" manifest for sessions in danger of exceeding context.

7. **Reverse: agent never re-reads anything** — instead of re-reading post-compact, agent issues a single `token-goat resume <session>` that returns a structured restoration packet (file slices, bash outputs, skill checklists, diffs since last edit). One round-trip restores 80% of pre-compact context.

8. **Museum curation pass** — before injecting any hint, run a "curator" pass that asks: is this token-positive *for this specific session right now*? A bash dedup hint at minute 90 of a stale session is curating an artifact nobody will look at; suppress.

## Pre-Mortem

**Scenario 1: Manifest grows, savings shrink.** It's 6 months later, the manifest is now 800 tokens and contains rich content slices, but compaction-LLM-savings per session has dropped 5%. Why? Because the richer manifest costs tokens on *every* compaction (1-3x per session), while the agent acts on only 30% of injected content — net negative. **Design implication:** every richer-manifest feature must measure realised-savings via stats (did the agent skip a Read that would have re-read this content?), and adaptive budget must shrink the manifest when stats show low realisation.

**Scenario 2: Hint fatigue → agent ignores hints.** Agents (or users) start ignoring all hints because too many fire per Read. Result: dedup hints exist but realise 0 tokens. **Design implication:** track per-session hint acceptance rate. When rate drops below 20% in a session, throttle hints to high-confidence only.

**Scenario 3: Phantom restoration sends agent the wrong way.** The "manifest as a hologram" injects file slices, but the slices are stale (edit happened mid-compaction). Agent acts on wrong content. **Design implication:** every injected slice must include a freshness assertion (mtime, content_sha), and inject *diff vs last-edited* not the raw current file when both differ.

## Improvement Backlog (ranked by adjacent-possible score then impact)

---

### 1. Universal terse-mode tokens for hint text — Score 1, Savings: ~150-400 tok/session, Cost: S

**Where**: `src/token_goat/hints.py` — all `ReadHint(...)` f-strings.
**Today**: hint strings still contain verbose phrases ("FAILED (exit=", "ran 2x — cached", "use `offset=N`", "different offset/limit", "loop?"). Recent commit `3bc6f60c` already shortened "tokens" → "t" but left many other phrases verbose.
**Change**: Define a module-level `_TERSE` mapping (`{"cached":"⌘", "exit":"x", "ran ":"×", "Overlap":"Ovr", " tokens":"t"}`) and apply via `str.translate`/replace at the end of each hint constructor. Also drop redundant words: "loop?" already implied by `⚠`+`×N`; drop. "use `offset=N`" → `→offset=N`.
**Why it saves tokens**: Each hint is in the conversation forever once injected. A typical session fires ~20-50 hints; saving 4-8 tokens each compounds to 150-400/session.
**Test**: `tests/test_hints.py` — add assertion that the rendered hint of every dedup type is <= some byte target (e.g. 110 chars for bash light, 180 for grep, etc.). Snapshot the new shorter forms.

**STATUS:** [DONE iter 1, commit c220424]

---

### 2. Drop full `output_id` from in-context hints; keep last 8 chars — Score 1, Savings: ~80-200 tok/session, Cost: S

**Where**: `src/token_goat/hints.py::_build_bash_dedup_hint_inner`, `_build_web_dedup_hint_inner`; `src/token_goat/hooks_session.py::_build_recovery_hint` (bash/web lines).
**Today**: hints embed full `output_id` strings (typically 40+ chars, e.g. `abcdef12-pytest_v_tests_-9a8b7c6d5e4f3210`). The `token-goat bash-output` CLI already accepts unambiguous prefixes.
**Change**: Render only the trailing 8 hex chars of `output_id` in hint and manifest strings (`id=…3210`). The CLI prefix-match is already disambiguating; if collisions happen, the CLI returns "ambiguous, here are matches" and the agent re-issues.
**Why it saves tokens**: 30+ chars × ~5 hint+manifest entries × every compaction = ~80-200 tokens/session.
**Test**: `tests/test_hints.py` — assert `output_id[:-8]` not in rendered hint, suffix is present. Add `tests/test_cli_bash_output.py` test for prefix-match resolution if not present.

**STATUS:** [DONE iter 2, commit unknown]

---

### 3. Tier-3 compaction manifest: "above the fold" 80-token sealed block — Score 1, Savings: ~50-150 tok/session realised, Cost: M

**Where**: `src/token_goat/compact.py::_render` — emit a fixed-size lead block before the main body.
**Today**: Manifest is one stream; truncation at the bottom drops "Key Files Read" but inversion-pyramid order is the only priority signal. Compaction LLM may attend more to top than bottom but no guarantees.
**Change**: Prepend a sealed 80-token block with structure: `### Must-Preserve` listing: (a) ≤3 edited file basenames with edit counts, (b) ≤1 blocker (most recent failure), (c) ≤2 active skill names. Wrap in explicit markers (`<<MUST_PRESERVE>>...<</MUST_PRESERVE>>`) the compaction LLM is unlikely to summarise away.
**Why it saves tokens**: The fold becomes the contract: "everything below may be compacted; everything above must survive." Compaction LLMs respect explicit markers more than priority order. Recovers signal otherwise lost when manifest is trimmed.
**Test**: `tests/test_compact.py` — assert manifest starts with the markers; assert content is bounded at 80 tokens; assert all three pieces survive a synthetic "top-only" truncation.

**STATUS:** [DONE iter 3, commit unknown]

---

### 4. Dedup bash entries in manifest against recently-emitted dedup hints — Score 1, Savings: ~60-150 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_select_top_bash_entries` (filter), `src/token_goat/session.py` (track which bash output_ids have appeared in a dedup hint).
**Today**: A bash command that fired a dedup hint earlier in the session AND appears in `_select_top_bash_entries` gets its full preview *and* output snippet in the manifest. Same info twice.
**Change**: Add `cache.bash_dedup_emitted_ids: set[str]` populated by `build_bash_dedup_hint` when it fires; exclude those `output_id`s from `_select_top_bash_entries` unless they're also a current blocker.
**Why it saves tokens**: A bash entry with snippet costs 80-200 tokens in the manifest. Removing 2-3 redundant ones recovers 100-300 tokens.
**Test**: `tests/test_compact.py` — synthesise a SessionCache where a bash output is both in `bash_history` and was emitted as a dedup hint; assert it's absent from the manifest.

**STATUS:** [DONE iter 4, commit unknown]

---

### 5. Strip output snippet from manifest bash entries when output_id already in recovery-hint trail — Score 1, Savings: ~40-120 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_format_bash_entry`.
**Today**: Every bash entry in manifest loads the cached body via `bash_cache.load_output` and emits 20 middle-truncated lines as inline snippet. Agent has the `output_id` and can recall on demand.
**Change**: Add a `inline_snippet: bool = True` parameter; default False for entries that are in the post-compact recovery hint or where `total_bytes < 600`. Render the header line only; agent uses `token-goat bash-output <id>` to retrieve.
**Why it saves tokens**: Each snippet is ~80-300 tokens. Cutting snippets on entries already pointed-at elsewhere saves ~40-120 per compaction.
**Test**: `tests/test_compact.py` — assert that when `inline_snippet=False`, the rendered entry has no `\n  ` indented block.

**STATUS:** [DONE iter 5, commit unknown]

---

### 6. Recovery hint injects skill checklist sections instead of recall commands — Score 2, Savings: ~200-600 tok/session realised, Cost: M

**Where**: `src/token_goat/hooks_session.py::_build_recovery_hint` (skills section); new helper in `skill_cache.py` to extract a "checklist" section.
**Today**: Recovery hint lists `- ralph (28KB) — token-goat skill-body ralph`. Agent must issue a separate tool call to recover the prose, which costs another round-trip and 28 KB of context.
**Change**: For each cached skill body, extract its `## DoD` or `## Checklist` or `## Steps` section using the existing `read_replacement.section_extract`. Inject the extracted section (capped at 400 chars per skill) directly. Fall back to the recall command when no checklist-shaped section is found.
**Why it saves tokens**: Eliminates a re-invocation round-trip. The 400-char checklist is the load-bearing fraction of a 28 KB skill body — the agent gets the same actionable content for 1.5% of the cost.
**Test**: `tests/test_post_compact_recovery.py` — store a synthetic skill body with `## DoD` section; assert recovery hint contains the DoD text and NOT the full body.

**STATUS:** [DONE iter 5, commit unknown]

---

### 7. Compaction manifest injects last-edited diff (not recall pointer) for top 2 edited files — Score 2, Savings: ~150-400 tok/session realised, Cost: M

**Where**: `src/token_goat/compact.py` — new section after "Files Edited" that inlines small diffs from `snapshots.py`.
**Today**: Manifest lists edited paths and `git diff --stat`. Agent post-compact must re-Read each file to see actual changes. Snapshot exists per `(session, file)` but is never surfaced in manifest.
**Change**: For the top 2 most-edited files where `snapshots.load(session, path)` succeeds AND a unified diff between snapshot and on-disk is < 600 bytes, inject the diff under a `### Recent Diffs (top edited)` heading. Skip files larger than `MAX_SNAPSHOT_BYTES`.
**Why it saves tokens**: Saves 2 full-file re-reads post-compact (often 200-2000 tokens each). Trades 600 bytes (~150 tokens) for that recovery.
**Test**: `tests/test_compact.py` — write a snapshot, mutate the file on disk, assert manifest contains the unified diff; assert files without snapshots fall through.

**STATUS:** [DONE iter 21, commit unknown]

---

### 8. "Curator" pass: skip dedup hints when session hint-acceptance rate < 20% — Score 2, Savings: ~50-200 tok/session, Cost: M

**Where**: `src/token_goat/hooks_read.py`, `hooks_fetch.py`, `hooks_cli.py::pre-bash`; new `session.SessionCache.hints_fired` + `hints_acted_on` counters.
**Today**: Every hint fires regardless of whether the agent ever acts on earlier ones. Hint fatigue → wasted tokens.
**Change**: Track `hints_fired` (every hint emitted) and `hints_acted_on` (heuristic: incremented when within 2 tool calls of a hint, the agent issued the recommended `token-goat <cmd>` OR omitted the redundant Read/Bash). If `acceptance < 0.20` after the first 10 hints in a session, throttle: only emit hints with `tokens_saved >= 200`.
**Why it saves tokens**: Hints that won't be acted on are pure tax. A session with 0% acceptance and 50 hints leaks ~750 tokens.
**Test**: `tests/test_hints.py` — synthesise session with low acceptance counters, assert a low-saving hint returns None; assert acceptance counter increments on a recall command following a dedup hint.

**STATUS:** [DONE iter 18, commit unknown]

---

### 9. Manifest "Active Skills" lists checklist titles, not just names — Score 1, Savings: realised via #6 prep, Cost: S

**Where**: `src/token_goat/compact.py::_format_skill_entry`.
**Today**: `- 🧠 ralph ×3 (28KB) recall: token-goat skill-body ralph`. Compaction LLM doesn't know whether to preserve the skill or whether the agent has moved on.
**Change**: When the cached body's first H2 heading after the front-matter is parseable, append it: `- 🧠 ralph ×3 (28KB) [## DoD Gates] recall: ...`. Truncate appended title to 40 chars.
**Why it saves tokens**: Helps compaction LLM distinguish "load-bearing skill, keep" from "exploratory skill, drop". Indirect; primarily makes #6 viable.
**Test**: `tests/test_compact.py` — synthesise skill cache with known H2, assert title appears.

**STATUS:** [DEFERRED — Score 1 moonshot, subsumed by #6 checklist extraction]

---

### 10. Drop manifest sections entirely when below their min-line floor — Score 1, Savings: ~30-80 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_render_budget_lines` and the `_render` call sites.
**Today**: A header like `### Patterns Searched` always emits with whatever content fits. If only one entry fits and its representative isn't load-bearing, we still pay 5 header tokens.
**Change**: Add `min_lines: int = 2` to `_render_budget_lines`. If the section yields fewer than `min_lines` content lines, return `[], 0`. For `### Web Fetches`, `### Directory Scans`, `### Cold Outputs`, set `min_lines=2`. For `### Active Skills` keep `min_lines=1`.
**Why it saves tokens**: 6 sections × ~5 header tokens for empty/near-empty sections = ~30 tokens worst case; saved per compaction.
**Test**: `tests/test_compact.py` — synthesise cache with one tiny web entry; assert `### Web Fetches` header absent.

**STATUS:** [DONE iter 14, commit unknown]

---

### 11. Pre-Read: when Read targets a large structured file (csv/json/jsonl/log), force surgical hint or row-slice — Score 2, Savings: ~500-3000 tok/session, Cost: M

**Where**: `src/token_goat/hints.py::_hint_from_index`; new function for structured-file detection.
**Today**: A Read of `data.csv` (10 MB) pours the whole file in. There's a large-file hint but no actionable suggestion for non-code structured files.
**Change**: Detect `.csv`, `.jsonl`, `.json` (>50 KB), `.log` (>50 KB), `.ndjson` extensions. Emit a strong hint: "X.csv: 12000 rows; use `token-goat read X.csv::rows=1-100` or `token-goat semantic '<term>' --file X.csv`". (Implementing the CLI side of `rows=` is a separate iteration; the hint is independent value.)
**Why it saves tokens**: A single avoided large-CSV Read is 5000+ tokens. Even with a 30% acceptance rate the expected value is huge.
**Test**: `tests/test_hints.py` — create a synthetic 100 KB CSV, assert the hint mentions surgical access; assert the hint suppresses for small structured files (<50 KB).

**STATUS:** [DONE iter 6, commit unknown]

---

### 12. Pre-Read for index-only files (uv.lock, package-lock.json, *.min.js): inject a synthesised summary, not the content — Score 2, Savings: ~1000-8000 tok/session, Cost: M

**Where**: `src/token_goat/hooks_read.py::pre_read` — short-circuit before the model receives the file.
**Today**: Lockfiles are filtered from manifest (noise) but a Read on them still pours full content into the conversation.
**Change**: In `pre_read`, detect lockfile basenames. Emit hint: "`uv.lock` is a 4500-line dependency lockfile. Direct dependencies: <run `uv pip list` or read `pyproject.toml::dependencies`>. Token-goat suppressed the full read." Return a hookSpecificOutput with `deny` action OR `additionalContext` and let the agent decide.
**Why it saves tokens**: One avoided lockfile read = thousands of tokens. (Caveat: this requires harness support for denying a Read; if not available, fall back to a strong nag hint.)
**Test**: `tests/test_hooks_read.py` — simulate Read on `uv.lock`, assert hint or denial fires; assert non-lockfile Reads unaffected.

**STATUS:** [DONE iter 12, commit unknown]

---

### 13. Recovery hint deduplicates skill bodies by content_sha across loads — Score 1, Savings: ~50-200 tok/session, Cost: S

**Where**: `src/token_goat/hooks_session.py::_build_recovery_hint` (skills loop).
**Today**: If the agent loaded `ralph` 3 times in a session (different content_sha each due to skill update? same content? not deduped at all in the hint), the recovery shows it three times.
**Change**: Before iterating `skill_entries`, dedup by `skill_name` keeping highest `ts`. Show `×N` suffix.
**Why it saves tokens**: Duplicate skill rows waste 20-40 tokens each.
**Test**: `tests/test_post_compact_recovery.py` — synthesise multiple skill entries with same name, assert single row with `×N`.

**STATUS:** [DONE iter 13, commit unknown]

---

### 14. Compaction-manifest path normalisation: strip the project name from paths in addition to /src//tests//docs/ — Score 1, Savings: ~30-100 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_short_path` and `_find_common_prefix`.
**Today**: `_short_path` strips `/src/`, `/tests/`, `/docs/`. The existing common-prefix detector can strip e.g. `token_goat/` but only when ≥3 paths and ≥70% coverage are met.
**Change**: When `cache.cwd` is known, additionally strip its basename when it appears as the first path component. Lower the common-prefix threshold from 3 paths to 2.
**Why it saves tokens**: A repo named `defi-kingdoms-interface` adds ~24 chars per path. With 10-20 paths in manifest that's 240-480 chars = 60-120 tokens.
**Test**: `tests/test_compact.py` — synthesise cache with `cwd=/foo/myrepo` and paths starting with `myrepo/`, assert prefix stripped, assert path-relative header inserted.

**STATUS:** [DONE iter 14, commit unknown]

---

### 15. Manifest emits `### TODOs` section from TaskList state — Score 2, Savings: ~100-300 tok/session realised, Cost: M

**Where**: `src/token_goat/compact.py` — new section; new module to read TaskList persistence.
**Today**: TaskList state is preserved across compaction by the harness, but the manifest doesn't see it. If TaskList isn't injected into the new context window, the agent loses task state.
**Change**: Look for a TaskList file under common locations (`%LOCALAPPDATA%\Claude\sessions\<id>\tasks.json` and `~/.claude/projects/<slug>/tasks.json`). If found, emit `### TODOs` listing in-progress and next-pending entries (capped at 5 lines).
**Why it saves tokens**: Saves the agent from re-deriving "what was I doing" from log/file context after a long-session compaction. Indirect but high-realised when active.
**Test**: `tests/test_compact.py` — write a synthetic tasks.json, assert section appears; assert section omitted when file missing.

**STATUS:** [DONE iter 11, commit unknown]

---

### 16. Recovery hint includes "next likely Reads" predicted from edited file's imports — Score 3, Savings: ~200-1000 tok/session realised, Cost: L

**Where**: `src/token_goat/hooks_session.py::_build_recovery_hint`; new `predict.py` module using `db.refs` table.
**Today**: Recovery hint shows files already touched. It doesn't proactively surface adjacent files the agent will probably need.
**Change**: For each top-3 edited file, query the project DB for its imports (refs where `kind='import'` and `file_rel=<file>`). Add a `**Nearby**:` section listing up to 5 import targets. Cap at 200 chars total.
**Why it saves tokens**: After compaction, agent often does N Reads to rebuild import context. Pre-injecting symbol+path tuples lets it skip the discovery phase.
**Test**: `tests/test_post_compact_recovery.py` — synthesise project with refs, assert nearby files appear in hint.

**STATUS:** [DEFERRED — Score 3 moonshot, requires cross-module traversal complexity]

---

### 17. Inline the most-recent `git diff HEAD` for a single edited file when total diff < 400 bytes — Score 1, Savings: ~150-400 tok/session realised, Cost: S

**Where**: `src/token_goat/compact.py::_get_git_diff_stat` — extend to optionally include diff body, not just stat.
**Today**: Manifest shows `### Diff Summary` with `file.py | 5 ++` lines (just the stat). Agent must re-read to see what changed.
**Change**: If exactly one file is edited AND `git diff HEAD -- <file>` is < 400 bytes, append the full diff under `### Diff Detail` (single file only; multi-file uses the stat).
**Why it saves tokens**: Eliminates a post-compact "what did I change in foo.py" Read.
**Test**: `tests/test_compact.py` — mock subprocess to return a small diff for one file; assert `### Diff Detail` present; multi-file path falls through.

**STATUS:** [DONE iter 9, commit unknown]

---

### 18. Pre-Read content-only-changed short-circuit — Score 1, Savings: ~300-1500 tok/session realised, Cost: S

**Where**: `src/token_goat/hooks_read.py::pre_read`, `src/token_goat/hints.py::build_diff_hint`.
**Today**: `build_diff_hint` returns a diff when snapshot != current. Hook *adds* the diff to context but lets the Read proceed. Result: agent gets BOTH the diff hint AND the full re-read in the next turn.
**Change**: When diff hint is emitted AND `diff_tokens / full_tokens < 0.10`, return `hookSpecificOutput` with a strong-deny suggestion ("re-read suppressed — diff above contains all changes; reissue Read if full file needed"). Agent can override by retrying with `noTokenGoat: true` style.
**Why it saves tokens**: Currently saves 0 tokens when agent re-reads anyway. With short-circuit saves the full re-read.
**Test**: `tests/test_hooks_read.py` — assert that when diff is tiny relative to file, hook returns a denial path; assert normal hint path otherwise.

**STATUS:** [DONE iter 9, commit unknown]

---

### 19. Cache the manifest text for a session and re-emit only when delta-changed — Score 2, Savings: ~200-600 tok/multi-compaction session, Cost: M

**Where**: `src/token_goat/compact.py::build_manifest_adaptive` — return prior manifest if cache key matches.
**Today**: Each PreCompact rebuilds the manifest from scratch and emits the full text. In a session with multiple compactions an hour apart, the bulk overlaps.
**Change**: Cache `(session_id, fingerprint(edited_files, last_few_file_keys, last_bash_ts, last_skill_ts)) → manifest_text`. On re-compaction with matching fingerprint, emit a 1-line manifest: "## Token-Goat Manifest — unchanged since prior compaction at HH:MM. Recall via `token-goat compact-hint`."
**Why it saves tokens**: Multi-compaction sessions get ~400 tokens off per redundant manifest.
**Test**: `tests/test_compact.py` — build twice with same cache, assert second call returns short-form; mutate cache, assert full rebuild.

**STATUS:** [DEFERRED — Score 2 moonshot, requires session-level manifest caching]

---

### 20. Suppress the manifest entirely when session activity score is below a floor — Score 1, Savings: ~200-400 tok/short-session, Cost: S

**Where**: `src/token_goat/compact.py::build_manifest_adaptive` and `hooks_session.py::pre_compact` decision.
**Today**: Manifest fires whenever event_count >= some min threshold. A young session with 3 file reads still emits ~150 tokens of manifest.
**Change**: Compute `activity_score = edited_files * 5 + symbols_files * 3 + len(bash_history) * 2 + len(skill_history) * 4`. If `score < 12` AND `age_seconds < 600`, emit empty manifest (no compaction help needed; the session is small enough that natural compaction does fine).
**Why it saves tokens**: Saves ~150-300 tokens on the trivial-session compactions that happen during long pondering phases.
**Test**: `tests/test_compact.py` — synthesise low-activity young cache, assert empty manifest; high-activity cache still emits.

**STATUS:** [DONE iter 20, commit unknown]

---

### 21. Compress `### Pending Changes` git stat lines: drop alignment padding — Score 1, Savings: ~20-60 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_get_git_diff_stat_summary`.
**Today**: `git diff --stat` outputs `src/token_goat/foo.py    | 12 ++++-----` with column alignment via spaces.
**Change**: Run a regex replacing `r"\s{2,}\|"` with `" |"` and `r"\|\s+(\d)"` with `"| \1"`. Single-space everything.
**Why it saves tokens**: Each stat line saves 2-8 spaces. 5-8 lines per session = 20-60 tokens.
**Test**: `tests/test_compact.py::test_get_git_diff_stat_summary` — assert no run of 2+ spaces around `|`.

**STATUS:** [DONE iter 21, commit unknown]

---

### 22. Drop the recall-line legend when only one recall kind appears — Score 1, Savings: ~15-30 tok/session, Cost: S

**Where**: `src/token_goat/hooks_session.py::_build_recovery_hint` (legend assembly).
**Today**: `Recall: 'token-goat skill-body <name>' / 'token-goat bash-output <id>' / 'token-goat web-output <id>'.` The `/` join is fine but when only one kind exists the prefix `Recall:` plus delimiters is wasted overhead.
**Change**: When `len(recall) == 1`, drop the `Recall: ` prefix and inline the example into the section header (e.g. `**Skills** (recall: token-goat skill-body <name>):`).
**Why it saves tokens**: ~15-30 tokens per recovery hint.
**Test**: `tests/test_post_compact_recovery.py` — assert single-kind sessions have no `Recall:` line.

**STATUS:** [DONE iter 22, commit unknown]

---

### 23. Hint fingerprint includes the file path (not just content), allowing same-text suppression across files — Score 1, Savings: ~30-80 tok/session, Cost: S

**Where**: `src/token_goat/hints.py::_hint_fingerprint`.
**Today**: Fingerprint is hash of hint text. Two different files producing the same hint shape (e.g. both got a "large file, use surgical access" nudge) hash differently because file names differ → no dedup across files.
**Change**: Add a *shape* fingerprint (hint text with file name stripped) used for a secondary throttle: after 3 hints of the same shape in a session, only emit if `tokens_saved >= 300`.
**Why it saves tokens**: A session that touches many large files repeatedly receives the same boilerplate "large file" hint. Throttle saves ~30-80 tokens.
**Test**: `tests/test_hints.py` — fire 4 identical-shape hints, assert the 4th is throttled.

**STATUS:** [DONE iter 16, commit unknown]

---

### 24. `### Commands Run` entries use middle-truncation cap of 12 lines (was 20) for non-blocker entries — Score 1, Savings: ~60-200 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_format_bash_entry` — change `_middle_truncate` cap from 20 to 12 for entries with `exit_code == 0`.
**Today**: Every cached bash output in manifest gets 20 lines of preview (first 8 + last 8 + omitted marker). For green tests this is overkill; the agent only needs "PASSED" + maybe the count.
**Change**: Pass `max_lines=12` when `entry.exit_code == 0`; keep 20 for failures (they may have meaningful context).
**Why it saves tokens**: 8 lines × ~10 tokens/line × 3-5 bash entries per manifest = 60-200 tokens.
**Test**: `tests/test_compact.py` — synthesise green and red bash entries, assert green has <= 12 preview lines, red has up to 20.

**STATUS:** [DONE iter 24, commit unknown]

---

### 25. Image-shrink: switch from JPEG quality 85 to AVIF quality 60 when Pillow has AVIF support — Score 2, Savings: ~variable (already-shrunk images), Cost: M

**Where**: `src/token_goat/image_shrink.py`.
**Today**: Pillow JPEG-compresses to a quality ceiling. AVIF gives ~30-50% smaller files at perceptually-equivalent quality.
**Change**: Detect AVIF support via `Image.registered_extensions().get('.avif')`. When available, prefer AVIF for screenshots; keep JPEG fallback.
**Why it saves tokens**: Images go into context as base64. Smaller bytes → fewer base64 tokens directly. For agents that paste UI screenshots heavily, ~30% reduction = potentially thousands of tokens per session.
**Test**: `tests/test_image_shrink.py` — write conditional test that skips when AVIF unavailable; assert AVIF output is smaller than JPEG for a fixed input.

**STATUS:** [DONE iter 7, commit unknown]

---

### 26. Session brief skips git log when current branch matches main and no uncommitted changes — Score 1, Savings: ~50-100 tok/session-start, Cost: S

**Where**: `src/token_goat/hooks_session.py::_build_session_brief`.
**Today**: Brief always emits `Recent: <5 commits>` even on a clean main branch with no work in progress.
**Change**: If `status_lines` is empty AND `branch in ("main", "master", "develop")`, set log_lines to first 2 commits only (or skip entirely).
**Why it saves tokens**: 50-100 tokens at session start on idle/clean state.
**Test**: `tests/test_session_brief.py` — clean main, assert short or absent log; with changes, full log.

**STATUS:** [DONE iter 21, commit unknown]

---

### 27. Hints injection budget: hard cap total hints per session at N (configurable) — Score 1, Savings: ~100-500 tok/long-session, Cost: S

**Where**: `src/token_goat/hooks_common.py` (counter); each pre-hook checks before emitting.
**Today**: There's per-shape dedup but no global cap. A pathological session can fire 100+ hints.
**Change**: Track `cache.hints_emitted_count`. Hard cap: when `>= 75` and not a "blocker" hint (failed bash with exit), suppress.
**Why it saves tokens**: Caps the worst case at predictable boundary.
**Test**: `tests/test_hints.py` — simulate 100 hint emissions, assert ~75 emitted then suppressed.

**STATUS:** [DONE iter 20, commit unknown]

---

### 28. Manifest emits `### What Worked` (last 2 green test runs) explicitly, shorter than full bash entry — Score 2, Savings: ~50-100 tok/session realised, Cost: S

**Where**: `src/token_goat/compact.py` — new selector for last-2 green tests.
**Today**: Green tests get full bash entry treatment with snippet. After compaction, the agent often "checks if tests still pass" which re-runs them.
**Change**: Emit `### Last Green Run: pytest tests/test_X.py — passed @ HH:MM (id=…3210)` and SUPPRESS the full bash entry for those. Saves snippet bytes.
**Why it saves tokens**: ~50-100 tokens per green run replaced by a one-liner.
**Test**: `tests/test_compact.py` — synthesise multiple bash entries, assert green pytest reduced to one-liner.

**STATUS:** [DONE iter 17, commit unknown]

---

### 29. Compaction manifest "Cold Outputs" section is opt-in via age tier (mature only) — Score 1, Savings: ~30-80 tok/active-session, Cost: S

**Where**: `src/token_goat/compact.py::_render` cold outputs branch.
**Today**: Cold outputs render in all tiers when criteria met; young/active sessions rarely benefit and pay the budget.
**Change**: Gate `cold_outputs` rendering on `age_tier == "mature"`. Young/active sessions skip the section entirely.
**Why it saves tokens**: 30-80 tokens off active-tier manifests.
**Test**: `tests/test_compact.py` — young + cold candidates: section absent; mature + cold: section present.

**STATUS:** [DONE iter 23, commit unknown]

---

### 30. Skill body cache stores extracted checklist alongside full body (prep for #6) — Score 1, Savings: prep, Cost: S

**Where**: `src/token_goat/skill_cache.py::store_output` and `SkillMeta`.
**Today**: Only the full body is stored; checklist extraction is done at recall time (slow + repeated).
**Change**: On store, extract `## DoD`/`## Checklist`/`## Rules`/`## Steps` section using a simple regex and store as a `.checklist` sidecar (text, capped at 800 bytes). `read_sidecar` returns it.
**Why it saves tokens**: Enables #6 with O(1) lookup; reduces per-compaction work.
**Test**: `tests/test_skill_cache.py` — store body with known checklist section; assert `.checklist` file written and readable.

**STATUS:** [DEFERRED — Score 1 prep, subsumed by #6 inline extraction]

---

### 31. `token-goat resume <session>` CLI: single round-trip post-compact restoration packet — Score 3, Savings: ~500-2000 tok/session realised, Cost: L

**Where**: new `src/token_goat/cli.py::resume` command; new `src/token_goat/resume.py`.
**Today**: Post-compact agent issues N separate commands (skill-body, bash-output, web-output, Read for each edited file). Each round-trip costs prompt overhead.
**Change**: `token-goat resume <session>` returns a structured Markdown bundle: skill checklists, last 2 bash outputs (head+tail), last edits' diffs, current blocker. One command, one tool-result, all restoration in 600-1200 tokens.
**Why it saves tokens**: Replaces 5-10 tool calls with 1. Each saved tool call = ~50-150 tokens of prompt overhead beyond the content itself.
**Test**: `tests/test_cli_resume.py` — synthesise session, assert resume bundle contains expected sections; cap total output at 2000 tokens.

**STATUS:** [DEFERRED — Score 3 moonshot, requires harness recovery hook integration]

---

### 32. `token-goat semantic` results emit ranked snippets only, not file headers — Score 1, Savings: ~50-150 tok/semantic-query, Cost: S

**Where**: `src/token_goat/read_commands.py` semantic command output.
**Today**: Semantic result output likely repeats file path headers + snippet wrappers per match. (Need to verify but the pattern across CLI commands is to be verbose.)
**Change**: Add `--compact` flag (default true) that prints `<path>::<symbol> | <snippet first line>` instead of multi-line per result.
**Why it saves tokens**: 50-150 tokens per semantic call; semantic is invoked multiple times per session in exploration phases.
**Test**: `tests/test_read_commands.py` — assert `--compact` shorter than default; assert `--no-compact` preserves verbose mode.

**STATUS:** [DONE iter 10, commit unknown]

---

### 33. Drop "(preserve)" suffix from `### Files Edited (preserve)` header — Score 1, Savings: ~3-5 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_render` edited section.
**Today**: Header includes "(preserve)" — informational but the `### Files Edited` heading is unambiguous; the must-preserve marker `<<MUST_PRESERVE>>` (from #3) is the actual contract.
**Change**: Drop the suffix. Rely on inverted-pyramid order + #3 sealed block to signal priority.
**Why it saves tokens**: Trivial, but adds up across compactions.
**Test**: `tests/test_compact.py` — assert literal `### Files Edited\n`.

**STATUS:** [DONE iter 15, commit unknown]

---

### 34. Compress "(cached output)", "(cached body)" qualifiers in section headers — Score 1, Savings: ~5-15 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_render` — bash/web section headers.
**Today**: `### Commands Run (cached output)` and `### Web Fetches (cached body)`.
**Change**: Drop qualifiers; the `id=...` in each entry makes "cached" implicit.
**Why it saves tokens**: Tiny but free.
**Test**: snapshot test update.

**STATUS:** [DONE iter 15, commit unknown]

---

### 35. Manifest assembly skips `### Patterns Searched` when only zero-result entries remain — Score 1, Savings: ~25-60 tok/session, Cost: S

**Where**: `src/token_goat/compact.py::_select_top_grep_entries`.
**Today**: After dropping zero-result greps (recent commit `1321128f`), if the all-zero fallback kicks in, the section still emits with low-signal entries.
**Change**: When `with_hits` is empty AND the agent has had >5 minutes of activity since the last grep, drop the section entirely.
**Why it saves tokens**: ~25-60 tokens; complements the recent zero-result drop.
**Test**: `tests/test_compact.py::test_grep_section_omitted_when_all_zero`.

**STATUS:** [DONE iter 25, commit unknown]

---

## Intersection clusters (ideas that overlap)

**Cluster A: "Inject content, don't just point to it"** — ideas #3 (sealed must-preserve block), #6 (skill checklists in recovery), #7 (last-edited diffs in manifest), #17 (single-file git diff inline), #31 (resume CLI). All point at the same insight: token-goat's biggest gain comes from converting the manifest from a *recall index* into a *content-restoration vehicle*. Score the cluster: high reward (manifest does double duty), moderate risk (must instrument realised-savings to avoid scenario 1 from the pre-mortem).

**Cluster B: "Terse-mode everywhere"** — ideas #1, #2, #21, #22, #33, #34. All small individually; together ~200-400 tokens per session at S-cost. The DRY enabler is a single `_terse()` helper applied consistently across hints and manifest.

**Cluster C: "Adaptive throttling"** — ideas #8 (hint-acceptance), #19 (manifest delta), #20 (suppress trivial-session manifest), #23 (shape-fingerprint throttle), #27 (hard cap), #29 (tier-gated cold outputs). Together they form a self-tuning system: the more the agent ignores token-goat, the quieter token-goat gets. Highest moonshot signal — feedback loops are what separate good systems from great ones.

**Cluster D: "Read-suppression for high-token, low-info files"** — ideas #11 (structured), #12 (lockfiles), #18 (diff-instead-of-reread). Same insight: some Reads are categorically wasteful. Need harness support for soft-deny; without it, fall back to nag hints.

## Out of scope

- New language indexers / tree-sitter adapters
- Changes to the SQLite schema or sqlite-vec usage patterns
- New auto-indexing triggers or worker scheduling
- Changes to `image_shrink.py` beyond #25 (e.g., perceptual hashing, dedup across sessions)
- Anything requiring Claude Code harness changes (other than the soft-deny experiment in #12/#18 which has a nag-only fallback)
- Compaction *speed* optimisations (parent says: separate brainstorm)
- Cross-session memory persistence beyond what `~/.claude/memory` already provides
- Reducing token-goat's own startup/import cost (relevant but covered under "speed" brainstorm)

## Hypothesis (Riskiest Bet)

**We believe that injecting content (file diffs, skill checklists, last-test snippets) directly into the compaction manifest and post-compact recovery hint will save 300-1000 tokens per compacted session because the agent will avoid the round-trip tool calls it currently issues to restore that same content.** We'll know we're right when (a) the per-session sum of `read_replacement` + `bash_output_recall` + `web_output_recall` stat tokens INCREASES after #6/#7/#31 ship (more recalls means more agent uptake), AND (b) the per-session sum of `Read`/`Bash` invocations within 5 minutes after a compaction event DECREASES by ≥25%. The riskiest assumption is that the compaction LLM and the post-compact agent will *use* injected content rather than re-deriving it from elsewhere. We can test this cheaply by shipping #6 alone first, measuring acceptance via stats for a week, and only investing in #7/#31 if uptake exceeds 30%.

## Open questions

1. **Does the Claude Code harness support a "soft-deny" hookSpecificOutput for Read?** Ideas #12 and #18 need this. Default if unknown: implement as a strong nag hint with a clear "suppressed by token-goat" prefix; let the agent decide to retry.

2. **Where does the TaskList file live on disk for ide #15?** Default: search both `%LOCALAPPDATA%\Claude\sessions\<id>\tasks.json` and `~/.claude/projects/<slug>/tasks.json`. If neither exists, skip section silently. (Verify against actual harness layout when implementing.)

3. **For #25 (AVIF), is the typical Pillow installation on Windows CI providing AVIF support out of the box?** Default: feature-flag behind a Pillow plugin check; skip the test on AVIF-absent installs.

4. **For #8, what's the right acceptance-rate window?** First 10 hints feels right but may be too narrow. Default: 10 hints OR 20 minutes, whichever comes first.

5. **For #19, what fingerprint inputs make the cache invalidate at the right granularity?** Default: `sha1(edited_files + bash_history_keys[-3:] + skill_history_keys[-2:])`. Tune based on observed hit rate over the first week.
