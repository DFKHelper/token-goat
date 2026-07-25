# Context Growth Audit & Mitigation

**Date:** 2026-06-05
**Status:** Revised (post-brainstorm)
**Priority order:** Change 4 → Change 2 → Change 3 → Change 1

---

## Problem

Context fills up unexpectedly fast and invisibly. A session that reads few files and does
modest work still hits autocompact in 8–12 turns. The culprit is **system-injected
content** — content that arrives in every turn regardless of file reads or tool calls:

| Source | Est. tokens/turn | Notes |
|---|---|---|
| Skills catalog (80+ skills) | ~10,800 | Always present; scales linearly with installed plugins |
| Loaded skill bodies | ~8–40K (one-time) | Embedded in system-reminder for the session's duration after first invocation |
| CLAUDE.md + MEMORY.md | ~4,100 | Always present |
| Conversation growth | ~1,500–3,000 | Scales with turn count |

The top two rows are the primary culprits. A single skill load can burn 9–40K tokens that
persist until the next `/compact`. With autocompact at 66% of 1M (~660K), a session with
two large skill loads and 20 turns can be most of the way there before any file is read.

**Catalog estimate caveat:** The 10,800 figure uses ~130 tokens/skill as a flat rate, which
is fragile. Real description lengths range from ~30 tokens (terse one-liners) to 300+
tokens (multi-paragraph descriptions like `ralph`, `superman`, `brainstorming`). The
implementation must sum actual file sizes from `claude_skills_dir()` and
`claude_plugins_dir()` on first use rather than multiplying by a flat rate.

**Token-goat cannot intercept system-reminder injection** (platform-level). It can:
- Make the cost visible (`doctor --context` section, rolled into `doctor`)
- Warn before a large skill load when context is already high (`pre_skill` advisory)
- Reduce the cost of loaded skills immediately on invocation (`post_skill` compact advisory)
- Give users a threshold-crossing ETA before autocompact fires (`user_prompt_submit`)
- Pre-generate compacts at install time so advisory hints cost zero compute on the hot path

---

## Prior Art Check

- `overflow_guard.py` — caps command *output* tokens. Not relevant here.
- `compact_assist.lazy_skill_injection` — already replaces embedded skill bodies in the
  pre-compact manifest with a recall pointer. Solves the compact manifest case only; does
  not help during the session between skill load and compact.
- `hooks_skill.post_skill` (393–663) — already captures skill bodies to `skills/` cache.
  Extension point exists; no advisory logic present.
- `user_prompt_submit` (1683–1753) — already injects a 1-line session summary every turn.
  Extension point exists; no context growth tracking present.
- `_read_precompact_estimate` in `hooks_session.py` — reads `bytes_estimate` from the
  PreCompact hook payload. This is the only place token-goat currently receives real
  context-size data. Available as a baseline for ETA estimation.

---

## Changes

### Change 1 — Context footprint section in `token-goat doctor`

**Previously:** Standalone `context-audit` command.
**Revised:** No standalone command. The information folds into `token-goat doctor` as
a new `--context` flag (also included in `doctor` default output when context is notable).

**Rationale for the change:** `doctor` is already the diagnostic entry point. A standalone
`context-audit` adds CLI surface with no capability that can't live in `doctor`. YAGNI.

**File:** `cli_doctor.py` — add `_build_context_section()` helper

**Output (as a `doctor` section):**

```
Context footprint
  Skills catalog: 82 skills ≈ 10,800 tokens/turn  [computed from actual file sizes]
  Loaded skills this session: 2 (~17,400 tokens in system-reminder)
    claude-api        ~9,200 tok   compact: 420 tok   saves ~8,780 tok at next /compact
    brainstorming     ~8,200 tok   no compact          run: token-goat skill-compact brainstorming
  CLAUDE.md + MEMORY.md: ~4,100 tokens/turn
  Conversation (~18 turns): ~36,000 tokens  (~2,000/turn)
  ──────────────────────────────────────────────────────────
  Estimated total: ~68,300 tokens
  Context at last compact: ~340,000  (from precompact estimate)
  Current estimate: ~408,300 / 660,000  (62%)
  ETA: ~12 turns at current rate

  Actions:
    token-goat skill-compact brainstorming     # cache compact for loaded skill
    token-goat skill-compact --all             # batch-refresh all missing compacts
```

**Implementation:**
- Sum actual description/file sizes from `claude_skills_dir()` and plugin dirs; cache
  the sum in session state after first computation.
