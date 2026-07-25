# Session Mining Findings — 9bd4c8b7

Source: a `dfkh-games` session (Vite/TypeScript/React + Phaser game) where token-goat ran as the globally-installed companion. Long autonomous agent run: 3480 transcript lines, 440 tool calls (130 Bash, 76 Read, 21 sub-agents, heavy Chrome-DevTools MCP use), 18 actual `token-goat` CLI invocations (`read`×9, `skeleton`×5, `symbol`×4).
Mined by Opus agent on 2026-06-14 with two Sonnet sub-agents reading the narrative halves. None of these duplicate the already-fixed items (invalid `symbol` templates iter 62, sub-agent reread_deny iter 63, skeleton-dir error iter 65, `::ClassName`/`::SymbolName` placeholders iters 66+68, CSS/SQL outline fallback iter 66).

**Environmental caveat (not a token-goat bug, but it shapes the perf numbers):** this machine was also running a separate Node.js ONNX semantic tool (`all-MiniLM-L6-v2`, almost certainly `claude-flow`) that re-downloaded a 23 MB model and spawned a fresh `node` process on nearly every Bash call, crashing repeatedly with `TypeError: Cannot read properties of undefined (reading 'length')`. Its stderr is what produced all 47 `hook_non_blocking_error` attachments (hookName `PreToolUse:Bash`). The sub-agents correctly excluded the 72–88 s monster hooks as `claude-flow`, not token-goat. token-goat's own `_tg_elapsed_ms` samples are isolated below and are genuinely token-goat's, but the contention from this Node tool is a plausible amplifier of the lock-wait latency in P2-A.

---

## P1 — `skeleton`/`symbol`/`outline` are blind to `export const X = () => {}` arrow exports (correctness, root-cause)

**What happened.** At transcript L1754 the agent ran `token-goat skeleton src/features/preferences/utils.ts` and got `# Skeleton: ... (0 symbols)`. I read the actual file (`C:\Projects\dfkh-games\src\features\preferences\utils.ts`, 900 bytes, 21 lines) — it contains **four** top-level exports, all arrow-function consts:

```ts
export const getClickCursor = (): string => { ... }
export const getDefaultCursor = (): string => { ... }
export const getDefaultCursorFull = (important?: boolean): string => { ... }
export const getClickCursorFull = (important?: boolean): string => { ... }
```

`skeleton` reported zero of them. The agent then full-`Read` the file (L1758). This is not isolated: the agent's near-total avoidance of `token-goat read`/`symbol`/`outline` in the back half of the session (sub-agent 2 counted ~40 Bash `cat`/`head`/`sed` reads on indexed source + 67 `Read` calls vs **2** skeleton calls and **zero** `read`/`outline`/`symbol`/`section`) is the downstream behavioral cost: modern React/TS code is overwhelmingly `export const Foo = () => {}`, so a parser that misses arrow-const exports makes token-goat look empty and untrustworthy on most of the codebase, and the agent stops using it.

**Where.** `src/token_goat/languages/typescript.py` `extract()` lines 364–396. The code *intends* to handle this: it loops `result.exports` and, when `_EXPORT_CONST_RE` matches `name_raw`, appends `Symbol(name=..., kind="const", ...)`. Empirically that branch did not fire for these four exports, so one of two things is true: (a) tree-sitter's `result.exports` does not include arrow-const exports for this file, or (b) `exp.name` / `name_raw` is already a bare identifier (e.g. `getClickCursor`) and `_EXPORT_CONST_RE` (`export\s+(?:const|let|var)\s+(NAME)`, line 269) requires the literal `export const` prefix, so `const_m` is `None` and the export is recorded only as an `ImpExp`, never as a skeleton symbol. The line-365 comment ("exports like `export const router = express()` aren't in structure") confirms the team already knows structure-walk misses these.

**Fix.** Add a failing regression test first: an arrow-const-export-only `.ts` fixture asserting `skeleton`/`outline`/`symbol` surface all the consts. Then make the export→Symbol promotion robust regardless of whether `name_raw` is a full statement or a clean identifier — match the arrow/value form (`NAME = (...) =>` / `NAME = function` / `NAME = ...`) and emit a `Symbol` (kind `function` when an arrow/`function` RHS is detected, else `const`). Verify whether `result.exports` actually carries these; if tree-sitter drops them, fall back to a source regex pass for `^export\s+(?:const|let|var)\s+NAME\s*=`. **Effort: M.** This is the highest-leverage fix in the session — it likely unblocks the surgical-read commands the other hints keep pointing at.

---

## P2-A — token-goat's own pre-read hook routinely burns its full ~2 s budget and delivers nothing (performance)

