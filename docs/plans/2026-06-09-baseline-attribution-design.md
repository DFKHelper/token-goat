# Environmental Baseline Attribution & Reduction — Design

Date: 2026-06-09 · Status: proposed · Gear: standard

## Build/Kill/Defer

**Verdict: BUILD, phased.**

- **Prior art (partial):** token-goat already manages *one* of the five baseline sources — skill text — via `skill-size` (measure), `skill-compact`/`skill-body` (serve compact), and the `pre_skill`/`post_skill` Skill-tool intercept. No full *baseline attribution* across all sources exists. `compact._token_count` / `estimate_tokens` already provide token costing. So: extend the existing measurement surface, don't reinvent.
- **Cost vs value:** Phase 1 ≈ a day (one read-only CLI command + 5 scanners + table). Value: converts an invisible, fatal failure (subagent overflow at "hello") into a measured, attributed, actionable report. Clears the bar easily.
- **Null option:** do nothing → the baseline stays invisible; the only mitigation is the deny-redirect shipped 2026-06-09 (commit `af1a694`), which treats the *symptom* (the fatal read) downstream, not the baseline. Do-nothing loses.

## Problem & success criteria

A spawned subagent starts each task with its window already heavily pre-loaded by context it didn't request and can't see itemized: both CLAUDE.md files, MEMORY.md, MCP instruction blocks, auto-injected skill text (UserPromptSubmit pushes), and other plugins' SessionStart dumps (the 54.8 KB Vercel knowledge-graph being the worst single offender). The baseline is invisible and unattributed, so overflow-on-first-read looks random.

**Success:** (1) one command shows, ranked by token cost, every baseline contributor, tagged by owner (you / harness / plugin:<name>) and fixability; (2) each line carries a concrete next action where one exists; (3) Phase 2 can refactor the sources token-goat or the user own (CLAUDE.md; MEMORY.md only if not already lazy) into pointer + serve-on-demand with an approved diff, actually subtracting tokens. Win: "why did that subagent die at hello?" becomes a 5-second lookup with a fix attached.

## Approach

Chosen: **read-only attribution report first, opt-in mutator second**, tied together by a threshold-gated advisory.

- **Phase 1 — `token-goat baseline`** ("session expense report"): scan five source classes, cost each via an existing token estimator (single source of truth), tag owner × fix, render a ranked table. Read-only, cold path, fail-soft per source.
- **Phase 2 — `token-goat slim`** (opt-in): refactor CLAUDE.md / MEMORY.md into pointer + `token-goat section`-served sidecars, diff-and-approve, `.bak` backup, `atomic_write_bytes`.
- **Advisory** (bridges the phases): `session_start` computes only the cheap fixed total and, above a configurable budget (default off), emits one quiet line pointing at `token-goat baseline`.

**Alternatives considered & ruled out:** hook-layer suppression of others' injections — *impossible*, confirmed against the Claude Code hooks docs (2026-06-09): hooks are append-only (`additionalContext` concatenates; no field strips another source). The only context-rewrite fields, `updatedInput`/`updatedToolOutput`, act on the current tool call only — already exploited by `pre_skill`/`post_skill` for Skill-tool bodies; a UserPromptSubmit skill-push is not a tool call, so it is untouchable.

## Components & data flow

New module `baseline.py` exposing `collect_baseline(...) -> list[BaselineRow]`; new Core CLI command `baseline`.

Source scanners:
1. **Hook dumps** — `~/.claude/projects/<project-key>/<session-id>/tool-results/hook-*-stdout.txt` (all plugins' SessionStart/UserPromptSubmit output). Needs a new `paths.py` helper to resolve the Claude session/tool-results dir (only `claude_config_dir()` exists today). Attribute by content-sniff; reconcile via transcript JSONL under `--exact`.
2. **CLAUDE.md** — global (`~/.claude/CLAUDE.md`) + project (`./CLAUDE.md`) + `@import`s.
3. **MEMORY.md** — costed; "already-lazy?" check (index + on-demand files vs inline bodies).
4. **MCP blocks** — servers from settings (`~/.claude.json` / `.mcp.json`); instruction text costed; cross-ref transcript tool-calls → loaded-but-unused flag.
5. **Skill text** — available-skills listing + auto-injected bodies; reuse `skill-size`.

Costing uses `bytes // 4` — the same convention `token-goat doctor`'s "Context footprint" and `compact._token_count` already use — so `baseline` totals reconcile with the doctor rather than contradicting it (the `//4` "conservative" estimate is preferred over `estimate_tokens`'s `//3+1` "realistic" one specifically for that reconciliation; `--exact`, deferred, would reconcile against the transcript). Each `BaselineRow`: `source`, `bytes`, `tokens`, `pct_of_window` (configurable window, default 200k), `owner ∈ {you, harness, plugin:<name>}`, `fix ∈ {slim, disable-hook, disable-mcp, lazy-load, none}`, `kind ∈ {fixed, variable}` (recurring every-session vs prompt-driven).

