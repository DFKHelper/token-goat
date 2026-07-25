# Session Mining Findings — 2ace93b9

Source: a `coracrea-website` session — but, unlike the blogarticle session (3342a3ae) from the same repo, this run worked the **Google Ads automation JavaScript/Node** surface (`scripts/google-ads-manager.js`, `scripts/ads-orchestrator.js`, `scripts/lib/*.js`, `tests/unit/*.test.js`), not the Shopify Liquid storefront. token-goat ran as the globally-installed companion under an autonomous `/improve`/ralph loop (commit-msg task files, 47 `date_change` events June 1–14 from many resumes). **16,263 transcript lines (~27 MB), 1,932 tool calls** (1,167 Bash, 401 Edit, 196 Read, 80 Write, **58 Agent sub-agents**, 6 Glob, 2 Grep), and — notably — **91 real `token-goat` CLI invocations** (`read`×39, `skeleton`×33, `symbol`×15, `semantic`×3, `section`×1). This agent *did* adopt token-goat heavily; that makes its failure modes unusually informative.

Mined by an Opus agent on 2026-06-14. Root-cause claims below were verified against the **current repo source (version 1.8.0)** — `src/token_goat/parser.py`, `read_commands.py`, `db.py`. (The `"version":"2.1.177"` strings in the JSONL are the **Claude Code** CLI version, not token-goat's; the blogarticle doc's "token-goat 2.1.158→2.1.177" line conflated the two — disregard that attribution.)

**Skip-list honored** (already fixed / pending per prior docs): invalid `symbol` templates (iter 62), `reread_deny` sub-agent blindness (iter 63), skeleton-dir error (iter 65), `::ClassName`/`::SymbolName` placeholders (iters 66+68), CSS/SQL outline fallback (iter 66), TS arrow-const exports (iter 69), `read`-on-missing-symbol silent-empty (pending).

**Overlap with prior docs:** the pre-read latency profile (9bd4c8b7 P2-A / 6b476e93 P2 / blogarticle P3-C), CRLF `git add` warnings (blogarticle P2-B), `symbol` file-scoping demand (6b476e93 P1 / 9bd4c8b7 P3-A), bare-file `read` error (blogarticle P2-A), and the `[1m]` context-percent miscalc (9bd4c8b7 Bonus) all **re-confirm** here with fresh numbers — summarized under "Corroborations," not re-argued. **Everything in P1/P2 below is new to this session**, anchored on the JS/large-file surface the prior docs never exercised.

---

## P1 — A 6.3 MB central file silently exceeds the 2 MB index cap → misdirecting "File not found" + ~69K tokens of `sed` fallback (the session's single biggest waste) (root-cause, correctness + token burn)

**What happened.** The dominant working file was `scripts/google-ads-manager.js` — **6,348,433 bytes / 157,261 lines** (verified on disk). It exceeds token-goat's hard index cap, so it is **never indexed**, and *every* surgical command against it fails. Transcript evidence:

- L596 `token-goat symbol addSitelinks scripts/google-ads-manager.js` → `Got unexpected extra argument(s)` (file-scoping, see P3-C) — and the file isn't indexed anyway.
- L692 `token-goat read "scripts/google-ads-manager.js::decideBudgetActions"` → `File not found in any indexed project: scripts/google-ads-manager.js` / `Did you mean: config/google-ads-manager.json, scripts/adapters/google-ads-adapter.js, scripts/setup-ads-manager.js`.
- L3310 same, prefixed with a `project db 5e627076 session slow: 1001.4ms total` warning.
- L1815 `read "scripts/google-ads-manager.js::122095"` (the agent passing a **line number** as the anchor) → silent empty under `2>/dev/null`.

The "Did you mean" list is actively misleading: it names three *unrelated* files and never hints that the requested file **exists on disk but is too large to index**. The agent — which clearly wanted to use token-goat — concluded the file was simply absent and fell back to paging through it with `sed`:

