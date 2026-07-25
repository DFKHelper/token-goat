# Context Savings — New Design Items — 2026-05-24

## Context

The previous 55-iteration loop implemented 30 of the 35 items from `docs/plans/2026-05-23-context-savings-design.md`. This document contains 25 **genuinely new** items that were not covered by that loop. They target angles that loop did not explore: multi-compaction caching, wire-format efficiency, cross-session Grep dedup, output-body re-emission compression, repomap verbosity, manifest markdown structure, Codex bridge overhead, result-pointer vs inline tradeoffs, and recovery hint timing.

Items marked Score 1 are surgical (<50 lines), Score 2 touch 2–3 modules (50–150 lines), Score 3 require a new abstraction (150+ lines).

---

### 1. Cache the rendered manifest SHA across compactions and emit a stub when unchanged — Score 2, Savings: ~300-600 tok/multi-compact session, Cost: M

**Problem:** `build_manifest_adaptive` rebuilds and re-emits the full manifest text on every `PreCompact` fire, even if the session state is byte-for-byte identical to the previous compaction. In sessions with multiple compactions per hour (long debug loops), the manifest text is redundant ~60–70% of the time.

**Proposal:** After emitting a manifest, persist `sha256(manifest_text)` + `emit_ts` to a small sidecar file (`sentinels/manifest_sha_{session_id}`). On the next `PreCompact`, recompute the SHA before rendering; if it matches and the sidecar is <`_MANIFEST_CACHE_TTL_SECS` old, return a 1-line stub: `"## Token-Goat Manifest — unchanged since HH:MM. Recall: token-goat compact-hint --session-id <id>."` The existing `_MANIFEST_CACHE_TTL_SECS = 600` constant and `_manifest_sha_written_this_process` set are already present in `compact.py` but the cache-hit path is not yet wired to actually short-circuit `_render`. Wire it up by computing the fingerprint from `event_count` + `edited_files` keys + last 3 bash/skill ts values before calling `_render`.

**Mechanism:** Fires on every second-or-later compaction within 10 minutes when no new edits or commands have run. Expected frequency: 1–3 multi-compaction sessions per day for active users.

