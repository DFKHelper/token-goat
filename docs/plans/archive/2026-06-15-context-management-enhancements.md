# Context Management Enhancements

Features identified as high-leverage improvements to token-goat's context reduction pipeline, covering smarter log compression, structural code reading, entropy-aware deduplication, and tool-output specialization.

---

## 1. Severity-scored log compression

**Problem:** The current log-line handling in `GenericFilter` works on pattern matching — lines matching PASS/FAIL patterns are kept or dropped as a unit, with no awareness of how important a line is relative to its neighbors. INFO and DEBUG noise from verbose daemons (e.g. `pytest -s`, `uvicorn`, language servers) survives because it doesn't match any suppression pattern. Stack traces are frequently split across the keep/drop boundary, arriving in context as orphaned frames with no associated error line.

**Solution:** Introduce numeric severity scoring for log lines. Assign each line a score: `1.0` for ERROR/FAIL/CRITICAL/EXCEPTION, `0.5` for WARN/WARNING, `0.1` for INFO, `~0` for DEBUG/TRACE. Keep every line scoring `≥ 0.5` plus a configurable N context lines above and below (default 3). Drop the remainder and emit a `[suppressed N lines]` sentinel at each gap. Stack trace detection uses a multi-line state machine: an error line opens a "trace window" that absorbs all subsequent indented or `at …` / `File "…"` continuation lines until a blank line or a non-indented non-error line closes it. Lines inside an open trace window are unconditionally preserved regardless of their individual score.

Implement as a `SeverityLogFilter` in `bash_compress.py`, registered ahead of `GenericFilter` so it claims output that looks like structured log streams. Wire the context-line count and score threshold into `config.py` under `[bash.severity_log]`.

**Files:** `src/token_goat/bash_compress.py`, `src/token_goat/bash_detect.py`, `src/token_goat/config.py`

**Effort:** M

**Tests:** log stream mixing DEBUG/INFO/WARN/ERROR lines → only WARN+ kept with N context lines; stack trace immediately after ERROR line → full trace block preserved; suppression sentinel appears with correct line count; threshold override via config respected

---

## 2. Post-read structural code compression

**Problem:** When the model reads a source file to understand its structure — class layout, public API, available functions — it receives the full body including docstrings, implementation detail, and inline comments. For files exceeding 200 lines this is almost always wasteful: the model needed the map, not the territory. The existing `pre_read` hint logic can redirect away from large files, but when the read is allowed through (e.g., the file is under the size threshold, or the model insists), the full content lands verbatim.

**Solution:** In `post_read`, detect reads that returned more than 200 lines of source code (identified by file extension: `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.go`, `.rs`, `.java`, `.cs`, `.kt`, `.swift`). Rewrite the returned content to a structural skeleton: preserve all import/use statements, class/function/method signatures, decorator lines, and type alias declarations; replace each body block with `# ... N lines` where N is the number of suppressed lines. Append a footer: `[Structural view — pass --full to token-goat read for complete source]`. The `--full` flag on `token-goat read` bypasses this filter for targeted deep-reads.

New module `src/token_goat/code_compress.py` handles the language-specific skeleton extraction using the same tree-sitter adapters already used by `parser.py`. The `post_read` hook in `hooks_read.py` calls it after the size check.

**Files:** `src/token_goat/hooks_read.py`, `src/token_goat/code_compress.py`, `src/token_goat/parser.py` (adapter reuse), `src/token_goat/config.py`

**Effort:** L

**Tests:** 250-line Python file → skeleton retains all `def`/`class` signatures and decorators, bodies replaced with `# ... N lines`; import block intact; 150-line file passes through unchanged; `--full` flag returns verbatim content; unsupported extension passes through unchanged; nested classes/functions correctly bounded

---

## 3. Shannon entropy gate

**Problem:** Deduplication and truncation in bash filters can destroy high-entropy tokens that carry unique, irreplaceable information. A UUID in a trace (`transaction_id=550e8400-e29b-41d4-a716-446655440000`), a JWT header, a git object hash, or an API key fragment are each unique identifiers — compressing or deduplicating lines that contain them silently discards forensic evidence. The current `JsonArrayFilter` and `GenericFilter` do not protect these tokens.

