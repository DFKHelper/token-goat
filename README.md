---
title: "AI Token Optimizer — Cuts Costs, Sharpens Focus, Blocks Prompt Injection"
description: "Cuts AI tool costs 40–80% and guards against prompt injection. Stops re-reads, extracts one function vs. whole file, shrinks screenshots 97%."
image: /token-goat/assets/goat-social.png
permalink: /
---

# Token-Goat

![Token-Goat](assets/logo.png)

**85%** smaller reads · **97.4%** image compression · **180+** filter & interception rules · **94–99%** skill overhead cut · compaction memory · **prompt injection** guard · **3.7 GB** never reached the model · **1.1 Gt** tokens saved

**Reduces AI token use/costs by 40–90%, and improves its focus. Fully automated, always online.**

**Also defends against prompt injection. Every fetched page is scanned for attack patterns and wrapped in an untrusted-content fence before hitting the model. One config line to disable.**

**Your AI re-reads the same file three times. Every compaction causes amnesia. Every build log buries the one line that matters. You pay for all of it. Token-Goat fixes all of it — automatically.**

Token-Goat sits silently between your AI and your tools. Re-read a file? It gets a one-line hint and a narrow-slice suggestion instead of the full file again. Grab a screenshot? A 100 KB copy reaches the model instead of 10 MB. Run `pytest`, `npm install`, `docker build`, or `cargo`? The thousands of progress bars and passing-test names are stripped to the failures before the output even reaches the context window. Open a PDF, a large Markdown doc, or a CSV? The hook intercepts it — heading tree, page count, or column preview — so the model never pays for the full file. Run `gh run watch` or `next dev` a second time? Prior output is recalled rather than re-run. Compact a long session? It gets a clean structured manifest of edited files and key symbols so nothing important is forgotten. Sessions drop 40–90%+ in cost. You change nothing about how you work.