- Read loaded skill body sizes from `skill_cache` (`body_tokens` field if present;
  otherwise len(body) / 4 as fallback).
- Read CLAUDE.md + MEMORY.md file sizes from `claude_project_path()`.
- Read `_read_precompact_estimate()` for context size at last compact.
- When no precompact estimate is available, show "< no compact baseline yet >" and estimate
  from known-injected sources only.
- `token-goat doctor --context` always shows this section. Default `doctor` run shows it
  only when estimated context > 40% or any loaded skill > 2K lacks a compact.

**Actionable output rule:** Every oversized source gets an `Actions` entry. "Context growing
fast" is useless; "run `token-goat skill-compact brainstorming`" is not.

---

### Change 2 — Compact advisory in `post_skill` and `pre_skill`

**File:** `hooks_skill.py`

**2a — `pre_skill` warning (new, fires before load)**

Before the skill body is injected, token-goat has the skill name and can read the cached
compact size (if any). If both of these conditions are true:
- Estimated context > 60%
- Cached compact or estimated skill body > 4,000 tokens

Then emit a single-line advisory in `additionalContext` **before** the skill loads:

```
[token-goat: context at ~62%. Loading ralph (~9K tokens) will push to ~68%.
Consider /compact first, or continue if you have enough turns remaining.]
```

This is the only point in the flow where the user can act before cost is incurred. The
advisory is non-blocking. Gate on both conditions to avoid noise on healthy sessions (a
9K skill load at 20% context is fine; the same load at 65% context with 5 turns remaining
is not).

**2b — `post_skill` advisory (existing extension point, refined)**

After the skill body is captured (already done), add:

1. Estimate the body size in tokens.
2. Check `skill_cache` for a fresh compact.
3. If body > 2,000 tokens:
   - **Compact exists (pre-generated or previously cached):** Emit info-only, no action
     required:
     ```
     [token-goat: <name> loaded (~N tokens in system-reminder).
     Compact available: M tokens. Saves ~(N-M) tokens from next /compact onward.]
     ```
   - **No compact, body < 10,000 tokens:** Generate synchronously (adds ~200ms). Then emit
     the "compact available" variant above with a `(just generated)` tag.
   - **No compact, body >= 10,000 tokens and worker available:** Dispatch to worker
     (non-blocking). Emit:
     ```
     [token-goat: <name> loaded (~N tokens — large skill). Generating compact in background.
     Run token-goat skill-compact <name> if you need it immediately.]
     ```
   - **No compact, body >= 10,000 tokens and worker unavailable:** Do not emit an imperative
     instruction the user cannot fulfill. Emit:
     ```
     [token-goat: <name> loaded (~N tokens — large skill). No compact cached.
     Run token-goat install or token-goat skill-compact --all when worker is available.]
     ```

**Why this separation matters:** The original spec had three paths with unclear fallback
semantics. The revised spec has one question per branch point: "Does a compact exist?" then
"Is the body small enough to generate synchronously?" This eliminates the case where the
advisory tells the user to run a command that will silently fail.

**Threshold notes:**
- 2K body threshold for advisory: kept. Below 2K, cost is negligible.
- Repeat loads: the threshold ignores repeat loads of the same skill. This is an acceptable
  limitation for v1 (the body only injects once per session regardless of repeated `Skill`
  tool calls).

---

### Change 3 — Threshold-crossing context ETA in `user_prompt_submit`

**File:** `hooks_session.py`, `user_prompt_submit` function (1683–1753)

**Previously:** ETA line on every turn above 30% estimated context.
**Revised:** Fire on threshold crossings only — not every turn.

**Rationale:** Per-turn advisory above 30% produces advisory fatigue. A session parked at
35% context for 40 turns shows the same line for 40 consecutive turns. When the real warning
fires at 80%, it looks like noise. The threshold-crossing model produces 2–3 advisory events
per session at most and preserves the urgency signal.

**Rules:**
- Below 50% estimated context: existing line unchanged. No context noise on healthy sessions.
- First turn context crosses 50%: append to the status line (one-time):
  ```
  [branch: main | edits: 3 | ctx: ~52% — context approaching midpoint]
  ```
- First turn context crosses 70%: replace status line (one-time):
  ```
  [CONTEXT ~72% full. Consider /compact soon. branch: main | edits: 3]
  ```
- Every turn above 85%: always emit (urgency zone — session is in danger):
  ```
  [CONTEXT ~88% full. /compact now. branch: main | edits: 3]
  ```

