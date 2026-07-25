# Session Mining Findings — blogarticle (3342a3ae)

Source: a `coracrea-website` session — a **Shopify Liquid storefront** where token-goat ran as the globally-installed companion. The session built/edited blog-article templates under an autonomous `/improve` loop (commit messages `improve_commit_msg_sections-article-pressed-flower-journal_N.txt` confirm the ralph/improve harness). 7991 transcript lines, ~20 MB, spanning token-goat versions **2.1.158 → 2.1.177** (resumed many times June 1–14). Tool mix: 306 Bash calls, 49 `.liquid` Reads (one file read **44×**), 50 `.liquid` Edits, 19 `.json` Reads, and only **2** real `token-goat` CLI invocations (`section`×1 → empty, `skeleton`×1 → "0 symbols").

Mined by an Opus agent on 2026-06-14 with two Sonnet sub-agents reading the encoding/notation and compression/read-behavior halves. Source claims below were verified against the live repo (`src/token_goat/*.py`) except the perf string noted in P3-C.

**Skip-list honored** (already fixed): invalid `symbol` templates (iter 62), `reread_deny` blind to sub-agent edits (iter 63), skeleton-dir error (iter 65), `::ClassName`/`::SymbolName` placeholders (iters 66+68), CSS/SQL outline fallback (iter 66), TS arrow-const exports (iter 69), `read` on missing symbol silent-empty (pending).

**Overlap with the 9bd4c8b7 doc:** this session independently re-confirms the `34285t wasted` false premise (their P2-B), the `read`-on-missing-symbol silent-empty (their P2-C / pending), and Bash file-dumps slipping past surgical-read nudges (their P2-F). Those are summarized briefly under "Corroborations" rather than re-argued. Everything in P1/P2 below is **new** to this session.

---

## P1 — Lone surrogate `\udc8f` crashes the session-manifest atomic write → session state silently lost (correctness, root-cause)

**What happened.** Five times (transcript lines **7074, 7141, 7147, 7703, 7709**; 7147 & 7709 fail twice — main JSON plus a temp sidecar) the `PostToolUse:Bash` hook emitted to stderr:

```
atomic write failed for 3342a3ae-81d9-49d9-b66a-ba8f2861c4db.json: 'utf-8' codec can't encode character '\udc8f' in position 90727: surrogates not allowed
```

The crash fires while caching Bash output that contains `🛠️` (U+1F6E0 U+FE0F — the dotenv/jest tip glyph). On Windows the piped command output reaches token-goat already mis-decoded (cp1252 instead of UTF-8), so U+FE0F's final byte `\x8f` survives as the lone UTF-16 surrogate `\udc8f`. When `post_bash` folds that string into the session manifest and `atomic_write_text` opens the temp file with `encoding="utf-8"` and **no error handler**, `fh.write()` raises, the write is aborted, and **the touched-file / line-range state for that turn is never persisted** — exitCode is still 0, so nothing surfaces to the user. This directly undermines the read-dedup and pre-compact-manifest features that depend on that state.

**Where.** `src/token_goat/paths.py:1101` — `_atomic_write_core`:
```python
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(content)
```
The write error is logged at `paths.py:1104` (`_LOG.warning("atomic write failed for %s: %s", ...)`) and re-raised. Root contamination is upstream at the Bash-output capture/cache boundary that decodes pipe bytes as cp1252.

**Fix.** Two layers: (1) **Sanitize at ingest** — when `post_bash` captures cached command output, decode/normalize with `errors="surrogatepass"` or strip lone surrogates (`content.encode("utf-8", "replace").decode("utf-8")`) so they never reach the manifest. (2) **Harden the write** — `atomic_write_text` should encode with `errors="surrogatepass"` (then `atomic_write_bytes`) or `"replace"` so a stray surrogate can never abort a session-state write. Add a regression test feeding a `\udc8f`-bearing string through `atomic_write_text` and asserting the file is written (not raised). **Effort: S.** This is the highest-priority correctness bug — it silently breaks state persistence.

---

## P1 — Same surrogate, double-encoded, corrupts a cached bash-output preview hint (correctness, shared root cause)

**What happened.** At line **5857** a `PreToolUse:Bash` cached-output preview hint rendered the dotenv banner as mojibake:

```
[dotenv@17.2.3] injecting env (48) from .env -- tip: ðŸ›\xa0ï¸?  run anywhere with `dotenvx run -- yourcommand`
```