Works with **Claude Code**, **Gemini CLI**, **Codex CLI**, **Aider**, **Cursor**, **Cline**, **Windsurf**, **Copilot CLI**, and OpenCode, plus **pi** ([pi-coding-agent](https://github.com/earendil-works/pi-mono)).

**Ask your AI to install it fully (give it this GitHub link), or install in one command:**

```
npm install -g token-goat && token-goat install
```

Restart your AI sessions. Run `token-goat stats` a couple of minutes after your next session to see the massive savings. It also doubles as a great tracker of your work. Welcome to token efficiency.

[![npm](https://img.shields.io/npm/v/token-goat.svg)](https://www.npmjs.com/package/token-goat) [![CI status](https://github.com/DFKHelper/token-goat/actions/workflows/ci.yml/badge.svg)](https://github.com/DFKHelper/token-goat/actions/workflows/ci.yml) [![PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-lightgrey)](LICENSE)

![Windows 10 | 11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?logo=windows&logoColor=white) ![Linux including WSL](https://img.shields.io/badge/Linux-including%20WSL-FCC624?logo=linux&logoColor=black) ![macOS (untested)](https://img.shields.io/badge/macOS-untested-lightgrey?logo=apple&logoColor=white) ![requires Node.js](https://img.shields.io/badge/requires-Node.js-339933?logo=node.js&logoColor=white)

> **Built and continually improved, free, by one person. If it saves you tokens, drop a ⭐️ at the top of this page. One click. Makes my day. Also, if you'd like anything added, [drop me a line](mailto:token-goat@dfkhelper.com).**

[Install](#install) · [CLI](#cli) · [What gets installed?](#what-gets-installed) · [Stats](#stats-display) · [Security & uninstall](#security-privacy-and-uninstall)

---

<p align="center">
  <img src="assets/stats_v180.png" alt="token-goat stats display" width="589">
  <br>
  <sub>Stats display — gradient bars, sparklines, and a calendar heatmap in 24-bit color</sub>
</p>

## The problem

AIs read `auth.py`. Then reads it again. And again. Then a third time after compaction wipes the session. Then it can't find what it wanted and searches other lines and files. You pay for every token and most of it is waste.

Long sessions accumulate waste five ways. Screenshots cross the model at full resolution. A single PNG can land at 10+ MB. The agent re-reads files it already parsed earlier in the same conversation. When a session compacts, the summary LLM doesn't know which files were edited or which symbols mattered, so it preserves the wrong things. And every `pytest`, `npm install`, `docker build`, or `git log` dumps thousands of lines of progress bars, deprecation warnings, and passing-test names that bury the one line that actually matters.

The fifth waste is skills. A single large skill injects 10k–65k tokens every time. Run a five-iteration `/improve` loop and you've paid for five full copies of the same rules. Token-Goat now blocks repeat skill loads before they happen: a PreToolUse hook intercepts the second invocation, serves the cached compact (~400 tokens) instead, and only allows a reload when compaction may have evicted the skill from context. It also intercepts direct reads of skill files and ensures the compaction manifest carries the full skill index — so nothing is forgotten and the full body never re-enters context unnecessarily.

The fastest way to reduce AI token costs is fixing these five, not writing shorter prompts. Each one is preventable. Token-Goat intercepts all five, automatically.

## What changes

| Without Token-Goat | With Token-Goat |
|--------------------|------------------|
| 3.3 MB screenshot lands in model context | 84 KB compressed copy, 97.4% smaller |
| Agent re-reads files from earlier in the session | "Already read this" reminder with narrow slice suggestion |
| Agent re-reads a file edited mid-session | Unified diff injected as a hint — full Read avoided when the diff covers the change. Docs (`.md`/`.rst`/`.txt`) by default; source/style/data files (`.ts`/`.css`/`.json`/…) when `serve_diff_on_reread` is enabled |
| Compaction forgets which files were edited | Structured session manifest injected before compact |
| Same files re-read from scratch after `/compact` | Recovery hint at SessionStart lists cached snapshot + bash + WebFetch IDs |
| Loaded skill body summarised away by compaction | `### Active Skills` manifest section + `**Skills**:` recovery block list every loaded skill; full body recoverable via `token-goat skill-body <name>` without re-invoking |
| Large skill bodies re-injected each turn (6 active skills = 65k+ tokens) | `<!-- COMPACT_END -->` marker: everything above the marker is the compact form; token-goat detects it on load, caches the compact slice, and injects only that — typically ~400 tokens vs. 10k+ |
| Model reads a skill SKILL.md file directly mid-session (burning the full 10k–65k tokens again) | Pre-Read hook intercepts `*/.claude/skills/<name>/SKILL.md` paths; if the skill is already cached this session it emits a `token-goat skill-body <name>` hint instead |
| Same large skill invoked twice in a session | PreToolUse hook blocks the reload; serves cached compact (~400 tokens) via `additionalContext` instead of the full 40–65k body. Allows the reload if compaction fired since the last load |
| Skill invoked with `first_load_compact=true` and `<!-- COMPACT_END -->` present | First load also blocked; only the curated compact section is served. Full body available via `token-goat skill-body <name>` on demand |
| Same docs URL fetched twice in a session | Re-fetch blocked at warm+ context pressure; cached body available via `token-goat web-output <id>` |
| `cat src/auth.py` or `Get-Content module.py` run via Bash | Pre-Bash hook detects whole-file reads of indexed source files and suggests `token-goat read "file::Symbol"`, `skeleton`, or `section` — covers `cat`, `bat`, `type`, PowerShell `Get-Content`/`gc` |
| `rg pattern src/` or `grep -rn` run via Bash (first time) | Pre-Bash hook suggests `token-goat symbol <name>` and `token-goat semantic "<query>"` as indexed alternatives to a full directory walk |
| `rg "^def" src/file.py` or `grep "class " module.ts` — structural search on a single source file | Pre-Bash hook redirects to `token-goat skeleton "file"` or `outline "file"` — all symbols with line numbers, no full-file read |
| `rg` or `grep` run twice with the same pattern | Pre-Bash dedup hint fires on repeated `rg`/`grep`/`ag` calls the same way it fires on the native Grep tool; repeat searches return a cached match-count hint instead of re-running |
| Read tool targets `tool-results/<id>.txt` or `tasks/<id>.output` | Pre-Read hook suggests `token-goat bash-output <id> --tail N` / `--grep PATTERN` / `--section H`; the filename stem is the output ID |
| Repeated monitoring command run again (`gh run watch`, `next dev`, `vitest`, `docker logs`) | Pre-bash recall hint: when a prior run is cached and its output exceeds 2 KB, a pointer to `token-goat bash-output <id> --grep PATTERN` is injected instead of re-running the command. Cache is keyed on the *base command*, so re-running with a different trailing pipe (e.g., `| tail -40` then `| grep error`) still hits the same cache entry |
| `pnpm`/`yarn`/`bun` install or build dumps full output | pnpm, yarn, and bun compress filters now strip install noise and build logs the same way npm does; `pnpm run`/`yarn run` route through their own filter |
| Surgical-read command returns a 10k-line symbol or a full section dump | Capped at ~25k tokens; marker names the truncation ratio and narrowing command (`symbol` → `file::Class.method`; `section` → sub-heading; cached → `--grep`/`--tail`) |
| Full file read for one function or section | `token-goat read file::symbol`, about 85% smaller |
| `pytest` dumps 150 PASSED lines + dots + tracebacks | Failures-first view, 80 to 97% smaller |
| `npm install` floods deprecation warnings + spinner | Errors kept; warnings collapsed by package, ~90% smaller |
| `docker build` emits sha256 digests + transfer progress | Step headers + errors kept; noise dropped, ~75% smaller |
| `ruff` / `eslint` / `mypy` repeat the same rule 50 times | Grouped by rule with first 3 examples, ~80% smaller |
| Same `pytest` / `cargo` / `git log` re-run mid-session | Small prior outputs (≤8 KB) served inline on first repeat; larger outputs get a hint pointing at `token-goat bash-output <id>` |
| Same `Grep` pattern re-run with hundreds of matches | Pre-Grep dedup hint quotes the prior match count |
| Same docs URL fetched twice | Re-fetch denied at warm+ context pressure (redirects to `token-goat web-output <id>`); advisory hint at cool |
| `token-goat section pyproject.toml::tool.ruff` | One TOML table extracted instead of the whole config; same for `.yaml`/`.yml`/`.json`/`.ini`/`.cfg`/`.env`/`Dockerfile` |
| Typoed `token-goat symbol getUserr` | Auto-redirects to the unambiguous close match (use `--strict` to opt out) |
| `grep`/`rg` returns 50+ match lines | File-level summary: top 20 files by match count; full result cached, ~80% smaller |
| Same "already read" hint fires on every re-read | Suppressed after first injection; SHA-256 fingerprinting prevents the same nag twice per session |
| Same bash command runs 3+ times in one session | Escalating warning: "ran 2×" on repeat, "WARNING: ran N×" by the third; output always cached |
| Agent starts cold with no git context in a dirty repo | Branch, change counts, and 5 recent commits injected at startup (~50 tokens) |
| Re-read hint shows only the line range | Hint includes previously-accessed symbol names: `[symbols: login, refresh, …]` |
| Manifest too large or unstructured after compaction | Manifest gains `### MUST_PRESERVE` sealed block, `### What Worked` (last 2 green test runs), inline git diffs, and `### TODOs` from TaskList |
| CSV/JSON/JSONL/log file re-read when only structure changed | Pre-Read hint for structured files (CSV headers, JSON keys, log format), ~70% smaller than full read |
| Index-only files (lockfiles, source maps, bundles) read on every session | Pre-Read suppression for read-only files (package-lock.json, *.map, dist/), skipped unless explicitly edited |
| Large markdown file read in full (README.md, CHANGELOG.md, CLAUDE.md ≥8 KB) | Heading tree intercepted instead — H1–H3 with `#2`/`#3` disambiguation; `token-goat section` shortcuts listed for well-known files; post-edit injects a re-read suggestion rather than the full file |
| PDF opened via Read | Full read denied; PDF shows page count and outline (`token-goat pdf-extract` pulls the actual text, optionally paged/sliced, when the outline isn't enough) |
| Excel/PowerPoint/Word file (.xlsx/.pptx/.docx) opened via Read | Full read denied; redirects to the matching narrow-slice command family (`xlsx-sheets`/`xlsx-head`/`xlsx-range`/`xlsx-query`, `pptx-outline`/`pptx-slide`/`pptx-notes`/`pptx-text`, `docx-outline`/`docx-text`) instead of extracting the whole document as text |
| Other Office binary (.odt, .ods, .ott, .odp) opened via Read | Full read denied; redirects to `pandoc` for text extraction (no dedicated reader for these formats yet) |
| Large CSV or TSV file (≥10 KB) read in full | Column headers, row count, and 3 sample rows shown; `token-goat csv-query` projects columns and/or filters rows instead of a full read; `duckdb` query suggestion for very large tabular data |
| WebFetch returns a page's full raw HTML | HTML-to-text extraction strips markup/scripts/styles before the model ever sees it — readable prose instead of a wall of tags |
| Large WebVTT/SRT transcript (≥10 KB) read in full | Duration, cue count, and detected speakers shown; `token-goat transcript-outline` gives a skimmable speaker/time overview and `token-goat transcript` slices by speaker/time range/pattern instead of a full read |

| Large TXT or log file (≥20 KB) read in full | Line count + first/last 5 lines shown; `.log`/`.out` files bias toward `--tail 100 --grep`; general catch-all for any file ≥100 KB |
| Subagent reads a 47–86 KB recon dump (or greps a 73 KB transcript) and overflows its window | `pre_read` denies a full Read at or above `large_read_redirect_bytes` (512 KB base, tightened by context pressure to as low as ~92 KB once the session is nearly full — the case that matters most for an already-strained subagent), and a `content`-mode Grep over one oversized file, redirecting both to surgical reads or a windowed `offset`/`limit` |
| Subagent overflows at "hello" with no idea why | `token-goat baseline` attributes the fixed environmental floor — other plugins' hook dumps, both CLAUDE.md files, MEMORY.md, MCP servers — by owner, suggested fix, and fixed-vs-variable cost |
| MCP screenshot call lands 10 MB image in context because no file path was passed | `pre_screenshot` denies chrome-devtools and playwright screenshot calls without a `filePath`/`file_path` argument; redirects the model to re-issue with one, so the saved file flows through image-shrink (~39K tokens raw → ~8K compressed) |
| `curl -v` dumps TLS handshake + all request/response headers | Verbose lines stripped; request line, HTTP status, content-type, and body kept — typically 70–90% smaller |
| `jest --verbose` / `vitest --verbose` emits one `✓` line per passing test | Consecutive passing-test lines collapsed to a count per file; failures kept verbatim, ~95% smaller on passing suites |
| `go test -v` emits `--- PASS: TestName (Ns)` for every passing test | PASS lines collapsed to a count per package; FAIL lines and panic output kept, ~90% smaller on clean runs |
| Python script raises and dumps a 30-frame traceback | Intermediate frame pairs collapsed to a count; outermost frame, exception type, and message kept |
| `tsc --noEmit` emits hundreds of type errors across many files | Errors grouped by file, up to 3 examples per file shown, rest counted; ~70–90% smaller |
| `make`/`cmake`/`ninja` emits hundreds of `[N%] Building …` progress lines | Progress lines collapsed to a count; warnings, errors, and `Built target` lines kept, ~85% smaller on clean builds |
| Command writes JUnit XML and prints the path | XML parsed directly; compact summary (totals + failed test names/messages) injected — raw XML never enters context |
| `grep`/`rg` matches a line in a `.min.js` or `.min.css` file | Matching line truncated to 200 chars; filename and line number preserved |
| Claude Code writes async-task output to a temp file | `pre_read` intercepts the path and redirects to `token-goat bash-output <id>` with `--head`/`--tail`/`--grep` support |
| Re-read hints fire immediately after conversation compaction | Grace period suppresses deny hints for the first few reads after a compact so the model can re-orient |
| Large reference doc (CLAUDE.arch.md, API spec) re-read in full every new session | `token-goat compact-doc <path>` builds a deterministic extractive sidecar (headings + first N lines per section); `pre_read` serves it in place of the full file — 80–95% smaller. Sidecar is automatically marked stale when the source is edited. |
| Re-read denial fires as an advisory hint the model can ignore | When `deny_reread` is on (default), `pre_read` actively denies re-reads of files confirmed in the current context window, not just nudges; the advisory still fires for older reads that may have scrolled out |
| Unchanged files produce duplicate hints across sessions | Hint fingerprint includes file path; unchanged-file short-circuit skips re-read pre-check entirely |
| Dedup hints fire even when agent ignores them | Curator pass skips dedup hints when the agent's preceding action pattern suggests they'll be ignored |
| Bash dedup hints conflict with other compression | `token-goat compress` can be called as dedup-vs-hint filter; one-call access to cached output |
| Large manifest sections with no useful signal | Drop empty sections, strip project name from paths (cleaner relative paths in manifest) |
| Manifest git-history section loses signal on clean main | Inline git diffs + skip git log when on clean main branch; session-awareness improves manifest hygiene |
| Skill body lost after compaction but recovery too verbose | Recovery hint deduped skills by content_sha (same skill loaded twice = one entry); inline skill checklist |
| Recovery hints omit critical paths when space is tight | Hint budget hard caps per kind (files=5, bash=3, web=2, skills=4); skip bash snippet when recall available |
| AVIF format not supported despite better compression | AVIF image-shrink via sharp (when libvips is built with libaom); WebP fallback; codec auto-detection in docker |
| Token-savings invisible until you run `stats` | Token-savings benchmark (slow-marked test suite) locks in measured wins; `token-goat stats` reports net-positive impact |
| Hook crash leaves agent waiting for response | Fail-soft barrier catches `BaseException`/`MemoryError`/`SystemExit`; hook always returns `{"continue": true}` |
| Concurrent edits lose update counts mid-session | Session CAS + mtime-based retry prevent lost edits in manifest |
| Dirty queue appends corrupt on concurrent writes | OS file lock (fcntl/msvcrt) prevents torn JSON lines |
| Worker claim file blocks all re-spawns on crash | Mtime staleness check (>60s) auto-recovers zombie claim files |
| DRY consolidation — 600+ lines duplicated | Tool-response extractor unified; cache helpers (`_safe_join`, `OutputStatDict`) consolidated; dedup-hint template collapsed; CLI output/history commands unified; `humanize_bytes` centralized in `render/ansi` |
| Compaction hook subprocess ~190 ms cold | Lazy imports of heavy modules in `hooks_session` and `compact`; compaction path ~110 ms cold (~42% faster) |
| Pre-compact subprocess runs on every session | Compact-skip sentinel on disk: if session file is <5 min old and no edits logged, subprocess exits in <1 ms |
| Git ops slow manifest build in non-repo dirs | `git diff` / `git log` calls skipped when `cwd` is not inside a git repo (saves 60–100 ms per hook fire) |
| `terraform init` downloads 30+ provider plugins | Provider install lines collapsed to a count note; generic progress lines head/tail compressed (5+5 kept); `Init complete!` preserved |
| `terraform show` dumps a full resource block | Noise attributes (id, arn, timeouts, tags) stripped per resource block; high-signal fields kept with a suppression note |
| `kubectl events` lists raw repetitive events | Events grouped by REASON with a per-group count; field-selector hint added to narrow scope |
| `kubectl describe` floods labels and annotations | Labels/annotations blocks collapsed to line counts; Conditions table kept in full; container resource fields preserved |
| `npm install` verbose output with sill/http/verb/spinner lines | Verbose timing, sill, http, verb lines suppressed; warn lines beyond first 3 collapsed; braille spinner reify lines dropped |
| Fetched web content lands raw in model context | Scanned for attack patterns, wrapped in an untrusted-content fence; matched pattern name written to the log |
| Chatty log repeats the same error or event thousands of times | `token-goat logfold` collapses consecutive duplicates to `[Nx]` counts; same event logged with different timestamps or request IDs folds correctly — ~90–95% smaller on repetitive logs |
| Reading poetry.lock or package-lock.json to find a pinned version | `token-goat lockdeps` returns a name/version table of direct dependencies; optional packages and transitive entries excluded |

On a per-token API plan, 100K wasted tokens per session runs about $0.30. Five sessions a week is ~$450/year. AI coding cost reduction at that scale comes from fixing the waste, not from using the product less. Token-goat is free. And on subscription plans, it can result in limits feeling 10x higher.

## Token savings, measured

Numbers below come from synthetic-fixture benchmarks in the test suite. Each row points at the source file where the measurement is reproduced.

| Source | Improvement | Measured impact | Where |
|--------|-------------|-----------------|-------|
| Image shrink | WebP encoder beats JPEG on screenshot-shaped images | ~39% smaller than the same image at JPEG quality 85 | `src/image_shrink.ts` (codec selection) |
| Repomap output | Short labels (`f:`, `s:`, `c:`) and auto-compact mode below 6 KB | ~30–40% denser output for the same byte budget | `src/repomap.ts` (`token-goat map --compact`) |
| DB reindex | Batched single transaction + composite indexes on `(file_id, kind)` | 100 files / 10K rows: 84 s → 1 s (~80× faster) | `src/parser.ts`, `src/db.ts` (index migration) |
| Hook cold-start | Lazy import of heavy modules; unknown events short-circuit | 86 ms → 30 ms (~65% faster); unknown-event dispatch <1 ms | `src/hooks_cli.ts` |
| Symbol start_line | TypeScript decorators captured in symbol span | One `token-goat read` returns the decorator + signature + body; no re-read | `src/parser.ts` (TypeScript adapter) |
| Section extraction | Setext headings, h5/h6, anchor IDs, and `__frontmatter__` | `token-goat section` resolves more headings without falling back to a full file read | `src/parser.ts` (Markdown adapter) |
| Image cache | Real LRU eviction (was FIFO; old hot entries got dropped) | Higher hit rate on repeat screenshots in long sessions | `src/image_shrink.ts` |
| Monorepo defaults | Reindex batch 500 → 2000; compact `min_events` 5 → 3 | Fewer worker wakeups; compact manifests fire on shorter sessions | `src/config.ts` defaults |
| Miss suggestions | `symbol` auto-redirects on a single high-confidence close match (`--strict` opts out); `read` / `section` print "Did you mean…?" | Keeps agents on the surgical-read path instead of falling back to full-file `Read` | `src/read_replacement.ts` |

## Token-savings examples

Concrete before/after for the four interception points. Token counts use the ~4-chars-per-token rule of thumb.

### 1. Image — screenshot interception

```
$ ls -lh screenshot.png
-rw-r--r-- 1 user user 1.2M screenshot.png

# Without token-goat: Claude reads the 1.2 MB PNG.
# With token-goat: hook re-encodes as WebP and substitutes the cached copy.

$ token-goat image-shrink screenshot.png
out: ~74 KB WebP   (94% smaller)
```

The same image at JPEG quality 85 lands around 120 KB. WebP wins by another ~39% on screenshot-shaped content (large flat regions, sharp text edges).

### 2. Surgical read — one function, not the whole file

```
# Without token-goat: full file read.
$ wc -l src/auth.py
512 src/auth.py            # ~12,000 tokens

# With token-goat: pull just the function.
$ token-goat read "src/auth.py::login"
out: 38 lines              # ~300 tokens   (97% smaller)
```

Same applies to `token-goat section "README.md::Install"` — one heading instead of the whole document. Anchor IDs and setext headings resolve too, so `section "doc.md::Quick-start"` works when the file uses `Quick start` as an `<h2>` with an explicit `{#quick-start}` anchor.

### 3. Compact manifest — preserve what mattered

```
# Without token-goat: PreCompact fires with no extra context.
# The summarizer LLM picks what to keep, often loses the edit set.

# With token-goat: PreCompact hook injects a structured manifest.
$ token-goat compact-hint --session-id <id>
out: ~280 tokens covering 8 edited files + 12 symbols accessed + 4 key reads
```

The 280-token manifest is one-shot during compaction. The win is downstream: post-compaction, the agent doesn't re-read files it had already edited, saving a full-file Read pass on each one.

### 4. Repomap — orientation without an `ls -R` dump

```
# Without token-goat: recursive ls + a handful of Read calls to figure out the repo.
$ ls -R . | wc -c
51234                       # ~50 KB of raw paths, no signal about importance

# With token-goat: PageRank-ranked, token-budgeted summary.
$ token-goat map --compact
out: ~4 KB                  # top-ranked files + key symbols   (92% smaller)
```

`token-goat map --compact` caps output at a fixed 2000-token budget, switching to short-label mode (`f:` files, `s:` symbols, `c:` calls) to fit more signal per byte. Plain `token-goat map` (no flag) prints the full PageRank-ranked project map with no cap.

### 5. Bash output compression

```
# Without token-goat: pytest dumps every PASSED line + dots + tracebacks.
$ pytest -v tests/
... (3 KB of output, 150 PASSED lines, 1 FAILED at the bottom)

# With token-goat: the PreToolUse hook rewrites the command to
# `token-goat compress --filter pytest`. The wrapper runs pytest, captures
# stdout+stderr, applies the per-tool filter, and prints failures first.
$ token-goat compress --filter pytest --cmd "pytest -v tests/"
= test session starts =
collected 150 items
FAILED tests/test_x.py::test_one
= 1 failed, 149 passed in 2.3s =

[token-goat: collapsed 149 PASSED lines]
[token-goat: pytest filter compressed 4.8 KiB to 0.1 KiB (97% saved)]
```

Built-in output compression covers 130+ dev tool CLIs: `pytest`, `jest` / `vitest`, `cargo`, `npm` / `pnpm` / `yarn` / `bun`, `docker`, `kubectl` / `helm`, `aws`, `ruff` / `eslint` / `mypy` / `pylint` / `oxlint`, `git`, `make` / `gradle` / `mvn` / `ant` / `bazel`, `go test` / `golangci-lint`, `terraform` / `pulumi` / `cdk`, `pip` / `uv` / `conda`, `python`, `gh`, `ansible`, `pre-commit`, `grep`, `eza` / `ls`, `fd`, `bat`, `jq`, `yq`, `curl` / `wget`, `rsync`, `dotnet`, `cmake` / `ctest`, `swift` / `xcodebuild`, `ruby` / `bundler`, `elixir` / `mix`, `php` / `composer`, `flutter` / `dart`, `rust` / `cargo`, `kotlin` / `ktlint`, `zig`, `crystal`, `haskell` / `cabal`, `nix`, `R`, `c++` (conan / vcpkg / cppcheck / clang-tidy), `wrangler` / `hardhat` / `serverless`, `erlang`, `fly.io`, `forge`, `elm`, `julia`, `tox`, `vault`, `packer`, `nx` / `lerna` / `turbo`, `prettier` / `biome`, `sass`, `wasm-pack`, `deno`, **and AI tool CLIs**: `aider`, `gemini`, `claude`, `gh copilot`, `copilot`, `cursor`, `windsurf` (incl. Cascade), `opencode`, `continue`, `cline`. Each filter strips ANSI escapes, collapses `\r` progress bars, dedupes repeated lines, groups linter issues by rule, keeps every error block verbatim, and caps total output at 1000 lines / 64 KiB. Compound commands (`cmd1 && cmd2`) are wrapped per segment, so `git diff && git log` compresses both halves. Disable globally with `TOKEN_GOAT_BASH_COMPRESS=0`, per-filter via `[bash_compress] disabled_filters = ["docker"]` in config.toml, or preview the output of any command with `token-goat compress --cmd '<your command>'`. To exclude project-specific directories from indexing (temporary venvs, build sandboxes), add `[indexing] skip_dirs = ["my-tmpdir"]` to config.toml.

`gh api` responses get an extra pass: boilerplate `*_url` fields (`followers_url`, `gists_url`, `starred_url`, and around a dozen others) are stripped from JSON objects; `html_url`, `avatar_url`, `clone_url`, and `ssh_url` are kept. User and repo objects typically shrink 60–80%. When token-goat sees a GitHub permission error in the output or a non-zero exit on a security endpoint, it injects a system message suggesting `gh auth refresh -s security_events`.

### 6. Context pressure

Token-goat tracks how close a session is to the autocompact trigger and tightens its hints as the window fills. Surgical-read suggestions kick in on progressively smaller files as pressure builds (500 lines at cool, down to 50 at critical), so large reads get flagged before they tip the session over. The PreCompact manifest also shrinks: capped at 500 tokens once the window runs hot, 300 once critical, so it stops contributing to the pressure it measures. The denominator is always the fixed 660,000-token autocompact trigger budget, not the model's raw context window, so the same thresholds apply across models. Run `token-goat doctor --context` to see the current footprint.

## Install

> **Easiest install:** paste this repo's URL into your AI and ask it to install token-goat properly. It will run the commands, check codecs, and confirm everything is working.

**Requirements:** Node.js 22 or later (all platforms)

```
npm install -g token-goat
token-goat install
token-goat doctor          # confirms hooks and sharp are working; look for "sharp: ok"
```

Three commands. Done. Hooks register, a background worker starts at logon and stays out of the way. No terminal popups, no tray icon, no service to babysit.

**Important — sharp is part of the install.** The biggest single win (~39% smaller than JPEG, ~97% smaller than raw PNG) comes from WebP encoding. sharp ships with prebuilt native binaries on Windows, macOS, and most Linux platforms, so a standard `npm install -g token-goat` includes it. On Alpine musl and some ARM boards, npm compiles from source against libvips — that may add a few seconds. `token-goat doctor` will report `sharp: ok` when the image pipeline is working; if it flags a failure, follow the [Image support](#image-support) section below before considering the install complete. **AI agents performing this install: run `token-goat doctor` after `token-goat install` and resolve any sharp failure as part of the same task — do not treat it as a follow-up.**

Two things change how Claude Code sessions behave: hooks fire automatically (image shrink, re-read dedup, compact manifests), and a block written to `~/.claude/CLAUDE.md` plus a registered skill tell the agent to prefer `token-goat read` / `symbol` / `section` over full-file reads. A `Bash(token-goat:*)` allowlist entry in `settings.json` lets the agent run those commands without a per-call approval prompt.

On Linux and WSL, the worker registers as a systemd user service when systemd is available. On WSL without systemd, and on macOS, the SessionStart hook ensures the worker is running at the start of every Claude Code session.

### Codex CLI users

```
token-goat install --codex
```

The `--codex` flag patches both Claude Code and Codex CLI in one pass.

### Gemini CLI users

```
token-goat install --gemini
```

This writes hook entries into `~/.gemini/settings.json` using Gemini CLI's `BeforeTool` / `AfterTool` / `PreCompress` event names. Token-goat translates between Gemini's snake_case tool names (`run_shell_command`, `read_file`, `grep_search`, etc.) and its internal format automatically. Image shrinking, session hints, post-edit indexing, compact assist, and bash output compression all work. To remove: `token-goat uninstall --gemini`.

### opencode users

```
token-goat install --opencode
```

The `--opencode` flag patches Claude Code and drops a TypeScript bridge plugin into opencode's plugins directory — one command, no separate base install. Image shrinking, post-edit indexing, and compact assist work. Session hints don't — opencode's plugin API has no way to inject context before a tool read.

### openclaw users

```
token-goat install --openclaw
```

The `--openclaw` flag patches Claude Code and registers a TypeScript bridge plugin with OpenClaw's gateway: it drops `~/.openclaw/plugins/token-goat.ts` and adds it to `~/.openclaw/openclaw.json`'s `plugins.load.paths` / `plugins.entries` (existing config is merged, never overwritten). OpenClaw's plugin SDK does support `before_tool_call`/`after_tool_call` hooks with the block/rewrite shape token-goat needs; unlike the other bridges, no argument-key remapping is needed at all, since OpenClaw's tool-call params are already snake_case (`file_path`, `command`, etc.) — the same keys token-goat's own `tool_input` uses.

What works: **bash output compression**, **re-read denial** and **surgical-read redirects for oversized first reads**, **image shrinking**, and **post-edit indexing** (all via `before_tool_call`/`after_tool_call`). What doesn't: **session hints** — OpenClaw's tool-call hooks have no context-injection channel, only param rewriting — and the **compaction manifest** — OpenClaw's `before_compaction`/`after_compaction` are observation-only, with no return-value mechanism to inject a manifest into the next turn the way pi's compaction hooks do.

This bridge has not been validated against a live OpenClaw instance — it's built from OpenClaw's documented plugin SDK and hook event types, not dogfooded against a real running gateway. If tool calls aren't being intercepted, the built-in tool name list in `openclaw.ts`'s `TOOL_TO_TG` map is the first thing to check. To remove: `token-goat uninstall --openclaw`.

### pi users

```
token-goat install --pi
```

The `--pi` flag patches Claude Code and drops a TypeScript extension into pi's global extensions directory (`~/.pi/agent/extensions/token-goat.ts`). pi auto-discovers it on the next launch (approve the project-trust prompt the first time). The extension is a normal pi extension — a default-exported factory that subscribes to `session_start`, `tool_call`, `tool_result`, `session_before_compact`, and `session_compact` — and bridges those events into token-goat's `token-goat hook <event>` subprocess protocol.

What works: **bash output compression** (the bash command is rewritten in `tool_call`), **re-read denial** and **surgical-read redirects for oversized first reads** (both return `{ block, reason }` from `tool_call` — a confirmed re-read, or a first read at/above the pressure-scaled `large_read_redirect_bytes` gate, pointing at `token-goat skeleton`/`section`/`symbol` instead), **image shrinking** (`tool_call` rewrites the read path in place to a materialized shrunk copy), **post-edit indexing** and **output caching** (`tool_result`), and the **compaction manifest** (captured at `session_before_compact`, re-injected after `session_compact` since pi's compaction replaces rather than appends). Skill-overhead preservation does not apply — pi has no Skill tool; skills are template expansions. To remove: `token-goat uninstall --pi`.

**Project-local install (single project only).** pi also loads extensions from a project's `.pi/extensions/` directory (after the project is trusted). To install for one project without touching the global directory, drop the extension there:

```bash
npx token-goat install --pi --local
```

This writes `.pi/extensions/token-goat.ts` in the current project only. Remove it by deleting that file.

### Copilot CLI users

```
token-goat install --copilot
```

The `--copilot` flag patches Claude Code and registers a Copilot CLI hook config: `~/.copilot/hooks/token-goat.json` (a `{ version, hooks }` file registering `preToolUse`, `postToolUse`, `preCompact`, `agentStop`, `subagentStop`, and `userPromptSubmitted`, per Copilot's own [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)) plus the shim script it points at, `~/.copilot/hooks/token-goat-shim.js`. Unlike Codex, Copilot's event names and response schema (`permissionDecision`/`modifiedArgs` for `preToolUse`, `modifiedResult`/`additionalContext` for `postToolUse`, `decision`/`reason` for `agentStop`/`subagentStop`) genuinely differ from Claude Code's, so the shim translates rather than passes through.

What works: **bash output compression and re-read denial** (`preToolUse` returns `modifiedArgs` or `permissionDecision: "deny"`), **image shrinking and post-edit indexing** (`postToolUse` returns `additionalContext`), and **stop-hallucination logging** (`agentStop`/`subagentStop` map a token-goat `deny` onto `decision: "block"`, everything else onto `decision: "allow"`). `preCompact` and `userPromptSubmitted` are notification-only on real Copilot CLI, per its docs: Copilot never reads a response body for either, so token-goat's compaction manifest and prompt-context hints have no surfacing channel there. The shim still calls through for both so token-goat's internal side effects keep running, but nothing gets injected back into the agent. Copilot's built-in tool names (`view`, `edit`, `create`, `bash`/`powershell`, `web_fetch`, `grep`, `glob`, `memory`, and MCP-server calls) are remapped onto token-goat's internal names where a clear match exists (`view`→Read, `edit`→Edit, `create`→Write, `bash`/`powershell`→Bash, `web_fetch`→WebFetch, `grep`→Grep, `glob`→Glob); `memory`, `task`, `ask_user`, and MCP tool calls pass through unmapped and simply no-op.

No ambient environment variable documents "this process is running under Copilot CLI" the way Codex/opencode set one, so the shim sets `TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli` itself before calling `token-goat hook` (same workaround `--pi` uses). To install for one project instead of user scope: `token-goat install --copilot --local` (writes `.github/hooks/token-goat.json` in the current project). To remove: `token-goat uninstall --copilot`.

**If Copilot CLI starts denying every tool call with `Denied by preToolUse hook ... (hook errored)`:** this is Copilot's own fail-closed behavior for a `preToolUse` hook that crashes, exits non-zero, or returns unparseable output -- it isn't limited to token-goat's own tool calls, since a fail-closed `preToolUse` hook blocks the whole session. Copilot caches hook configs at session start, so **renaming or reinstalling the hook mid-session has no effect** -- the only recovery is: run `token-goat install --copilot` (or `token-goat doctor`, which now checks the installed hook end-to-end and calls out a stale node-binary path from an nvm/fnm/volta upgrade specifically), then **fully restart Copilot CLI**.

### Cline, Windsurf, Cursor, and other AI tool CLIs

No separate install step needed. Token-goat compresses the terminal output of these tools automatically as soon as they appear on your PATH. Run `token-goat doctor` to confirm they are detected — the "Third-party AI tools" section will show `detected — bash output compression active`.

Filters are built in for: **Cline** (`cline` / `claude-dev`), **Windsurf** (`windsurf`, including Cascade AI patterns), **Cursor** (`cursor`), **GitHub Copilot CLI** (`gh copilot explain/suggest` and the standalone `copilot` binary — this passive output filter is separate from the `--copilot` hook bridge above; it works with no install step and covers Copilot CLI's own terminal chrome, not the hook-driven read/index integrations), **Aider** (`aider`), **Continue** (`continue`), **OpenCode** (`opencode`). Each filter strips version banners, spinner/thinking lines, token-usage boilerplate, and tool-call progress noise while keeping the AI response body, error signals, and any user-approval prompts verbatim.

### Updating

Updates ship automatically. `token-goat install` schedules a weekly `npm install -g token-goat@latest` run at Sunday 03:00 local time (Windows scheduled task; Linux/macOS crontab line tagged `# token-goat-autoupdate`). `token-goat uninstall` reverses it.

Manual paths:

| When | Command |
|------|---------|
| Update now | `npm install -g token-goat@latest` |
| Reinstall from scratch (broken install, sharp failure) | `npm install -g token-goat@latest` |
| Disable auto-updates | Delete the `token-goat-update` scheduled task (Windows) or the `# token-goat-autoupdate` crontab line (Linux/macOS) |

### Upgrading from the Python version

The old Python package (`pip install token-goat`) wrote hook entries into `settings.json` with commands containing `token_goat` (underscore), invoking Python directly: something like `pythonw.exe -m token_goat.cli hook pre_tool_use`. The npm package uses `token-goat hook pre_tool_use` (hyphen) instead.

`token-goat uninstall` only strips entries matching `token-goat hook`. Python-style entries are invisible to it. Left in place alongside the new npm entries, both sets fire on every tool call.

To upgrade cleanly:

1. Remove the Python package: `pip uninstall token-goat`
2. Open `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`) and delete any hook entries whose `command` contains `token_goat` (underscore).
3. Install and register the npm package: `npm install -g token-goat && token-goat install`
4. Verify: re-run `token-goat install` (safe to repeat) or use the `jq` check under [Verify](#verify).

**AI agents handling an upgrade:** complete all four steps in sequence. After step 4, confirm no `token_goat` entries remain in `settings.json` before reporting the upgrade done.

## CLI

| Command | What it does |
|---------|-------------|
| `token-goat symbol <name>` | Jump to a symbol definition. |
| `token-goat read "file::symbol"` | Pull one function or class, not the whole file. Supports qualified lookups (`read "file.py::Class.method"`) and line ranges: `read "file.py@10-40"` for lines 10 to 40 inclusive, or `read "file.py@42"` for one line. Line ranges read straight from disk, so they work on any file, including paths outside an indexed project. `--force-refresh` reparses the file from disk and updates the index before querying — for files touched by git operations, external tools, or direct filesystem writes that bypass the normal post-edit indexing hook. |
| `token-goat replace <file>` | Replace one string in a file using `--old-from`/`--new-from` or `--old-b64`/`--new-b64`; `--all` replaces every match. |
| `token-goat section "doc.md::Heading"` | Pull one Markdown section by heading. A miss that is an unambiguous prefix of exactly one heading auto-redirects with a `(redirected from: …)` marker (and a `redirectedFrom` field under `--json`). Disambiguate duplicates with `"doc.md::Heading#2"`. |
| `token-goat skill-section "<name>::<heading>"` | Extract a named section from an installed skill without reading the full skill file. |
| `token-goat skeleton "file"` | Show all signatures in a file without bodies — typically 70–90% fewer tokens than a full read. `--force-refresh` reparses from disk first, bypassing a stale index. `--stats` adds a per-symbol reference count and doc-coverage flag, computed live from the index. |
| `token-goat outline "file"` | List top-level symbols with line ranges and docstring hints — one-glance file map. `--force-refresh` reparses from disk first, bypassing a stale index. `--stats` adds a per-symbol reference count and doc-coverage flag, computed live from the index. |
| `token-goat brief "file::symbol"` | Bundle a symbol's body, resolved callers (grouped by enclosing function), and its containing doc section into one round-trip instead of three separate `read`/`callers`/`section` calls. `--limit <n>` caps the callers shown (default 20; the true caller count is reported even when truncated). |
| `token-goat scope "file:line"` | Show symbols in scope at a given line — avoids reading the whole file to understand locals. |
| `token-goat exports "file"` | List public (exported) symbols with types and docstring hints. |
| `token-goat refs "<name>"` | Show all files and line numbers where a symbol is referenced. Pass a comma-separated spec (`a,b,c` or `file::a,b`) to merge several symbols' references into one call, each group headed by its symbol name. |
| `token-goat callers <symbol>` | Show which functions call a given symbol, grouped by caller with file, caller name, and every invoking line. Complements `refs`, which shows raw reference sites without grouping by enclosing function. |
| `token-goat call-chain <symbol>` | Trace every caller layer from a symbol back to the entry points — one step deeper than `callers`. Use when you need to know what reaches a function across the whole call graph, not only who invokes it directly. Pairs with `impact` for the downstream direction. |
| `token-goat impact <symbol>` | Walk the reference graph forward and list every file and function that depends on a symbol, with hop depth and dependency type (call, type annotation, import). Run before a refactor to size up the blast radius without starting a build. |
| `token-goat context-for <task>` | Takes a natural-language task description, runs semantic search across the indexed codebase, and emits a prioritized list of `token-goat read` commands trimmed to a token budget. Fetches only the relevant slices instead of loading entire files. `--budget N` sets the token ceiling; `--top N` limits the file count; `--json` for structured output. |
| `token-goat ask "<question>"` *(experimental)* | Answers a question about the codebase out-of-band: retrieves the relevant slices, synthesizes a short answer in token-goat's own process, and returns only that answer plus pointer-citations, so the primary model never pays for the slice bodies. When the `claude` CLI (Claude Code) is on PATH it synthesizes with Haiku, its cheapest tier, with no setup; `codex` falls back to its own default model. Set `TOKEN_GOAT_ASK_MODEL=<model>` or `--model` to choose a different model, or `TOKEN_GOAT_ASK_CMD="<command>"` for a custom backend. With no CLI on PATH it makes no network call and degrades to `context-for` pointers. Answers cache across sessions and self-invalidate when a cited slice changes. `--scope`, `--budget`, `--show-sources`, `--json`. |
| `token-goat changed [<ref>]` | List symbols that changed since a git ref, without reading the full diff. |
| `token-goat blame "file::symbol"` | Git blame narrowed to a specific symbol's lines — no whole-file blame needed. |
| `token-goat types ["file"]` | List type definitions (TypedDict, Protocol, dataclass, Pydantic models) in a file or across the project. |
| `token-goat imports "file"` | Show the import graph for a file one level deep. |
| `token-goat find "<query>"` | Unified search: exact/fuzzy symbol match + semantic, merged and ranked by confidence. |
| `token-goat similar "file::symbol"` | Find the top-k symbols most similar to a given symbol, via full-text search over symbol names and bodies. |
| `token-goat test-for "file"` | Find test file(s) for an implementation file and list their test functions. |
| `token-goat dead` | Surface functions, methods, and classes with no recorded callers in the project index. Private names and common entry points (`main`, `app`, etc.) are excluded by default. `--include-private` lifts the underscore filter; `--kind` narrows to specific symbol types; `--top N` caps output; `--json` for structured output. Results are a heuristic lead — dynamic dispatch and external callers are invisible to static indexing. |
| `token-goat coverage-gaps` | Find callables in non-test source files that never appear in a test file's reference records. Useful for spotting untested surface area before a refactor or release. `--top N` caps output; `--json` for structured output. |
| `token-goat recent [N]` | Show the N most recently edited/accessed files with their symbols. |
| `token-goat grep "<pattern>" [paths...]` | Built-in fallback regex search over files (no `rg` shell-out, no caching) — session-aware dedup for raw `rg`/`grep` Bash calls is a separate hook, not this command. Accepts zero or more paths: omit to walk cwd, or pass several to search them together with hits merged in argument order under one `--max-lines` cap. `-C, --context <n>` shows `n` lines before and after each match. |
| `token-goat semantic "<query>"` | Find code by meaning, not by filename: embedding-vector similarity search over indexed file chunks, falling back to full-text search (BM25) over symbol names/bodies if no vector index exists yet (e.g. optional embedding deps unavailable, or `indexing.embeddings_enabled` is off). `--limit <n>` caps result count. |
| `token-goat map` | Get a compact orientation of the repo. Add `--compact` to fit a fixed 2000-token budget. |
| `token-goat arch` | Project-wide import graph summary: hub modules (most imported), entry points (nothing imports them), and circular chains. Complements `token-goat deps <file>` for per-file depth. |
| `token-goat ignores` | List active skip patterns for the current project — built-in skip dirs and suffixes, plus any patterns from `.tokengoatignore`. |
| `token-goat gdrive-sections <file-id>` | List the heading outline of a Google Doc without fetching the body. |
| `token-goat stats` | See how many tokens you have saved. Shows total events / bytes saved / tokens saved. Add `--full` for the per-source, per-command, and per-day breakdown. |
| `token-goat cost [--session]` | Estimated tokens saved, session or all-time, broken down by savings source. |
| `token-goat context-stats [--project <path>]` | Report estimated token overhead from `CLAUDE.md` files and `MEMORY.md` in a project. `--json` for structured output; `--fix` is not yet implemented. |
| `token-goat history` | Show current session access history: bash commands and URLs fetched. |
| `token-goat bash-output <id>` | Retrieve a cached Bash output by ID instead of re-running the command. Large outputs return a head(30)+tail(80) view by default; pass `--head N`/`--tail N` large enough to cover the full output, or narrow with `--grep PATTERN` (cap `--grep` to the first N hits with `--max-matches N`). Read a file directly with `--file <path>` (e.g. a background task's `tasks/<id>.output`); add `--transcript` to parse that file as a subagent JSONL transcript, keeping only assistant text blocks in order before the slicers apply. |
| `token-goat bash-history` | List cached Bash outputs (newest first) with their IDs, byte sizes, and exit codes. |
| `token-goat compress --cmd '<command>'` | Preview what the Bash compression hook would do to any command — runs it, applies the matching filter, and prints the compressed view. |
| `token-goat web-output <id>` | Retrieve a cached WebFetch response body by ID — same head+tail default and `--head`/`--tail`/`--grep`/`--max-matches` slicers as `bash-output`. |
| `token-goat web-history` | List cached WebFetch responses (newest first) with their IDs, byte sizes, status codes, and URL previews. |
| `token-goat skill-body <name>` | Retrieve a cached Skill body by name without re-invoking the skill (which would replay side effects). Prints the full body; `-c`/`--compact` prints the compact slice instead. No head/tail/grep slicers. |
| `token-goat skill-history` | List cached Skill bodies (newest first) with their IDs, byte sizes, truncation status, and skill names. |
| `token-goat skill-compact [name]` | Cache the compact slice for a skill so later `skill-body --compact` calls are instant, and print a confirmation. Resolves an installed skill by name (falling back to `~/.claude/skills/<name>/SKILL.md` when it was never loaded this session), or pass `--path <file>` to compact a skill straight from a file without name resolution. |
| `token-goat skill-compact --all` | Batch-regenerate stale or missing compacts for every skill cached in the current session. Skips skills whose compact is already fresh (source SHA matches). Run after updating any skill file on disk. |
| `token-goat skill-list [--session-id <id>]` | List all skills cached in the current (or specified) session with body token count, compact availability, compact_stale status, hit count, and age. |
| `token-goat skill-list --json` | Machine-readable version; each skill row includes `compact_stale` (true/false/null) — true means the compact's embedded source SHA no longer matches the body's current SHA and a `skill-compact <name>` regeneration is recommended. |
| `token-goat skill-size` | Show per-session token overhead for all cached skills, with restructure recommendations. |
| `token-goat skill-diff "<name>"` | Unified diff between the two most recent cached versions of a skill — tracks skill updates across sessions. |
| `token-goat compact-hint --session-id <id>` | Inspect the compaction manifest for a session. Add `--trigger auto` to preview the pressure-aware budget the live PreCompact hook would use. |
| `token-goat resume <session_id>` | Emit a single post-compact recovery packet — top skills, last two Bash outputs, top edited-file diffs, and `git diff --stat`, capped at ~2000 tokens. Replaces 5-10 round-trips. |
| `token-goat config list / get / set / validate` | Inspect or edit `config.toml` from the CLI. `validate` reports unknown keys with did-you-mean suggestions. |
| `token-goat config-get <file> <key>` | Look up one key from a config-shaped file (TOML/INI `key = value`, or YAML) without reading the whole thing. On a `.md` file, a leading `---`-fenced YAML frontmatter block (Jekyll/Hugo/SKILL.md style) is checked first and takes precedence over the TOML/INI fallback; a `.md` file with no frontmatter, or an unclosed fence, falls through to the normal lookup unchanged. |
| `token-goat pdf-extract <file>` | Extract plain text from a PDF instead of a raw Read. `--pages <spec>` narrows to a page range (e.g. `1-5` or `3`); `--head`/`--tail`/`--grep`/`--max-matches`/`--section` slice the extracted text the same way `bash-output`/`web-output` do. `--layout` heuristically reconstructs column-aware reading order from text-item coordinates instead of raw content-stream order (imperfect on rotated/overlapping text). |
| `token-goat pdf-outline <file>` | List a PDF's bookmark/outline tree with page numbers instead of a raw Read. |
| `token-goat pdf-meta <file>` | Page count, title/author, and whether a PDF has an extractable text layer (so you know before extracting whether it's scanned/image-only). |

| `token-goat csv-query <file>` | Project columns and/or filter rows from a CSV instead of a raw Read. `--columns <cols>` selects a comma-separated subset; `--where <spec>` is repeatable and ANDed, supporting `col=value`, `col!=value`, `col>value`, `col<value`, and `col~=regex`; `--head <n>` caps rows; `--json` emits rows as a JSON array of objects instead of a formatted table; `--delimiter <char>` and `--no-header` handle non-comma or headerless files. |
| `token-goat csv-profile <file>` | Per-column type inference (number/date/string), null/distinct counts, and min/max or top values for low-cardinality columns, instead of a raw Read. Same `--delimiter`/`--no-header` flags as `csv-query`. |
| `token-goat sharepoint-resolve <shareUrl>` | Best-effort resolve a SharePoint/OneDrive sharing URL to a local synced file path, purely from the local filesystem and `OneDrive`/`OneDriveCommercial` env vars -- no network call, no Graph API, no credentials. Prints the resolved path (feed it to `xlsx-sheets`/`pptx-outline`/etc.) or an honest "could not resolve" with the paths it tried. |
| `token-goat video-chapters <file>` | Lists a video's embedded chapter markers (timestamps + titles) and subtitle/caption streams via `ffprobe`, instead of downloading/transcoding the file to inspect it. Requires ffmpeg on PATH; degrades with a clear message when it's missing. |



| `token-goat xlsx-sheets <file>` | List sheet names, used range, and dimensions in an Excel workbook instead of a raw Read. |
| `token-goat xlsx-head <file> --sheet <name>` | Preview the header + first N rows of one sheet (`--rows`, default 20) instead of a raw Read. |
| `token-goat xlsx-range <file> --sheet <name> --range <a1>` | Extract one cell range (e.g. `A1:D50`) from a sheet; `--formulas` shows formulas instead of computed values. |
| `token-goat xlsx-query <file> --sheet <name>` | Project columns / filter rows from one sheet instead of a raw Read (same `--columns`/`--where`/`--head` shape as `csv-query`, via the sheet's CSV projection). |
| `token-goat pptx-outline <file>` | Per-slide title, body size, and speaker-notes flag instead of a raw Read. |
| `token-goat pptx-slide <file> --slide <n>` | Full text of one slide; `--notes` appends that slide's speaker notes. |
| `token-goat pptx-notes <file>` | Speaker notes for one slide (`--slide <n>`) or all slides, instead of a raw Read. |
| `token-goat pptx-text <file> --grep <pattern>` | Find slides whose text matches a pattern instead of a raw Read. |
| `token-goat docx-outline <file>` | Heading tree of a Word document instead of a raw Read. |
| `token-goat docx-text <file>` | Full body text of a Word document instead of a raw Read; `--head`/`--tail`/`--grep`/`--section`/`--max-matches` slice it the same way `pdf-extract` does. |
| `token-goat transcript-outline <file>` | Speaker list, duration, and time-bucketed markers for a WebVTT/SRT transcript instead of a raw Read. |
| `token-goat transcript <file>` | Slice a WebVTT/SRT transcript by `--speaker <name>`, `--from`/`--to <hh:mm:ss>`, and/or `--grep <pattern>` instead of a raw Read. |


| `token-goat screenshot <url> <destPath>` | Capture a local headless-browser screenshot, shrunk the same way local image reads are (image-shrink pipeline). `--executable-path` overrides the Chrome/Chromium binary; `--width`/`--height` set the viewport (default 1280x800); `--full-page` captures the full scrollable page. |
| `token-goat clean-cache` | Prune on-disk caches to their configured floor without waiting for the worker. |
| `token-goat prune-cache` | Manually trigger LRU eviction across all cache directories (images, bash, web, skills). |
| `token-goat session-summary` | Compact one-liner about current session state — designed for orchestrators and multi-agent loops. |
| `token-goat cache-audit` | Audit your Claude Code config for patterns that bust the prompt cache. |
| `token-goat pack <patterns>` | Collect files matching glob patterns into a single LLM-ready output — Markdown (default), XML, or plain text — with a manifest table of per-file line and token counts. `--line-numbers` prefixes each line; `--instruction-file` appends a task prompt; `--output` writes to a file; `--no-ignore` bypasses `.tokengoatignore`. `--strip-comments` removes language-appropriate comments before packing (shebangs preserved; `#` inside string literals is a known limitation). `--scan-secrets` checks for credentials and exits 2 with per-file warnings if any are found. `--budget N` exits 3 when the estimated token count exceeds N — lets a shell script treat an oversized context as a hard error. Reads file paths from stdin when no patterns are given. |
| `token-goat budget <patterns>` | Estimate the token cost of a file set without reading them into context. Prints results sorted by cost descending; `--context <N>` shows each file as a share of an N-thousand-token window. `--json` for machine-readable output. Run before `pack` to decide what to include. |
| `token-goat tokens [patterns]` | Per-file token footprint table, sorted largest-first. `--tree` groups by directory with subtotals and percentage of total. `--top N` limits to the N biggest files. `--asc` reverses order. `--json` for structured output. Omit patterns to scan the whole project. Useful for deciding what to exclude before running `pack`. |
| `token-goat todo` | Scan indexed project files for `TODO`, `FIXME`, `HACK`, `XXX`, and `NOTE` comment markers. Groups by file by default; `--group kind` to group by marker type; `--kinds` to filter to a subset; `--json` for machine output. Markers in string literals are excluded. |
| `token-goat failures [src]` | Extract failing test blocks from test runner output (pytest, Jest, Go, Cargo). Passes and preamble are dropped; each failure comes back as a labeled block. Reads stdin by default; pass a file path for saved output. `--json` for structured output. |
| `token-goat trace [src]` | Condense Python exception tracebacks to project-owned frames. Strips library, stdlib, and venv frames; chained exceptions preserve cause notes; bare exceptions without a message are handled. `--keep N` (default 5) caps the frame count. `--json` for structured output. |
| `token-goat lockdeps [path]` | Summarize lock file dependencies as a compact table. Reads poetry.lock, uv.lock, requirements.txt, Pipfile.lock, package-lock.json, Cargo.lock, and yarn.lock. Direct dependencies only — optional and transitive entries excluded. `--json` for structured output. |
| `token-goat logfold [src]` | Collapse consecutive duplicate log lines. Runs of identical or structurally equivalent lines fold to `[Nx] line`. Normalizes timestamps, UUIDs, IPs, and hex IDs before comparing so the same event with different values folds correctly. `--tail N` keeps last N lines; `--no-normalize` disables normalization; `--json` for structured output. |
| `token-goat hot [--limit N]` | Cross-session file frequency table: read and edit counts tallied from all stored sessions, ranked by total activity. Shows which files dominate your token spend across your entire history. `--project <dir>` filters to one project; `--json` for structured output. |
| `token-goat note set/get/unset/list/clear` | Persistent per-project notes stored as key-value pairs. Token-goat injects them at session start and after compaction so they survive conversation rollover. Use to pin decisions, constraints, or reminders that would otherwise vanish after compaction. `note list --json` for machine-readable output; `note clear` removes everything at once. |
| `token-goat project list` | Show all project roots indexed by token-goat with their file counts. Roots on the blocklist appear tagged `[excluded]`. `--json` for structured output. |
| `token-goat project exclude <path>` | Add a project root to the blocklist so the worker never indexes it. Writes the resolved absolute path to `[worker] blocked_roots` in `config.toml`; idempotent. Remove the entry from the config to re-enable indexing. |
| `token-goat project prune [--dry-run]` | Remove tracked roots that no longer exist on disk. `--dry-run` previews removals without touching the database. Useful after deleting or moving projects. |
| `token-goat install` | Wire up hooks and autostart. `--dry-run` previews the changes, `--verify` audits an existing install. |
| `token-goat doctor` | Confirm everything is wired correctly. Surfaces install state, cold-import timing, cache hit rates, compaction-budget telemetry, opt-in flag status, and canonical-root sanity. Pass `--context` to show the **Context footprint** section: a fill bar with severity (ok / warn / high / URGENT), per-component breakdown (skills catalog, loaded skill bodies, CLAUDE.md+MEMORY.md, conversation estimate), session-to-session growth trend with sessions-to-URGENT projection, and tiered compaction recommendations (Tier 0–4) naming the exact commands to run. Auto-shown when fill > 40 % or any loaded skill > 2 K tokens lacks a compact. |
| `token-goat baseline` | Attribute the per-session environmental baseline — other plugins' SessionStart hook dumps, both CLAUDE.md files, MEMORY.md, and configured MCP servers — ranked by token cost and tagged by owner (you / harness / `plugin:<name>`), a concrete fix, and whether the cost is fixed (recurs every session) or variable. Identical re-fired hook dumps are deduped to one row. `--subagent` shows only the fixed sources a freshly spawned agent inherits; `--json` for the machine view. Complements `doctor --context` (which costs skills); set `[hints] baseline_budget_tokens` to get a once-per-session SessionStart nudge when the fixed baseline exceeds your budget. |
| `token-goat compact-doc <path>` | Build an extractive compact sidecar for a large reference doc (`.md`/`.markdown`). The compact is stored in the token-goat data dir as a SHA-keyed sidecar; `pre_read` serves it in place of the full file when it exists and is fresh, saving 80–95% of context tokens. Use `--force` to rebuild, `--sentences N` to control lines per section (default 2), `--show` to print the result. The sidecar is automatically marked stale when you edit the source file. Config: `[hints] stable_doc_compacts = true` (default on). |

Missed lookups recover surgically: `symbol` auto-redirects to a single high-confidence close match (pass `--strict` to opt out), while `read` and `section` print a "Did you mean…?" list — a typo costs at most one extra glance, not a re-read.

### Skill efficiency — the `<!-- COMPACT_END -->` marker

When Claude Code invokes a skill, it re-injects the full skill body on every subsequent turn. A large skill file (e.g. a 10k-token `/improve` or `/ralph`) can cost 40–65k tokens per session across 6 active skills. The `<!-- COMPACT_END -->` marker solves this: place it in any skill file to split it into a compact form (above the marker, ~400 tokens) and a reference section (below). Token-goat detects the marker the first time the skill fires, caches only the compact slice, and injects that from then on — labelled `--- compact form (N tokens) ---` so the model knows to request the full body only when it needs the detail.

To add the marker to a skill, open the file and insert `<!-- COMPACT_END -->` on its own line where the "quick reference ends and the detail begins" — typically after the quick-start table and before step-by-step instructions. The full reference section is still reachable via `token-goat skill-section "<name>::<heading>"` or `token-goat skill-body <name>` when needed.

**Re-load and direct-read protection.** Even without the marker, token-goat protects against the two other ways large skills burn context in a long session:

- If the model tries to `Read` a skill file directly (`~/.claude/skills/improve/SKILL.md`), the pre-read hook intercepts it and emits a `token-goat skill-body improve` hint instead — the full 10k–65k tokens never enter context.
- If the same skill is invoked a second time in the session (e.g. `/improve` called again after a `/compact`), re-load detection fires: instead of re-caching the full body, token-goat emits the cached token count and `skill-body`/`skill-section` recall hints. The model can retrieve any section it actually needs rather than absorbing the whole skill again.

To check overhead for your current skills: `token-goat skill-size`. To inspect compact freshness, run `token-goat skill-list` — the `compact_stale` column shows `[stale]` when a skill's compact was generated from an older version of the file. Run `token-goat skill-compact --all` to refresh every stale compact in the current session in one pass.

`token-goat install` now pre-generates compacts for all installed skills as its final step, so compacts are ready from the first session. If you install new skills after the initial install, run `token-goat skill-compact --all` manually — or check `token-goat doctor --context` which reports how many skills were added since the last pre-gen pass and shows the exact command to run.

## MCP server

```
token-goat mcp-serve
```

Runs token-goat as an MCP ([Model Context Protocol](https://modelcontextprotocol.io)) stdio server, exposing `read`, `symbol`, `section`, `outline`, `skeleton`, and `semantic` as tools that call the same in-process logic the CLI commands do — no subprocess spawn per call.

**VS Code** — add it to `.vscode/mcp.json` under the `"servers"` key (this is the correct root key for VS Code's MCP config; it is not `"mcpServers"`):

```json
{
  "servers": {
    "token-goat": {
      "type": "stdio",
      "command": "token-goat",
      "args": ["mcp-serve"]
    }
  }
}
```

**Copilot CLI** — add it to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "token-goat": {
      "command": "token-goat",
      "args": ["mcp-serve"]
    }
  }
}
```

**Caveat.** Registering the server does not force any harness to prefer it. Unlike the hook-based bridges elsewhere in this project — which intercept a `Read`/`Grep`/`Glob` call before it reaches the model and can redirect or deny it outright — an MCP tool is just one more option in the harness's own tool-selection decision. Copilot (or any other MCP-aware client) decides for itself whether to call token-goat's `read` tool or fall back to its own built-in file-read tool; there is no interception mechanism for MCP the way there is for hooks.

## What gets installed?

`token-goat install` writes the following on your machine — nothing else, anywhere. Every entry is reversed by `token-goat uninstall`. Run `token-goat doctor` at any time to see which of these are currently present.

**Claude Code integration** (`~/.claude/`)

| Path | What |
|------|------|
| `~/.claude/settings.json` | Hook entries for `SessionStart`, `PreToolUse` (Read/Grep/Bash, Drive/WebFetch), `PostToolUse` (Edit/Write/MultiEdit, Read/Grep/Glob, Bash, WebFetch, Skill), and `PreCompact`. Plus a `Bash(token-goat:*)` permission allowlist entry. Existing hooks are preserved; a timestamped `.bak` is written before any change. |
| `~/.claude/CLAUDE.md` | A delimited block (`<!-- token-goat-begin -->` … `<!-- token-goat-end -->`) telling the agent to prefer `token-goat read` / `symbol` / `section` over `Read` / `Grep`. Any existing content is preserved. |
| `~/.claude/skills/token-goat/SKILL.md` | The token-goat skill — the same routing guidance in skill form. |

**Worker autostart** (one of the following, picked by platform)

| Platform | Entry |
|---------|------|
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\token-goat-worker`. No admin rights required. |
| Linux (with `systemd --user`) | `~/.config/systemd/user/token-goat-worker.service`, enabled. |
| Linux (no systemd, incl. WSL) | `~/.config/autostart/token-goat-worker.desktop`. On WSL without systemd, the SessionStart hook also starts the worker on every Claude Code session. |
| macOS (untested) | `~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist`, loaded via `launchctl`. |

The autostart command is `node <npm-prefix>/lib/node_modules/token-goat/dist/cli.js worker --daemon`. No compiled `.exe` is dropped; AV/EDR products do not behavior-flag this invocation pattern.

**Weekly auto-update** (Sunday 03:00 local time, runs `npm install -g token-goat@latest`)

| Platform | Entry |
|---------|------|
| Windows | Scheduled task `token-goat-update` (`schtasks`). |
| Linux / macOS | A `crontab` line tagged with `# token-goat-autoupdate`. |

**Data directory** (created on first run)

| Platform | Path |
|---------|------|
| Windows | `%LOCALAPPDATA%\dfk-helper\token-goat\` |
| Linux / WSL | `~/.local/share/token-goat/` |
| macOS | `~/Library/Application Support/dfk-helper/token-goat/` |

Contains the symbol index (`global.db`, per-project `.db` files), session cache, shrunken-image cache, cached skill bodies (5 MB cap, LRU-evicted), logs, locks, and the dirty-file queue. Nothing outside this directory and `~/.claude/` is written.

**With `--codex`** (Codex CLI integration)

| Path | What |
|------|------|
| `~/.codex/config.toml` | Hooks block with Codex-specific matchers (`view_image|Bash`, `apply_patch`, `web_search`). Existing hooks preserved. |
| `~/.codex/AGENTS.md` | A delimited block (`<!-- token-goat-codex-begin -->` … `<!-- token-goat-codex-end -->`) with the same routing guidance, adapted for Codex tool names. |
| `~/.codex/hooks/token-goat-shim.js` | The hook script `config.toml`'s hook commands invoke (`node "<path>" <event>`). Strips internal `_tg_*` keys and injects `hookSpecificOutput.hookEventName` to satisfy Codex's strict schemas. Regenerated on every `install --codex` run. |

**With `--gemini`** (Gemini CLI integration)

| Path | What |
|------|------|
| `~/.gemini/settings.json` | Hook entries under Gemini's `BeforeTool`, `AfterTool`, and `PreCompress` events, using Gemini's own snake_case tool-name matchers (`run_shell_command`, `read_file`, `grep_search`, etc.). Existing hooks preserved; a timestamped `.bak` is written before any change. |

**With `--opencode`** (opencode plugin)

| Path | What |
|------|------|
| `~/.config/opencode/plugins/token-goat.ts` (Linux/macOS) or `%APPDATA%\opencode\plugins\token-goat.ts` (Windows) | TypeScript bridge plugin. Fires on `tool.execute.before`, `tool.execute.after`, and `experimental.session.compacting`. Covers image shrinking, post-edit indexing, and compact assist. |

**With `--pi`** (pi extension)

| Path | What |
|------|------|
| `~/.pi/agent/extensions/token-goat.ts` | TypeScript extension (default-exported `ExtensionAPI` factory). Subscribes to `session_start`, `tool_call`, `tool_result`, `session_before_compact`, and `session_compact`. Covers bash compression, re-read denial, pressure-scaled surgical-read redirects for oversized first reads, image shrinking, post-edit indexing, output caching, and the compaction manifest. A project-local install writes `<project>/.pi/extensions/token-goat.ts` instead. |

**With `--copilot`** (Copilot CLI hook bridge)

| Path | What |
|------|------|
| `~/.copilot/hooks/token-goat.json` | Hook config (`{ version, hooks }`) registering `preToolUse`, `postToolUse`, `preCompact`, `agentStop`, and `subagentStop`, each pointing at the shim script below. Existing files elsewhere in the hooks directory are untouched. |
| `~/.copilot/hooks/token-goat-shim.js` | The shim `token-goat.json`'s hook commands invoke (`node "<path>"`). Translates Copilot's event names and response schema (`permissionDecision`/`modifiedArgs`, `additionalContext`) to/from token-goat's internal hook protocol. Regenerated on every `install --copilot` run. A project-local install (`--copilot --local`) writes `<project>/.github/hooks/token-goat.json` and `<project>/.github/hooks/token-goat-shim.js` instead. |

**With `--hermes`** (Hermes Agent integration)

| Path | What |
|------|------|
| `~/.claude/settings.json` | No new entries beyond the base Claude Code install. Hermes delegates tasks to Claude Code via `claude -p '<task>'`, which loads hooks from this file normally. `token-goat install --hermes` verifies the hooks are present and reports the result. To remove the Hermes detection: `token-goat uninstall --hermes` (removes no files — Hermes shares the Claude Code hook entries). |

**With `--openclaw`** (OpenClaw plugin)

| Path | What |
|------|------|
| `~/.openclaw/plugins/token-goat.ts` | TypeScript bridge plugin (`definePluginEntry` registration). Subscribes to `session_start`, `session_end`, `before_tool_call`, `after_tool_call`, and `before_compaction`. Covers bash compression, re-read denial, pressure-scaled surgical-read redirects for oversized first reads, image shrinking, and post-edit indexing. Not validated against a live OpenClaw instance — see README's "openclaw users" section. |
| `~/.openclaw/openclaw.json` | Adds the plugin path to `plugins.load.paths` and an entry to `plugins.entries.token-goat`. Existing config preserved; a timestamped `.bak` is written before any change. |

## Zero maintenance

After install, there is nothing to start, stop, or restart. The worker runs at logon on Windows, Linux, and macOS; on WSL without systemd, the SessionStart hook covers it. Survives reboots on every platform. `token-goat uninstall` reverses every change, including the startup entry.

## Verify

```
token-goat doctor
token-goat stats
```

`doctor` confirms the install is healthy. `stats` shows cumulative savings.

### Confirming hooks are wired

`doctor` checks the binary, worker, database, and disk. It does not inspect `settings.json` hook wiring. To confirm all three hooks are present, re-run `install`:

```
token-goat install
```

`install` is idempotent: it adds any missing entries and leaves existing hook entries alone. Re-running it is always safe. To inspect the wiring directly:

```bash
# Linux / macOS / WSL
jq '[.hooks | to_entries[] | select(.value[].hooks[]?.command | contains("token-goat hook")) | .key]' ~/.claude/settings.json

# Windows (PowerShell with jq on your PATH)
jq '[.hooks | to_entries[] | select(.value[].hooks[]?.command | contains("token-goat hook")) | .key]' "$env:USERPROFILE\.claude\settings.json"
```

A working install returns `["PreToolUse", "PostToolUse", "PreCompact"]`. Any missing event means a partial install; run `token-goat install` to fill it in.

**AI agents:** after `token-goat install`, run the `jq` check above or re-run `token-goat install` before marking the install complete. `doctor` does not verify hook wiring.

## Image support

Token-goat shrinks large images before they reach the model, cutting vision token costs by 60–90%. The pipeline uses [`sharp`](https://sharp.pixelplumbing.com/), a Node.js image processing library that ships prebuilt native binaries for Windows, macOS, Linux, and Alpine.

On most platforms, `npm install -g token-goat` installs sharp without additional steps. npm pulls a prebuilt binary keyed to your Node.js major version and OS — no C++ compiler, libvips, or system codec libraries required.

Quick check (any platform):

```
token-goat doctor
```

If the `sharp` line shows `OK`, you're done.

### Image support — troubleshooting

If `token-goat doctor` reports `sharp: FAIL`, the most common cause is a cached binary built against a different Node.js version. A fresh install usually fixes it:

```bash
npm install -g token-goat@latest
token-goat doctor
```

On Alpine Linux, some ARM boards, and air-gapped environments, npm can't fetch a prebuilt binary and falls back to compiling from source. That requires `libvips` and C++ build tools:

```bash
# Debian / Ubuntu / WSL
sudo apt-get install -y libvips-dev build-essential

# Alpine
apk add --no-cache vips-dev build-base python3

# Fedora / RHEL
sudo dnf install -y vips-devel gcc-c++ make
```

After installing the system packages:

```bash
npm install -g token-goat@latest
token-goat doctor
```

For platform-specific build details, see the [sharp installation docs](https://sharp.pixelplumbing.com/install).

## Stats display

`token-goat stats` uses 24-bit ANSI color and Unicode block characters for gradient bars, sparklines, and the activity heatmap. In the right terminal it renders sharply. In the wrong one you get broken characters, flat gray blocks, or a "rich is not installed" error.

When it's working, the output shows rounded box borders (╭─╮), gradient bars with fractional edges (▏▎▍▌▋▊▉█), sparklines (▁▂▃▄▅▆▇█), and a heatmap where cells step from dark to bright green. Question marks, boxes, or solid-color bars mean the terminal or font needs fixing.

---

### Stats display — Windows

The old Windows console host — `cmd.exe`, the legacy "Windows PowerShell" app — does not support 24-bit color. Windows Terminal does.

**Step 1: Install Windows Terminal** (already on Windows 11; skip if you have it)
```powershell
winget install --id Microsoft.WindowsTerminal -e --silent
```

**Step 2: Set it as the default terminal** (Windows 10 only — Windows 11 handles this automatically)

Open Windows Terminal → `Ctrl+,` → **Startup** → **Default terminal application** → **Windows Terminal** → **Save**.

**Step 3: Confirm the font**

Windows Terminal ships with Cascadia Code, which covers every character token-goat uses. No additional install needed. To confirm it's selected: `Ctrl+,` → **Profiles → Defaults → Appearance** → Font face should read `Cascadia Code` or `Cascadia Mono`.

If you prefer a Nerd Font, download any variant from [nerdfonts.com](https://www.nerdfonts.com/font-downloads), install it, and select it in the font preference above.

**If bars still look flat** (solid single-color blocks instead of a gradient), add to your PowerShell profile (`$PROFILE`):
```powershell
$env:COLORTERM = "truecolor"
```

---

### Stats display — macOS

Terminal.app on Catalina and later, iTerm2, and the VS Code integrated terminal all handle truecolor and Unicode without configuration. Most users need nothing here. (macOS is untested — see the badge at the top.)

If sparklines or box borders show as question marks or plain dashes, install a complete font:
```bash
brew install --cask font-jetbrains-mono-nerd-font
```
Set it in your terminal's font preferences and reopen.

If colors look flat, add to `~/.zshrc` or `~/.bash_profile`:
```bash
export COLORTERM=truecolor
```

---

### Stats display — Linux / WSL

**WSL users:** you're running inside Windows Terminal. Follow the Windows steps above — same terminal, same font.

**SSH sessions:** the remote shell doesn't inherit truecolor from the local terminal. Add to `~/.bashrc` on the remote machine:
```bash
export COLORTERM=truecolor
export TERM=xterm-256color
```

**Missing Unicode characters:** any Nerd Font covers everything token-goat uses.
```bash
# Ubuntu / Debian
sudo apt install fonts-jetbrains-mono

# Arch
sudo pacman -S ttf-jetbrains-mono-nerd
```

---

### Stats display — AI automated setup

Scripts for non-interactive setup. No prompts.

#### Windows (PowerShell)
```powershell
# 1. Install Windows Terminal if absent
if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    winget install --id Microsoft.WindowsTerminal -e --silent
}

# 2. Set Windows Terminal as the default console host
#    UI equivalent: Windows Terminal -> Ctrl+, -> Startup -> Default terminal application -> Windows Terminal
#    GUIDs are for Windows Terminal stable release
reg add "HKCU\Console" /v DelegationConsole /t REG_SZ /d "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}" /f
reg add "HKCU\Console" /v DelegationTerminal /t REG_SZ /d "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}" /f

# 3. Enable truecolor for the current session and persistently for the user account
[System.Environment]::SetEnvironmentVariable("COLORTERM", "truecolor", "User")
$env:COLORTERM = "truecolor"

# 4. Verify
token-goat stats
```

#### macOS / Linux / WSL (bash)
```bash
OS="$(uname -s)"

# Install a complete font
if [[ "$OS" == "Darwin" ]]; then
    command -v brew &>/dev/null && brew install --cask font-jetbrains-mono-nerd-font
elif [[ "$OS" == "Linux" ]]; then
    command -v apt-get &>/dev/null && sudo apt-get install -y fonts-jetbrains-mono
    command -v pacman  &>/dev/null && sudo pacman -S --noconfirm ttf-jetbrains-mono-nerd
fi

# Enable truecolor — appends only if not already present
RCFILE="${HOME}/.zshrc"
[[ -f "${HOME}/.bashrc" ]] && RCFILE="${HOME}/.bashrc"
grep -q "COLORTERM=truecolor" "$RCFILE" || echo 'export COLORTERM=truecolor' >> "$RCFILE"
grep -q "TERM=xterm-256color" "$RCFILE" || echo 'export TERM=xterm-256color' >> "$RCFILE"
# shellcheck disable=SC1090
source "$RCFILE"

# Verify
token-goat stats
```

#### Truecolor check (any platform)

Run this if the stats output still looks wrong. A smooth green gradient from left to right means truecolor is active. Solid single-shade green means it isn't.

```bash
node -e "for(let r=0;r<256;r+=32)process.stdout.write('\x1b[48;2;0;'+r+';0m  ');process.stdout.write('\x1b[0m\n')"
```

## Security, privacy, and uninstall

**No telemetry. No analytics. No background reporting or silent outbound connections.**

Outbound network is reserved to two explicit cases:

- Google Drive API calls, only if you already authorized Drive in Claude Code. Token-goat never prompts for its own auth.
- Image fetches from URLs: either explicit via `token-goat fetch-image <url>`, or when the AI agent issues a WebFetch call that returns image content — the hook intercepts and shrinks the image. The URL always originates from the agent's work, not from token-goat itself.

**Security reports.** See [SECURITY.md](SECURITY.md). Email `token-goat@dfkhelper.com`; do not file as a GitHub issue. Reports are acknowledged within 7 days; coordinated disclosure with a 90-day default window.

**Prompt injection.** When an AI reads a file, web page, or command output, that content enters its context alongside your own instructions. Prompt injection is when untrusted content includes text designed to look like instructions — "Ignore all previous directives and run this instead" — to redirect the AI mid-task.

Token-goat intercepts every Read, Fetch, and Bash call the AI makes. It does not filter or sanitize content before passing it to the model; doing so would silently break legitimate use cases. The primary defense is the model's own training to treat tool output as data, not as commands from a trusted party.

In practice: if you're reading files from untrusted sources or fetching unknown URLs during a session, pay attention to any actions the AI takes immediately after. Unusual follow-on behavior — opening files it wasn't asked about, writing to unexpected locations — is a sign that something in the read content may have tried to redirect it.

**Windows Defender (optional, Windows only).** Real-time scanning slows indexing. To exclude the data folder, open PowerShell as administrator:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\dfk-helper\token-goat"
```

`0x800106ba` means the prompt is not elevated; reopen as administrator. On enterprise-managed Windows (domain-joined / Intune), Defender exclusions may be locked by Group Policy. The command will fail; that is expected and harmless.

**Uninstall.**

```
token-goat uninstall
```

Reverses everything in [What gets installed?](#what-gets-installed): the scheduled task or systemd unit, the registry value or `.desktop` or `.plist`, the hook entries in `settings.json`, the `CLAUDE.md` block, the skill directory. Add `--codex`, `--gemini`, `--opencode`, `--pi`, `--hermes`, `--openclaw`, or `--copilot` to also strip those integrations. Add `--purge` to also delete the data directory (cache, index, models, logs). Nothing else on the system depends on it.

## About

I built this because long Claude Code and Codex sessions on my machine kept burning context in the same ways: screenshots landing at 2-3 MB, the agent re-reading a file it parsed hours earlier in the same conversation, compactions that forgot which functions were edited. Each felt preventable.

This is a solo project. I use it daily on Windows 11. Tests run on Node.js 20 and 22.

## Requests and issues

Want token-goat to support something it doesn't yet? Open a GitHub issue. Feature requests: a new agent CLI integration (Cline, Copilot Workspace, or any tool not yet covered), a new language adapter, or an image or document format the shrink path doesn't compress yet. Issues are public and searchable. That's where I work out what to build next. A short repro plus what you'd want the command to do is enough.

Bug reports go to the same place. The most useful ones include:
- Your OS, shell, and token-goat version (`token-goat --version`)
- The matching log line from `%LOCALAPPDATA%\dfk-helper\token-goat\logs\` on Windows or `~/.local/share/token-goat/logs/` on Linux/WSL
- What you expected and what actually happened

For private questions, commercial licensing, or anything you'd rather not post publicly, contact me at token-goat@dfkhelper.com.

## Available for work

Senior or staff engineering. Developer tools, AI infrastructure, or context management.

I've spent months inside Claude Code's hook system, session management, and compaction pipeline. Not reading the docs. Instrumenting them to see what was actually happening. The work is in this repo.

I build systems that run without babysitting, measure their own impact, and fail quietly. If you're building tooling for developers who work with AI, reach out.

[token-goat@dfkhelper.com](mailto:token-goat@dfkhelper.com)

## Disclaimer

Token-Goat runs on your machine and touches your files. The software is provided as-is, without warranty of any kind. DFK Helper LLC is not liable for any damages arising from use. Full terms, including the No Liability clause, are in the LICENSE file.

## License

Token-Goat is licensed under the PolyForm Noncommercial License 1.0.0. See the LICENSE file for the full terms.

Individual developers may install and use Token-Goat on their own machines for personal productivity without a commercial license, provided the use does not involve providing Token-Goat as a service to others, incorporating it into a commercial product or platform, or deploying it as shared infrastructure across a team or organization. Employment at a for-profit company does not by itself make use commercial — but if your employer is the primary beneficiary of the deployment, a commercial license applies. When in doubt, email token-goat@dfkhelper.com.

Commercial use is reserved. That means copying or incorporating this codebase into a product, charging for access to it, or running it as shared infrastructure across a team at a for-profit company. Commercial licensing: token-goat@dfkhelper.com.

Copyright (c) 2026 DFK Helper LLC.

Patent Pending.