**Crossing detection:** Track `last_context_advisory_threshold` in `SessionCache` (values:
None, 50, 70). When `context_pct` crosses a stored threshold for the first time, emit the
advisory and update the stored value. The 85% zone bypasses threshold tracking and always
fires.

**Estimation formula:** unchanged from original spec — `context_pct` = (precompact_bytes +
loaded_skill_body_sizes + skills_catalog_estimate + turns × per_turn_avg) / 660,000.

**ETA formula:** unchanged — `(660,000 − current_estimate) / per_turn_growth_rate`. Clamp
to "< 3 turns" / "~N turns" / "> 20 turns (omit)". Show range (`~8–12 turns`) when < 3
data points. The ETA appears in the crossing advisory; between crossings it does not appear.

**Session state additions:** `turns_since_last_compact` (increment in `user_prompt_submit`,
reset on PreCompact), `loaded_skill_total_tokens` (updated in `post_skill`),
`last_context_advisory_threshold` (enum: None, 50, 70). All cheap scalars on `SessionCache`.

---

### Change 4 — Pre-generate compacts at install time

**File:** `install.py` (or equivalent install/setup command)

During `token-goat install` (and `token-goat skill-compact --all`), discover all skill
files in `claude_skills_dir()` and plugin skill directories. For each skill file that does
not have a fresh compact, generate one. This runs once at install time and makes every
subsequent `post_skill` invocation a cache hit rather than triggering a generation job.

**New plugin detection (gap fix):** `token-goat doctor` should surface:

```
Context footprint
  ...
  Skills installed since last pre-generation: 3 (new plugins detected)
  Action: token-goat skill-compact --all
```

This is detected by comparing `claude_plugins_dir()` mtime (or plugin count) against the
timestamp of the last `skill-compact --all` run, stored in `SessionCache` or a sentinel
file. The point is that users who install new plugins between `install` runs see the gap
before a session starts rather than getting a "no compact" advisory mid-session.

**Doctor health section (expanded from original):**

```
Context footprint
  Skills catalog: 82 skills ≈ 10,800 tokens/turn  [actual file sizes]
  Skill compacts: 74 of 82 skills have fresh compacts
  Skills installed since last pre-generation: 3
  Uncompacted loaded skills (this session): brainstorming (~8,200 tokens)
  Action: token-goat skill-compact --all
```

Thresholds: warn if skills catalog > 8,000 tokens/turn (> ~62 skills at flat rate; adjust
if actual measurement diverges) or any loaded skill > 2K lacks a compact or > 0 skills
installed since last pre-generation.

---

## Edge Cases

| Case | Handling |
|---|---|
| `_read_precompact_estimate` returns None (first session) | Start estimate from 0 + known-injected sources. Show "< no compact baseline yet >". Threshold-crossing model still works with the partial estimate. |
| Worker unavailable, body >= 10K | Do not emit an imperative instruction. Emit info-only advisory describing cost. User can run `install` or `skill-compact --all` later. |
| Worker unavailable, body < 10K | Generate synchronously (~200ms). No worker needed. |
| Skills catalog count changes mid-session | Catalog estimate computed once at first doctor/audit call, cached in session. Re-run doctor after plugin installs. |
| ETA estimate has < 3 turns of history | Show range rather than point estimate. |
| Single skill body > 20K tokens | Escalate post_skill advisory wording. Do not block invocation. Worker gets async job; if unavailable, info-only fallback. |
| pre_skill advisory fires on a benign load | Gate on context > 60% AND estimated skill size > 4K. Below either threshold, no advisory. |
| Context already above 85% when skill is loaded | pre_skill advisory fires with "context at ~87% — strongly consider /compact before loading". |
| New plugin installed between `install` runs | Doctor surfaces "N skills installed since last pre-gen". post_skill advisory shows "no compact" for new skills and generates sync (< 10K) or async (>= 10K). |
| Flat-rate catalog estimate diverges from actual | Sum actual file sizes from `claude_skills_dir()` + plugin dirs. Cache in session state. First call pays one disk scan; subsequent calls free. |

---

## Testing Strategy

- **`doctor --context` section:** mock a session with two loaded skills at known sizes + a
  precompact estimate. Assert table values match. Assert "no compact" and action appear for
  the uncompacted skill. Assert section is absent when context < 40% and no uncompacted
  loaded skills.
- **`post_skill` compact advisory — compact exists:** assert advisory shows "compact available:
  M tokens" with no action required line. No worker dispatch.
- **`post_skill` compact advisory — no compact, body < 10K:** assert advisory shows "just
  generated" and compact is stored in `skill_cache`. No worker dispatch.