**Solution:** Before any deduplication or truncation decision in `bash_compress.py`, score each candidate token for normalized Shannon entropy: `H = -Σ(p_i × log2(p_i)) / log2(len(charset))`. Flag any token as `preserve=True` when its normalized entropy is ≥ 0.85 and its length is ≥ 8 characters. Tokens matching this profile include UUIDs, SHA hashes, JWTs, base64 blobs, and random API keys. Lines containing at least one `preserve=True` token are excluded from deduplication and from truncation (`[... N more]`) collapsing — they are always emitted verbatim.

Implement `score_entropy(token: str) -> float` and `has_high_entropy_token(line: str) -> bool` in a new `src/token_goat/entropy.py` utility. Wire calls into `JsonArrayFilter`, `GenericFilter`, and the line-dedup path shared by several filters.

**Files:** `src/token_goat/entropy.py` (new), `src/token_goat/bash_compress.py`

**Effort:** M

**Tests:** UUID string → entropy ≥ 0.85; SHA-256 hex → entropy ≥ 0.85; word "hello" → entropy < 0.85; line containing UUID survives dedup that would otherwise collapse it; JSON array with UUID-valued field not collapsed; short high-entropy token (< 8 chars) not flagged

---

## 4. Recent-read suppression window

**Problem:** The re-read hint fires whenever the session cache records a prior read of the same file, regardless of how recently it happened. If the model reads `config.py`, gets a hint on the next call, reads it again three turns later, and then legitimately forgets it after 40 more tool calls, the hint fires again — but this time it's accurate and useful. Conversely, if the model re-reads a file immediately (within 4 tool calls), the content is still fresh in its context window and the hint is noise that interrupts the flow without saving tokens.

**Solution:** Track the tool-call index of the most recent read for each file in the session cache. Add a `protect_recent_reads` config option (default: `4`) defining a suppression window. When `pre_read` fires and the same file was read within the last N tool calls, skip the re-read hint entirely. Only emit the hint when `current_call_index - last_read_index > protect_recent_reads`. The call index is already tracked implicitly by the session — add an explicit `last_read_call` column to the session reads table.

**Files:** `src/token_goat/hints.py`, `src/token_goat/hooks_read.py`, `src/token_goat/session.py`, `src/token_goat/config.py`

**Effort:** S

**Tests:** file read at call 1, re-read at call 3 (within window=4) → no hint; file read at call 1, re-read at call 6 (outside window) → hint fires; window=0 disables suppression (hint always fires); config override respected; window size applied per-file independently

---

## 5. Per-hunk relevance scoring in diff

**Problem:** `GitDiffFilter` and `DiffFilter` keep or drop hunks based on line count and hard thresholds, not on how much change a hunk actually represents. A hunk touching 20 lines with 1 changed line carries far less information than a hunk with 18 changed lines — but both are treated equally. In diffs for large refactors or reformatting commits, dozens of low-density whitespace-only hunks dominate the output and bury the meaningful changes.

**Solution:** Compute a change density score for each parsed hunk: `density = (added_lines + deleted_lines) / total_hunk_lines`. Score ranges from 0.0 (pure context, no changes) to 1.0 (every line changed). After scoring all hunks for a file, cap the per-file hunk count at a configurable maximum (default: `10`). When more hunks exist than the cap allows, keep the highest-density hunks and replace the dropped set with a `[... N more hunks, avg density 0.12 — likely whitespace/formatting]` summary line. The density threshold and per-file cap are configurable under `[bash.diff]`.

Extend `GitDiffFilter` and `DiffFilter` in `bash_compress.py`. The hunk parser already tokenizes `@@ … @@` boundaries — add the scoring pass over the collected hunk objects before the emit phase.

**Files:** `src/token_goat/bash_compress.py`, `src/token_goat/config.py`

**Effort:** M

**Tests:** diff with 15 hunks → only 10 emitted; dropped hunks replaced with summary sentinel containing correct count; hunk with 18/20 lines changed scores higher than hunk with 1/20 changed; cap=0 disables filter (all hunks kept); density threshold in summary line is accurate; pure whitespace hunk (density 0.05) dropped before mixed hunk (density 0.6)