> **260 `sed`/`cat`/`head` dumps of `google-ads-manager.js`, totalling 276,143 chars ≈ ~69,000 tokens** of raw, uncompressed, un-deduped JavaScript poured into context across the session (e.g. L729 `sed -n '121122,121250p'`, L1843 `sed -n '122400,122660p'` = 11,548 ch, L331 `sed -n '126490,126610p'`, L2972 `sed -n '146440,146580p'`). This is, by a wide margin, the largest token sink in the run — and 100% of it traces to one file being silently dropped from the index.

**Where.** `src/token_goat/parser.py:168` `MAX_FILE_SIZE: Final[int] = 2_000_000`; the skip fires at `parser.py:614-618` (`iter_source_files: skipping oversized file … > limit`). The miss message is built at `src/token_goat/read_commands.py:322-333` — it calls `_close_file_matches` and emits `File not found in any indexed project` with **no check for whether the path exists on disk or sits in the large-file skip table** (`_skipped_large: list[LargeFileInfo]`, parser.py:950-958 — the machinery to report skipped-large files already exists; the read path just never consults it).

**Fix (two complementary parts).**
1. **Honest error for over-cap files.** In the `file_not_found` path, before emitting "Did you mean," check whether `file_part` resolves to a real file in the project root and/or appears in the large-file table. If so, emit a *distinct* message: `` `scripts/google-ads-manager.js` is 6.3 MB (over the 2 MB index cap; raise indexing.large_file_skip_kb to index it). Surgical symbol reads unavailable — use a line range: `token-goat read "scripts/google-ads-manager.js:122400-122660"`. `` Stops the agent treating an existing file as missing.
2. **Serve line-range reads from disk even when unindexed** (see P1-B) — this is what actually reclaims the 69K tokens.

**Effort: M.** Highest-leverage fix in the session; it converts ~69K tokens of raw dumps into deduped, header-tagged surgical reads and stops the most-important file looking broken.

---

## P1-B — `read "file::N-M"` line-range works, but is gated on the file being indexed; it should fall back to disk for unindexed/over-cap project files (root-cause, partner to P1)

**What happened.** token-goat **already supports** line-range reads — `read "parser.py::100-200"` (read_commands.py:1065 help: `<file>::<symbol|N-M>`, range validation at L1002). So in principle the agent's 260 `sed -n 'A,Bp'` dumps could each have been `token-goat read "google-ads-manager.js::A-B"`, gaining the overflow-guard, the `## file — lines: A-B` header, and **read-dedup** (so re-reading the same window is suppressed instead of re-dumped). But every line-range read resolves the file through the **index DB first**, and the over-cap file isn't there, so it returns `File not found in any indexed project` and the agent reverts to `sed`. The agent also tried the wrong separator (`::122095` single line, L1815) and got silent-empty — there's a discoverability gap too (range needs `::N-M`, not `::N`).

**Where.** `read_commands.py` — `_resolve_file_target` / the colon-split that requires an indexed `rel_path`. A line/range read needs **zero index data**: it's `sed`-equivalent over a path that exists in the project tree.

**Fix.** When the target is a pure line range (`file::N-M` or `file:N`) and the file is **not indexed but exists on disk inside a known project root**, read the slice directly from disk and apply the normal header + overflow-guard + session-cache/dedup. Also accept `::N` (single line) as a 1-line range so `::122095` works. Emit the `read "file:N-M"` form in the P1 over-cap message so the agent discovers it. **Effort: S–M.** Pairs with P1; together they route the entire 69K-token `sed` fallback back through token-goat.

---

## P2-A — token-goat's most useful read/symbol diagnostics are emitted on STDERR; the agent's habitual `2>/dev/null` silences them → "(Bash completed with no output)" (correctness of UX, precise mechanism behind prior P2-C)

**What happened.** Five token-goat surgical reads returned a bare `(Bash completed with no output)` (L1530 `symbol … --name loadActions 2>/dev/null`, L1815, L2872, L8324, L9166) — indistinguishable from an empty/erroring file. But the **same command classes produce rich, helpful diagnostics when stderr is *not* suppressed**:

- L607 `symbol "highROASCampaigns" 2>&1` → `No matches for 'highROASCampaigns'` / `Did you mean: getCampaigns, shoppingCampaignRows, fetchCampaigns, activeCampaigns, campaigns`.
- L7613 `symbol checkoutConvPctThreshold` → `Did you mean: getCautionThreshold, checkFreezeThreshold, resolveThreshold`.

The difference is purely the redirection: `2>&1` shows the "Did you mean," `2>/dev/null` hides it. token-goat emits these diagnostics with `err=True` (read_commands.py:264, 266, 323; `typer.echo(..., err=True)` at 838/866/1060/1456). **60 token-goat invocations in this session piped `2>/dev/null`** — so on every miss the agent saw nothing and was trained that the tool "returns empty on a typo."

**The causal loop is worse than it looks.** The agent learned `2>/dev/null` *because* token-goat also pumps **noisy** warnings onto the same stderr stream — `project db … session slow: NNNNms` (a `_LOG.warning` at db.py:825, **236 occurrences** this session) and `normalize_payload` warnings. So: noisy stderr (perf/log warnings) → agent defensively adds `2>/dev/null` → useful stderr (Did-you-mean / File-not-found / "use outline") is collaterally hidden → silent-empty → abandonment.

**Where.** `read_commands.py` not-found echoes (err=True); `db.py:825` slow-DB warning; the install/help text that the agent may have copied `2>/dev/null` from.

**Fix.** Split signal from noise across the two streams. (a) Route **not-found diagnostics** ("No matches / Did you mean / File not found / use `outline`") to **STDOUT** — they are the command's primary answer on a miss, not an error; reserve stderr for genuine crashes. Then `2>/dev/null` can't hide them. (b) Demote the `session slow` and `normalize_payload` warnings to DEBUG (or log-file only) so they stop polluting captured output and stop *motivating* `2>/dev/null`. (c) Never exit 0 with empty stdout on a miss. Add a test asserting a missing-symbol `read` writes the "Available/Did-you-mean" line to **stdout**. **Effort: S.** Directly converts the silent-empty abandonment pattern (prior P2-C, re-confirmed 5× here) into a self-correcting hint.

---

## P2-B — `read` symbol-miss is weaker than `symbol`'s miss: no available-symbol list on some paths (consistency)

**What happened.** L4352 `read "scripts/lib/microsoft-search-query-mining-action.js::mineAndAddWinningQueries"` (captured via `2>&1`) → exactly `Symbol not found: mineAndAddWinningQueries (in …)` — **no "Did you mean," no "use outline" pointer.** The file *is* indexed (it returned "Symbol not found," not "File not found"), so the available symbol names were free to list. Compare `symbol`'s miss (L607/L7613), which always fuzzy-suggests. Current source (read_commands.py:753-767) *intends* to append either close-symbol suggestions or an `outline` pointer, but neither surfaced for this case — meaning `_close_symbol_matches` returned empty *and* the outline-fallback branch didn't fire for the captured output (possibly an older deployed build, or the fuzzy threshold rejected a real near-miss).

**Where.** `read_commands.py:753-780` (`_close_symbol_matches`, suggestion/outline assembly).

**Fix.** Guarantee the miss message **always** ends with *something actionable on stdout* — either `Did you mean: …` (loosen the fuzzy threshold so a moderately-close name like a casing/affix variant appears) or, unconditionally when no close match, `Run \`token-goat outline <file>\` to list symbols.` Make `read`'s miss output identical in shape to `symbol`'s. **Effort: S.** Pairs with P2-A (both are "a miss must teach the next step, on stdout").

---

## P2-C — Large `git status --short` and `git add` outputs pass through raw (10K+ ch each) (compression coverage)