**What happened.** 436 `_tg_elapsed_ms` samples from token-goat hooks: **median 1375 ms**, mean 1081 ms, p90 2016 ms, p95 2016 ms, max 2046 ms. **251/436 (58%) exceeded 500 ms, 250 (57%) exceeded 1000 ms, 90 (21%) sat at the ~2 s ceiling.** Sub-agent 2 measured the pre-read slice specifically at median ~2286 ms with 109/125 over 1500 ms against a 2000 ms budget, and the watchdog (`_tg_watchdog_tripped`) firing very frequently (~97–140 occurrences across the file). When the watchdog trips, the ~2 s is still spent but the hint content comes back empty (e.g. L1742 emits empty `additionalContext`) — worst of both worlds: the latency is paid and no hint is delivered.

This is a far worse profile than the reference 6b476e93 session (median 78 ms there). The difference is almost certainly contention: this machine was running the crashing Node ONNX tool (see caveat) plus 21 sub-agents and Chrome-DevTools MCP, all hammering the box, and token-goat's `db.py:295 with_timeout(..., timeout_s=2.0)` / `PRAGMA busy_timeout = 2000` means every contended pre-read backs off to the full 2 s ceiling.

**Where.** `src/token_goat/db.py:295` (2 s busy_timeout), plus the pre-read hint path in `hooks_read.py`.

