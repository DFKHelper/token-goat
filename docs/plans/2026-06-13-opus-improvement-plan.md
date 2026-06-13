# Token-Goat Improvement Plan — 2026-06-13 (Opus)

Derived from mining a real Claude Code session (`coracrea-website/66914af7`, 1677 lines, 147 Bash / 21 Read / 12 Edit calls) plus a precise audit of current token-goat coverage. Items are ranked by impact × feasibility: cheap high-leverage wins first.

## Headline findings from the session

- **Bash produced 82% of all tool-result bytes** (190 KB of 231 KB). Read was only 15%.
- **Repeated probing of one unchanged log file**: `/tmp/ads-dryrun3.log` was hit by **17 distinct** `grep`/`wc`/`tail` commands, `/tmp/ads-dryrun.log` 15×, `ads-dryrun2.log` 9×. Current grep-dedup only catches *byte-identical* commands, so it caught **none** of these.
- **Same source files grepped many ways**: `ads-orchestrator.js` touched 31× by bash read-commands, `competitor-surge-detector.js` 12×, `keyword-margin-bid-action.js` 7×.
- **`wc -l` ran 13×** and is not detected at all.
- Large single results: `git push` (14.8 KB + 10 KB), `git diff --stat` (10 KB / 9 KB / 7 KB), `git commit` (10 KB), `codex exec` (10.7 KB), `node -e` probe (2.5 KB).

The verified gaps (everything else in the audit is already implemented): log re-grep caching, `wc -l`, `find`, `node -e`/`python -c` probes, `codex exec` output, and >8 KB Bash auto-promotion.

---

## Tier 1 — Quick wins, high impact (the log-probe loop)

### 1. Log-file content cache keyed on (path, size, mtime) [M]
The single biggest unaddressed burner. When a `grep`/`rg`/`wc`/`tail`/`head`/`sed`/`cat` targets a file under `/tmp`, `*.log`, or any path written earlier this session, cache the file's full content once keyed on `(abspath, size, mtime)`. Serve every subsequent probe of the unchanged file from the cache and emit a hint pointing to `token-goat bash-output <id> --grep/--tail/--section`. In the session this would have collapsed 17 + 15 + 9 = 41 file reads into 3. Touch `bash_cache.py` (new `store_file_snapshot`/`load_file_snapshot`), `bash_detect.py` (flag log-like targets), `hooks_cli.py` (wire pre-bash). Expected savings: ~30–40 KB/session on log-heavy debugging.

### 2. Detect `wc -l` / `wc -c` as a metadata probe [S]
`wc` ran 13× and is unhandled. Add `wc` to `bash_detect.py` read-command set; when the target is cached (item 1) or indexed, answer the line/byte count from cached metadata without re-reading. Most `wc -l file && tail -N file` calls become a single cached lookup. Touch `bash_detect.py`, `bash_cache.py`.

### 3. Compound-command splitting for `A && B` read chains [S]
Many calls were `wc -l X && tail -N X` or `cat X && cat Y`. The parser should split on `&&`/`;` and evaluate each segment against the cache independently, so a cached `wc` and a cached `tail` of the same file both resolve. Touch `bash_parser.py` (already splits some — extend to multi-read segments and merge cached answers).

### 4. Re-grep-of-same-file advisory hint [S]
Even when content differs per grep, track per-session `grep_target_counts[path]`. On the 3rd distinct grep of the same unchanged file, emit a hint: "you've grepped X 3× with different patterns; the file is cached — use `token-goat bash-output <id> --grep <pat>` or read it once." Cheap to add alongside existing `file_access_counts`. Touch `hints.py`, `session.py`.

### 5. `find` parity with `fd` [S]
Only `fd`/`fdfind` get `FdFilter`; bare `find` falls through. Add a `find`-recognizing branch that maps to the same dir-listing/recursive-listing compression path. Touch `bash_detect.py`, `bash_cache.py` (`is_dir_listing_command`).

### 6. `node -e` / `python -c` inline-probe passthrough labeling [S]
These are parsed as `unknown` and uncompressed (one produced a 2.5 KB stderr dump). Detect single-line `-e`/`-c`/`-p` eval probes and apply generic stderr/stack-trace compaction (collapse node_modules frames, dedupe repeated lines). Touch `bash_parser.py`, `bash_compress.py`.

### 7. `codex exec` / external-agent output compaction [S]
`codex exec --sandbox read-only` returned 10.7 KB of banner + workdir + reasoning preamble. Add a filter that strips the fixed Codex/agent banner ("OpenAI Codex vX.Y", workdir/model lines) and keeps the substantive output. Touch `bash_compress.py` (new `CodexFilter`).