CLI flags: table (default), `--json`, `--exact` (transcript-accurate vs file-stat estimate), `--subagent` (fresh-spawn baseline = fixed sources only, excluding the parent's turns → "a spawned agent starts at ~N tokens, X% full before its first action").

Advisory: `[hints] baseline_budget_tokens` (default 0 = off; env `TOKEN_GOAT_BASELINE_BUDGET_TOKENS`; two-stage `_validated_int` + `_env_int`, clamp). `session_start` computes the cheap fixed total (file stats, no transcript parse); if > budget, append one `systemMessage`/`additionalContext` line, once-per-session via the session cache.

## Edge cases & failure modes

- Missing `tool-results` dir / non-Claude harness (Codex) → skip source, note "unavailable," never crash.
- MCP settings across multiple files/formats → parse known, skip unknown.
- Token estimate vs reality drift → label as estimate; `--exact` reconciles via transcript.
- `slim` (Phase 2) on `@import`-based or section-less CLAUDE.md → refuse ("no safe split found"); no-op if already lazy.
- CRLF doubling on Windows when writing sidecar/pointer → `atomic_write_bytes` (known trap).
- Advisory noise → default off; once-per-session dedup.
- Variable (prompt-driven) vs fixed dumps bucketed separately so recurring "subscriptions" (Vercel 54.8 KB) stand out from one-off pushes; the shadcn/cache/flags pushes roll up into a "plugin:vercel pushed N unrequested skills across M prompts" line.

## Testing strategy

- Unit `collect_baseline()` vs a synthetic session dir (fixture `tool-results` of known sizes): assert rows, totals, owner tags, fixed/variable bucketing.
- Consistency: report token counts equal the reused `estimate_tokens` (no second estimator).
- `--subagent` excludes conversation turns, includes fixed sources.
- Advisory: > budget emits one line, < budget none, deduped within session — assert *behavior/threshold*, not exact wording (hint-text-coupling trap); `rg` old strings before committing.
- Cross-platform via `paths.py`; run on WSL (`UV_PROJECT_ENVIRONMENT=/tmp/tg-linux-venv`) — Windows-only green is a false positive.
- Tag any git-integration tests `slow`.
- Phase 2 `slim`: golden dry-run diff; `--apply` byte-correct (explicit CRLF regression) + `.bak` + idempotent + refuses bad input.

## Known unknowns

- **[RESOLVED]** "No hook event subtracts another component's injection." Confirmed via Claude Code hooks docs (2026-06-09): append-only. Phase 1 stays measure+advise.
- Whether subagents **re-fire** other plugins' SessionStart hooks (does the 54.8 KB hit children, or only the parent?). Verify by spawning a trivial subagent and inspecting its `tool-results`. Affects how the `--subagent` number is framed.
- Per-plugin attribution of anonymous UUID-named dump files — content-sniff may misattribute; transcript parse is reliable but schema-coupled.
- MCP "loaded-but-unused" requires cross-referencing transcript tool-calls — schema-coupled.

## Out of scope

- Suppressing/editing others' or the harness's injections (impossible — the premise).
- Auto-disabling plugins/MCP servers (advise only; user edits config).
- Editing skill bodies (`skill-compact` already does this; baseline measures and points to it).
- Post-read truncation of arbitrary tool output via `updatedToolOutput` (adjacent feature, not the baseline).
- Live TUI / dashboard.
- Codex baseline parity in v1.

## Open questions (resolved with reversible defaults)

- Advisory **off by default** (`baseline_budget_tokens = 0`).
- Slim sidecars named `CLAUDE.<topic>-ref.md` next to the source (existing convention).
- `baseline` stays **read-only** — no stat-row writes in v1.

(Flip any of these later; all reversible.)