---

## 6. Cargo build/test output compression enhancements

**Problem:** The existing `CargoFilter` suppresses basic compiling progress lines, but `cargo build` output in workspace projects still leaks through: per-crate `Compiling foo v1.2.3 (/path)` lines for dozens of transitive deps, `Finished dev [unoptimized + debuginfo] target(s)` summaries per sub-crate, and `Running unittests` preambles before individual test results. On a cold build of a mid-size workspace, this easily produces 200+ lines of noise. `cargo test` is worse: every passing test emits `test tests::foo_bar … ok`, which in a suite of 300 tests is 300 lines before the summary.

**Solution:** Extend `CargoFilter` with three additional compression passes. (1) Compiling progress: collapse all `Compiling <crate> v<ver>` lines into a single `[compiling N crates …]` sentinel emitted once at the start. (2) Test pass lines: replace runs of `test <name> … ok` with `[N tests passed]` per test binary, keeping only `test <name> … FAILED` lines verbatim. (3) Finished/Running preambles: suppress `Finished …` and `Running unittests …` lines unless they immediately precede a failure line.

**Files:** `src/token_goat/bash_compress.py`

**Effort:** S

**Tests:** 50 `Compiling` lines → single sentinel with count 50; 200 passing test lines + 2 failures → 2 failures kept + `[198 tests passed]` sentinel; `Finished` line before failure kept; `Finished` line at end of clean build suppressed; `Running` preamble before failure kept

---

## 7. Go test output compression enhancements

**Problem:** The existing `GoTestFilter` handles basic `--- PASS` / `--- FAIL` line suppression, but `go test ./...` on a multi-package project produces additional noise: `=== RUN TestFoo` preamble lines for every test before it runs, `=== PAUSE` / `=== CONT` lines from parallel test execution, and `FAIL\tgithub.com/org/pkg\t0.123s` package-level summary lines even for failing packages where the detail already appeared above. The `=== RUN` lines alone can double the output size.

**Solution:** Extend `GoTestFilter` to also suppress `=== RUN`, `=== PAUSE`, and `=== CONT` lines unconditionally (they carry no information not already in the corresponding `--- PASS`/`--- FAIL` line). Preserve the per-package `ok` summary line as the only trace of a passing package. For failing packages, keep the package-level `FAIL` summary line and all associated `--- FAIL` + output lines; suppress the `--- PASS` lines within the same package. Emit a `[N packages passed, M packages failed]` aggregate at the end of multi-package runs.

**Files:** `src/token_goat/bash_compress.py`

**Effort:** S

**Tests:** `=== RUN` / `=== PAUSE` / `=== CONT` lines suppressed; `ok github.com/org/pkg 0.3s` kept; `FAIL` package line kept; `--- FAIL` with output kept; `--- PASS` within failing package suppressed; aggregate summary line appended; single-package output not aggregated

---

## 8. Make output compression enhancements

**Problem:** The existing `MakeFilter` suppresses some `make[N]` directory transition lines, but `make` output from C/C++ and mixed-language projects remains dense: each recipe command is echoed verbatim before execution (producing duplicated `gcc -O2 -c foo.c -o foo.o` lines), entering/leaving directory messages fire on every recursive sub-make invocation, and `.PHONY` target announcements (`make[2]: Nothing to be done for 'all'`) add lines with zero diagnostic value.

**Solution:** Extend `MakeFilter` with: (1) command-echo suppression — suppress any line that is an exact echo of a compiler/linker invocation (line starts with `cc`, `gcc`, `g++`, `clang`, `clang++`, `ld`, `ar`, `as`, `nasm`, `ninja`) unless the next line is a non-zero exit or error; (2) directory noise — suppress `make[N]: Entering directory` and `make[N]: Leaving directory` lines entirely; (3) nothing-to-do — suppress `make[N]: Nothing to be done for '…'`; (4) preserve all lines containing `Error`, `error:`, `warning:`, or `undefined reference`.

**Files:** `src/token_goat/bash_compress.py`

**Effort:** S