**Fix.** Generate pre-read hints from a non-contending read-only connection (or an in-memory snapshot of the session cache) and return immediately on a contended lock instead of waiting 2 s — a missed hint is cheap, a 2 s stall on every read is not. Defer the session-cache *write* to an async path off the read hot-path. Consider dropping the pre-read budget to ~300–500 ms so a slow analysis self-aborts fast rather than at 2 s. **Effort: M.** (Same root as the reference doc's P2, but this session shows it is far more severe under multi-agent load and that the watchdog-trip path wastes the budget while delivering nothing.)

---

## P2-B — The "wasted tokens" pre-read hint prints a hardcoded-looking, file-independent number (correctness, misleading)

**What happened.** Two different files received the **byte-for-byte identical** hint:
- L1631: `` `ballista.tsx` L1-2000 ⌘ (L1-100000). ~34285t wasted. ``
- L1969: `` `utils.ts` L1-2000 ⌘ (L1-100000). ~34285t wasted. ``

`utils.ts` is 21 lines (~200 tokens). Claiming "~34285t wasted" on it is simply wrong. The identical `L1-2000`, `(L1-100000)`, and `34285t` across two unrelated files show the figure is derived from the **Read tool's requested line range** (the default `limit`, ~2000, extrapolated against some 100000 ceiling), not the file's actual indexed length. The `⌘` glyph and the `(L1-100000)` notation are also opaque — neither sub-agent nor the live agent could interpret them, and the agent changed no behavior in response.

**Where.** The pre-read "wasted tokens" hint template in `src/token_goat/hints.py` (the `⌘` / `L<a>-<b> (L<a>-<b>)` / `~Nt wasted` formatter).

**Fix.** Compute the waste from the file's actual indexed size (lines/bytes → tokens), not the requested range; for a 21-line file the waste is ~0 and the hint should be suppressed entirely. Replace `⌘` and the dual `(L1-100000)` range with plain language ("reading all ~N lines; only M are new"). Add a test asserting two files of different sizes never get the same waste figure. **Effort: S.**

---

## P2-C — `token-goat read` on a non-existent symbol returns empty output with no diagnostic (UX, drives abandonment)

**What happened.** L1742: `token-goat read "src/theme/components.tsx::CursorStyle"` → "(Bash completed with no output)". `CursorStyle` doesn't exist in that file; the agent got nothing back — indistinguishable from an empty/erroring file — and immediately fell back to `skeleton` then a full `Read`. Compare L586 where a different bad symbol *did* produce `Symbol not found: l (in ...SiegeGame.tsx)`. So `read`'s not-found behavior is **inconsistent**: sometimes a message, sometimes silent-empty (the silent case may be stderr that a `2>/dev/null` swallowed, which is itself a smell — diagnostics belong on a stream the user sees). A surgical-read tool that returns nothing on a typo trains the agent to stop trusting it (this is the first `read` failure in the session and `read` usage collapses afterward).

**Where.** The symbol-resolution path of the `read` command in `src/token_goat/cli.py` and its symbol lookup.

**Fix.** On symbol-not-found, always exit non-zero with a one-line "Symbol 'X' not found in <file>. Available: a, b, c …" pulled from the already-computed skeleton (the index has the names for free), and emit it on stdout so a `2>/dev/null` can't hide it. Never return success-with-empty-output for a missing symbol. **Effort: S.** Pairs naturally with P1 — once arrow-consts are indexed, the "Available:" list will actually contain the symbols the agent wants.

---

## P2-D — Read-dedup "already in context" hint asserts a false premise across a compaction boundary (correctness of hint)

**What happened.** L308 hint: "`SiegeHUD.tsx` lines 186–225 is already in context (prior reads this session: 1+). The file is unchanged. Use what is already in context…". The agent's own reasoning at L316 and again L326: *"since the session was compacted, I don't actually have that content in my current context."* The read-dedup counter survived compaction but the file *content* did not, so the hint told the model to "use what's already in context" when nothing was. Same pattern recurs in the back half (sub-agent 2: `ArcherHuntGameScene.ts read 6x`, `SiegeSplashModal.tsx read 6x`, with the agent re-fetching anyway via `head`/`token-goat`). token-goat *injects the pre-compact manifest itself*, so it knows exactly when a compaction happens.

**Where.** Session read-cache / dedup-hint logic in `src/token_goat/hooks_read.py`, and the pre-compact hook in `src/token_goat/hooks_*` that builds the manifest.

**Fix.** When the pre-compact hook fires, reset (or mark stale) the per-file "already in context / read N×" counters for that session — after compaction the content is gone, so the next read is legitimate, not redundant. At minimum downgrade the wording from "already in context" to "previously read this session (content may have been compacted away)". **Effort: M.**

---

## P2-E — Symbol-level dedup fallback omits the exact line range the agent was after (UX)

**What happened.** After the L308 dedup hint on `SiegeHUD.tsx` lines 186–225, the agent followed the suggestion and ran `token-goat read "...SiegeHUD.tsx::SiegeHUD"` (L317) — but that returned the component's signature/state block (~24 lines, L320), **not** the JSX at 186–225 (the `key={i}` maps it was hunting). It abandoned token-goat and ran `sed -n '185,225p'` (L327). A line-range read deduped into a whole-symbol read silently drops the sub-region of interest.

**Where.** The dedup-hint template that suggests `read "file::Symbol"` as the replacement for a line-windowed Read, in `src/token_goat/hints.py`.

**Fix.** When the original Read carried an explicit `offset`/`limit`, suggest a **line-windowed** surgical read rather than a whole-symbol one — either teach `token-goat read` a `"file:186-225"` line-range syntax and emit that, or have the hint suggest re-issuing the Read with the narrowed `offset`/`limit` it already knows. **Effort: S–M.**

---

## P2-F — Bash file-dumps (`cat`/`head`/`tail`/`sed -n`) of indexed source slip through with no surgical-read nudge (coverage gap)

**What happened.** The agent repeatedly read indexed source files through Bash, bypassing token-goat's read hints entirely and landing 3–4 KB of uncompressed file content in context each time, e.g.: L604 `cat src/features/siege/components/SiegeGame.tsx` (3285 chars), L1885 `cat src/features/dungeon/state.ts | head -80` (4007), L3083/L3104 `sed -n '1,80p' .../DungeonGame.tsx` (3079), L3449 `head -120 src/features/dungeon/components/DungeonGame.tsx` (4250), plus `sed -n` slices of `SiegeBattleScene.ts` and `ArcherHuntGameScene.ts`. None of these triggered a hint. token-goat's read-nudge fires on the `Read`/`Grep`/`Glob` tools but not on Bash `cat`/`head`/`tail`/`sed`/`Get-Content`/`type`/`bat` — so the agent can (and did) route around every read hint by using Bash. This is the read-side analogue of the reference doc's "edit via Bash to dodge the deny."

**Where.** The Bash `PreToolUse` hook (`src/token_goat/hooks_bash*` / wherever the eza/compress auto-wrap lives — it already parses Bash commands).

**Fix.** In the Bash pre-hook, detect file-dump commands (`cat`, `head`, `tail`, `sed -n '…p'`, `bat`, `type`, PowerShell `Get-Content`) whose argument resolves to an indexed source file, and emit the same surgical-read nudge (`token-goat read "file::symbol"` / `outline file`) the Read hook would — and honor the session read-cache so repeat dumps get the "already read" treatment too. **Effort: M.**

---

## P3 — Smaller items

**P3-A — `token-goat symbol NAME --repo PATH` rejected (`No such option: --repo`).** L1196: the agent tried `token-goat symbol "showingEncounterPreview" --repo "C:/Projects/dfkh-games"` to scope the lookup; `symbol` only accepts `--help`/`--refs`, so it errored, and the agent re-ran without the flag (L1201, which worked). The agent reached for repo-scoping naturally. Add `--repo`/`--project` (and likely file-scoping, as the reference doc also suggested) to `symbol`. `src/token_goat/cli.py` symbol command. **Effort: S.**

**P3-B — eza auto-compression fires on trivially small output and still costs ~2 s.** L2664: `ls -la src/games/` (3 entries, "total 16") was auto-wrapped through `compress --filter eza` and tagged `[token-goat: eza filter -1%; ...]`, with `_tg_elapsed_ms: 2015` — two seconds and added marker noise to compress a 3-line listing that needed no compression. Gate the eza/compress wrap on a minimum raw-output-size (or line-count) threshold so tiny listings pass through untouched. `src/token_goat/hooks_bash*` compress dispatch. **Effort: S.**

**P3-C — `skeleton` omits file header/imports, prompting an immediate follow-up read.** L2300: after `skeleton archerhunt/state.ts` returned 5 method symbols, the agent still `head -30`'d the same file for the imports / initial-state block that skeleton doesn't show. Offer an optional `--header`/imports section (or a one-line import summary) in skeleton output so the common "what does this import / what's the initial state" question doesn't force a second read. `src/token_goat/cli.py` skeleton renderer. **Effort: S.**

**P3-D — Placeholder hint tokens still observed (verify fix coverage).** Across the session, hints still printed non-actionable templates the agent ran zero times: `token-goat symbol <NAME>` (L2288), `token-goat read "...::SymbolName"` (L2241), `token-goat read "...::<symbol>"` (L2911), `token-goat read "src/constants/sdk-extra/constants.ts::ClassName"` (L1762). The `::SymbolName`/`::ClassName` family is on the already-fixed list (iters 66+68) and this session likely predates the installed fix — but the **angle-bracket** variants (`symbol <NAME>`, `read "...::<symbol>"` in the read-N×-this-session and already-in-context templates) are distinct tokens; confirm the iter-66/68 fix covers them, not just the bare-word forms. Note that even a perfect placeholder fix is moot for arrow-const files until P1 lands — there is no real symbol name to interpolate. `src/token_goat/hints.py`. **Effort: S.**

**P3-E — Double-daemon churn still recurs in the wild (known bug, field confirmation).** `cleanup-orphans: killed 1 stale token-goat worker(s) from non-venv interpreter` appears across ~32 lines — the non-venv-interpreter daemon keeps respawning and getting killed every few tool calls. This matches the documented double-daemon bug; flagging that it is still actively firing in real sessions and adding visible noise. `worker --kill-duplicate` / `install --check` path. **Effort: (already tracked).**

---

## Bonus — live observation in *this* mining session (not from 9bd4c8b7)

While running this analysis, token-goat's own pre-read hints to me read **"CONTEXT CRITICAL (338% full): context window is almost full"** — on an Opus model with a 1M-token context that was nowhere near full. The percentage appears computed against a ~200K-token assumption, so on a 1M-context model (`claude-opus-4-8[1m]`) it over-reports by ~5× and cries "CRITICAL" early. Worth verifying the context-budget calc detects the `[1m]` / large-window models before it starts forcing surgical-only mode and suppressing reads. (Reported as a direct observation, not mined from the target transcript.)

---

## Recommended implementation order

1. **P1** — index `export const X = () => {}` arrow exports (+ regression test). Highest leverage; unblocks the surgical-read commands every other hint points at.
2. **P2-C** — `read` emits "Symbol not found / Available: …" on stdout, never silent-empty. Cheap, restores trust; synergizes with P1.
3. **P2-A** — move pre-read hint generation off the 2 s-contending DB path; fail fast on lock contention; shrink the budget.
4. **P2-B** — fix the "wasted tokens" figure to use actual file length and suppress it on tiny files; de-glyph the notation.
5. **P2-D / P2-E** — reset read-dedup counters on compaction; suggest line-windowed reads for ranged Reads.
6. **P2-F** — extend the Bash pre-hook to nudge on `cat`/`head`/`sed -n`/`tail`/`Get-Content` of indexed files.
7. **P3** items as polish; verify the `[1m]` context-percentage calc (Bonus).

Key files: `src/token_goat/languages/typescript.py` (extract @364–396), `src/token_goat/hints.py` (wasted-tokens + placeholder + dedup templates), `src/token_goat/hooks_read.py` (pre-read budget + dedup), `src/token_goat/db.py:295` (2 s busy_timeout), `src/token_goat/cli.py` (`read` not-found diagnostic, `symbol --repo`, `skeleton` header), the Bash pre-hook compress/eza dispatch.
