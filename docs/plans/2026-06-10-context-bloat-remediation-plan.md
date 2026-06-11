# Context-Bloat Remediation Plan

**Date:** 2026-06-10
**Status:** Ready for execution
**Source:** Five-loop audit of all saved Claude Code transcripts (4,079 files, 2.97 GB, ~465M est content tokens, 2026-04-28 → 2026-06-09), with two adversarial verification passes. Full per-agent stats were persisted to `%TEMP%\tg-context-audit\{agent1..agent7,verifyA,verifyB,verify2}\findings.md` — these are OS temp files and may be gone; every number needed to execute is inlined below.

This plan is written to be executed by an agent with **no access to the originating conversation**. Each task is self-contained: evidence, implementation sketch, files, and acceptance criteria.

---

## Verified findings the plan rests on

All numbers survived independent re-measurement by adversarial verifiers (fresh scripts, <15% tolerance unless noted). Token estimates are `chars / 4`, not tokenizer-exact.

| Fact | Verified number |
|---|---|
| True per-API-call floor before 2026-06-09 cleanup | ~30K tok (~15% of window) |
| `token-goat baseline` after Vercel plugin disable (done 2026-06-09) | 3,677 tok reported (CLAUDe.md global 2,871 + project 806) — but baseline v1 does **not** cost skill listing or MCP schemas, so true floor is still ~15K |
| Skill listing attachment | ~11,575 tok avg, injected into every session **and** every subagent spawn; 48.3M tok historical, 42.4M byte-identical repetition; ~71 tok per skill entry |
| Skills: listed vs used | 91 user skill dirs + plugin skills (~125 listed); only **25 distinct skills ever invoked** (1,865 calls). Top: ralph 669, humanizer 487, marketing 280, token-goat 234 |
| Zero-usage plugins | searchfit-seo (17 skills, ~1,082 tok/listing), stripe, claude-md-management, skill-creator, feature-dev, security-guidance, frontend-design duplicate (from `claude-code-plugins` marketplace) — 0 invocations each |
| Zero-usage MCP | gitnexus (user-level `mcpServers` in `~/.claude.json`): 0 calls ever. Canva / Gmail / Google Calendar connectors: 0 calls. context7: 9 calls. playwright: 98 calls vs chrome-devtools 745 (overlapping capability) |
| In-session repeated-Read waste | 29.7M tok; **~11.6M genuinely addressable** (byte-identical + contained + overlapping windows of unchanged files); rest is legitimate paging of files too large to read whole |
| Hint efficacy | Hints are advisory; re-reads happened **3,044 times after a hint on the same file in the same session**; historical denials: 0 |
| Cross-session re-read waste | 42.7M tok = 21.0M byte-identical dup results in ≥2 transcripts + 21.7M near-identical full-file re-reads. Top files: `twilight-forgotten-coven/research/canon-brief.md` (372K wasted / 32 transcripts), `marketing/tactics.md` (191K / 11), `rhetoric.md` (131K / 7), `foundations.md` (52K / 13) — all stable reference .md |
| MCP screenshot gap | 176 `take_screenshot` calls, 6.89M tok model-visible, avg ~39K/call. `hook_registry.py` PreToolUse matchers are exactly `Read\|Grep\|Glob\|Bash`, `mcp__claude_ai_Google_Drive__.*\|WebFetch`, `Skill` — nothing matches chrome-devtools/playwright; `image_shrink` fires only via the `pre_read` file_path rewrite (`hooks_read.py:347` at audit time) |
| Skill-compaction gaps | token-goat compacts **repeat** Skill-tool loads to ≤600 tok (`skill_cache.py`, ~line 307) and blocks repeats via `pre_skill` additionalContext. NOT covered: (a) post-compaction re-loads — **dedup explicitly disarms once compaction fires**; (b) first-load isMeta skill bodies (26.3M historical) — harness-injected, not hook-modifiable; (c) harness-side `invoked_skills` re-injection after compaction (14.2M) — needs upstream |
| Subagent hint delivery | **Working — no action.** Hooks did not run inside subagents before Claude Code's ~June 6–8 update (hence 22,629 historical unhinted subagent re-reads). Verified live on June 9: PreToolUse hooks fire in subagents, the read-cache is shared via the parent session_id (`session.py:1113`), hints reach the subagent model |
| Compaction pressure | 56% of main sessions compact ≥1×; 92–93 sessions ≥5×; max 182 in one session; floor re-pays after every compaction |