**Tests:** `make[2]: Entering directory '/src'` suppressed; `gcc -O2 foo.c -o foo` suppressed when build succeeds; same `gcc` line kept when followed by error; `error: undeclared identifier` kept; `make[1]: Nothing to be done` suppressed; warning line kept verbatim

---

## 9. Docker build layer compression enhancements

**Problem:** The existing `DockerFilter` handles some step collapsing, but `docker build` output for non-trivial Dockerfiles generates verbose per-layer noise that survives compression: `---> Using cache` lines for every cached layer, `---> sha256:abc123…` image ID lines after each step, `Removing intermediate container` lines, and the `Step N/M :` headers for all steps including trivially fast ones. A 30-step Dockerfile on a warm cache emits 90+ lines before any meaningful output appears.

**Solution:** Extend `DockerFilter` with: (1) cache/ID lines — suppress `---> Using cache` and `---> sha256:…` lines; replace with a running tally; (2) Step headers — suppress `Step N/M : <cmd>` lines for steps that complete without error (detected by the absence of an error line before the next `Step` header or a `---> ` line); (3) intermediate containers — suppress `Removing intermediate container …`; (4) emit a single `[building N/M layers, M cached]` preamble and preserve any `RUN` step that produced error output verbatim. The final `Successfully built <id>` line is always kept.

**Files:** `src/token_goat/bash_compress.py`

**Effort:** S

**Tests:** `---> Using cache` lines suppressed; `---> sha256:…` lines suppressed; `Removing intermediate container` suppressed; cached count in preamble matches suppressed cache lines; `Step N/M` header for clean step suppressed; `Step N/M` header for error step kept; `Successfully built` line always kept; `RUN` error output preserved verbatim

---

## 10. Truncated-read surgical hint

**Problem:** When a Read call returns a partial view of a large file, the system prompt appends a notice along the lines of "PARTIAL view — lines X–Y of Z total". The model sees this but has no concrete next step offered to it. The natural response is to issue another Read call for the next range, repeating until the whole file has been slurped in — burning tokens proportional to file length rather than query specificity. There is currently no hook that intercepts this scenario and offers cheaper alternatives.

**Solution:** In `post_read`, after the content is returned, detect the partial-read sentinel by scanning the tool result for the pattern `lines \d+[–-]\d+ of \d+`. Extract the total line count Z. Inject an advisory hint appended to the result (or via a separate `systemMessage` emission): `"File is Z lines; consider token-goat section 'file::Heading' to extract a named section (~95% smaller) or token-goat skeleton file for the full symbol list."` Include the actual total line count in the hint so the model can calibrate. The hint is suppressed when the partial read covers the full file (X=1 and Y=Z), or when the file extension is not a known text format.

**Files:** `src/token_goat/hooks_read.py`, `src/token_goat/hints.py`

**Effort:** S

**Tests:** Read result containing `lines 1-200 of 1500` → hint injected with correct Z=1500; `lines 1-50 of 50` (complete) → no hint; hint text contains `token-goat section` and `token-goat skeleton`; binary file extension → no hint; hint suppressed when `TOKEN_GOAT_BASH_COMPRESS=0`

---

## Implementation order

1. Implement the truncated-read surgical hint (feature 10) — pure hook addition, zero risk to existing compression paths, immediate payoff on large-file reads.
2. Extend `CargoFilter`, `GoTestFilter`, `MakeFilter`, and `DockerFilter` (features 6–9) — each is a self-contained enhancement to an existing filter class, low coupling, easily verified in isolation.
3. Add the recent-read suppression window (feature 4) — config + session change with no compression logic, testable without any filter work.
4. Add Shannon entropy gate (feature 3) — new utility module with broad application; wire it into `JsonArrayFilter` first, then extend to `GenericFilter` dedup paths.
5. Implement per-hunk relevance scoring in diff (feature 5) — extends the existing hunk parser in `GitDiffFilter`/`DiffFilter`; depends on no other new feature.
6. Implement severity-scored log compression (feature 1) — new `SeverityLogFilter` with multi-line state machine; build after the simpler filter enhancements to avoid scope interference.
7. Implement post-read structural code compression (feature 2) — largest scope; depends on tree-sitter adapter reuse from `parser.py`; ship last once the simpler hooks are stable.