### 8. Bash-output auto-promotion above a byte threshold [M]
No auto-promotion exists. When a Bash result exceeds ~8 KB after compression, store it to the bash-output cache, return a head/tail preview plus a hint ("full output cached: `token-goat bash-output <id> --grep/--section/--tail`"). Caps the worst single results (`git push` 14.8 KB, `codex` 10.7 KB). Touch `bash_runner.py`, `bash_cache.py`, `hints.py`.

### 9. `git push` progress-line collapse hardening [S]
`GitPushFilter` exists but two pushes still returned 14.8 KB and 10 KB. Audit against the captured payloads: collapse `remote:` resolving-deltas progress, repeated `Enumerating/Counting/Compressing objects` percentage lines, and verbose branch-tracking blocks to one summary line each. Touch `bash_compress.py::GitPushFilter`.

### 10. `git diff --stat` large-tree summarization tuning [S]
Three `--stat` calls returned 10 KB / 9 KB / 7 KB despite `_compress_git_diff_stat`. Lower the per-file-list threshold and, for `--stat -- <pathspec>`, group by top-level directory with `N files, +X/-Y` rollups. Touch `bash_compress.py::_compress_git_diff_stat`.

---

## Tier 2 — Cross-tool dedup and smarter caching

### 11. Content-hash cross-tool dedup (Bash cat ↔ Read) [M]
Audit says `_handle_bash_dedup` exists but matches on path/offset, not content hash. Add a content-hash table so a Read after a Bash `cat`/`sed -n` of the same bytes (and vice-versa) is recognized even when the path string differs (relative vs absolute, forward vs back slash). Touch `hooks_common.py`, `bash_cache.py`.

### 12. Path normalization for dedup keys [S]
Sessions mix `C:\Projects\...`, `scripts/ads-orchestrator.js`, and `./scripts/...` for the same file. Normalize to a canonical absolute path before hashing dedup keys so cross-call dedup actually fires. Touch `hooks_common.py`, `paths.py`.

### 13. Dependency-listing cache keyed on lockfile hash [M]
`is_dep_list_command` detects npm/pip/etc but does not cache. Cache `npm ls` / `pip list` / `uv pip list` output keyed on the hash of the relevant lockfile (`package-lock.json`, `uv.lock`, `requirements.txt`); serve from cache until the lockfile changes. Touch `bash_cache.py`, `bash_detect.py`.

### 14. Recursive-listing fingerprint cache [M]
`ls -R` / `find .` / `fd` over a tree: cache keyed on a directory fingerprint (max child mtime + entry count). Re-issue serves cached tree unless the fingerprint changed. Touch `bash_cache.py`.

### 15. git diff-of-diffs (incremental) [M]
When the same `git diff` (same args, same HEAD) is re-run after edits, show only the delta vs the previously cached diff rather than the whole thing. Keyed on `(args, HEAD sha, dirty-file set)`. Touch `bash_compress.py`, `bash_cache.py`.

### 16. Repeated-failure stderr delta [M]
Test/build commands re-run after a fix often emit near-identical stderr. Cache the prior stderr and, on re-run, show only changed lines plus a "N unchanged error lines suppressed" note. Touch `bash_compress.py`, `bash_cache.py`.

### 17. `sleep N && <probe>` polling-loop recognition [S]
The session had `sleep 30 && wc -l log && grep ... log` polling a running job. Recognize the `sleep && probe` idiom and, if the probed file is unchanged since the last poll, return "unchanged since last poll (N s ago)" instead of re-emitting content. Touch `bash_parser.py`, `bash_cache.py`.

### 18. `cat A 2>/dev/null || cat B` fallback-chain dedup [S]
`cat /tmp/X.txt || cat /tmp/Y.json | python -m json.tool` patterns appeared. Parse `||` fallback chains and cache whichever branch produced output. Touch `bash_parser.py`.

### 19. JSON pretty-print passthrough caching [S]
`cat file.json | python -m json.tool | head -200` is a structured read. Route to the structured-file path so it gets `token-goat section` treatment and caching. Touch `bash_detect.py`, `bash_compress.py`.

### 20. `ls scripts/*.js && cat package.json` combo compaction [S]
One call mixed a glob listing with a file dump (5.7 KB). Split the compound, cache the listing, and apply structured-read to `package.json`. Touch `bash_parser.py`.