## Explicitly out of scope (verified non-opportunities — do not build)

- **Transcript disk pruning** (`toolUseResult` 71.6M, `hook_success` Pre/PostToolUse stdout, file-history snapshots, Drive `mcpMeta` base64): transcript/disk-only, never reaches the model.
- **User-pasted image shrinking** (9.6M historical): lives in user message content; not hook-reachable.
- **Subagent read-cache propagation**: already works upstream (see table). Do not implement.

---

## Execution conventions (apply to every code task)

- Repo: `C:\Projects\token-goat`. Read source surgically (`token-goat symbol NAME`, `token-goat read "file::symbol"`, `token-goat semantic "query"`), not whole-file Reads.
- `uv sync --all-extras` before any push (mypy needs types-psutil). Lint: `uv run ruff check --fix`; types: `uv run mypy src`; tests: `uv run pytest -m "not slow"` for the dev loop, full suite must pass before push. Validate on WSL too (`UV_PROJECT_ENVIRONMENT=/tmp/tg-linux-venv`) — Windows-only green has produced false positives before.
- Hint/deny wording is coupled to tests: **assert concepts, not exact strings**, and `rg` any old hint text across `tests/` before committing a wording change.
- In `hooks_read.py::pre_read`, any new generic size/content-gated deny must be a **fallback after the type-specific handlers** (skill/index/structured/diff); the only early-preempt exception is the ≥10 MB catastrophic tier via the `floor` param. Place new handlers accordingly.
- Collapse multi-line code comments into one `#` line (E501 is off).
- One commit per task, descriptive messages, **no Co-Authored-By / Claude attribution, no iteration counters**. Bug fixes ship with their regression test in the same commit. After committing code: `uv tool install --reinstall` so the live binary updates. Do not push or release without the user's go-ahead.
- Config knobs go in `config.py` with defaults documented in README's config section; CHANGELOG entry under `[Unreleased]` per task.

---

## Task 1 — Prune the dead skill/plugin/MCP inventory (config only, no repo code)

**Goal:** cut ~13.7K tok from every session floor and every subagent spawn. Highest value, zero code.