**What happened.** The autonomous loop touched hundreds of files, so VCS commands emitted huge raw blobs:
- L13699 `git status --short` → **203 lines / 10,474 ch** of one-line-per-file status.
- L8531 `git add tests/unit/… …` → **206 lines / 10,879 ch** — overwhelmingly `warning: … LF will be replaced by CRLF …` (the blogarticle P2-B CRLF noise, re-confirmed on a JS repo).

Neither was compressed. A 200-file `git status --short` is largely shape-redundant (` M`, `??`, ` D` prefixes); it can collapse to counts-by-status plus a bounded sample, preserving conflict/untracked specifics.

**Where.** The git/compound filter registry in `src/token_goat/bash_filters.py`.

**Fix.** (a) Strip `^warning: (in the working copy of|.*LF will be replaced by CRLF)` in the git/compound filter (already proposed in blogarticle P2-B; this session adds a 206-line JS-repo data point). (b) Add a `git status --short` shape filter: when the output is N>~40 `XY path` lines, emit `git status: 203 files (M 150, ?? 40, D 13) — showing first 20:` + the sample, with full conflict (`UU`) / untracked detail preserved. **Effort: S–M.**

---

## P3 — Smaller items

- **P3-A — `codex exec` output dumps raw (10K+ ch).** The agent uses the Codex peer-review skill, which shells `codex exec … 2>&1`; L13252 → 232 lines / 10,455 ch, L551 → 165 lines / 7,610 ch of Codex reasoning + banners landed raw in context. Niche to this user's workflow, but a "codex exec" filter (drop the sandbox/banner preamble, keep the verdict/diff) would help. `bash_filters.py`. **Effort: S–M.**

- **P3-B — Markdown task-file `cat … | head` instead of `section`.** L52 `cat tasks/ads-improvements-checklist.md | head -100` (7,699 ch), L67 `cat tasks/lessons.md | head -80`, L12957 `cat tasks/deferred-items.md | head -100` (10,746 ch) — large markdown docs dumped wholesale. These are exactly what `token-goat section "file::Heading"` is for, but no pre-read nudge fired on a Bash `cat` of an indexed `.md`. Same coverage gap as 9bd4c8b7 P2-F (Bash file-dumps bypass read hints), with markdown-section as the better redirect. **Effort: M** (Bash-dump nudge) — already tracked under P2-F; logged here as fresh `.md` evidence.

- **P3-C — `symbol NAME FILEPATH` file-scoping attempted 3 ways, all rejected (demand now proven across 3 sessions).** L596 `symbol addSitelinks scripts/google-ads-manager.js` → `Got unexpected extra argument(s)`; L1530 `symbol … --name loadActions` (no such option); L9166 `symbol "pmax-…\|strengthResult\|StrengthRefresh" scripts/ads-orchestrator.js` (regex-alternation as a name + file positional) → empty. The agent keeps reaching for file-scoped symbol lookup. Already on the list (6b476e93 P1 / 9bd4c8b7 P3-A); this session is the strongest demand signal yet — **prioritize adding `symbol NAME [FILE]` (or `--file`) scoping.** `src/token_goat/cli.py` symbol command. **Effort: S.**

- **P3-D — `skeleton` of a 22K-line file is usable but the agent always `head`-truncates it.** L4680 `skeleton scripts/ads-orchestrator.js | head -40`, L4261 `skeleton …microsoft-ads-adapter.js | head -40` — both reported `(80 symbols)` and the agent piped `head -40`/`head -80` every time, implying the full skeleton of a large file is more than it wants at once. (The hard cap is `MAX_SYMBOLS_PER_FILE = 1_000`, parser.py:177 — not hit here; the "80" is the real count.) Consider a `skeleton --top N` / paged mode, or grouping by class/section so a large skeleton is scannable without `head`. **Effort: S.**

---

## Corroborations (already documented — fresh evidence only)