- **`post_skill` compact advisory — no compact, body >= 10K, worker up:** assert advisory
  fires, worker queue receives compact job, advisory wording matches "generating in background".
- **`post_skill` compact advisory — no compact, body >= 10K, worker down:** assert advisory
  fires with info-only wording (no imperative instruction). Worker queue not called.
- **`post_skill` compact advisory — body < 2K:** no advisory emitted.
- **`pre_skill` advisory — context 55%, skill 4.5K:** assert advisory emitted.
- **`pre_skill` advisory — context 55%, skill 1K:** no advisory (below 4K threshold).
- **`pre_skill` advisory — context 45%, skill 9K:** no advisory (below 60% threshold).
- **`pre_skill` advisory — context 88%:** assert advisory uses escalated wording regardless
  of skill size.
- **`user_prompt_submit` threshold crossings:** test context at 0.35 over 10 turns → no
  advisory any turn. Simulate context crossing 0.52: assert advisory fires exactly once on
  the crossing turn. Continue to 0.73: assert advisory fires exactly once on crossing turn.
  Simulate 0.88: assert advisory fires on every turn.
- **`user_prompt_submit` below 50%:** assert no ctx field in status line at any point.
- **Install pre-generation:** assert `install.py` calls `generate_compact()` for all
  discovered skill files and a subsequent `post_skill` invocation finds a cache hit and
  emits "compact available" not "no compact".
- **New-plugin detection in doctor:** mock plugin dir with mtime newer than last-pre-gen
  sentinel. Assert doctor shows "N skills installed since last pre-generation".

---

## Open Questions

1. Should the `pre_skill` advisory be gated by a config flag
   `[hints] pre_skill_advisory = true`? Default on is defensible (it only fires above 60%
   context and with a large skill), but users who find it intrusive should have an escape
   hatch. Recommendation: default on, add config key.

2. Should the threshold-crossing advisories in `user_prompt_submit` also be gated by a
   config flag `[hints] context_threshold_advisory = true`? The 85% always-fire rule is
   probably always wanted. The 50% and 70% crossings are more debatable. Recommendation:
   gate the 50%/70% crossings only; the 85% zone is unconditional.

3. Where exactly does pre-generation run for users who do not go through `token-goat install`
   (e.g., running from source via `python -m token_goat`)? The `skill-compact --all` path
   covers them. A `doctor` warning for "N skills without compacts" is the nudge mechanism.
   No automatic pre-generation on first run (would be surprising behavior).

4. The `pre_skill` hook does not currently exist as a registered hook event. Adding it
   requires a `hook_registry.HOOK_EVENTS` entry, a new `@hook_app.command` in `hooks_cli.py`,
   and a settings.json install update. This is the largest implementation delta introduced
   by this revision. If pre_skill is out of scope for this iteration, the pre-load warning
   can be approximated with a `post_skill` advisory that fires immediately and says "just
   loaded" — less ideal but lower implementation cost.

---

## Out of Scope

- Intercepting or compressing the skills catalog before it reaches system-reminder
  (platform-level)
- Per-turn real-time token counting from the API
- "Unloading" a skill after it has been injected into system-reminder
- Any change to the skills catalog injection mechanism in Claude Code itself
- Standalone `token-goat context-audit` command (folded into `doctor`)
- Per-turn advisory below the 50% threshold (advisory fatigue)
- `body_tokens` field in skills cache as a dedicated optimization (deferred to v2)

---

## Decisions Log (brainstorm findings)

| Original spec | Revised to | Rationale |
|---|---|---|
| Standalone `context-audit` command | `doctor --context` section | YAGNI; `doctor` is already the diagnostic entry point; zero CLI surface growth |
| Per-turn ETA above 30% | Threshold-crossing at 50%, 70%, always-on at 85% | Advisory fatigue; signal lost in noise; crossing model preserves urgency |
| 130 tokens/skill flat rate for catalog | Sum actual file sizes from disk (cached in session) | Flat rate is fragile; power users with verbose skill descriptions see 2x under-estimate |
| post_skill advisory dispatches to worker with sync fallback for body < 20K | Sync for body < 10K; async for >= 10K if worker up; info-only if worker down | Eliminates the "run skill-compact" imperative when it will silently fail |
| No pre_skill advisory | pre_skill advisory when context > 60% and skill > 4K | Only actionable moment before cost is incurred; gates prevent noise on healthy sessions |
| No new-plugin gap detection | Doctor surfaces count of skills installed since last pre-gen | Closes the gap between install-time pre-gen and newly installed plugins |