**Risks:** If the fingerprint misses a meaningful change (e.g. a new blocker that didn't change `event_count`), the compaction LLM gets a stale stub. Mitigation: always include the most-recent bash `exit_code != 0` entry in the fingerprint inputs.

**Files touched:** `src/token_goat/compact.py`, `src/token_goat/hooks_session.py`.

---

### 2. Recovery hint deferred to first PreToolUse(Read) after compaction, not SessionStart — Score 2, Savings: ~150-400 tok/compact session, Cost: M

**Problem:** The post-compact recovery hint is injected at `SessionStart` (source="compact"). But at that moment the agent's first tool call is not yet known — the hint may describe Bash outputs or web fetches the agent will never need in this new context window. Recovery hint tokens are always injected; they are sometimes wasted.

**Proposal:** Instead of injecting the recovery hint at `SessionStart`, write the recovery payload to a sidecar file (`sentinels/recovery_pending_{session_id}`) and return `CONTINUE` with no `additionalContext`. In `pre_read` (hooks_read.py), check once per session whether a pending recovery sidecar exists. On the first `PreToolUse(Read)` after compaction, load and inject it as `additionalContext` alongside the normal hint. Delete the sidecar after injection. This defers the cost to the moment when the agent actually starts working with files, and the hint is now contextually relevant (the agent just tried to read something, so file/bash/skill hints are relevant).

**Mechanism:** One-time injection per compact event, deferred ~1 tool call. Saves injection entirely on sessions where the first post-compact action is not a Read (e.g. the agent runs a Bash command to check state — the recovery hint about file reads is wasteful).

**Risks:** If the agent's first post-compact action is a Bash command that triggers `pre_bash`, the hint won't fire until the first Read. Mitigation: also check for the sidecar in `pre_bash`; inject on whichever hook fires first. The "deferred" design is identical to the compact-skip sentinel pattern already in use.

**Files touched:** `src/token_goat/hooks_session.py`, `src/token_goat/hooks_read.py`, `src/token_goat/session.py`.

---

### 3. Manifest markdown: replace repeated `### Section` headers with a single legend line — Score 1, Savings: ~40-100 tok/session, Cost: S

**Problem:** The manifest emits 6–9 `### Section` headers (e.g. `### Files Edited`, `### Symbols Accessed`, `### Commands Run`, `### Patterns Searched`, `### Web Fetches`, `### Current Blockers`, `### What Worked`, `### Pending Changes`, `### TODOs`). Each H3 header costs ~4–6 tokens. With 8 sections present, that's 40–50 tokens just for headers. The compaction LLM doesn't need H3 formatting — bullet lists with a bold label are equally parseable and cheaper.

**Proposal:** Replace all `### Section Name` headers in `compact.py::_render` with bold inline labels at the start of the section's first bullet: `**Edited:**`, `**Syms:**`, `**Ran:**`, `**Grep:**`, `**Web:**`, `**Blocked:**`, `**Passed:**`, `**Pending:**`, `**TODOs:**`. Preserve `<<MUST_PRESERVE>>` markers since they're semantic contracts, not display headers. The sealed block header `### MUST_PRESERVE` is the one exception — keep it because the compaction LLM is specifically looking for that marker.

**Mechanism:** Saves ~4 tokens per section × 8 sections = ~32–40 tokens per manifest, per compaction.

**Risks:** If the compaction LLM relies on H3 anchors to parse sections, switching to bold labels may reduce section boundary clarity. Mitigation: test against a sample manifest by comparing summarizer output before/after. Easy rollback: one-line change per section.

**Files touched:** `src/token_goat/compact.py`.

---

### 4. Codex `denormalize_response`: skip camelCase key remapping when no renaming needed — Score 1, Savings: ~2-5 ms/hook call (latency, not tokens), Cost: S

**Problem:** `hooks_common.py::denormalize_response` unconditionally iterates and remaps all keys in the hook response dict from snake_case to camelCase for the Codex wire format. For Claude Code responses (`hookEventName`, `additionalContext`, `continue`, `systemMessage`) no remapping is ever needed — those keys are already in their wire-format form. The remap loop runs on every single hook response, including the 10+ hooks that fire per session even in quiet sessions.

**Proposal:** Add a fast-path in `denormalize_response`: if the response only contains keys from `{"continue", "hookSpecificOutput", "systemMessage"}`, return it directly without iterating. The camelCase remapping is only relevant for Codex's `tool_input` update path (which uses `command`, `additionalContext` under `hookSpecificOutput`). Gate the remap loop on `"tool_input_update" in resp or "input_update" in resp`.

**Mechanism:** Eliminates the dict copy+remap on every CONTINUE response. Per-hook call savings: ~1–3 µs × 30 calls/session = trivial on timing but reduces unnecessary allocations in high-frequency hook paths.

**Risks:** If a future hook response adds a new snake_case key that needs remapping, the fast-path gate may silently skip it. Mitigation: add a `__debug__` assertion in dev mode that verifies all non-gateway keys are already camelCase.

**Files touched:** `src/token_goat/hooks_common.py`.

---

### 5. Grep cross-session dedup: suppress repeat patterns seen in prior N sessions — Score 2, Savings: ~80-250 tok/session for repeat-pattern sessions, Cost: M

**Problem:** The Grep dedup hint suppresses repeat patterns within a single session. But many agents run the same exploratory Grep patterns across sessions (e.g. `rg "def test_"` or `rg "TODO"` at the start of every session). The session JSON is reset on `SessionStart`, so the dedup counter resets — the agent gets the same "already searched" hint suggestion only if it repeats the pattern within one session.

**Proposal:** In `session.mark_grep`, record grep pattern hashes in a lightweight cross-session Grep index: a small SQLite table `global.db::grep_patterns(pattern_hash TEXT, last_ts REAL, count INT)` updated on every new unique pattern. In `build_grep_dedup_hint`, query this table alongside the session cache: if `count >= 3` (pattern seen in 3+ sessions) and `last_ts < 1 hour ago`, emit a reduced hint: `"Grep '<pattern>' is a frequent exploratory pattern — results may already be indexed. Try: token-goat semantic '<intent>'."` This nudges toward semantic search for repeated exploratory queries.

**Mechanism:** Fires at the start of sessions where the agent reflexively runs the same Grep patterns. Frequency: moderate for agentic loops that always start with the same orientation queries.

**Risks:** Cross-session state in `global.db` adds a write on every grep call. Mitigation: write only when pattern is new OR `last_ts` is >24h stale (amortized cost ~1 write per day per unique pattern). Also gate on `result_count >= _GREP_DEDUP_MIN_RESULT_COUNT` to avoid noisy zero-result patterns.

**Files touched:** `src/token_goat/hints.py`, `src/token_goat/session.py`, `src/token_goat/db.py`.

---

### 6. Repomap: drop the file-list preamble from `--compact` output when project has >50 files — Score 1, Savings: ~100-300 tok/map call, Cost: S

**Problem:** `token-goat map --compact` emits a ranked list of the most important files followed by a compact symbol overview. For projects with >50 files, the file-list preamble (one line per file, sorted by PageRank) can consume 100–200 tokens before any symbol content appears. An agent that just ran `token-goat map` to orient itself often doesn't need every file's path — it needs the top symbols.

**Proposal:** In `repomap.py`, when `--compact` is set AND the project has >50 files, replace the full file list with a 1-line summary (`"N files indexed. Top modules: foo.py, bar.py, baz.py (+N more)"`) and go directly to symbol clusters. The `--no-summary` flag (or `--full`) restores the original file list. Threshold 50 is configurable via `[repomap] compact_file_threshold` in config.toml.

**Mechanism:** Saves ~100–300 tokens on every `token-goat map --compact` call in medium/large repos. The agent gets the same orientation signal (top symbols, module clusters) with a fraction of the token cost.

**Risks:** The file-list provides "what exists" orientation that symbols alone don't give. Mitigation: the 1-line summary preserves the count and top-3 filenames; full list via `--full` is always available.

**Files touched:** `src/token_goat/repomap.py`, `src/token_goat/cli.py`.

---

### 7. Web-output body: emit only first + last 20 lines in recovery hint instead of full body — Score 1, Savings: ~100-400 tok/session with web fetches, Cost: S

**Problem:** The recovery hint's `**Web**:` section lists `url_preview + body_bytes + output_id` per entry, which is already terse. But when the agent uses `token-goat web-output <id>` to recall a cached page, the full body is emitted (potentially thousands of tokens). There is no intermediate "give me the gist" path.

**Proposal:** Add a `--head-tail` flag to `token-goat web-output` (and equivalently to bash-output) that returns the first 20 lines + last 20 lines + a `--- N lines omitted ---` marker, mirroring the middle-truncation already used in the manifest's bash-entry formatting (`compact.py::_middle_truncate`). Default the recovery hint's recall suggestion to include `--head-tail` when `body_bytes > 5000`. This is not a context-reduction at injection time but at recall time — the agent gets a useful summary without loading the full page into context.

**Mechanism:** Fires when the agent uses the web-output recall command post-compaction. Expected savings per recall: 500–3000 tokens for typical documentation pages.

**Risks:** If the relevant content is in the middle of the page (neither head nor tail), `--head-tail` misleads. The agent can always issue without the flag for the full body.

**Files touched:** `src/token_goat/cli.py`, `src/token_goat/web_cache.py`, `src/token_goat/hooks_session.py` (recovery hint recall suggestion).

---

### 8. Session brief: merge branch + status into one line, drop "Branch:" and "Recent:" labels — Score 1, Savings: ~15-30 tok/session-start, Cost: S

**Problem:** `_build_session_brief` emits: `## Session Context\nBranch: main | 2 modified, 1 untracked\nRecent: abc1234 fix ... | def5678 ...`. The `## Session Context` header costs 4 tokens. The `Branch:` and `Recent:` labels cost ~3 tokens each. Total label overhead: ~10 tokens that carry no information beyond position.

**Proposal:** Drop `## Session Context`, `Branch:`, and `Recent:` labels. Emit: `main | 2 modified, 1 untracked — abc1234 fix auth | def5678 add tests`. One line, same information, ~10 fewer tokens. When only status exists (no recent commits): `main | 2 modified, 1 untracked`. When only commits exist: `main — abc1234 ...`.

**Mechanism:** Saves ~10–30 tokens at every session start (fires once per session, compactly on the systemMessage path).

**Risks:** Without the `## Session Context` header, the brief might not be visually distinct from other session-start injections. Mitigation: the brief fires as `systemMessage` which already has a structural distinction from `additionalContext`.

**Files touched:** `src/token_goat/hooks_session.py::_build_session_brief`.

---

### 9. Manifest `### Active Skills` emits only skill names when all checklists are inline in recovery — Score 1, Savings: ~50-120 tok/session, Cost: S

**Problem:** The compaction manifest's `### Active Skills` section currently lists each skill with name, size, `×N` count, and a `recall:` command. The recovery hint already inlines the checklist for each skill and provides the recall command. When recovery is going to fire (i.e. session is in a compaction path), the manifest's skills section duplicates the recovery hint's skills section.

**Proposal:** In `compact.py::_render`, when the session has active skills, detect whether the recovery hint path will also fire (check `session.skill_history` non-empty). If so, reduce the skills section to a single summary line: `**Skills:** ralph ×3, improve ×1 — recall via token-goat skill-body <name>`. Skip the per-skill size and checklist excerpt — the recovery hint will cover those. Full per-skill manifest lines only when `skill_history` is empty (meaning the recovery hint won't have anything to inject).

**Mechanism:** Saves ~15–25 tokens per skill × 3–4 skills = 50–100 tokens per compaction that has active skills.

**Risks:** If the recovery hint is suppressed (e.g. low-activity session), the manifest must still carry the full skill info. Guard: fall back to full listing when `_session_activity_score(cache) < _ACTIVITY_FLOOR`.

**Files touched:** `src/token_goat/compact.py`.

---

### 10. Bash-output `--grep` filter: emit match count + 3 context lines instead of all matches — Score 1, Savings: ~200-1000 tok/grep-filtered recall, Cost: S

**Problem:** `token-goat bash-output <id> --grep PATTERN` currently returns all matching lines with no cap. For a `pytest` output with 200 lines containing "WARN", the agent receives all 200 matching lines when it may only need to confirm the pattern exists and see a sample.

**Proposal:** Add `--grep-max N` (default 20) to `bash-output` and `web-output`. When `--grep PATTERN` is combined with `--grep-max N`, emit: (a) `Match count: N`, (b) first `N` matching lines with 1-line context before each. Add `"use --grep-max 0 for all"` footer when truncation fires. Pairs naturally with the `--grep` suggestion already in the bash dedup hint (`"add --grep PATTERN to filter"`).

**Mechanism:** Every `token-goat bash-output --grep` call. Common in post-compact recovery when agents grep test output for specific error patterns.

**Risks:** The agent may miss matches beyond the first 20. The count line compensates: if `Match count: 47` and only 20 lines shown, the agent knows to narrow the pattern.

**Files touched:** `src/token_goat/cli.py`, `src/token_goat/bash_cache.py`.

---

### 11. Pre-Compact: strip duplicate consecutive symbols from the `### Symbols Accessed` section — Score 1, Savings: ~30-80 tok/session, Cost: S

**Problem:** When an agent iterates on a function — reading it, editing it, reading it again — `session.mark_file_read` accumulates the same symbol name multiple times in `symbols_read` (once per `token-goat read` call). The manifest's `### Symbols Accessed` section emits these duplicates, wasting ~5 tokens per duplicate line.

**Proposal:** In `compact.py::_render` (the symbols section), deduplicate `entry.symbols_read` before rendering: `seen = set(); syms = [s for s in entry.symbols_read if not (s in seen or seen.add(s))]`. This preserves order (most-recent first from `_rank_symbols_by_recency`) while dropping repeats. Add a `+N dupes removed` annotation only when `N >= 3` (to inform the compaction LLM that the symbol was accessed repeatedly).

**Mechanism:** Fires on every manifest build for sessions with symbol dedup. Symbol reads are the most common repeated operation in iterative debugging sessions.

**Risks:** None — deduplication is purely a rendering change. The underlying `symbols_read` list is not mutated.

**Files touched:** `src/token_goat/compact.py`.

---

### 12. Image hint: emit an alt-text style 1-line summary after shrink instead of suppressing the path — Score 2, Savings: ~variable (~50-500 tok/large-image session), Cost: M

**Problem:** After image shrinking, the hook redirects the Read to the cached shrunk copy and the agent receives the image content. There is no mechanism to provide a text summary of the image alongside the pixel data, so the agent must "read" the full image context to understand it. For UI screenshots in web projects, the agent often needs to know "this is the login page" or "this shows a TypeScript error" — information extractable from metadata without re-sending the image.

**Proposal:** After `image_shrink.shrink()` succeeds, run a cheap metadata probe: (a) check for XMP/EXIF `Description` or `ImageDescription` tags (Pillow `_getexif`), (b) check if the filename contains semantic keywords (e.g. `screenshot_login`, `error_modal`), (c) check image dimensions to classify as `screenshot` (wide) vs `diagram` (tall). Inject a 1-line `additionalContext` alongside the redirected path: `"[Image: screenshot ~1280×720, filename: login_page.png]"`. This is metadata the agent can use without parsing the full image.

**Mechanism:** Fires on every image Read that triggers shrink. For projects with heavy screenshot usage (UI work), saves the agent from needing to re-examine images already seen.

**Risks:** EXIF extraction can raise on malformed images. Use fail-soft: `try: meta = ...; except: meta = ""`. Never block the image redirect on metadata failure.

**Files touched:** `src/token_goat/image_shrink.py`, `src/token_goat/hooks_read.py`.

---

### 13. Manifest `### Pending Changes` section: skip when `git diff` is already inlined per-file — Score 1, Savings: ~30-80 tok/session, Cost: S

**Problem:** `_render` emits both a `### Pending Changes` section (from `_get_git_diff_stat_summary` — the whole-repo stat) AND per-file inline diffs (from `_get_inline_diff_for_file` / `_get_whole_repo_diff`). When per-file diffs are successfully inlined, the `### Pending Changes` stat section is redundant — it repeats the same files with less information (just `+/-` counts, not the actual hunks).

**Proposal:** In `_render`, gate the `### Pending Changes` section emission on `not any_inline_diffs_emitted`. Track with a boolean `_inline_diffs_were_emitted` set during the `### Files Edited` pass. If at least one per-file diff was inlined, skip the whole-repo stat section. If no inline diffs were produced (files too large, no snapshot, not a git repo), fall back to the stat section as today.

**Mechanism:** Saves the `_get_git_diff_stat_summary` output (~6 lines × 8 tokens) for every session that has at least one small-enough edited file with a snapshot. Expected frequency: most iterative coding sessions.

**Risks:** If the inlined diff covers only 1 of 5 edited files, skipping the stat section loses context about the other 4. Mitigation: only skip when `len(inline_diff_files) >= len(edited_clean) - 1` (i.e. all-but-one or all files have inline diffs).

**Files touched:** `src/token_goat/compact.py::_render`.

---

### 14. Web dedup hint: when body is >10 KB, suggest `--grep` upfront (not just at `bash_dedup`) — Score 1, Savings: ~50-200 tok/web-heavy session, Cost: S

**Problem:** The bash dedup hint already suggests `--grep PATTERN` for large outputs (>5 KB, see `_BASH_DEDUP_GREP_SUGGEST_BYTES`). The web dedup hint (`_build_web_dedup_hint_inner`) does not have an equivalent; it always suggests `token-goat web-output <id>` without a grep qualifier. Agents fetching large documentation pages (MDN, GitHub raw files) receive a hint that, if acted on, will dump thousands of tokens into context.

**Proposal:** In `_build_web_dedup_hint_inner` (hints.py), add a size-threshold check mirroring the bash path: when `entry.body_bytes >= 5000`, append `" (add --grep PATTERN to filter)"` to the recall command in the hint text. Use the same `_BASH_DEDUP_GREP_SUGGEST_BYTES` constant for consistency. One 5-token addition that redirects to a much cheaper recall path.

**Mechanism:** Fires on every web dedup hint for large pages. Web fetches of documentation are typically 10–100 KB, so the threshold fires frequently in web-heavy sessions.

**Risks:** None — advisory only.

**Files touched:** `src/token_goat/hints.py::_build_web_dedup_hint_inner`.

---

### 15. `token-goat section` output: strip the file path header when caller already knows the file — Score 1, Savings: ~10-30 tok/surgical-read call, Cost: S

**Problem:** `token-goat section "pyproject.toml::tool.ruff"` emits a header line like `## pyproject.toml — section: tool.ruff` before the section content. This is redundant when the agent issued the command with the exact path and section name — the agent already knows both. The header costs ~10 tokens.

**Proposal:** Add `--no-header` flag (default False) to `token-goat section` and `token-goat read`. When the agent issues the command programmatically (rather than a human reading terminal output), it will want `--no-header` to avoid paying for context it already has. Additionally, make `--no-header` the default when the output is being captured (i.e. `sys.stdout.isatty()` is False) — hook and agent usage always captures, so header is suppressed by default in those paths.

**Mechanism:** Fires on every `token-goat section/read` call issued from agent context. Typical session: 10–30 surgical reads × 10 tokens header = 100–300 tokens.

**Risks:** If the agent's context doesn't have the file path (e.g. it piped output somewhere), `--no-header` loses the anchor. The TTY detection heuristic is the same pattern used by many CLI tools (ripgrep, fd) for color/formatting decisions.

**Files touched:** `src/token_goat/cli.py`, `src/token_goat/read_commands.py`.

---

### 16. `compact.py`: merge Files Edited + Key Files Read into one section when overlap >= 50% — Score 2, Savings: ~60-150 tok/session, Cost: M

**Problem:** The manifest has two separate file sections: `### Files Edited` and `### Key Files Read`. When a session edits a file and also reads it frequently (the typical iterative coding pattern), the same filename appears in both sections. With 5 edited files and 8 key reads, if 4 of the 5 edited files are also in the top 8 reads, the same 4 paths are listed twice — paying ~13 tokens per path × 4 = 52 tokens of duplication.

**Proposal:** In `_render`, after computing `edited_clean` and the top `files_read` candidates, check overlap: `overlap = set(edited_clean) & set(f.rel_or_abs for f in files_read_top)`. If `len(overlap) / max(len(edited_clean), 1) >= 0.5`, merge into a single `**Files (edited+read):**` section, listing each path once with a combined annotation: `✎×2 →×5` (edited twice, read 5 times). Files only edited but not read get `✎` only; files only read get `→` only. This replaces two sections with one, saving the duplicate lines and one section header.

**Mechanism:** Fires whenever the agent's top reads overlap substantially with its edits — the common iterative pattern. Expected frequency: most non-trivial coding sessions.

**Risks:** Combined section changes the established `### Files Edited` format the compaction LLM has been trained (via repeated sessions) to parse. Mitigation: keep the combined section name clearly marked and retain `✎` glyph which already appears in the existing legend.

**Files touched:** `src/token_goat/compact.py::_render`, `src/token_goat/compact.py::_format_*` helpers.

---

### 17. `hooks_common.py`: short-circuit `record_hint_stat_pair` when `tokens_saved == 0` — Score 1, Savings: ~2-5 ms/session (latency), Cost: S

**Problem:** `record_hint_stat_pair` writes two stat rows to SQLite (`db.record_stat`) for every hint: one for the hint injection overhead and one for the tokens saved. For suggestion hints (`tokens_saved == 0` — large-file nudges, lockfile hints), both rows carry zero saving. The two SQLite writes happen on the hot pre-read path (every `pre_read` call) and add measurable latency even on NVMe (~0.5–1 ms each on WAL-mode SQLite).

**Proposal:** In `hooks_common.py::record_hint_stat_pair`, add a guard: `if tokens_saved == 0 and injection_tokens == 0: return`. Also add a config gate `[stats] record_zero_savings = false` (default false) that skips zero-saving stat rows entirely. Zero-saving hints already accumulate as noise in the stats DB over time; the agent-visible count would be unchanged (hints emitted is tracked in `session.hints_emitted` not the stat DB).

**Mechanism:** Reduces SQLite writes on every `pre_read` call. Frequency: every Read in every session. Zero-saving hints (large-file index hints, lockfile hints) are the most common hint type.

**Risks:** Suppressing zero-saving stat rows means `token-goat stats` will undercount "hints emitted". Document that the session-JSON `hints_emitted` counter is the authoritative source for hint count; the stat DB tracks realized savings only.

**Files touched:** `src/token_goat/hooks_common.py`.

---

### 18. Bash compress: add a `--ruff` / `--mypy` filter to compress linting output — Score 2, Savings: ~500-3000 tok/lint-heavy session, Cost: M

**Problem:** `bash_compress.py` has filters for `pytest`, `npm`, `docker`, `cargo`, `kubectl`, and `uv`. It does not have filters for `ruff check` or `mypy`. Both produce verbose output: ruff emits one line per violation with full path + rule code + message; mypy emits similar per-file per-violation lines. A session that runs `ruff check` or `mypy src` before committing can produce 50–200 lines of output. The agent needs the error lines but not the repeated file paths or the `Found N errors` footers repeated per sub-package.

**Proposal:** Add `RuffFilter` and `MypyFilter` classes in `bash_compress.py` following the existing `Filter` base class pattern. `RuffFilter`: deduplicate same-rule violations across files into a summary (`E501: 23 occurrences in 8 files`), keep all unique rule codes with 1 representative example each, keep the final `Found N errors` line. `MypyFilter`: group errors by file, keep per-file error lines, suppress `Success: no issues found` repetition in multi-package runs. Register in `FILTERS` dict with binary name detection (`ruff`, `mypy`).

**Mechanism:** Fires on every `ruff check` or `mypy` invocation. Lint runs are among the highest-volume bash outputs in Python development sessions.

**Risks:** Compressing linting output may hide error context the agent needs (e.g. the full line of code that triggered E501). Mitigation: keep 1 full example per rule code; suppression only applies to repeated violations of the same rule.

**Files touched:** `src/token_goat/bash_compress.py`, `tests/test_bash_compress.py`.

---

### 19. Per-session Glob result cache: dedup repeated Glob patterns within one session — Score 1, Savings: ~50-200 tok/session, Cost: S

**Problem:** `build_glob_dedup_hint` checks `cache.globs` for the same `(pattern, path)` pair. This dedup fires at hint-generation time but the underlying Glob result is not cached to disk — the agent still re-runs the glob and receives the full result again. The hint is advisory only. For a pattern like `**/*.py` in a large project (300 files), a re-run pours 300 paths into context.

**Proposal:** Add Glob result caching to `bash_cache` (reuse existing infrastructure): in `post_read`, when `tool_name == "Glob"`, write the results list to `bash_cache` with `cmd_sha = glob_hash(pattern, path)`. In `pre_read` (glob path), when the same pattern fires within `STALE_READ_AGE_SECONDS`, instead of a hint, return the cached result via `hookSpecificOutput` with `toolResult` override. This converts the advisory dedup hint into an actual result dedup (same pattern as bash output caching).

**Mechanism:** Fires on repeat Glob calls within a session. Most common: `**/*.ts` or `**/*.py` pattern run multiple times during exploration. Each avoided re-glob saves the full file list from landing in context again.

**Risks:** Cached glob results go stale when files are added/deleted. Mitigation: invalidate the glob cache entry on any `PostToolUse(Edit|Write)` that creates a new file (detectable when `tool_name == "Write"` and path is new in `edited_files`).

**Files touched:** `src/token_goat/hooks_read.py`, `src/token_goat/bash_cache.py`, `src/token_goat/session.py`.

---

### 20. Recovery hint: emit the most-recent green test run inline as 1 line, not as a bash recall pointer — Score 1, Savings: ~30-80 tok/session, Cost: S

**Problem:** The recovery hint's `**Bash**:` section lists cached bash outputs including green pytest runs as recall pointers (`token-goat bash-output <id>`). The compaction manifest's `### What Worked` section already emits a 1-line "pytest passed @ HH:MM" summary for the last 2 green runs. Post-compaction, the recovery hint redundantly points the agent at the same cached output — the agent already knows "tests passed" from the manifest; the recall pointer adds overhead without additional signal.

**Proposal:** In `_build_recovery_hint`, for bash entries where `exit_code == 0` AND `cmd_preview` matches pytest-like patterns, replace the full recall-pointer line with a 1-line inline: `"✓ pytest passed @ HH:MM"`. Skip the `output_id` entirely for these entries. Only emit the full recall pointer for green runs when `session_activity_score` is high (the agent may want to inspect the exact output for diff analysis).

**Mechanism:** Saves ~15–20 tokens per green bash entry in the recovery hint. Sessions that have 2–3 green pytest runs contribute 30–60 tokens of savings.

**Risks:** If the agent needs to inspect what tests ran (not just that they passed), the inline summary is insufficient. Mitigation: always include `(use token-goat bash-output <id> for details)` in the inline line, but as a short suffix rather than as the primary pointer.

**Files touched:** `src/token_goat/hooks_session.py::_build_recovery_hint`.

---

### 21. `compact.py`: use a `bytearray` accumulator instead of `list[str]` + `"\n".join` for manifest assembly — Score 1, Savings: ~1-5 ms latency per manifest build, Cost: S

**Problem:** `_render` builds the manifest by appending strings to `sections: list[str]` and joining with `"\n\n".join(parts)`. For a 400-token manifest (~1200 chars), the join creates a final copy of the entire string. With N sections, the intermediate list holds N separate string objects. Python's `str.join` is already efficient but for a frequently-called path (every PreCompact invocation) the extra allocation matters.

**Proposal:** Convert the manifest assembly to use `io.StringIO` (write-buffer pattern): `buf = io.StringIO(); buf.write(section); buf.write("\n\n")`. Call `buf.getvalue()` at the end. This avoids the N-object intermediate list and the final join copy. Alternatively, use a single `bytearray` + `decode` at the end for maximum efficiency on the Windows hook subprocess path.

**Mechanism:** Reduces manifest assembly allocations. Not a token savings — a latency saving on the most time-sensitive hook path (PreCompact blocks compaction LLM startup).

**Risks:** Minimal. `io.StringIO` is stdlib; the change is mechanical. Test coverage in `test_compact.py` catches correctness.

**Files touched:** `src/token_goat/compact.py::_render`.

---

### 22. Skill-body recall: add `--section <heading>` flag to `token-goat skill-body` — Score 2, Savings: ~2000-10000 tok/skill-recall, Cost: M

**Problem:** `token-goat skill-body <name>` returns the full skill body (default head+tail view, `--full` for everything). A skill like `ralph` is 28 KB. The agent post-compaction uses the recovery hint's checklist excerpt (3 lines) to confirm the skill is relevant, then calls `skill-body` to get the full body — receiving 28 KB when it actually needs only the `## DoD Gates` section (1–2 KB) to continue its work.

**Proposal:** Add `--section <heading>` to `token-goat skill-body`, implemented using the existing `read_replacement.section_extract` function (already used for structured config section reads). `token-goat skill-body ralph --section "DoD"` returns only the `## DoD` section of the cached body. Also emit a `**Sections available:**` line listing H2 headings when the flag is absent, so the agent can discover the section names before deciding which to fetch. The recovery hint's `recall:` suggestion would be updated to include the section-name hint: `"token-goat skill-body ralph --section DoD"` instead of the full recall command.

**Mechanism:** Every post-compact skill recall where the agent only needs one section of a large skill body. Expected frequency: common — Ralph, improve, superman all have distinct `## DoD` / `## Steps` / `## Checklist` sections.

**Risks:** `section_extract` relies on H2 headers in the skill body. Skills without clear H2 headers fall back to the full body (no regression). The `--section` flag is additive.

**Files touched:** `src/token_goat/cli.py`, `src/token_goat/skill_cache.py`, `src/token_goat/read_replacement.py`, `src/token_goat/hooks_session.py` (recovery hint).

---

### 23. Manifest budget: reduce `_MAX_FILES_READ` from 10 to 6 when `edited_files` count >= 5 — Score 1, Savings: ~50-130 tok/heavy-edit session, Cost: S

**Problem:** `_MAX_FILES_READ = 10` is a fixed constant. In sessions with many edits (5+ files), the `### Files Edited` section already consumes ~70 tokens of the 400-token budget. The `### Key Files Read` section then adds up to 10 more entries (each ~13 tokens) for a total of 130 tokens — 33% of the budget. The "key files read" section has diminishing value when the edited files section already covers the most important context.

**Proposal:** In `build_manifest_adaptive` or `_render`, compute a dynamic `max_files_read`: when `len(edited_clean) >= 5`, set `max_files_read = 6`; when `len(edited_clean) >= 10`, set `max_files_read = 4`. Pass the dynamic value to `heapq.nlargest` in the files-read selection. This preserves the most-read files while freeing budget for the symbols, bash, and skill sections that provide higher signal in heavy-edit sessions.

**Mechanism:** Fires in any session editing 5+ files — typical of refactoring passes, feature implementation, or test-fix cycles. Most agentic sessions that use Ralph or /improve qualify.

**Risks:** The agent may lose a key file from the manifest. Mitigation: edited files are always listed in `### Files Edited` regardless of this cap, so the agent retains paths to all touched files; only non-edited reads are trimmed.

**Files touched:** `src/token_goat/compact.py`.

---

### 24. Inject a `token-goat map --compact` pointer instead of per-file symbol lists when session reads >15 unique files — Score 2, Savings: ~200-500 tok/wide-read session, Cost: M

**Problem:** The `### Symbols Accessed` section of the manifest emits per-file symbol lists (up to `_MAX_SYMBOLS_FILES = 8` files, `_MAX_SYMBOLS_PER_FILE_ENTRY = 6` symbols each). For a wide session that reads 20+ files, this section can consume 200–300 tokens listing symbol names the compaction LLM will struggle to keep in mind anyway. The agent post-compact gets a long symbol list that it then uses to re-read files — the extra specificity doesn't save tool calls.

**Proposal:** In `_render`, count `len(cache.files)`. When `>= 15`, replace the full per-file symbol section with a single line: `"**Symbols:** 15 files accessed — use \`token-goat map --compact\` to re-orient."` This informs the compaction LLM that broad context was in use, without wasting budget on symbol lists it can't act on. The threshold 15 is configurable via `[compact] wide_session_file_threshold` in config.toml.

**Mechanism:** Fires on wide sessions (many-file reads, typical of codebase orientation or large refactors). The replaced section saves ~100–300 tokens while providing the actionable re-orientation pointer.

**Risks:** Symbol information is lost from the compaction manifest in wide sessions. Mitigation: the `### Files Edited` section and git diff still provide the highest-signal context; symbol lists are secondary context that the agent can regenerate via `map`.

**Files touched:** `src/token_goat/compact.py::_render`.

---

### 25. `token-goat resume <session>` — single-command post-compact restoration packet — Score 3, Savings: ~500-2000 tok/session (eliminates 5-10 recall round-trips), Cost: L

**Problem:** Post-compaction, the agent typically issues 3–8 separate commands to restore context: `token-goat skill-body <name>` (×1–3), `token-goat bash-output <id>` (×1–3), reads the top edited files, possibly runs `token-goat map`. Each command costs a tool-call round-trip: prompt overhead (~50–150 tokens) plus the output tokens. With 5 round-trips, the agent spends ~500–1000 tokens in overhead before it has restored its working context.

**Proposal:** Implement `token-goat resume <session_id>` in `cli.py` backed by a new `resume.py` module. The command: (1) loads the session cache, (2) outputs skill checklists inline (via `skill_cache.extract_checklist_section`, up to 400 chars each, max 3 skills), (3) outputs the last 2 bash outputs head+tail (20 lines each), (4) outputs per-file diffs for the top 2 edited files (from `_get_inline_diff_for_file`), (5) outputs the current git diff stat summary. Total output: 600–1200 tokens. One tool call replaces 5–10. The recovery hint's `## Post-Compact Recovery` section would mention `token-goat resume <short_id>` as the recommended restoration shortcut. The session_id is emitted in 8-char short form in the recovery hint.

**Mechanism:** Replaces 5–10 post-compact tool calls with 1. Frequency: every compacted session that the agent tries to restore context in. This is the highest-leverage item in the list if adoption is high.

**Risks:** The output bundle may include stale content (bash output from 45 minutes ago, diff on a file that has since changed again). Mitigation: add freshness annotations to each section (`"as of HH:MM"`). The agent can override any section with the targeted recall command. Size cap: hard-cap the total output at 2000 tokens (`_MAX_RESUME_TOKENS`) to prevent the "one command but 10K tokens of output" failure mode.

**Files touched:** `src/token_goat/cli.py`, new `src/token_goat/resume.py`, `src/token_goat/hooks_session.py` (recovery hint pointer), `src/token_goat/skill_cache.py`, `src/token_goat/compact.py` (reuse `_get_inline_diff_for_file`).

---

## Scoring summary

| # | Title | Score | Savings est. | Cost |
|---|-------|-------|--------------|------|
| 1 | Manifest SHA cache across compactions | 2 | 300–600 tok/multi-compact | M |
| 2 | Defer recovery hint to first post-compact Read | 2 | 150–400 tok/compact | M |
| 3 | Manifest: replace ### headers with bold labels | 1 | 40–100 tok/session | S |
| 4 | Codex denormalize_response fast-path | 1 | latency only | S |
| 5 | Cross-session Grep pattern dedup | 2 | 80–250 tok/session | M |
| 6 | Repomap --compact drops file-list preamble >50 files | 1 | 100–300 tok/map call | S |
| 7 | web-output --head-tail for large bodies | 1 | 100–400 tok/recall | S |
| 8 | Session brief: drop "Branch:" / "Recent:" labels | 1 | 15–30 tok/session | S |
| 9 | Skills manifest section: collapse to summary line | 1 | 50–120 tok/session | S |
| 10 | bash-output --grep with --grep-max N cap | 1 | 200–1000 tok/recall | S |
| 11 | Manifest: dedup consecutive symbols in section | 1 | 30–80 tok/session | S |
| 12 | Image hint: alt-text metadata alongside shrink | 2 | 50–500 tok/image session | M |
| 13 | Skip ### Pending Changes when inline diffs present | 1 | 30–80 tok/session | S |
| 14 | Web dedup hint: suggest --grep for large bodies | 1 | 50–200 tok/web session | S |
| 15 | section/read --no-header default in non-TTY | 1 | 10–30 tok/surgical read | S |
| 16 | Merge Files Edited + Key Files Read at >=50% overlap | 2 | 60–150 tok/session | M |
| 17 | Skip zero-saving record_hint_stat_pair writes | 1 | latency only | S |
| 18 | ruff + mypy bash compress filters | 2 | 500–3000 tok/lint session | M |
| 19 | Glob result caching (not just dedup hint) | 1 | 50–200 tok/session | S |
| 20 | Recovery hint: inline green test result, skip pointer | 1 | 30–80 tok/session | S |
| 21 | Manifest assembly: StringIO instead of list+join | 1 | latency only | S |
| 22 | skill-body --section <heading> flag | 2 | 2000–10000 tok/skill recall | M |
| 23 | Dynamic _MAX_FILES_READ based on edit count | 1 | 50–130 tok/heavy-edit session | S |
| 24 | Map pointer instead of symbol list in wide sessions | 2 | 200–500 tok/wide session | M |
| 25 | token-goat resume <session> restoration packet | 3 | 500–2000 tok/compact session | L |

**Score distribution:** 15 Score-1, 8 Score-2, 2 Score-3.

---

## Intersection clusters

**Cluster E: "One call, full restoration"** — items 2 (deferred recovery), 22 (skill-body --section), 25 (resume command). All address the same problem: post-compact the agent makes multiple tool calls to rebuild context. Items 22 and 25 are the content side; item 2 is the timing side. Together they reduce post-compact tool-call overhead from 5–10 calls to 1–2.

**Cluster F: "Manifest structural compression"** — items 3 (header labels), 11 (symbol dedup), 13 (skip redundant stat), 16 (merge sections), 23 (dynamic file cap), 24 (map pointer). All reduce tokens within the manifest without reducing information value. Together they could free 200–400 tokens of manifest budget for higher-signal content.

**Cluster G: "Recall precision"** — items 7 (web-output head-tail), 10 (bash-output grep-max), 22 (skill-body section). All add precision-access flags to recall commands, preventing the agent from receiving thousands of tokens when it needs a targeted slice.

**Cluster H: "Cross-boundary dedup"** — items 1 (manifest SHA cache across compactions), 5 (cross-session grep dedup), 19 (glob result caching). All extend dedup beyond the single-session boundary. The previous design doc's dedup items were all intra-session.

---

## Riskiest bets

The riskiest assumption underlying items 3, 9, 16, and 24 is that the compaction LLM will parse bold labels as well as H3 headers, and will correctly identify the merged `Files Edited+Read` section without being confused by the new format. This can be tested cheaply by running `token-goat compact-hint` before and after and manually inspecting a compacted session for context preservation. Items 22 and 25 are the moonshots — their value depends entirely on the agent using the `--section` flag and `resume` command, which requires the recovery hint to surface the suggestions clearly enough that the agent prefers them over its default re-read behavior.