The original text was `🛠️`. Its UTF-8 bytes `\xf0\x9f\x9b\xa0\xef\xb8\x8f` were decoded as cp1252 → `ðŸ›\xa0ï¸` plus the same lone surrogate `\udc8f` (rendered `?`). So token-goat read the cached command output as cp1252 instead of UTF-8 when building the preview. **Identical root cause to P1 above** — fix the decode at the bash-output capture/cache boundary (force `encoding="utf-8", errors="replace"`) and both the manifest crash and the garbled preview disappear together.

**Where.** The bash-output cache ingest / preview-builder in `src/token_goat/hooks_bash.py` (or wherever cached command stdout is read back for the "Preview (first N lines)" / "cached output" hints). Grep the cached-output path for any `.decode()` / `open()` without an explicit `encoding="utf-8"`.

**Fix.** Standardize all cached-output reads/writes on UTF-8 with an explicit error handler. Add a test: a command whose stdout contains a multibyte emoji, asserting the stored preview round-trips the glyph (or cleanly replaces it) rather than producing `ðŸ`-style mojibake. **Effort: S.**

---

## P1 — `git push` pre-push asset-bundler spam passes through raw (~13.7K tokens; biggest single waste) (compression coverage)

**What happened.** This repo's pre-push hook (Husky/lefthook) runs a Shopify asset bundler + schema validation + a Playwright checkout test. Every `git push` emits **one `… NNms (unchanged)` line per asset** before the actual push result. Six large `git push` results landed **raw** in context (result lines **1775, 1792, 3386, 5907, 6037, 6344, 7043**), each ~10K chars (max 16,132 at L1792). Sample at L5907: **255 of 270 lines** are `assets/foo.js 35ms (unchanged)`. Across the session that is **~1,172 `(unchanged)` lines ≈ 54,777 chars ≈ ~13.7K tokens of pure noise**; the signal is the trailing ~4 lines (`To github.com…`, `… -> main`, the test pass/fail). token-goat's bash compression did **not** fire on these. The agent noticed and began hand-appending `| tail -N` to later pushes (L3668, L6379, L7034, L7321, L7689, L7804, L7972) — direct evidence a filter is overdue.

**Where.** The bash-compression filter registry in `src/token_goat/bash_filters.py` (or equivalent). There is a `git-log` filter and a compound-command wrapper, but no `git push` / asset-bundler filter.

**Fix.** Add a filter keyed on **output shape**, not the literal command (several pushes were already piped through `tail`, and the noise comes from a wrapped pre-push hook, not git itself): when output contains a run of lines matching `^\s*\S+\.(js|css|liquid|json)\s+\d+ms\s+\(unchanged\)$`, drop the `(unchanged)` lines, collapse changed-asset timing lines to a count, and always preserve the tail (push result, reject/error lines, Playwright/jest summary, `Validating Shopify schemas... All schemas valid.`). Reclaims ~13.7K tokens in this one session. **Effort: M.**

---

## P1 — Liquid is unindexed; the dedup hint repeatedly suggests `outline`/`symbol` that return nothing for `.liquid` (coverage gap + bad-suggestion loop)

**What happened.** The dominant file type was `.liquid` (49 Reads, 50 Edits). `article-pressed-flower-journal-2026.liquid` (108 KB) was read **44×**. On nearly every re-read the dedup hint fired (lines 3590, 3806, 4338, 4381, 4396, 4416, 4503, 4633, 4691, 4774, 5053, 5678, 5737, 6106, 6233 …) with:

```
`article-pressed-flower-journal-2026.liquid` read NNx this session — consider
`token-goat outline …` or `token-goat symbol …<filepath>` for a narrower read.
```