### 21. PowerShell `Get-Content -Tail` / `-TotalCount` mapping [S]
PS read-detection exists; ensure `-Tail N`, `-TotalCount N`, `-Head` map to the same offset/limit cache keys as their Unix `tail`/`head` equivalents so cross-shell dedup works. Touch `bash_parser.py`.

### 22. PowerShell `Select-String` ↔ grep dedup [S]
Map `Select-String -Pattern` to the grep cache namespace so a `grep` and an equivalent `Select-String` on the same file dedupe. Touch `bash_parser.py`, `bash_cache.py`.

### 23. `git stash list` / `git diff --cached --stat` combo cache [S]
Appeared as a 2.6 KB compound. Cache `--cached --stat` keyed on the staged-tree hash; invalidate on `git add`. Touch `bash_compress.py`.

### 24. Cache `git rev-parse` / `git symbolic-ref` cheap metadata [S]
Branch/HEAD probes are tiny but frequent; cache for the duration of a no-commit window to avoid re-shelling. Touch `bash_cache.py`.

### 25. `gh` CLI output compaction [S]
`gh pr`/`gh run` JSON and table output can be large. Add a light filter that keeps the requested fields and truncates long bodies, with a `token-goat bash-output` pointer. Touch `bash_compress.py`.

---

## Tier 3 — Smarter read-side hints

### 26. "Hot file, grep many ways" → suggest read-once [S]
`ads-orchestrator.js` was probed 31×. When a single file crosses a probe threshold across grep+read+cat, emit one consolidated hint suggesting a single `token-goat skeleton` + targeted `symbol` reads. Touch `hints.py`.

### 27. Grep-pattern-to-symbol upgrade for camelCase identifiers [S]
Many greps were for identifiers (`googleCustomer`, `loadMemory`, `runHealthChecks`). When a grep pattern is a single indexed symbol name, redirect to `token-goat symbol NAME` (handler `_handle_grep_symbol_redirect` exists — broaden its trigger to alternation patterns where one alternative is an indexed symbol). Touch `hooks_read.py`, `hints.py`.

### 28. Alternation-pattern symbol extraction [M]
Session greps used `A\|B\|C` alternations mixing symbols and free text. Parse the alternation, resolve any branch that is an indexed symbol to its definition, and return those slices plus a grep over the remainder. Touch `hooks_read.py`, `read_replacement.py`.

### 29. Read-after-many-greps consolidation hint [S]
When a Read tool fires on a file already grepped 3+ times this session, note that the file is cached and suggest a surgical slice instead of a full read. Touch `hooks_read.py`.

### 30. Repeat-Read of identical range → recall, not re-read [S]
`ads-orchestrator.js` was Read 5× (some overlapping ranges). Strengthen the existing overlap detector to fully suppress a byte-identical re-Read and recall from cache. Touch `hooks_read.py::_handle_partial_overlap_hint`.

### 31. Suggest `token-goat semantic` when greps churn [S]
3+ exploratory greps with shifting patterns against the same area signals the agent is searching semantically. Emit a one-time hint to try `token-goat semantic "<inferred query>"`. Touch `hints.py`.

### 32. `.lock` / status-file read recognition [S]
`cat .claude/locks/*.lock` and similar tiny status reads recurred. Recognize lock/pid/status files and serve a compact "exists / contents" answer, deduped. Touch `bash_detect.py`.

### 33. Hint when reading a file that has an up-to-date skeleton [S]
On full-file Read where a fresh skeleton exists, surface the skeleton inline as the preview with an offer to expand a symbol. Touch `hooks_read.py`.

### 34. Test-file ↔ impl mapping for `.js`/`.ts` [S]
The `test_file` hint exists; ensure the JS/TS `*.test.js` ↔ source mapping is covered (the session was a JS project). Touch `hints.py`.

### 35. Suppress redundant hint re-emission within a tight window [S]
Avoid emitting the same hint type repeatedly across a rapid probe burst; debounce per (hint_type, path) within N seconds. Touch `hints.py`, `session.py`.

---

## Tier 4 — CLI surgical-read improvements

### 36. `token-goat bash-output --grep` regex + `-i`/`-E` flags [S]
The cache pointer is only useful if recall matches what the agent would have grepped. Ensure `--grep` supports case-insensitive and extended-regex to mirror the `grep -inE` patterns seen. Touch `cli.py`, `hooks_cli.py`.

### 37. `token-goat bash-output --between START END` line range [S]
Mirror `sed -n 'X,Yp'`, which appeared several times. Add a line-range recall flag. Touch `cli.py`.