**Steps:**
1. **Derive the keep-list from data, not memory.** Stream all `*.jsonl` under `C:\Users\zelys\.claude\projects\` with a small Python script (never Read a .jsonl whole — files reach 174 MB) and collect distinct `Skill` tool_use input names. Expect ~25 (ralph, humanizer, marketing, token-goat, improve, brainstorming, superman, codex, oss-pr-contribution, wcag, update-config, …). When in doubt, keep.
2. **Archive (never delete) unused user skills:** create `C:\Users\zelys\.claude\skills-archive\` and move every skill dir in `C:\Users\zelys\.claude\skills\` not on the keep-list (~60+: game-dev ×14, cloudflare ×8, seo/marketing ×11, react/frontend ×12, misc). Moving a dir out of `~/.claude/skills` delists it (verified). Exceptions: keep `engineering-foundations` (declared dependency of superman/ralph) even though it is never invoked directly. `tokenwise` is a stale duplicate of the `token-goat` skill — archive it.
3. **Disable zero-use plugins** in `C:\Users\zelys\.claude\settings.json` → `enabledPlugins`: searchfit-seo, stripe, claude-md-management, skill-creator, feature-dev, security-guidance, and the duplicate frontend-design from the `claude-code-plugins` marketplace (keep the official one). Verified semantics: disabling delists the plugin's skills and stops its MCP/hooks. Confirm `vercel@claude-plugins-official` is still `false`.
4. **Remove dead MCP:** `claude mcp remove gitnexus -s user` (it is the sole user-level `mcpServers` entry in `C:\Users\zelys\.claude.json`). The Canva/Gmail/Google-Calendar claude.ai connectors (0 calls) disconnect via claude.ai settings or `/mcp` — if not reachable from CLI, list them in the report for the user to click through.
5. **Flag for user decision, do not act unilaterally:** disabling context7 (9 lifetime calls) and playwright (98 calls, capability overlaps chrome-devtools at 745 calls).

**Acceptance:** skill dir count in `~/.claude/skills` drops to ≈ keep-list size; archived dirs intact in `skills-archive`; `enabledPlugins` shows the seven plugins false; `claude mcp list` no longer shows gitnexus; a fresh session's `token-goat baseline` floor does not regress; short report of before/after counts.

---

## Task 2 — Escalate re-read hints to deny-redirect for known-content reads (feature)

**Goal:** convert the advisory hint into a deny when the requested content is provably already in context. Targets the ~11.6M addressable in-session waste; hints alone were ignored 3,044 times.

**Design sketch:**
- In `pre_read`, when a Read targets a file whose session-cache entry (`session.py`) shows the requested window is **byte-identical or fully contained** in line ranges already read this session AND the file is unchanged (SHA/mtime check — the worker already SHA-checks), deny with a redirect message: which earlier read covers it (line ranges), plus the surgical alternative (`token-goat read "file::symbol"` / `offset`/`limit` for just the delta).
- If the file changed since the last read, do not deny — serve the existing diff-hint path.
- Anti-loop guard: track denials per (session, path, window); allow the read through on the second identical attempt so a model that genuinely needs it is never hard-blocked. Mirror the 1.6.0 `large_read_redirect_bytes` deny-redirect pattern and its tests.
- Config: `[hints] reread_deny = true` (default on), plus a threshold so trivial small files (< ~2 KB result) are never denied — denying tiny reads costs more goodwill than tokens.
- Respect pre_read handler ordering (see conventions): this is a type-specific handler, not the generic fallback.

**Files:** `hooks_read.py` (pre_read), `session.py` (read-range bookkeeping — line_ranges already stored), `hints.py` (message text), `config.py`, README config table, tests (`test_hooks_read*`, new regression tests for: contained-window deny, changed-file pass-through, second-attempt pass-through, small-file exemption, subagent shared-cache deny).

**Acceptance:** full suite + WSL green; a scripted scenario (read file → read same window again) yields a deny with redirect on attempt 1 and pass-through on attempt 2; CHANGELOG entry.

---

## Task 3 — MCP screenshot deny-redirect (feature, small)

**Goal:** close the verified guard gap: screenshot results average ~39K tok and bypass every hook.

**Design sketch:**
- Add a PreToolUse matcher for screenshot-producing MCP tools: `mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot` and the playwright equivalent (`mcp__plugin_playwright_playwright__browser_take_screenshot`) — pattern them loosely (`mcp__.*take_screenshot|mcp__.*browser_take_screenshot`) so plugin-name prefixes don't break the match. Docs confirm regex matchers on MCP tool names work; token-goat already matches `mcp__claude_ai_Google_Drive__.*`.
- Handler: if the call does not already pass a `filePath`/save-to-disk argument, deny with redirect: "re-call with filePath=<suggested temp path>, then Read the file" — the Read then flows through the existing image-shrink path. If the tool input already saves to disk, allow.
- Keep it advisory-free: this is a deny, modeled on the oversized-read deny tier.

**Files:** `hook_registry.py` (new matcher), a small handler module or extension of the image path in `hooks_read.py`/`image_shrink.py`, `config.py` knob (`[images] screenshot_redirect = true`), tests covering: deny without filePath, allow with filePath, non-screenshot MCP tools unaffected.

**Acceptance:** full suite + WSL green; matcher verified against the live tool names in `~/.claude/plugins` manifests; CHANGELOG entry.

---

## Task 4 — Re-arm skill dedup after compaction (feature, small-medium)

**Goal:** the audit found dedup **explicitly disarms once compaction fires**, so post-compaction Skill re-loads pay full body cost again (part of the 14.2M invoked_skills + repeat-load pool). Serve the ≤600-tok compact instead.

**Design sketch:**
- Locate the disarm (in/near `skill_cache.py` ~line 307 and `pre_skill`). Rationale for the disarm was presumably "after compaction the body is gone from context, a re-load is legitimate." That holds for the FIRST post-compaction load of a skill the model actively needs — but the PreCompact manifest already carries an "Active Skills" section, and the harness re-injects invoked_skills itself. So: after compaction, on a repeat Skill load, serve the compact (with a pointer to where the full body lives) instead of the full body; allow one full load per skill per compaction epoch only if the compact is judged insufficient (config: `[skills] post_compact_full_loads = 0|1`).
- Do NOT attempt to intercept first-load isMeta bodies or the harness invoked_skills attachment — verified not hook-modifiable; that slice is upstream's.

**Files:** `skill_cache.py`, `hooks_skill.py`/`pre_skill` path, `config.py`, tests: dedup stays armed across a simulated compact boundary, compact served on post-compaction repeat, epoch counter resets per compaction.

**Acceptance:** regression test that fails on pre-fix behavior (dedup disarmed after compact) and passes after; full suite + WSL green; CHANGELOG entry.

---

## Task 5 — `baseline` v2: cost the skill listing and MCP schemas (feature)

**Goal:** baseline currently reports 3,677 tok while the true floor is ~15K because it ignores the skill listing (~71 tok × listed skills, ≈6.4K currently) and MCP/deferred tool schemas. This also delivers the deferred Phase-2 "loaded-but-unused MCP detection" with real data behind it.

**Design sketch:**
- Add attribution rows: (a) **skill listing** — enumerate `~/.claude/skills` dirs + enabled plugins' skills, estimate per-entry cost from name+description length (audit-measured avg 71 tok/entry); (b) **MCP servers** — enumerate configured servers (user `~/.claude.json`, enabled plugin manifests, project `.mcp.json`) and estimate schema cost per server; mark each with a per-session AND per-subagent-spawn multiplier note (the listing re-pays on every spawn — historically 3,684 spawns cost 48M tok).
- Optional `--usage` flag: scan local transcripts for `mcp__<server>__` calls and Skill invocations, annotate each row with calls-ever / last-used, and flag zero-use items as removal candidates. Keep the scan streaming and bounded (this is the same scan Task 1 step 1 does — factor it into a shared helper if clean).
- Keep `baseline` read-only; the threshold-gated SessionStart advisory inherits the new totals automatically — verify the budget comparison still behaves.

**Files:** `baseline.py`, `cli.py`, `config.py` if a knob is needed, `tests/test_baseline.py` (29 existing tests — extend, don't weaken), README baseline section, CHANGELOG.

**Acceptance:** `token-goat baseline` shows listing + MCP rows with sane numbers on this machine; `--usage` flags gitnexus-style zero-use servers when present; tests cover empty-skills-dir, plugin-disabled, and usage-flag paths; full suite + WSL green.

---

## Task 6 — Stable-doc compact serving (needs design first — run /brainstorming, Standard gear)

**Goal:** address the 42.7M cross-session pattern: large stable reference .md files (book canon, methodology docs) re-read at the start of every session in writing-heavy projects.

**Critical design constraint discovered in the audit:** a naive cross-session cache CANNOT save context — each new session has an empty window and genuinely needs the content once. The only real savings are (a) serving a **compact/summary** of a known-stable doc on first read (analogous to skill compacts), with full read on request, and (b) serving **diffs** when a doc changed slightly (the 21.7M near-identical half). Any design that just "caches" full content saves disk, not window — reject it.

**Sketch to evaluate, not prescribe:** persistent per-project content-hash index of "stable reference docs" (read in ≥3 sessions, low churn); on Read of one, `pre_read` offers/serves a compact (~10–15% of size) + section map (`token-goat section` already covers structured docs) with an explicit escape to full read. Opt-in config (`[hints] stable_doc_compacts`), per-doc opt-out. Validate the compact-quality risk: for creative-writing canon, lossy summaries may be unacceptable — consider section-map-only mode as the default.

**Acceptance for this task:** a design doc in `docs/plans/` with the chosen approach, savings estimate against the named top files, and the YAGNI/kill decision explicitly made if the design can't beat section-maps-only. Implementation only after that gate passes.

**Gate result (2026-06-10):** DEFER — see `docs/plans/2026-06-10-t6-stable-doc-design.md`. Auto-extractive compact path KILLED (silent quality failures). Explicit user-authored sidecar design deferred to v-next on user demand. Immediate micro-win filed: section-map hint in `hints.py` for large indexed docs (drive-by, no new state).

---

## Suggested order and sizing

| Order | Task | Size | Why this order |
|---|---|---|---|
| 1 | Task 1 config prune | ~30 min, no code | Biggest floor win, zero risk, independent |
| 2 | Task 3 screenshot guard | S | Small, isolated, verified gap |
| 3 | Task 2 re-read deny | M | Core feature, builds on 1.6.0 deny pattern |
| 4 | Task 4 dedup re-arm | S–M | Contained fix with regression test |
| 5 | Task 5 baseline v2 | M | Measures the wins from 1–4 |
| 6 | Task 6 stable-doc design | design-only gate | Largest unknowns; may be killed at the gate |

Tasks are sequential by default (one agent, commit per task). Tasks 2/3/4 touch overlapping hook files — do not parallelize them.