The agent **never ran `outline` or `symbol` once** across the whole session despite ~25 such nudges; the read count climbed 24 → 44 unabated. I verified live why: on the actual file,
- `token-goat outline` → *"No indexed top-level symbols found"*
- `token-goat symbol <filepath>` → *"No matches"* (and `symbol` takes a **symbol name**, not a file path — the hint's usage is structurally wrong, the same class of bug as the iter-62 fix but for the dedup-hint path)
- `token-goat skeleton` → *"0 symbols"* (also seen live at transcript L6818)

So the hint kept advertising two commands that return nothing for Liquid, and the agent correctly learned to ignore them and stick with `Read` + `rg`. **A dedup hint that suggests a command which returns empty for the file's language trains the agent to distrust all token-goat hints.**

**Where.** Two issues. (1) Language coverage: there is no Liquid adapter under `src/token_goat/languages/`, so symbol/skeleton/outline are empty for every `.liquid` file in a Shopify repo. (2) Hint construction in `src/token_goat/hints.py`: the dedup nudge passes a **file path** into the `token-goat symbol …` template (symbol expects a name), and it suggests `outline`/`symbol` without checking whether the file actually has indexed symbols.

**Fix.** (a) **Add a Liquid adapter** that extracts meaningful anchors — `{% schema %}` blocks (by their `"name"`), `{% comment %}`-delimited sections, and HTML id/section landmarks — so `outline`/`skeleton` return something for `.liquid`. Liquid is the entire surface of a Shopify storefront; this is high-leverage for any Shopify user. (b) **Guard the dedup hint**: before suggesting `outline`/`symbol`, check the index has ≥1 symbol for the file; if zero, suggest the *working* path instead — `token-goat read "<file>::<section-name>"` (which **does** work on Liquid, see P2-A) or a bounded `Read` with `offset`/`limit`. Never emit `token-goat symbol <filepath>` (wrong arg shape). **Effort: M** (adapter) **+ S** (hint guard). Add a test asserting the dedup hint for a zero-symbol file does not suggest `outline`/`symbol`.

---

## P2-A — `read` and `section` disagree on what a Liquid "section" is (`read` works, `section` fails) (correctness, confusion)

**What happened.** The agent's own attempt at a surgical read, L6768:
```
token-goat section "tasks/article-cyanotype-content.md::Section 4 - Step by Step" 2>/dev/null || echo "fallback"
```
returned **empty** (Bash completed with no output; the `|| echo` didn't even fire, so exit 0 with no text). Separately I verified live on the Liquid file that the two commands resolve sections **inconsistently**:
- `token-goat read "…article-pressed-flower-journal-2026.liquid::Botanical Journal Guide"` → **works**, returns the 56-line `{% schema %}` block named "Botanical Journal Guide".
- `token-goat section "…article-pressed-flower-journal-2026.liquid::Botanical Journal Guide"` → **"Section not found"**.

And the *good* pre-read hint (lines 4416, 5682, 5737) correctly told the agent to use `token-goat read "…::Botanical Journal Guide"` — but the agent reached for `section` instead and got nothing, reinforcing distrust. So: the hint recommends `read` (correct), but `section` silently fails on the same anchor, and a bare-file `read` errors (`Error: target must be '<file>::<symbol>'`). Three commands, three different notions of "section."

**Where.** `src/token_goat/cli.py` — the `read` and `section` command handlers and their shared (or divergent) section/symbol resolver.

**Fix.** Unify section resolution so `read "file::X"` and `section "file::X"` accept the same anchors (schema names, markdown headings, comment-delimited blocks). When an anchor isn't found, **exit non-zero with a diagnostic on stdout** listing available sections (never success-with-empty-output — same principle as the pending `read`-missing-symbol fix). Add a test that the identical `file::Anchor` succeeds (or fails identically) across `read` and `section`. **Effort: M.**

---

## P2-B — `git`/compound filters don't strip Windows CRLF warnings (88 lines of pure noise) (compression coverage)

**What happened.** `warning: in the working copy of '…', LF will be replaced by CRLF the next time Git touches it` appeared **88×** in the transcript (**41×** inside Bash tool_results, across **30** separate results — e.g. L3456 had 2 in a 14,293-char blob; L6310/L6324/L6141 each 2–3). On Windows with `core.autocrlf` this is 100% noise emitted on nearly every `git add` / `git stash` / `git pull --rebase` / `git diff`. The git-log filter and compound-command wrapper that *did* fire (L5628, L5885, L6021) passed these straight through.

**Where.** The git filter and compound wrapper in `src/token_goat/bash_filters.py`.

**Fix.** Drop any line matching `^warning: (in the working copy of|.*LF will be replaced by CRLF)` in the git filter and the compound-stage wrapper. Zero risk, never load-bearing. ~88 lines reclaimed. Add a fixture asserting the warning lines are stripped while the diff/status payload survives. **Effort: S.**

---

## P2-C — Stored-output recall delivered zero value: 6 stores, 0 recalls; hostile id format (UX, dead feature)

**What happened.** token-goat stored large Bash output **6×** with hints like `[token-goat] large output: 270 lines stored (bash-output <id> to recall)` (lines 5908/5910, 6086/6126, 6311/6313, 6325/6327, 7026, 7259). The agent ran a `token-goat bash-output <id>` recall command **zero times** (scanned all 306 Bash calls). Meanwhile it re-ran the same noisy commands constantly — `git push` ×27, `git status` ×17, `git diff --stat` ×11, `npx jest` ×17 — because what it wanted was *fresh* state, not the *stored* prior output. Three compounding reasons recall is ignored: (1) **the id is hostile** — `3342a3ae-81d9-49-1781455310293-1ff44c28d6be42b8` is 48 chars of no semantic content; an agent won't retype it; (2) **the wrong content was stored** — 270 lines of `(unchanged)` push spam (fix P1's git-push filter and most stores stop happening); (3) recall only helps when the *same prior* output is needed again, which almost never happens in an `/improve` loop. The dedup "(no re-run)" hint (only **2** fired all session, L7595/L7596) already demonstrates a better UX — it shows a short `…8db3fd88` tail-id.

**Where.** The store-hint formatter in `src/token_goat/hooks_bash.py` (large-output storage path) and the dedup-hint formatter in `src/token_goat/hints.py`.

**Fix.** (a) Make the store hint use the **short tail-id** form (`…8db3fd88`) the dedup path already uses, or a memorable alias (`bash-output last`, `bash-output push-1`). (b) De-prioritize manual recall in favor of expanding the dedup "(no re-run)" hint to the repeated git/jest families — that mechanism is the one that actually changes behavior, and it under-fired here. (c) Fixing P1 (git-push filter) removes most of the junk being stored in the first place. **Effort: S** (short ids) **+ M** (dedup coverage).

---

## P2-D — `node scripts/*.js` progress + dotenv banner pass through raw (compression coverage)

**What happened.** Ad-hoc `node scripts/*.js` runs (`populate-theme-images.js` L5942 ~3,307 chars; `upload-reel-thumbnails.js`) dumped raw dotenv banners and per-item progress into context. The recurring `[dotenv@17.2.3] injecting env (48) from .env -- tip: …` banner is per-run noise (and is the very output that triggered the P1 mojibake). No filter exists for ad-hoc node scripts.

**Where.** Filter registry in `src/token_goat/bash_filters.py`.

**Fix.** Add a one-line strip for the dotenv `injecting env (N) from .env … tip:` banner, and a generic "node script progress" filter that collapses repeated per-item `[item] ok/done`-style lines to a count while preserving the summary and any error/stack lines. **Effort: S–M.**

---

## P3 — Smaller items

- **P3-A — `normalize_payload` warns on every SessionStart (45× log noise).** `SessionStart:compact` (43×) and `SessionStart:resume` (2×) emit `normalize_payload: tool_name missing or invalid; received None` to stderr. SessionStart events legitimately carry no `tool_name`. Source: `src/token_goat/hooks_cli.py:139-143`. All exitCode 0 (harmless), but 43 firings in one compact-heavy session is pure noise. **Fix:** skip the `tool_name` validation (or downgrade to `_LOG.debug`) for SessionStart-family events, which have no tool by design. **Effort: S.**

- **P3-B — "34285t wasted" false premise on small config files (re-confirms 9bd4c8b7 P2-B).** Lines 2640/2645/2650/2655: `` `.mcp.json` L1-2000 ⌘ (L1-100000). ~34285t wasted. `` — identical figure on `.mcp.json` (34 lines), `settings.json` (92), `settings.local.json` (206), global `settings.json` (336). Root cause verified in source: `hints.py:854` sets `req_end = req_start + (safe_limit or DEFAULT_READ_LIMIT) - 1` with `DEFAULT_READ_LIMIT = 2000` (line 516); `hints.py:1322` computes `wasted = _est_tokens_from_lines(requested_lines)` = `2000 × 17.14 ≈ 34285` for *every* limitless re-read regardless of true file size. The cached `(L1-100000)` is the `_UNKNOWN_END_SENTINEL = 99_999` (`session.py:3730`, recorded at `session.py:3946`). **Fix:** clamp `requested_lines` to the file's actual indexed/observed line count (the index already knows it) before estimating waste; suppress the figure entirely when the cached range is the unknown-end sentinel. Already on the list via 9bd4c8b7 P2-B — this session adds a fourth-through-seventh independent data point and the exact source lines. **Effort: S.**

- **P3-C — `global db session slow: NNNNms` (56× this session, ~1.3 s median).** Distribution: min 1016 ms, max 1922 ms, median 1313 ms; by hook `PostToolUse:Bash` n=35, `PreToolUse:Read` n=16, `PreToolUse:Grep` n=3, `PreToolUse:Bash` n=2. The 1.0 s floor and clustered ~1313 ms medians across unrelated hooks point to a shared slow global-DB **session-acquire** path (SQLite open/connect or `vec0` attach on a large global index), not per-call workload. Note: the string `global db session slow` is **not in the current repo** `src/`, so the running binary (`%LOCALAPPDATA%\dfk-helper\token-goat\`) is an older/installed build — confirm deployed version, but the perf signal is real and matches 9bd4c8b7 P2-A / 6b476e93 P2. **Fix:** acquire pre-read/pre-bash hints from a non-contending read-only connection and reuse a cached handle across hook invocations within a session; return fast on a contended lock instead of waiting out the timeout. **Effort: M.**

---

## Corroborations (already documented — no new action, just fresh evidence)

- **`read` on a missing anchor returns success-with-empty-output** (pending fix / 9bd4c8b7 P2-C). Re-confirmed at L6768 where `token-goat section "…::Section 4 - Step by Step"` returned nothing. See P2-A above for the `read`/`section` inconsistency angle, which is the new wrinkle.
- **Bash `cat`/`sed`/`rg` reads of indexed files slip past surgical-read nudges** (9bd4c8b7 P2-F). This session: `cat templates/article.*.json` (L45/L46), `cat snippets/article-email-capture.liquid` (L1354), plus large `sed -n`/`cat` Liquid dumps (L5223 ~19.7K chars, L5333, L7256 ~12K). For `.liquid` this is partly justified (no symbols to read surgically — see P1), but the JSON `cat`s had no nudge. A pre-read nudge on `cat`/`sed -n` of an indexed file would catch these.

---

## What's working well (don't regress)

- **jest filter** fired correctly (L7112): `jest: 1 PASS suite(s) suppressed … 0 FAIL suite(s) shown`. Suite-level PASS suppression with FAIL preserved is right. (Agent still hand-piped jest through `grep -E "√|×|PASS|FAIL"` 17×, suggesting the filter could be more aggressive so manual grepping stops.)
- **git-log filter** (L5628) and **compound-command auto-wrap** (L5885, L6021) fired as designed.
- The **section-anchored pre-read hint** ("Lines 1591–1604 span `Botanical Journal Guide`. Use `token-goat read "…::Botanical Journal Guide"`") is the one hint that pointed at a *working* command for Liquid (L4416, L5682, L5737). Lean into this pattern; it's the right model for the P1 Liquid-adapter and P1-hint-guard fixes.

---

## Recommended implementation order

1. **P1 surrogate write-crash + ingest sanitize** (`paths.py`, bash-output ingest) — silently breaks session-state persistence; also fixes the P1 mojibake preview. Both share one root cause. (S)
2. **P1 git-push asset-bundler filter** (`bash_filters.py`) — ~13.7K tokens reclaimed per session; also cuts the junk feeding P2-C stores. (M)
3. **P1 dedup-hint guard for zero-symbol files + stop emitting `symbol <filepath>`** (`hints.py`) — fast, stops training distrust on every Liquid re-read. (S)
4. **P2-B CRLF-warning strip + P2-D dotenv/node-script filters** (`bash_filters.py`) — cheap, broad noise reduction. (S)
5. **P1 Liquid adapter** (`languages/`) — unlocks surgical reads for the entire Shopify surface; pairs with #3. (M)
6. **P2-A unify `read`/`section` resolution + non-empty diagnostics** (`cli.py`). (M)
7. **P2-C short/aliased bash-output ids + expand dedup "(no re-run)" coverage** (`hooks_bash.py`, `hints.py`). (S+M)
8. **P3-A SessionStart warning silence** (`hooks_cli.py`); **P3-B waste clamp** (`hints.py`); **P3-C global-DB acquire perf** (`db.py`). (S/S/M)