### 38. `token-goat tail <file> -n N` surgical log tail [S]
A first-class command to tail a cached/indexed file by line count, so the agent has an obvious non-Bash path for the log-probe loop. Touch `cli.py`.

### 39. `token-goat grep <pattern> <file>` cached-grep command [M]
A surgical grep that reads the file once, caches it, and answers repeated patterns from cache — the CLI counterpart to item 1. Touch `cli.py`, `bash_cache.py`.

### 40. `token-goat skeleton --symbols-only` ultra-compact mode [S]
For the "what functions exist" question that drove many greps, a names-only skeleton is far cheaper than the current output. Touch `cli.py`, `repomap.py`.

### 41. `token-goat read "file::A,B,C"` multi-symbol single call [S]
Agents grep for several symbols at once; let one read pull multiple symbol slices in one call. Touch `cli.py`, `read_replacement.py`.

### 42. `token-goat symbol NAME --callers` [M]
Many greps chased "where is this called" (`utils.googleCustomer`, `loadMemory`). Add a caller/reference listing from the refs index. Touch `cli.py`, `db.py`.

### 43. `token-goat section` for log files by run-marker [M]
Logs had natural markers (`EXIT:$?`, `Orchestrator run complete`, `[CompetitorSurge]`). Allow sectioning a cached log by a marker regex so the agent recalls just the relevant block. Touch `cli.py`, `bash_cache.py`.

### 44. `token-goat diff --since-last` incremental diff CLI [M]
CLI front for item 15: show only what changed since the last cached diff. Touch `cli.py`.

### 45. `token-goat map --changed` scoped to dirty files [S]
After edits, an agent wants a map of only touched files. Filter `map` to the session's edited set. Touch `cli.py`, `session.py`.

---

## Tier 5 — Diagnostics, tests, and config

### 46. Stats counter: bytes saved by log-snapshot cache [S]
Add a metric for item 1 so its impact is measurable in `token-goat stats`. Touch `stats.py`.

### 47. `token-goat doctor` check for unindexed hot dirs [S]
Warn when a frequently-read directory (e.g. a JS `scripts/` tree) is not indexed, which forces grep fallbacks. Touch `cli_doctor.py`.

### 48. Regression fixtures from the coracrea session [M]
Capture the `/tmp/ads-dryrun*.log` re-grep sequence and the `ads-orchestrator.js` multi-grep sequence as golden fixtures asserting the new caches fire. Touch `tests/` (new `test_log_snapshot_cache.py`, `test_wc_detect.py`); tag git-touching ones `@pytest.mark.slow`.

### 49. Bench harness: replay a session JSONL and report token delta [M]
A `token-goat baseline --replay <jsonl>` mode that simulates hooks over a recorded session and prints before/after byte totals, so every future item is measured against real traffic. Touch `baseline.py`.

### 50. `wc`/`find`/`codex` detection unit tests [S]
Direct unit tests for the new `bash_detect.py` branches (items 2, 5, 7) with the exact command strings from the session. Touch `tests/test_bash_detect.py`.

### 51. Config flags to toggle each new cache [S]
Add `[bash_cache]` config keys (`log_snapshot`, `dep_list`, `recursive_listing`, `auto_promote_kb`) so the new behaviors are tunable and can be disabled if they misfire. Touch `config.py`.

### 52. Cross-platform log-path handling [S]
Log targets appeared as both `/tmp/...` and `C:\Users\...\Temp\...\tasks\*.output`. Normalize temp-dir detection across Unix `/tmp` and Windows `%TEMP%`/`AppData\Local\Temp` so the snapshot cache fires on Windows runs too. Touch `paths.py`, `bash_detect.py`.

### 53. `.output` task-file recognition [S]
The session read Claude task `.output` files via `cat`/`tail`/`wc`. Treat `tasks/*.output` like log files for the snapshot cache. Touch `bash_detect.py`.

### 54. Invalidation correctness tests for mtime/size keys [S]
Verify the snapshot cache re-reads when a log is appended to (size/mtime change) and serves cache otherwise — the load-bearing invariant for items 1, 13, 14. Touch `tests/`.

---

## Suggested execution order

Land Tier 1 items 1–4 first: they target the verified dominant pattern (the log-probe loop and `wc`) and together would have cut roughly a third of this session's Bash bytes. Items 5–10 are each a small self-contained filter. Tier 2 cross-tool dedup (11–12) is the next force-multiplier because path normalization unlocks dedup that silently fails today. Build the replay bench (49) early so every later item is measured against real traffic rather than estimated.