- **Pre-read/global-DB latency** (9bd4c8b7 P2-A, 6b476e93 P2, blogarticle P3-C). 3,156 `_tg_elapsed_ms` samples: **median 1,188 ms, mean 1,064 ms, p90 2,015 ms; 59% ≥ 1 s, 23% pinned at the ~2 s ceiling; 696 watchdog trips (23%).** Plus **236** `session slow: NNNNms` warnings (db.py:825, ~1.0–1.9 s each). Same root: contended `busy_timeout`/global-DB acquire on a large index under a 58-sub-agent load. Fix unchanged: non-contending read-only handle for hints, fail-fast on contended lock, demote the warning (see P2-A-b).
- **`[1m]`/large-context percentage miscalc** (9bd4c8b7 Bonus). **Live re-confirmation in *this* mining session:** token-goat's own pre-read hint to me read `CONTEXT CRITICAL (380% full): context window is almost full … Avoid full-file reads … (+1 more hints suppressed)` while running on `claude-opus-4-8[1m]` with vast headroom. The percentage is computed against a ~200K assumption and **over-reports ~5×** on 1M-context models, prematurely forcing surgical-only mode *and suppressing other hints*. Detect the `[1m]`/large window before the budget calc. (Direct observation, not from the target transcript.)
- **Read-dedup "already in context" false-positive across reads** (9bd4c8b7 P2-D). **Live re-confirmation:** my first `Read` of `2026-06-14-session-6b476e93-mining-findings.md` was denied as "already in context" when it was **not** in context; the promised "second identical request passes through automatically" **also** denied; I had to route around via `cat`. And the dedup counter **over-reported** ("read_commands.py read 10x this session" after a single Read). The counter both blocks legitimate first-reads and inflates counts.
- **Placeholder hint tokens still emitted** (9bd4c8b7 P3-D / 6b476e93 P3). Live: the dedup hint shown to me printed literal `token-goat symbol <NAME>` and `…::SymbolName`. Confirm the iter-66/68 fix covers the angle-bracket/`SymbolName` variants in the read-N×/already-in-context templates.

---

## What's working well (don't regress)

- **`symbol NAME` fuzzy "Did you mean"** is genuinely good (L607, L7613) — the right model for the P2-A/P2-B "miss teaches next step" fixes. The only problem is it lives on stderr.
- **Real adoption:** 91 token-goat CLI calls, ~75 of them successful surgical reads. When the file is indexed and the symbol exists, the agent uses and trusts the tool. The failures above are the friction points that erode that.
- **Line-range read syntax already exists** (`read "file::N-M"`); the gap is only that it requires an indexed file (P1-B).

---

## Recommended implementation order

1. **P1 + P1-B** — over-cap files: honest "too large, use a line range" message **and** serve `read "file::N-M"`/`file:N` from disk for unindexed-but-present project files (`read_commands.py`, parser large-file table). Reclaims the ~69K-token `sed` sink and stops the central file looking broken. (M)
2. **P2-A** — move not-found diagnostics to **stdout**; demote `session slow`/`normalize_payload` warnings off stderr so agents stop adding `2>/dev/null` (`read_commands.py`, `db.py`). Kills the silent-empty abandonment loop. (S)
3. **P2-B** — make `read` misses always end with `Did you mean`/`outline` on stdout, matching `symbol` (`read_commands.py:753-780`). (S)
4. **P2-C** — git CRLF-warning strip + `git status --short` volume collapse (`bash_filters.py`). (S–M)
5. **P3-C** — `symbol NAME [FILE]` file-scoping (demand proven 3 sessions running) (`cli.py`). (S)
6. **Corroborations** — `[1m]` context-percent detection; dedup first-read false-positive + counter inflation; perf acquire path. (S/M)

Key files: `src/token_goat/parser.py:168/177/614-618/950-958` (caps + large-file table), `src/token_goat/read_commands.py:264/322-333/668/753-780/1002/1065` (miss messages, stderr routing, line-range gating), `src/token_goat/db.py:825` (slow warning), `src/token_goat/bash_filters.py` (git/status/codex filters), `src/token_goat/cli.py` (`symbol` file-scoping), the `[1m]` context-budget calc and dedup-hint logic in `hooks_read.py`/`hints.py`.
