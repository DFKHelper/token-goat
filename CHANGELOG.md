# Changelog

All notable changes to Token-Goat are documented in this file. Format follows Keep a Changelog. Token-Goat follows Semantic Versioning starting at 1.0.

## [Unreleased]

### Fixed

- **Semantic search now actually functions: declared the missing `sqlite-vec` dependency and fixed the `vec0` rowid bind.** `sqlite-vec` (the native extension providing the `vec0` virtual table that stores 384-dim embedding vectors) is loaded at runtime in [src/db.ts](src/db.ts) and marked `external` in the bundle, but was never declared in any `package.json` section, so a clean install never had it, `vec0` never loaded, and `token-goat semantic` silently returned nothing. It is now in `optionalDependencies` alongside `@xenova/transformers`. This surfaced a second bug the missing dependency had masked: [src/embeddings.ts](src/embeddings.ts) bound the chunk rowid into `chunk_vectors` as a plain JS number, but `vec0` declares `rowid` as a strict `INTEGER PRIMARY KEY` and rejects a number-bound value ("Only integers are allowed for primary key values"), so the first vector insert threw and the whole `upsertChunks` transaction rolled back. The insert is now centralized in an exported `insertChunkVector` helper that coerces the rowid to `BigInt`, regression-tested against a real `vec0` table in [tests/embeddings_vec_insert.test.ts](tests/embeddings_vec_insert.test.ts).

- **Regression guards so the dead-semantic-search class cannot silently return.** Added [tests/guards/semantic_deps.test.ts](tests/guards/semantic_deps.test.ts), which derives every optional native package the runtime loads via `_require('<pkg>')` (outside the tree-sitter grammars already covered by `grammar_deps`) from the `src` sources and asserts each is declared in `package.json`, so it fails the instant `sqlite-vec` or any future optional native dependency is required but undeclared. Strengthened [tests/embeddings_vec_insert.test.ts](tests/embeddings_vec_insert.test.ts) to classify `sqlite-vec` as working/broken/absent so an installed-but-non-loading `vec0` fails loudly instead of skipping to green, and to run the production `MATCH`/`k` KNN query after inserting, proving the stored vector is actually retrievable rather than just stored.

- **TS/JS destructuring declarations now index each bound identifier individually.** Previously, `const { alpha, beta } = obj` and `const [first, second] = arr` emitted a single unresolvable symbol named after the whole pattern (`"{ alpha, beta }"` or `"[first, second]"`), making it impossible for `token-goat symbol alpha` to find the binding and polluting the symbols table. The fix adds a `collectPatternBindings()` helper that walks destructuring pattern nodes recursively, extracting the actual bound identifiers (`alpha`, `beta`, `first`, `second`), and emits one variable symbol per binding instead. Renamed bindings (`const { a: b } = obj`) now correctly bind `b` (the value), not `a` (the key). See [src/parser.ts](src/parser.ts).

- **chunkFile endLine off-by-one on newline-terminated files.** The `split(/\r?\n/)` method yields a phantom trailing empty string when splitting newline-terminated content (e.g., `"a\nb\n".split(/\r?\n/)` → `["a","b",""]`). This inflated the final chunk's `endLine` by one and appended a stray newline. The fix mirrors Python's `splitlines()` behavior by popping a single trailing empty element if present, ensuring `endLine` reflects the file's actual line count. See [src/embeddings.ts](src/embeddings.ts).

- **drainOnce lost-update race in the dirty queue.** The drain loop in [src/worker.ts](src/worker.ts) was vulnerable to a lost-update race: a file appended to the queue by `appendDirtyPath` (from a concurrent hook) between the queue snapshot and the whole-file delete would be dropped without being indexed. The fix ports the Python original's atomic rename-to-claim pattern: the drain atomically renames the live `dirty.txt` to `dirty.txt.draining` so concurrent appends either land before the rename (and travel with it) or recreate a fresh queue after it (next poll). Also adds crash recovery: if a drain process crashes, the next drain absorbs the abandoned `.draining` file and indexes its contents. Windows rename contention (EPERM/EBUSY when the file is open for append) is handled via a retry loop with 50ms sleeps. Two regression tests verify the fix: "does not drop paths appended during a drain" and "recovers from abandoned .draining file".

- **Surgical-read path lookups now match case-insensitively on Windows/macOS.** On case-insensitive filesystems, `token-goat symbol`/`read`/`refs` silently missed when the queried path's casing differed from the stored on-disk casing. Root cause: `normalizePath` lowercases only the drive letter — the rest keeps the user-typed casing — while indexed `file_path` keeps the on-disk casing; SQL queries used case-sensitive `file_path = ?` comparisons, so `read "src/Worker.ts"` missed a row stored as `src/worker.ts` and fell back to a full Read (the exact waste token-goat exists to prevent). The fix adds a shared `isCaseInsensitiveFs()` / `foldPath()` helper pair to [src/util.ts](src/util.ts), consolidates two existing case-folding duplicates in [src/walk_index.ts](src/walk_index.ts) and [src/worker.ts](src/worker.ts), and applies case-insensitive SQL matching to the three affected query paths in [src/index_reader.ts](src/index_reader.ts) via a `pathEq()` predicate builder (`COLLATE NOCASE` on case-insensitive filesystems, plain `= ?` on case-sensitive). Regression tests verify case-folding queries match across casing and case-sensitive queries still distinguish (set via `TOKEN_GOAT_CASE_INSENSITIVE_FS` for deterministic cross-platform testing).

### Added

- **Bash-output compression: 17 language-runtime and compiler filters (batch K1).** The K1 language filter family is ported from Python to TypeScript and registered in `TOOL_FILTERS` as `LANGUAGE_FILTERS` ([src/tool_filters/languages.ts](src/tool_filters/languages.ts)). All 17 filters share `errorPassthrough = true` so stderr is preserved when a command fails. Filters: `NodeFilter` (`node -e`/`--eval`/`-p`/`--print`; collapses node_modules and node:internal stack frames; token-capped at 1 000 on failure); `PythonFilter` (`python`/`python3`; traceback compression with first-2+last-3 frame trimming for deep traces; consecutive repeated-line dedup; warning-class dedup capped at 3 per category); `RubyFilter` (`ruby -e`/`-r`; backtrace compression, gem-install progress drop); `BunFilter` (`bun test`/`build`/`run`; registered _before_ `NodePackageFilter` which also claims `bun`; download-line collapse, test-result keep, error-section preserve); `DenoFilter` (`deno run`/`test`/`compile`; bundle/compile progress drop; error-chunk preserve); `FlutterFilter` (`flutter build`/`run`/`test`; verbose framework frames collapse); `DartFilter` (`dart run`/`test`/`compile`; stack-trace head+tail with omission marker); `SwiftFilter` (`swift build`/`run`/`test`/`package`; linker/linking-progress collapse; compiler warning dedup); `XcodeFilter` (`xcodebuild`; per-phase collapsing of compile/link/copy lines); `MixFilter` (`mix`/`elixir`; compilation-warning dedup; test-suite summary keep); `ZigFilter` (`zig build`/`run`/`test`; note-line accumulation, error-chunk extraction); `RCmdFilter` (`R`/`Rscript`; message/warning line dedup; loading-package progress drop); factory-built via `makeLanguageFilter`: `erlangFilter` (`erl`/`escript`/`rebar3`; crash-dump drop, error-chunk keep), `crystalFilter` (`crystal`; compile-error keep, progress drop), `haskellFilter` (`ghc`/`stack`/`cabal`; warning/note dedup, linking-progress collapse), `elmFilter` (`elm`; compile-error keep, dependency-fetch drop), `juliaFilter` (`julia`; precompile-progress drop, deprecation dedup), `powerShellFilter` (`pwsh`/`powershell`; error/warning dedup, progress-bar drop).

- **Bash-output compression: 18 db/runner/utility filters (batch K2) — completes the 158-filter port.** The final filter family is ported from Python to TypeScript in `misc.ts` and registered in `TOOL_FILTERS` after `LANGUAGE_FILTERS` ([src/tool_filters/misc.ts](src/tool_filters/misc.ts)). Two filters (`PlaywrightFilter`, `CypressFilter`) are registered individually before `bunFilter` in dispatch to avoid being shadowed by `BunFilter`'s `bunx` claim. The remaining 16 form `MISC_FILTERS`. Four filters have `errorPassthrough = true` (`ToxFilter`, `NoxFilter`, `NgFilter`, `WasmPackFilter`). `SeverityLogFilter.matches()` and `TailTruncFilter.matches()` both return `false` (content-based and explicit-opt-in respectively). DB clients: `PsqlFilter` (`psql`; migration vs SELECT routing; >20-row collapse); `MySQLFilter` (`mysql`/`mysqldump`; binary-name routing; query table state machine; dump first-3-CREATE-TABLE keep); `Sqlite3Filter` (`sqlite3`; DDL passthrough when ≥50% of lines are schema; else row collapse); `RedisCLIFilter` (`redis-cli`; SCAN cursor detection, bulk-OK collapse, long-list collapse). Build/runner: `SysPackageFilter` (`apt-get`/`apt`/`apk`/`brew`; per-manager progress collapse); `ProtocFilter` (`protoc`/`buf`; `[libprotobuf INFO]` drop, WARNING keep, identical-line dedup); `SassFilter` (`sass`/`node-sass`/`lessc`; first-5 write lines sample, deprecation dedup by 60-char prefix); `ToxFilter` (`tox`; env-create/pip noise collapse); `NoxFilter` (`nox`; venv-create/reuse/pip noise collapse); `WasmPackFilter` (`wasm-pack`; `[INFO]` and Cargo compile drop); `NgFilter` (`ng`; test → Karma noise drop, build → webpack chunk table head+tail); `PlaywrightFilter` (`playwright`/`npx playwright`/`bunx playwright`; pass-line and download-progress drop); `CypressFilter` (`cypress`/`npx cypress`/`bunx cypress`; 5-state section suppressor). Generic/catch-all: `DotenvFilter` (`dotenv`; ≥2 banner lines → count note); `EnvFilter` (`env`/`printenv`; ≤20 vars passthrough, else low-priority var suppression); `JsonArrayFilter` (content-based; key-set dedup of objects preserving high-entropy values; 50-item cap); `SeverityLogFilter` (content-based; WARN+ kept + 2-line context, stack-trace continuations); `TailTruncFilter` (opt-in only; first 50 + marker + last 50 when >500 lines). 108 golden tests in [tests/tool_filters_misc.test.ts](tests/tool_filters_misc.test.ts); e2e smoke (psql + playwright) in [tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts).

- **Bash-output compression: 20 shell/file-utility filters (batch J).** The complete Python shell/file filter family is now ported to TypeScript and registered in `TOOL_FILTERS` as `SHELL_FILE_FILTERS` ([src/tool_filters/shell_file.ts](src/tool_filters/shell_file.ts)). Dispatch ordering within `SHELL_FILE_FILTERS`: `RgFilter` precedes `GrepFilter` (RgFilter claims both `rg` and `grep`; GrepFilter is the simpler fallback); `LsFilter` precedes `EzaFilter` (LsFilter claims `ls`/`eza`/`exa`; EzaFilter is reached via `exa` only). Twenty filters: `GrepFilter` (grep/grep variants; head+tail 80; collapses same-file repeated-line runs), `RgFilter` (rg + grep; strips context-line prefix by depth; head+tail 80; count aggregation), `LsFilter` (ls/eza/exa; dot-files collapse, extended-attr drop, long-format permission collapse), `EzaFilter` (eza-specific; strips header/footer frame; icon/colour noise drop), `TreeFilter` (tree; collapses sub-trees deeper than 2 levels; homogeneous leaf collapse), `FdFilter` (fd/fdfind; head+tail 50; same-extension run collapse), `WcFilter` (wc; leading-whitespace normalisation), `BatFilter` (bat/batcat; strips decorative border; head+tail 100), `DeltaFilter` (delta; strips commit header; head+tail 120), `FzfFilter` (fzf; head+tail 30; ANSI strip on selection), `LazyGitFilter` (lazygit; head+tail 60; ANSI strip), `JqFilter` (jq; head+tail 100; deep-nested repeated key collapse), `YqFilter` (yq; head+tail 100; scalar-list block collapse at 150 lines), `CurlFilter` (curl/wget; progress-line drop; header preserve on `-v`/`-I`; head+tail 60), `RsyncFilter` (rsync; transfer-progress drop; path cap at 100 → first 20 + count note), `DiffFilter` (diff; hunk scoring via `_scoreAndCapHunks`; keeps top-N hunks by density; file headers always kept), `FfmpegFilter` (ffmpeg; frame/fps/bitrate progress drop; stream-info block collapse to first 3 lines), `BinaryInspectFilter` (xxd/hexdump/od/hd; head+tail 30; magic-byte annotation), `FileTypeFilter` (file; head+tail 40; same-MIME run collapse), `PsFilter` (ps/top; dynamic column-header parse; sort by CPU%; cap at 30 rows; low-CPU collapse). Golden tests in [tests/tool_filters_shell_file.test.ts](tests/tool_filters_shell_file.test.ts) (137 cases); e2e smoke in [tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts).

- **Bash-output compression: 11 AI-CLI streaming assistant filters (batch I).** The complete Python AI-CLI filter family is now ported to TypeScript and registered in `TOOL_FILTERS` before the batch-H CI filters ([src/tool_filters/ai_clis.ts](src/tool_filters/ai_clis.ts)). Dispatch ordering note: `AI_CLI_FILTERS` is spread before `CI_FILTERS` so `GhCopilotFilter` (matching `gh copilot explain/suggest`) precedes `GhFilter` (which claims all `gh` commands). All filters use the new `makeAiCliFilter(cfg)` factory from `families.ts` except `CodexExecFilter` (bespoke structural algorithm). Eleven filters: `AiderFilter` (prepends collapse notice for `applying edits` progress lines; tracks last token-usage and cost lines as trailing notes; drops repo-map/banner/footer noise), `GhCopilotFilter` (custom `matches()` for `gh copilot explain/suggest` only; drops spinner, banner, and disclaimer/note lines), `CopilotFilter` (standalone `copilot` binary; drops workspace noise, spinner, banner, disclaimer; tracks last completion-stats line), `GeminiCliFilter` (prepends startup-status and tool-call-spinner collapse notices; tracks last context/token-meter line; drops banner/thinking/footer noise), `ClaudeCliFilter` (custom `matches()` skips management subcommands `install/update/doctor/config/login/logout`; counts tool-call log lines as a trailing note; tracks stats and context lines; drops model-header/spinner/footer noise), `CursorFilter` (drops banner, extension-host startup, and telemetry noise), `WindsurfFilter` (drops banner, startup, Codeium activation, telemetry, Cascade status/spinner, workspace noise; counts Cascade tool-call lines as a trailing note; tracks last context line), `OpenCodeFilter` (drops banner, Mode line, spinner, session-save noise; counts tool-call and tool-result lines as an appended collapse notice; tracks last Provider/Model/Context lines), `ContinueFilter` (appends indexing collapse notice with last-seen progress line; tracks last tokens line; drops banner/model-load/config noise), `ClineFilter` (always keeps "wants to execute" lines before any drop rules; appends file-read collapse notice; tracks last tokens/cost/context lines; drops banner/spinner/startup/MCP noise), `CodexExecFilter` (structural extraction: scans first 20 lines for two `--------` separators, extracts model from config block, finds last `codex` role label, scans backward for `tokens used` footer, emits `[codex: model=X, tokens=Y]` header + answer body). New `makeAiCliFilter` factory adds `AiCliFilterConfig`, `AiCliCountedRule`, and `AiCliKeepLastRule` interfaces to `families.ts`. Covered by 95 golden tests ([tests/tool_filters_ai_clis.test.ts](tests/tool_filters_ai_clis.test.ts)) and a built-bundle e2e asserting `aider --model claude-3-5-sonnet` rewrites to `token-goat compress -f aider` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 9 CI/security-scanner filters (batch H).** The complete Python CI-runner and security-scanner filter families are now ported to TypeScript and registered in `TOOL_FILTERS` after the batch-G cloud/IaC filters ([src/tool_filters/ci.ts](src/tool_filters/ci.ts)). Dispatch order: `GhRunLogFilter` must precede `GhFilter` (both match `gh`; `GhRunLogFilter` requires the `--log` flag); `GenericCIFilter` is last (keyword-only match, no binary gate). Nine filters: `GhRunLogFilter` (strips step-name TAB column prefix and ISO-8601 timestamps; drops `##[command]` echo lines unless they contain a failure signal; drops runner boilerplate/cleanup; collapses `##[group]...##[endgroup]` blocks with >20 lines and no failure signal; summarises setup-action `Run` lines into a count note), `GhFilter` (includes the `python-gh-filter-ref` enhancement — recursive strip of boilerplate `*_url` JSON fields from `gh api` responses, preserving `html_url`/`avatar_url`/`clone_url`/`ssh_url` and stripping noise keys `gravatar_id`/`site_admin`; subcommand dispatch: `run view` → pass-step collapse, `*/list` → 30-row cap, `api` → `*_url` strip + JSON pretty-print; base64 `content` fields redacted before dispatch), `ActFilter` (strips `[job/step] |` prefix from body lines; collapses Docker-pull progress; collapses matrix expansion; preserves ✅/❌ status lines verbatim), `PreCommitFilter` (collapses Passed/Skipped hook result lines into a count sentinel; keeps Failed blocks verbatim; keeps only the first `[INFO]` env-setup line and emits a dropped-count note), `BanditFilter` (per-file `testing` progress drop; HIGH/MEDIUM issue blocks kept verbatim; LOW blocks collapsed to count note; `Code scanned:`/`Total issues` stats block always kept), `TrivyFilter` (drops timestamped `INFO`/`WARN`/`DEBUG` log lines from stderr; parses table column positions dynamically; keeps CRITICAL/HIGH rows; collapses MEDIUM/LOW to per-library count notes; always keeps `Total:` summary and no-vulnerability messages), `SnykFilter` (keeps first `Testing` line only; tree-lines >10 collapsed to count note; vulnerability block headers kept; `More about this vulnerability:` URL lines collapsed; summary and license lines always kept), `SemgrepFilter` (per-rule instance cap of 3 via rule-count maps; `Details:` and annotation URL lines dropped per block; scanning banner kept first-only; suppression notes injected before summary), `GenericCIFilter` (no binary gate — fires on `--log`/`logs`/`pipeline`/`workflow` keywords; strips ISO-8601 timestamps and ANSI escapes; collapses DEBUG/TRACE and heartbeat/health-check lines to count notes; always keeps failure-signal lines). Covered by 123 golden tests ([tests/tool_filters_ci.test.ts](tests/tool_filters_ci.test.ts)) and a built-bundle e2e asserting `gh run view 1234 --log` rewrites to `token-goat compress -f gh-run-log` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 16 cloud/IaC filters (batch G).** The complete Python cloud/IaC filter family is now ported to TypeScript and registered in `TOOL_FILTERS` after the batch-F container filters ([src/tool_filters/cloud.ts](src/tool_filters/cloud.ts)). Dispatch order: `AwsCliFilter` must precede `AwsFilter` (both match `aws`/`aws2`; `AwsCliFilter` owns CFN/S3 routing; `AwsFilter` is the simpler JSON-array fallback). Sixteen filters: `TerraformFilter` (matches terraform/tofu/terragrunt; subcommand dispatch: plan — drops refresh/read lines, collapses `(known after apply)` attribute blocks, emits plan-summary first + last-20-line tail; apply — dedupes `Still creating` per-resource; init — head=5/tail=5 for provider installs; show/state — key-attribute-only per resource block; `errorPassthrough=true`), `AwsCliFilter` (json-array threshold 10/keep 3; S3 transfer progress collapse; CFN IN_PROGRESS dedup by logical resource ID), `AwsFilter` (json-array threshold 20/keep 20; table truncation fallback), `GcloudFilter` (spinner-char drop, service-enable/wait collapse, structured-output collapse >70% structured + >20 lines), `AzureCliFilter` (json-array threshold 10/keep 3; preview warning collapse; provisioning progress-JSON collapse to last status), `AnsibleFilter` (`compress()` override — structural error handling; routes by binary: ansible-lint → rule-code grouping (first 3 per rule); ansible-galaxy → head=5/tail=5; ansible-playbook — ok/changed/skipped collapsed per task section, failure blocks kept verbatim, PLAY RECAP always preserved), `PulumiFilter` (in-progress/still-heartbeat lines dropped, completion/summary kept), `CdkFilter` (asset progress dropped, `WORD_IN_PROGRESS` table rows dropped, `WORD_COMPLETE` rows and failure/summary kept), `VaultFilter` (kv list/list paths collapsed to first 5 with elision note; lease/token metadata dropped; table dividers dropped), `PackerFilter` (SSH/WinRM wait polls collapsed; provisioner step announcements collapsed; lifecycle lines kept), `NixFilter` (fetch/substitute + building derivation + flake lock update lines collapsed to count notes; error/note/warning always kept), `WranglerFilter` (asset upload + skip + bulk-progress lines collapsed; build-step noise dropped), `HardhatFilter` (Compiling N files + Solc timing + passing tick lines collapsed; tx receipt noise dropped; test summary kept), `ServerlessFilter` (Packaging/Uploading/Validating/Updating steps collapsed; CF IN_PROGRESS rows dropped; polling dots dropped; Service Information/endpoint lines kept), `FlyFilter` (Docker build steps + `#N CACHED/DONE` layer lines collapsed; per-machine wait lines collapsed; DNS polling dropped; step headers + summary kept), `ForgeFilter` (Compiling/Solc-timing lines collapsed; passing `[PASS]` lines collapsed; gas-report separator rows dropped; test-suite header/summary always kept). Covered by 117 golden tests ([tests/tool_filters_cloud.test.ts](tests/tool_filters_cloud.test.ts)) and a built-bundle e2e asserting `terraform plan` rewrites to `token-goat compress -f terraform` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 5 container/kubernetes filters (batch F).** The complete Python container filter family is now ported to TypeScript and registered in `TOOL_FILTERS` after the batch-E build filters ([src/tool_filters/containers.ts](src/tool_filters/containers.ts)). Dispatch order: `KubectlLogsFilter` must precede `KubectlFilter` (both match `kubectl`/`k`); `DockerComposeFilter` must precede `DockerFilter` (both match `docker`). Five filters: `DockerFilter` (custom `compress()` override; reverses stdout/stderr merge via `combineOutput(stderr, stdout)` because Docker writes layer progress to stderr; drops `---> Using cache`/`---> xxxxxxxx` layer IDs; collapses `Step N/M` build steps via `dedupeNumericRuns`; head+tail cap at 60), `DockerComposeFilter` (custom `matches()` detects `docker-compose` binary OR `docker compose` two-word form; `errorPassthrough=true`; drops `Network created`/`Volume created`/`Pulling`/`Pulled from`/`Pull complete`/`Digest:`/`Status:` noise; dedupes service health-check wait lines; keep-first for `Creating`/`Starting`/`Stopping`/`Removing` lifecycle verbs), `KubectlFilter` (`errorPassthrough=true`; routes by first positional: `get`/`describe`/`apply`/`delete`/`rollout` head+tail, `events` → event compression, `logs` → head-30/tail-20; table column-count collapse to first 3 rows + count note when >=10 rows), `KubectlLogsFilter` (custom `matches()` requires `kubectl`/`k` binary + `logs` first positional; `errorPassthrough=true`; engages only when `nonEmpty.length > 50` — faithful to Python; applies access-log collapse, stack-trace collapse to 5 frames, repetitive-line dedup keeping first 3 of each message + flush on switch, JSON blob collapse, head+tail cap at 200 lines), `HelmFilter` (`errorPassthrough=true`; matches `helm`/`helmfile`; routes `install`/`upgrade` to NOTES-block preservation + status-noise drop, `list`/`ls` to head+tail 20, `template` to YAML-doc counting with first-3+last-1 keep). Covered by 64 golden tests ([tests/tool_filters_containers.test.ts](tests/tool_filters_containers.test.ts)) and a built-bundle e2e asserting `docker build .` rewrites to `token-goat compress -f docker` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 17 build-tool filters (batch E).** The complete Python build filter family is now ported to TypeScript and registered in `TOOL_FILTERS` after the batch-D git filters ([src/tool_filters/build.ts](src/tool_filters/build.ts)). Seventeen filters: `MakeFilter` (matches make/gmake/ninja plus gradle/mvn/bazel/go binary stems; per-stem routing: go download+error dispatch, configure probe-drop, cmake-style `[N%] Building` collapse, generic make[N] directory-marker drop), `CmakeFilter` (routes `ctest` to pass/fail compression; cmake: `[N%] Building` collapse with last-line note, `-- Found` package collapse), `GradleFilter` (case-insensitive subcommand matching including camelCase tasks like `bootJar`; task-progress drop, BUILD SUCCESSFUL/FAILED preserve, stack-trace cap at 10), `MavenFilter` (`compress()` override; `[ERROR]` extraction + last 20 lines on non-zero; test/verify/package dispatch), `AntFilter` (run-length collapse per task type: echo/mkdir/copy/delete/move/chmod/touch/get), `BazelFilter` (`INFO: From Compiling` collapse with count note; PASSED test-target collapse), `MesonFilter` (`errorPassthrough=true`; MESON_KEEP_RE passthrough; compiler-detail/probe/Found-tool drop; `[N/M] Compiling` collapse; `[N/M] Linking` keep), `MSBuildFilter` (warning dedup by code; Copy/MakeDir/task collapse; keeps first Build started), `DotnetFilter` (`compress()` override dispatching test/restore/build-publish-pack/format), `SbtFilter` (`compress()` override; `[info]` loading-noise and test dot-progress collapse; `[warn]` cap at 5 per category), `JavacFilter` (collapses `Note: *.java uses unchecked` groups; preserves error diagnostic blocks), `CargoFilter` (`compress()` override dispatching test/clippy/bench/build; build: Compiling collapse to `[compiling N crates…]` when >=3; test: `[N tests passed]` injection after each running section), `GoFilter` (custom `matches()` excludes `test` so `goTestFilter` wins; per-subcommand handlers for get/mod-tidy/vet/build), `NxFilter` (matches `nx` or `npx/pnpx nx`; cache-hit detection before task-header; failed-task header sampling on non-zero exit), `LernaFilter` (first-5 `info run` sampling; verbose/notice drop), `TurboFilter` (cache-hit task set tracking; body-line drop for cache hits), `WebpackFilter` (`_invokesViteBuild()` routing to vite or webpack path; vite requires `build` subcommand). `CargoFilter` and `GoFilter` registered first in `BUILD_FILTERS` to ensure dispatch ordering; `GoFilter.matches()` excludes `test` so the batch-A `goTestFilter` wins. Covered by 122 golden tests ([tests/tool_filters_build.test.ts](tests/tool_filters_build.test.ts)) and built-bundle e2e entries asserting `make all` rewrites to `token-goat compress -f make` and `cargo build --release` rewrites to `token-goat compress -f cargo` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 7 git VCS filters (batch D).** The complete Python git filter family is now ported to TypeScript and registered in `TOOL_FILTERS` after the batch-C linter filters ([src/tool_filters/git.ts](src/tool_filters/git.ts)). Seven filters: `GitLogFilter` (`log` — format-aware: oneline cap 50, patch collapse, stat collapse, full-format collapse to one-liners for >10 commits), `GitDiffFilter` (`diff`/`show` — binary summary, large-hunk truncation at ~50 changed lines, JSONL hunk semantic summary when ≥75% of added lines are JSON dicts with ≤5 distinct key-sets, `--stat` directory rollup vs pathspec truncation), `GitStatusVerboseFilter` (`status` — short/porcelain passthrough; verbose: advice strip + file listing grouped to section counts), `GitBlameFilter` (`blame` — annotated and porcelain formats: same-commit runs collapsed to first line + `N more lines by` marker), `GitCommitFilter` (`commit`/`--amend`/`--fixup` — lefthook banner/hook-run noise collapsed to a single checkmark summary line on pass; error block preserved on fail), `GitPushFilter` (`push` — remote/local progress bundler keeping only 100%-done stage lines + non-progress informational lines, pytest-dot compression, upstream error preservation), `GitFilter` (generic catch-all for all other `git` subcommands — internal dispatch for status/log/diff/ls-files/ls-tree/fetch/pull/push/clone; fallback to `dedupeCombinedOutput`). All filters extend `GitBaseFilter` which overrides `postNormalise` to strip git CRLF warnings (modern single-line format and legacy two-line pair). `errorPassthrough = false` for all — errors are handled structurally per filter. Covered by 95 golden tests ([tests/tool_filters_git.test.ts](tests/tool_filters_git.test.ts)) and a built-bundle e2e asserting `git diff HEAD` rewrites to `token-goat compress -f git-diff` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 16 linter/type-checker/formatter filters (batch C).** The complete Python linter family is now ported to TypeScript and registered in `TOOL_FILTERS` after the batch-B package-manager filters ([src/tool_filters/linters.ts](src/tool_filters/linters.ts)). Dispatch order mirrors the Python `FILTERS` list: `TscFilter` (custom `matches()` for bare/npx/yarn/pnpm tsc; three modes: typecheck TS-code dedup at 3 per code, watch-cycle collapse keeping first+last, build up-to-date aggregate), `RuffFilter` (check: per-code cross-file summary for codes with >=3 occurrences in >=2 files; format: reformatted/would-reformat sample with count note), `MypyFilter` (error/note dedup by normalised message, standalone `[code]` drop, See-https drop), `PylintFilter` (module-header defer, always-keep E/F severity, C/W/R dedup by code at 3, separator/config-noise drop), `OxlintFilter` (per-file per-rule dedup with location-block suppression for elided issues), `ESLintFilter` (stanza-based: errors always kept; warnings deduped by rule within each file stanza), `BiomeFilter` (custom `matches()`; <=40-line pass-through; rule-stanza collapse to first 3 with <=2 source lines; hint/annotation drop), generic `LinterFilter` (pyright/pylint via key-dedup; stylelint/rome via ESLint-stanza algorithm), `GolangciLintFilter` (per-file/linter dedup with placeholder-then-replace for accurate extra counts; structured-log noise drop), `PhpStanFilter` (stem-dispatched: phpstan per-file row dedup; psalm progress drop + error-type dedup), `swiftlintFilter` (produced by the new `makeLinterFilter` factory; always-keep error/serious; warning dedup by rule with summary emitted last), `BlackIsortFilter` (black: reformatted/would-reformat sample at 5; isort: Fixing sample at 5), `PrettierFilter` (custom `matches()`; changed-file sample at 5; unchanged drop counted), `KtlintFilter` (plain-text error-always-keep/warning-dedup; checkstyle XML: rule dedup via `source=` attribute), `CppcheckFilter` (Checking/progress/config-check drop with count notes), `ClangTidyFilter` (warnings-generated aggregate; include-chain drop; keep first context block per diagnostic; subsequent caret/tilde context dropped). The `makeLinterFilter` factory (added to [src/tool_filters/families.ts](src/tool_filters/families.ts)) captures the shared per-rule warning-dedup + always-keep-severity + summary-last pattern for linters that fit that model. PylintFilter is registered before the generic LinterFilter in `LINTER_FILTERS` so `pylint` always dispatches to the specific filter. Covered by 78 golden tests ([tests/tool_filters_linters.test.ts](tests/tool_filters_linters.test.ts)) and a built-bundle e2e asserting `eslint src/` rewrites to `token-goat compress -f eslint` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **Bash-output compression: 15 package-manager filters (batch B).** The complete Python `NpmInstallFilter`, `PnpmFilter`, `YarnFilter`, `PipFilter`, `UvFilter`, `CondaFilter`, `GemFilter`, `BundlerFilter`, `ComposerFilter`, `NuGetFilter`, `PubFilter`, `ConanFilter`, `VcpkgFilter`, `NodePackageFilter`, and `DepListFilter` are now ported to TypeScript and registered in `TOOL_FILTERS` ([src/tool_filters/package_managers.ts](src/tool_filters/package_managers.ts)). Two filters use the new `makePackageManagerFilter` factory in [`src/tool_filters/families.ts`](src/tool_filters/families.ts) (BundlerFilter and PubFilter — a single keep/drop loop with per-rule note counts); the remaining 13 subclass `ToolFilter` directly with richer structural logic (multi-phase install pipelines, freeze/list truncation, dedup, error passthrough). Dispatch order places the install-specific filters before the general `NodePackageFilter` so `pnpm run dev` and `yarn add` route to their dedicated handlers. `ConanFilter` and `VcpkgFilter` use `errorPassthrough = true` and override `compressBody`; `DepListFilter` uses a custom `matches()` that fires only on listing subcommands (list/freeze/tree/show/ls) and a PKG_MGR_STEMS set (npm/pnpm/yarn/cargo) to avoid conflicting with the dedicated install filters. Covered by 132 golden tests ([tests/tool_filters_package_managers.test.ts](tests/tool_filters_package_managers.test.ts)) and a built-bundle e2e asserting `pip install requests` rewrites to `token-goat compress -f pip` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

## [2.2.4] - 2026-06-29

### Added

- **Bash-output compression framework (TypeScript): activated for build and test commands.** The Python implementation structurally compressed verbose tool output (progress bars, ANSI, repeated lines, passing-test noise) through per-tool filter classes invoked by a pre-bash command rewrite; the TypeScript port carried over the dormant pieces (the filter base, the `token-goat compress` CLI) but never wired the rewrite, so no command's output was ever compressed automatically. This reconnects the mechanism end to end. The pre-bash hook ([src/hooks_bash.ts](src/hooks_bash.ts)) now recognizes a single build/test command with no cached prior run and rewrites it to `token-goat compress -f <name> -c '<orig>'` through a new `rewriteInput` hook result ([src/types.ts](src/types.ts)) serialized to the Claude Code `PreToolUse` `updatedInput` wire shape ([src/hook_registry.ts](src/hook_registry.ts)); the wrapped subprocess ([src/bash_runner.ts](src/bash_runner.ts)) runs the original command, applies the matching filter, and re-emits a compressed view with a one-line savings marker. The filter is chosen on the cd-stripped command, but the wrapper preserves any `cd … &&` prefix so the command still runs in the right directory, and the post-hook unwraps the wrapper before keying its output cache so `bash-output` recall stays keyed on the original command (a cached prior run is recalled instead of re-run). The catch-all `generic` filter ([src/tool_filters/generic.ts](src/tool_filters/generic.ts)) is live now (ANSI/progress strip plus consecutive-line dedupe); the per-tool filters (vitest, npm, docker, git, and the rest) are being ported in follow-up batches on the shared helper and base foundation ([src/tool_filters/helpers.ts](src/tool_filters/helpers.ts), [src/tool_filters/base.ts](src/tool_filters/base.ts)). Opt out globally with `TOKEN_GOAT_BASH_COMPRESS=0`, or per filter with `[bash_compress] disabled_filters`. Covered by in-process unit tests of the rewrite decision, `description`/`timeout`/cd-prefix preservation, the env and disabled-filter opt-outs, and the recall round-trip, plus a built-bundle e2e asserting the exact `PreToolUse` wire JSON ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).
- **Bash-output compression: Jest and Vitest filters (first structured batch).** With the framework now wired, the per-tool filters begin landing. Jest (also covering Mocha / Ava / Tap) and Vitest are the first: passing-file headers and per-test `✓` ticks collapse to counts, `FAIL` / `×` blocks pass through verbatim, the `Test Suites` / `Test Files` / `Tests` / `Duration` summary is always kept, `console.*` / `stdout |` blocks collapse to a count line, and Jest `--verbose` duplicate `Failures:` sections (already shown inline) are dropped. Both are built from a single shared Node test-runner family factory ([src/tool_filters/families.ts](src/tool_filters/families.ts)) so the next runner is a config object rather than another loop, and both register into the dispatch table ([src/tool_filters/test_runners.ts](src/tool_filters/test_runners.ts), [src/tool_filters/dispatch.ts](src/tool_filters/dispatch.ts)) so the pre-bash hook auto-selects them — `npx vitest run` now rewrites to `token-goat compress -f vitest -c '…'` instead of the generic fallback. Faithful ports of the original Python `JestFilter` / `VitestFilter`, covered by golden tests ([tests/tool_filters_test_runners.test.ts](tests/tool_filters_test_runners.test.ts)) and a built-bundle e2e proving the registration survives bundling ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).
- **Bash-output compression: pytest and `go test` filters (bespoke runners).** The second test-runner batch lands two filters too structured for the shared Node family. The pytest filter ([src/tool_filters/pytest.ts](src/tool_filters/pytest.ts)) strips pytest-xdist `[gwN]` worker prefixes, collapses pytest-cov per-file coverage tables to their `TOTAL` line, trims the `slowest N durations` section to the first five entries, deduplicates the warnings summary (dropping `-- Docs:` footers), drops the constant banner/preamble/`= test session starts =` lines, and collapses `PASSED` lines (default and verbose) to a count — while keeping every `FAILURES`/`ERRORS` block and the final tally verbatim. The `go test` filter ([src/tool_filters/go_test.ts](src/tool_filters/go_test.ts)) collapses `--- PASS:` / `=== RUN` lines to counts, drops `go: downloading` noise, counts `--- SKIP:` separately, passes `go test -json` through untouched so downstream parsers still work, and keeps `WARNING: DATA RACE` fence blocks verbatim with deep goroutine stacks collapsed to the first five frames; it registers ahead of any future `go build`/`go run` filter since both match `go`. Both are faithful ports of the Python `PytestFilter`/`GoTestFilter`, covered by golden tests ([tests/tool_filters_pytest_gotest.test.ts](tests/tool_filters_pytest_gotest.test.ts)) and a built-bundle e2e proving `python -m pytest tests/` rewrites to `token-goat compress -f pytest` ([tests/bash_compress_rewrite.test.ts](tests/bash_compress_rewrite.test.ts)).

- **`token-goat index --walk` indexes a non-git folder.** `index` enumerates files with `git ls-files`, so a folder that is not a git repository produced an empty index and `symbol`/`skeleton`/`outline`/`semantic` returned nothing until it was `git init`'d (`read`/`section`/`grep` always worked, being index-free). Passing `--walk` opts into a bounded directory walk instead, reusing the same dependency-free walker as `map` ([src/baseline.ts](src/baseline.ts)). Because the `git ls-files` exclusions are lost on this path, the walk re-adds the safety that matters ([src/walk_index.ts](src/walk_index.ts)): it refuses an over-broad root (a filesystem root, the home directory, or any ancestor of it), caps the tree at 20,000 source files, and drops `.env*` secrets and generated `.d.ts` files before indexing. Without the flag the empty-index error now names `--walk`. The default git-tracked path is byte-for-byte unchanged. Covered by policy unit tests ([tests/walk_index.test.ts](tests/walk_index.test.ts)) and a non-git walk-index run against the built `dist/token-goat.mjs` bundle ([tests/worker_index_e2e.test.ts](tests/worker_index_e2e.test.ts)).

### Fixed

- **WebFetch responses are now actually cached for cross-process recall.** The post-fetch hook ([src/hooks_fetch.ts](src/hooks_fetch.ts)) extracted each WebFetch response body and validated its size but never stored it — `postFetchHandler` returned without calling `storeWebOutput()` / `recordWebFetch()`, so the cross-process recall promise of [src/web_cache.ts](src/web_cache.ts) was dead: `token-goat web-output <id>` always missed and a later hook process could not resolve a body fetched by an earlier one. The handler now stores the body (≥1024 bytes, non-empty session id) and records it in the session index, mirroring the bash-output path. A regression test drives the store/recall round-trip plus the below-threshold and empty-session skips, failing on the pre-fix handler ([tests/hooks_fetch_persistence.test.ts](tests/hooks_fetch_persistence.test.ts)).
- **Compressed output lines no longer exceed `maxLineLength`.** When `truncateLine` shortened an over-long line it appended `… [N chars truncated]` without counting the marker against the budget, so a 1000-character line capped at 500 emitted 523 characters. The truncation now reserves the marker's worst-case width before slicing and reports the exact number of characters dropped ([src/bash_compress.ts](src/bash_compress.ts)), with a regression test asserting every output line stays within the cap ([tests/bash_compress_truncate_bug.test.ts](tests/bash_compress_truncate_bug.test.ts)).
- **`token-goat config-get` returns the value from the requested section, not the first match.** The TOML/INI fallback parser did a flat line scan, so `config-get pyproject.toml project.version` returned the `version =` from an earlier `[tool.ruff]` table instead of `[project]`. The lookup now tracks the active section header and only matches keys inside the requested one ([src/read_commands.ts](src/read_commands.ts)), with a regression test covering the duplicate-key-across-sections case ([tests/test_configget_bug.test.ts](tests/test_configget_bug.test.ts)).
- **The reindex queue deduplicates paths case-insensitively on Windows and macOS.** `getDirtyPathsFor` ([src/worker.ts](src/worker.ts)) deduped on the raw path, so `C:\Projects\file.ts` and `c:\projects\file.ts` — the same file on a case-insensitive filesystem — were reindexed twice. It now folds the normalized path to lowercase for the dedup key on `win32`/`darwin` while preserving the original path for indexing.
- **Flat section ranges never end before they start.** `assignFlatEndLines` ([src/languages/common.ts](src/languages/common.ts)) could assign a section an `endLine` earlier than its own `startLine` when adjacent headings produced an inverted range, yielding an empty or backwards slice. The end line is now floored at the section's start line.
- **Task-output recall hints now name a command that actually works.** When the Read tool or a `cat`/`tail` of a `…/tasks/<id>.output` (or `…/tool-results/<id>.txt`) session-artifact file was intercepted, the hint suggested `token-goat bash-output --tail N` with no id or path — which errors with `provide an <id> or --file <path>` — and the Bash-side deny additionally claimed the output was "already cached" when it never checked the cache. These artifacts are written to disk by the harness, not through the bash-output cache, so `bash-output <id>` misses (the task id is not a cache key). The hooks now emit `token-goat bash-output --file "<path>" --tail 50` (preserving the requested line count for `tail -n N`), a copy-pasteable command that reads the on-disk file and applies the slice ([src/hooks_read.ts](src/hooks_read.ts), [src/hooks_bash.ts](src/hooks_bash.ts)). Regression tests assert every recall hint names the working `--file` form and no longer carries the broken bare placeholder ([tests/hooks_read.test.ts](tests/hooks_read.test.ts), [tests/hooks_bash.test.ts](tests/hooks_bash.test.ts)).

- **Session recall and output caches now survive the hook process boundary.** Token-goat's hooks run as a fresh `token-goat hook <event>` OS process per tool call (the installer wires `{ type: "command", command: "token-goat hook <event>" }`), but the entire session-recall layer lived in process-local in-memory maps that died when each hook process exited — a regression from the Python original, which persisted a `SessionCache` to JSON. In the shipped TypeScript binary this meant re-read dedup, the bash/web recall index, and curl-download dedup never fired across calls: a second Read of the same file emitted no "already read" hint, and `bash-output <id>` / `web-output <id>` always missed from the session-less CLI or a later process. Three on-disk layers under `tokenGoatHome()` (`TOKEN_GOAT_HOME`, else `~/.token-goat`) restore the behavior: per-session state is loaded and saved around every hook in [src/relay.ts](src/relay.ts) via the new [src/session_store.ts](src/session_store.ts) (merge-on-save with set-union hints and field-merged file entries, atomic-write, file cap, fail-soft), serialized through new `exportSessionState()` / `importSessionState()` in [src/session.ts](src/session.ts); bash and web outputs additionally persist content-addressed blobs through the new shared [src/disk_cache.ts](src/disk_cache.ts), so [src/bash_output_cache.ts](src/bash_output_cache.ts) and [src/web_cache.ts](src/web_cache.ts) read through to disk on an in-memory miss and prune by age (24h) and count (200). The three bash recall sites in [src/hooks_bash.ts](src/hooks_bash.ts) now guard on the cached content entry existing — not just the session index — so a pruned blob never yields a `bash-output <id>` hint that would error. A built-bundle cross-process test ([tests/session_persistence_e2e.test.ts](tests/session_persistence_e2e.test.ts)) drives the real `dist/token-goat.mjs` through separate `spawnSync` processes and asserts the re-read hint and bash recall survive the boundary — it fails on a port without disk persistence — alongside unit coverage for the blob store, session store merge/cap, and disk read-through ([tests/disk_cache.test.ts](tests/disk_cache.test.ts), [tests/session_store.test.ts](tests/session_store.test.ts), [tests/content_cache_disk.test.ts](tests/content_cache_disk.test.ts)).

- **`trimToBudget` no longer slices a line mid-ANSI-escape.** When a single oversized first line had to be truncated to fit the token budget, the budget and per-line cost were measured on the ANSI-stripped string but the slice was taken on the raw line, so escape bytes silently consumed budget and a mid-escape cut left dangling color codes. The truncation now slices the stripped string ([src/overflow_guard.ts](src/overflow_guard.ts)), with a regression test that fails on the pre-fix code ([tests/overflow_guard.test.ts](tests/overflow_guard.test.ts)).
- **Skill compact cache filenames are colon-free and consistent across store/get/list.** Four functions built the on-disk compact filename from the skill name but handled colons inconsistently: `storeCompact`, `getCompact`, and `getCompactAnySession` passed the raw name through (writing literal-colon filenames that are invalid on Windows), while `listSkills` used `.replace(':', '_')` without the `/g` flag and so replaced only the first colon — a suite-named skill like `commit-commands:commit` resolved to a different filename in each path and its cached compact never matched. A new `sanitizeSkillId()` helper replaces every colon with an underscore at all four sites ([src/skill_cache.ts](src/skill_cache.ts)), so every path agrees on one filename, with regression tests ([tests/skill_cache.test.ts](tests/skill_cache.test.ts)).

## [2.2.3] - 2026-06-28

This is a significant correctness release. The migration off the original Python implementation to TypeScript left several core components unwired in the shipped binary while the unit suite stayed green. The background worker drained the dirty queue into a stub, so the `symbols` table was never written and the real parser was tree-shaken out of the bundle; `refs` returned `[]` and its command was never registered; `semantic` always reported no matches because its FTS query aliased the virtual table; `index` stored relative path keys that no reader could match; and `exports`, `imports`, `find`, `grep`, and `web-output` were implemented but never wired into the CLI. Every surgical-read and index-backed command is now reconnected end to end. New structural guards make this class of failure fail the build instead of shipping silently: a data-driven CLI registration guard runs in a fast pre-commit tier, and a built-bundle command matrix runs every registered command against the shipped artifact at pre-push and in CI.

### Added

- **`token-goat refs <file::symbol> --callers` now resolves real callers.** The `refs` table and the `refs` / `--callers` command shipped, but `parseFile` returned `refs: []` by design (a port stub carried over from the Python→TS migration) and the `refs` subcommand was never registered on the CLI, so the table stayed empty and the command did not exist. Reference extraction is now wired through the real indexer write path ([src/parser.ts](src/parser.ts)): a single tree-sitter walk per file captures call-site references — bare calls (`foo()`), member/selector/method calls (`obj.foo()` → `foo`), Rust macros, and `new`/constructor calls — and records each one's callee, line, column, and enclosing function/method/class symbol (stored in the `refs.context` column) so `--callers` groups usages by the symbol that contains them. References with a resolved enclosing caller are produced for every bundled tree-sitter grammar — TypeScript, JavaScript, Python, Go, Rust, Java, C, and Ruby — including C/C++ functions, whose name lives in a nested `declarator` chain rather than a `name` field. C++ source falls back to the regex extractor (no `tree-sitter-cpp` grammar is bundled), so it yields no references until that grammar is added; the C/C++ caller resolver is already in place for when it is. The `refs` command is registered in [src/cli.ts](src/cli.ts) and reads back through [src/index_reader.ts](src/index_reader.ts). Regression tests prove the failing→passing transition at the parser level, drive the real no-callback worker drain path ([tests/worker.test.ts](tests/worker.test.ts)), and run `refs --callers` against the built `dist/token-goat.mjs` bundle ([tests/worker_index_e2e.test.ts](tests/worker_index_e2e.test.ts)) so the walker cannot be silently tree-shaken out of the shipped artifact.

- **`token-goat index [path]` rebuilds the whole symbol index.** The background worker only indexed files incrementally as they were edited, so a fresh install (or any project not touched since install) had an empty index and `symbol`, `read "file::symbol"`, `skeleton`, `outline`, and `map` all returned nothing. The new command walks every git-tracked source file via `git ls-files` and parses it into the index in one pass, so the index is populated immediately. Implemented in [src/cli.ts](src/cli.ts) on top of the shared synchronous indexer in [src/parser.ts](src/parser.ts).

- **Wired `serve_diff_on_reread` for source, style, and data files.** The opt-in flag (`TOKEN_GOAT_SERVE_DIFF_ON_REREAD=1` or `[hints] serve_diff_on_reread = true`) previously affected only docs, despite being advertised for changed files generally. It now extends diff-on-reread to `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.scss`, `.json`, `.py`, `.go`, `.rs`, `.yaml`, `.toml`, and 15+ other source/style/data extensions: a re-read of a changed file injects a compact unified diff (with an extension-aware surgical-read hint — `token-goat read ::Symbol` for code, `token-goat section` for structured files) instead of the full file, and an unchanged file returns a one-line note. A savings guard skips the diff when it would exceed 60% of the file (e.g. minified single-line JS/CSS/JSON), falling through to the existing re-read denial. Files over 256 KB are never snapshotted. Default remains OFF, preserving the flat-deny behavior for anyone who has not opted in; docs (`.md`/`.mdx`/`.rst`/`.txt`) continue to diff by default.

- **Registered four implemented-but-unreachable commands and made them functional: `exports`, `imports`, `find`, `grep`.** These handlers existed in [src/read_commands.ts](src/read_commands.ts) but were never wired into the Commander dispatcher, so the commands did not exist on the CLI — the same `refs`-style gap. They are now registered in [src/cli.ts](src/cli.ts). Two were also non-functional as written: `imports` queried the symbol index for `kind: 'import'` rows that the tree-sitter indexer never persists (always empty), and `exports` filtered on symbol bodies starting with `export`, but the indexer stores a symbol's body from its inner declaration (`function`/`class`), not the `export` modifier on the parent statement (always empty for real TS/JS). `imports` now extracts module specifiers directly from source (TS/JS `import`/`require`/dynamic-`import`/re-export, Python, Go blocks, Rust `use`, Java, C/C++ `#include`), and `exports` combines the index heuristic with a source scan so it reports real exports for TS/JS, Python, Rust, Java, and Go. Helpers `extractImports`/`extractExportNames` are unit-tested per language.
- **Registered `token-goat web-output <id>`.** The WebFetch-response recall command was referenced by the overflow guard's recall-command list but had no CLI registration, so the documented `web-output` command did not exist. It now mirrors `bash-output` (`--head`/`--tail`/`--grep`) over the in-process web cache in [src/cli.ts](src/cli.ts).
- **Added a data-driven CLI registration guard.** [tests/guards/cli_registration.test.ts](tests/guards/cli_registration.test.ts) introspects `buildProgram()` and the cli.ts source: every `cmd*` handler must be referenced by an `.action(...)`, every user-facing command (including the four above and `web-output`) must be registered, each must appear in `--help`, and each must carry a description. New commands are covered automatically, so an unregistered handler fails the suite. Built-bundle smoke tests in [tests/worker_index_e2e.test.ts](tests/worker_index_e2e.test.ts) run `exports`/`imports`/`find`/`web-output` against `dist/token-goat.mjs`.

- **Layered the command-coverage tests and added a built-bundle command matrix.** The fast registration guard now lives in a pre-commit `tests/guards/` tier (`npm run test:guards`, ~2s, no bundle build / DB / git fixtures) wired into lefthook after lint and typecheck, so an implemented-but-unregistered or unfunctional command fails before the commit lands. A new pre-push/CI matrix ([tests/command_matrix_e2e.test.ts](tests/command_matrix_e2e.test.ts)) indexes one git fixture against the shipped `dist/token-goat.mjs` and runs every registered command, asserting real output. Both tiers derive their command set from a single helper ([tests/registry.ts](tests/registry.ts)), so a newly registered command with no matrix case fails the coverage gate automatically — there is no second list to maintain. This matrix is what surfaced the `semantic` FTS bug above.

### Changed

- **Consolidated the two parallel read-command surfaces onto a single source of truth.** The surgical-read commands existed twice: native handlers in [src/cli.ts](src/cli.ts) and a complete parallel set of `run*` functions in [src/read_commands.ts](src/read_commands.ts) that had zero non-test callers and was never bundled. The Commander actions for `symbol`, `read`, `section`, `refs`, `skeleton`, `outline`, `changed`, and `config-get` now delegate to the `read_commands.ts` `run*` functions, so there is one implementation of each. cli.ts keeps only the thin option-mapping adapter and the handlers with no `read_commands` twin (`semantic`, `index`, `map`, worker/install/doctor/etc.). To avoid regressing the richer native output, the cli-only niceties were ported into `read_commands`: `runSymbol` now prints a header plus a five-line body preview, `runRead` regained the path-suffix fallback for partial paths, `runSection` regained its `# heading — file:range` header, the caller grouping regained its `(module scope)` label, and `runChanged` was aligned to the shipped semantics (default `HEAD~5`, flat file list, `name (kind) — file:line` symbol lines). As a side effect, the consolidated commands gain `--json` (and `--min-lines` for `skeleton`/`outline`) uniformly. A `runChanged` unit test closes the gap left by the rewrite.

### Fixed
- **`token-goat semantic <query>` now returns matches.** The FTS5 fallback search aliased the `symbols_fts` virtual table (`FROM symbols_fts f … WHERE f MATCH ?`), but SQLite’s `MATCH` operator and `bm25()` must name the FTS table directly — the alias resolves as a bare column reference, raising `no such column: f`, which the function’s `catch` silently swallowed. Every `semantic` query therefore returned “no matches” regardless of what was indexed, even though `symbol` found the same rows. The query now references `symbols_fts` directly in [src/index_reader.ts](src/index_reader.ts). The pre-existing unit test masked the regression by asserting correctness only `if (hits.length > 0)` (rationalized as “FTS5 may be unavailable”); it now asserts a non-empty hit whenever the FTS mirror exists ([tests/index_reader.test.ts](tests/index_reader.test.ts)), and the built-bundle command matrix exercises `semantic` end-to-end.
- **`token-goat config-get <file> <key>` now reads the named file.** The shipped handler ignored its `file` argument entirely and queried token-goat's own loaded configuration via `loadConfig()`, so the documented call `config-get pyproject.toml project.version` never read `pyproject.toml` — it returned token-goat config (almost always "key not found"). The command now routes through `runConfigGet` in [src/read_commands.ts](src/read_commands.ts), which parses the actual file (JSON natively, with a line-based fallback for TOML/YAML/INI) and navigates the dotted key.

- **`token-goat index .` (a relative root) now produces a queryable index.** `cmdIndex` keyed each file with `normalizePath(f)`, where `f` came from `getTrackedFiles` as `path.join(root, rel)`. With the natural relative root (`token-goat index .`), `f` stayed relative, so symbol rows were stored under a relative key (`src/worker.ts`) while every reader resolves to the absolute-normalized key via `resolveIndexPath` — making the whole index unreachable: `index .` followed by `skeleton src/worker.ts` returned "not indexed". `cmdIndex` now resolves each file through the same `resolveIndexPath` helper before indexing ([src/cli.ts](src/cli.ts)), so the write key matches the read key byte-for-byte for relative, subdirectory, and absolute roots alike. A built-bundle regression ([tests/worker_index_e2e.test.ts](tests/worker_index_e2e.test.ts)) runs `index .` inside a fixture repo, opens the DB to assert the stored `file_path` is the absolute-normalized key, and proves a relative reader query resolves non-empty.

- **Index-backed read commands now resolve relative and Windows-style paths.** Every symbol row is keyed by the absolute normalized path (`normalizePath(absolute)`), but `skeleton`, `outline`, `read`, `refs`, `imports`, and `changed --symbol` queried by the raw path the user typed. Because the lookup is exact equality (`file_path = ?`), the documented relative-path interface (`token-goat skeleton src/worker.ts`, `read "src/worker.ts::drainOnce"`) silently returned "not indexed" even when the index was fully populated, and a backslash path (`src\worker.ts`) never matched at all. A single shared resolver — `resolveIndexPath(file)` in [src/paths.ts](src/paths.ts) — converts user input to the stored key form before every query, so relative, `./`-prefixed, backslash, and absolute paths all resolve to the same row across platforms. Routed through every query site in [src/cli.ts](src/cli.ts) and [src/read_commands.ts](src/read_commands.ts), including a `changed` site that previously used `path.resolve` without normalization. Per-command regression tests cover read, skeleton, and outline with a Windows backslash variant.

- **The background indexer now actually writes to the symbol index.** `runWorkerLoop` and the daemon polling loop called `drainOnce(dir)` with no index callback, so the drain path fell through to a stub that wrote `would index: <path>` to discarded stderr and never touched the database. Nothing was ever inserted into `symbols`, the real parser was tree-shaken out of the esbuild bundle as dead code, and every surgical read (`symbol`, `read`, `skeleton`, `outline`, `semantic`) plus read-dedup silently returned an empty index. The drain path now parses each changed file and writes its rows via a shared synchronous indexer (`indexFileSync` in [src/parser.ts](src/parser.ts)), wired in through [src/worker.ts](src/worker.ts). A regression test drives the real no-callback default path end-to-end, and a bundle smoke test runs the built `dist/token-goat.mjs` so a parser missing from the shipped artifact is caught.

- **YAML and TOML kebab-case keys are now indexed.** The symbol extractors used `[a-zA-Z_]\w*`, which excludes hyphens, so common kebab-case keys (`runs-on:` in CI YAML, `my-key = 1` as a TOML bare key) were never indexed and `token-goat section "file.yml::runs-on"` returned nothing. The key pattern now accepts hyphens after the first character, so these keys resolve; YAML list items (`- foo:`) and document markers (`---`) are still correctly ignored.

- **`token-goat read` resolves 3+ part dotted symbols to the leaf.** A spec like `file::Outer.Inner.method` split on `.` and looked up the middle segment (`Inner`), resolving to the inner class instead of the method and returning the wrong symbol body. The lookup now uses the last dotted segment, so the method is found; the common two-part `Class.method` case is unchanged.

- **Git-diff truncation marker names the file cleanly.** When a large `git diff` was capped at 50 lines per file, the `[... N more lines in <name>]` marker showed the doubled header tail (`a/src/file.ts b/src/file.ts`) as the filename. It now shows the path once (`src/file.ts`), parsed by splitting on ` b/` so paths containing spaces survive.

### Docs

- Rewrote [CLAUDE.arch.md](CLAUDE.arch.md) to accurately describe the current TypeScript codebase (all Python references removed; new Data Flow and Adding a New Command sections added).

## [2.2.2] - 2026-06-27

### Added

- **Build/monitoring output cache keyed on base command, ignoring pipes and redirects.** Running the same jest/tsc/pytest/`gh run view` command a second time with a different trailing pipe (e.g., `| tail -40` vs `| grep "●"`) now hits the cache instead of re-executing. A `stripOutputPipeline` pass strips everything from the first top-level unquoted `|` and removes trailing stream redirections (`2>&1`, `>/dev/null`), quote-aware so `--testPathPattern="a|b"` and `||` are never misidentified as pipes. Applied at both the store site (`postBashHandler`) and all recall lookups. curl’s URL-based keying is unchanged.
- **PowerShell system-query recall.** `Get-CimInstance`, `Get-Process`, `Get-Counter`, `Get-Service`, `Get-PSDrive`, and `Get-WmiObject` commands run via `powershell.exe`/`pwsh` are now registered as monitoring commands. Output is cached after the first run and a `token-goat bash-output <id> --tail 50` recall hint is emitted on repeats.
- **`token-goat section`/`outline`/`symbol` repeat recall.** Running the same `token-goat section "FILE::Heading"`, `outline FILE`, or `symbol NAME` command a second time in a session now emits a bash-output recall hint instead of re-executing.

## [2.2.1] - 2026-06-27

### Added

- **`cd DIR && CMD` prefix stripping for all pre-bash interceptors.** Strips one or more leading `cd <dir> &&` prefixes before routing, so commands like `cd /projects/app && cat src/auth.ts` are correctly intercepted. Previously the `^`-anchored regexes never matched cd-prefixed commands.
- **`cd`-prefixed build command recall.** `postBashHandler` now applies the same prefix strip before storing cached output, so commands like `cd C:/projects/app && npx tsc --noEmit` produce recall hints on repeat runs.
- **`npx tsc` build and monitoring recall.** `BUILD_COMMAND_PATTERNS` now matches `npx tsc` in addition to bare `tsc`, and a `MONITORING_COMMAND_PATTERNS` entry emits a targeted `--grep` recall hint for TypeScript compiler output.
- **`ls DIR | grep`/`| wc -l` → `token-goat map` hint.** Piped directory listing patterns now trigger the map hint.
- **`for f in ...; do wc -l` → `token-goat outline` hint.** For-loop file-size probes redirect to `token-goat outline` for symbol names and line counts.
- **`node scripts/*.mjs`/`node src/scripts/*.js` monitoring recall.** Node.js script runner invocations register as monitoring commands with targeted recall hints.

### Fixed

- **`tsc-watch` false positive.** `BUILD_COMMAND_PATTERNS` used `\b` after `tsc` which matched `tsc-watch`. Fixed to `(?:\s|$)`.
- **Path hints for cd-prefixed source file reads.** When a `cd DIR &&` prefix is stripped, path-sensitive hints (cat, WSL cat, python open, node readFileSync) now emit `contextOutput` instead of `denyOutput` to avoid suggesting paths relative to the wrong directory.
- **`npx tsc` recallHint trailing space and unbalanced quote** cleaned up.

## [2.2.0] - 2026-06-27

### Added

- **Count-based hard-deny for repeated source file reads.** On the 3rd or later read of the same `.ts`/`.tsx`/`.js`/`.jsx`/`.py`/`.go`/`.rs`/`.java`/`.rb`/`.php`/`.swift`/`.kt`/`.cpp`/`.c`/`.h` file in a session, the pre-read hook returns a hard deny with a message to use `token-goat read`, `skeleton`, or `outline` instead. First read is always allowed; second gets a soft context hint; third and beyond are hard-denied. Records a `read_count_deny` stat.

- **Identifier grep on a single source file → `token-goat symbol` hint.** `extractRgSymbolSearch` detects `rg`/`grep -n "Identifier"` or `rg "Id1|Id2|Id3"` when targeting exactly one indexed source file (pattern must be a pure identifier or `|`-joined identifier alternation, no regex metacharacters). Emits a contextOutput suggesting `token-goat symbol <Identifier>` to jump straight to the definition.

- **Python heredoc reads caught.** The `python3 - << 'HEREDOC'` form is now parsed by `extractPythonFileRead` — the heredoc body is scanned for `open(path)` calls, with the same write-mode exclusion (`.write()`/`.writelines()`) applied.

- **`.sql` files intercepted in cat hooks.** `cat migration.sql` and WSL-proxied equivalents emit a contextOutput suggesting `token-goat section "file.sql::table_name"` to pull a single `CREATE TABLE`/`CREATE TYPE` block.

- **Section heading normalization.** `token-goat section` now normalizes both the query and stored headings before matching: em/en-dashes to hyphen, trailing parentheticals stripped, leading `N. ` numeric prefixes stripped. On a miss, the complete ordered heading list is printed instead of a top-5 "Did you mean?".

- **Markdown heading grep → `token-goat outline` hint.** `extractMarkdownHeadingGrep` detects `grep -n "^#"` / `rg -n "^#+"` on `.md` files and suggests `token-goat outline <file>` followed by `token-goat section "file::Heading"`. Wired before `extractRgStructuralSearch` so heading patterns do not misdirect to symbol search.

- **Session artifact re-read dedup.** `tasks/<id>.output` and `tool-results/<id>.txt` files under `.claude/` and AppData session directories are tracked through the diff-or-deny path: first read snapshots content; re-read with changed content injects a unified diff; re-read unchanged denies with a one-line note. First reads of large artifacts hint `--tail`/`--grep` recall.

- **`eza --tree`, bare `tree`, and `ls -R` → `token-goat map` hint.** `extractDirectoryListing` now covers three additional directory-tree idioms alongside the existing `eza --long` match.

- **`grep | grep` double-filter chain hint.** `extractGrepPipeChain` detects `grep ... | grep ...` / `rg ... | grep ...` pipelines and suggests collapsing to `rg -e PAT1 -e PAT2`, or using `token-goat refs`/`semantic` for symbol discovery. Does not fire on `grep | wc`, `grep | head`, or other non-grep consumers.

- **curl GET cache keyed on URL.** `curl -s <url> | jq '...'` and `curl -s <url> | python3 -c '...'` with the same URL now share a cache entry regardless of the downstream pipeline — the pipe is stripped before fingerprinting.

- **Doc-file diff-on-reread.** When a previously-read `.md`/`.mdx`/`.rst`/`.txt` file has changed since the last read, the pre-read hook serves a compact unified diff rather than the full file. When unchanged, a one-line note is served.

- **`curl -o <file>` download dedup.** `extractCurlDownload` records URL to saved-path after each file download; a repeat fetch of the same URL emits a recall hint pointing at the already-saved file, covering different temp-file names for the same URL.

- **`cat <config>.json | jq` pipeline → `config-get`/`section` hint.** `extractCatJsonPipe` detects `cat *.json | jq` (and `bat`/`python`/`node` consumers) on JSON config files and suggests the appropriate surgical-read command.

- **`node require('*.json')` inline reads intercepted.** `extractNodeFileRead` extended to match `require('path/config.json')` patterns in `node -e` evaluations.

- **`cat *.css`/`*.scss`/`*.sass`/`*.less` intercepted.** CSS and preprocessor source files now trigger the surgical-read hint alongside JS/TS/Python/Go.

- **`curl GET` response caching and recall.** Successful curl GET responses stored in the session store by URL; a repeat fetch emits a `token-goat bash-output <id>` recall hint.

- **`.md` re-read denial.** All `.md` files are denied on 2nd+ access regardless of size, including a distinct path for files under `memory/` and `.claude/memory` directories.

- **`find` command interception.** Bare `find . -name "*.ts"` and similar patterns redirect to `fd` or `token-goat symbol`.

- **git diff compression.** `bash_compress.ts` caps large git diff outputs to 50 lines per file hunk.

### Fixed

- **Python write-mode false-deny.** `extractPythonFileRead` no longer intercepts scripts containing `open('file', 'w')`, `open(..., 'a')`, `.write(`, or `.writelines(`.

- **tail -c byte-mode reads.** `tail -c 1024 tasks/foo.output` (byte-count mode) is now correctly intercepted.

- **cat with flags.** `cat -n`, `cat -A`, and other flag variants recognized correctly.

- **WSL-proxied cat reads.** `wsl -d Ubuntu -- cat /mnt/c/...` patterns resolve to the Windows path and trigger the appropriate interceptor.

- **Security hardening.** Shell injection via unquoted path interpolation, path traversal through symlink resolution, and FIFO read-blocking vectors in hook handlers patched.

- **Windows mkdirSync race.** `EEXIST` race condition on Windows guarded with retry + `path.exists()` fallback.

- **Multiple CLI and embedding fixes.** Elision threshold off-by-one, compact slice direction, head default line count, write-file validation for `TOKEN_GOAT_MAX_STDIN_MB`, embedding chunks metadata, vector rowid correlation, `deleteFileEmbeddings`, CRLF in Windows chunks, null-guard fixes in `ask`, `capAnswer`, and `pack`.

### Refactored (internal)

- `shortFingerprint`, `ensureNewline`, `extractErrorMessage`, and `isCodeFenceDelimiter` extracted as shared helpers, eliminating call-site duplication.
- Config defaults, command predicate functions, and platform detection consolidated.

## [2.1.0] - 2026-06-26

### Added

- **Pre-bash file-read interception.** The bash hook now intercepts `cat`, `cat -n` (and other flags), `cat` via WSL paths, `python -c "..."`, `head`, `tail`, and `node -e "readFileSync()"` on source files. Each pattern rewrites the command to a `token-goat read` call. 8 pre-bash interceptors total.

- **`rg` structural search hint.** When `rg` is run without content flags on a source directory, the bash hook redirects to `token-goat symbol` or `token-goat semantic`, cutting typical output by 90%+.

- **Orchestrator state file exemption.** `.improve-state-*.json`, `.claude/` session files, and similar tool-internal state files are excluded from re-read denial.

- **`src/filter_counts.ts` — maintainable count exports.** Exports `TOTAL_FILTER_COUNT` plus per-category counts for all hook types. Dynamic counts update automatically when source arrays grow; static counts carry comments pointing to the source module. `src/hints/lang_patterns.ts` now also exports four count constants (`LOCK_FILE_COUNT`, `MANIFEST_FILE_COUNT`, `BUILD_DIR_COUNT`, `GENERATED_EXT_COUNT`).

### Fixed

- **Re-read denial for small files.** Small source files (under 5 KB) are now denied on a 3rd+ access within the same session, preventing repeated micro-reads of shared utility modules.

- **`.env` and SQL file reads denied after first access.** Credentials and schema files now deny on second access.

- **Config file bash hints corrected.** Config files now suggest `token-goat section` rather than `token-goat read` in hint text.

## [2.0.3] - 2026-06-26

### Fixed

- **`stats` recording restored end-to-end.** The TypeScript rewrite had ported only the read/display side of stat recording; the write side was silently missing since 2026-06-25. `recordStat()` is now implemented in `stats.ts` and wired into all four hook handlers (`hooks_read.ts`, `hooks_bash.ts`, `hooks_fetch.ts`, `hooks_skill.ts`). Recorded rows now also carry real `bytes_saved` / `tokens_saved` values (file size and bytes/4) instead of defaulting to zero.

- **`git_history.ts` hunk line counts overcounted.** The `@@ -L,N +L,N @@` header N values (which include context lines) were used directly as `linesAdded`/`linesRemoved`. The parser now counts actual +/- prefixed body lines, giving accurate per-symbol change counts.

- **`git_history.ts` hunk loop broke early on diff content starting with `+++`/`---`.** A bare `hunkLine.startsWith('+++')` guard would prematurely exit the hunk body when a file contained lines whose content began with `++` or `--`. Guard now matches exact git file-header prefixes (`+++ b/`, `+++ /dev/null`, `--- a/`, `--- /dev/null`).

- **`parser.ts` symbol line ranges used the parent declaration node instead of the child declarator.** Multi-declarator `const x = 1, y = 2` statements reported each variable's range as the whole declaration span instead of the individual `variable_declarator` child node's span.

- **`parser.ts` JSON property extraction missed top-level keys whose values opened a nested object on the same line.** The `braceDepth` check captured depth after processing the line, so a key like `"nested": {` was recorded at depth 1 (inside the nested object) rather than depth 0 (top-level).

- **`embeddings.ts` left `\r` in chunks on Windows CRLF content.** `raw.split('\n')` produced chunks with trailing carriage returns. Changed to `raw.split(/\r?\n/)`.

- **`hooks_cli.ts` suppressed non-`Error` thrown values in catch blocks.** The `instanceof Error` check silently swallowed string errors, rejected Promises, and other thrown values.

- **`read_commands.ts` `skeleton()` reported the wrong final line number when `--min-lines` was active.** The function used the unfiltered symbol array's last element for the total line count even after `--min-lines` had reduced the set, producing a count larger than the visible output.

- **Event listener leaks on stdin and `parentPort`.** `readStdin()` in `hooks_cli.ts` and the stdin mode of `cmdWriteFile()` in `cli.ts` registered `data`/`end`/`error` listeners without ever removing them, leaking listeners across invocations. Named handler refs and a `cleanup()` call in all exit paths now prevent the leak. `worker.ts` `parentPort` message listener is removed when the `'stop'` message is received.

## [2.0.2-post] - 2026-06-26

### Fixed

- **`stripComments` treated backtick as a Python string delimiter instead of JS/TS.** The string-tracking branch in `code_compress.ts` had an inverted condition — `isPython && ch === '`'` — so backtick template literals in TypeScript/JavaScript were transparent to the comment stripper while Python (which has no backtick strings) got the tracking instead. Flipped to `!isPython` so JS/TS template literals are correctly treated as string boundaries.

- **`embeddings.ts` discarded all but the first merged hit's text.** `mergeNearbyHits` accumulated hits into one entry but never joined the text fields, causing semantic search results that spanned merged chunks to return only the first chunk's content. All merged texts are now accumulated and joined with a newline separator.

- **`gdrive.ts` used string `.length` for UTF-8 byte offsets.** `parseDocSections` computed byte offsets with `string.length` (UTF-8 code units), producing wrong offsets for any content containing non-ASCII characters. Replaced with `Buffer.byteLength`.

- **`worker.ts` debounce leaked timers.** The dirty-queue flush debounce set a new `setTimeout` on every event without clearing the previous one, allowing multiple concurrent flush callbacks. The old timer is now cleared before setting the new one.

- **`parser.ts` loaded tree-sitter-c grammar for C++ files.** The `cpp` branch in `loadGrammar` called `require('tree-sitter-c')` instead of `require('tree-sitter-cpp')`, causing all C++ source files to be parsed with the C grammar and missing C++-specific constructs (classes, templates, namespaces, lambda captures).

- **`mcp_cache.ts` path traversal check missed Windows backslash paths.** The traversal guard only checked forward-slash sequences (`../`), allowing `..\` to bypass the check on Windows. Both separators are now rejected.

- **`webfetch.ts` IP octet parsing skipped `Number.isFinite` validation.** `isPrivateIPv4` used `Number()` on split octets and applied range checks without first verifying the result was a finite number, so non-numeric segments (empty strings from malformed IPs) passed the integer range test.

- **`cli.ts` ANSI truncation operated on stripped string but returned offsets into the raw line.** `overflow_guard.ts` stripped ANSI codes, truncated the stripped result, then used that truncation point on the original raw string, producing malformed escape sequences in output. Truncation now operates consistently on the stripped form.

- **`skill_cache.ts` sliced at string code-unit boundaries, corrupting multi-byte characters.** Truncation used `string.slice`, which counts JavaScript code units not bytes. Replaced with `Buffer.slice` so the cut falls on valid UTF-8 byte boundaries.

- **`git_history.ts` crashed on empty `runGit` stdout.** `getRecentCommits` did not guard against empty output from `runGit`, attempting to parse an empty string into commit entries. An early-return guard is now in place.

- **`git_history.ts` used `indexOf(':')` for symbol separator, breaking filenames with colons.** The colon-split that separates a file path from its symbol used `indexOf`, picking the first colon in paths like `C:\Projects\...`. Changed to `lastIndexOf` so only the final colon (the actual separator) is used.

- **`hints.ts` called `substring` on a `-1` return from `lastIndexOf`.** When a file path had no extension, `lastIndexOf('.')` returned `-1` and `substring(-1)` returned content from the end of the string. A guard now skips the extension check when no dot is found.

- **`bash_compress.ts` off-by-one in tail output.** The `tailKeep` calculation caused the tail section to include one extra line, exceeding `maxLines` by one. Corrected the index arithmetic.

- **`pack.ts` table and XML document index numbering.** `formatMarkdown` reset the row counter from the loop index rather than an independent counter, causing gaps when entries were falsy. `formatXml` hardcoded `result.files.length + 1` as the document index for the first file, always emitting index 1 regardless of previous entries.

- **`cli.ts` `--head`/`--tail` NaN propagation.** Invalid or missing values from `parseInt` were used directly in array slicing without an `Number.isFinite` check, silently producing empty output when malformed values produced `NaN`.

- **`memory_prune.ts` serialized `undefined` into reconstructed lines.** A missing nullish-coalescing guard caused `undefined` to be concatenated into the output string when a line segment was absent.

## [2.0.2] - 2026-06-26

### Added

- **git diff and npm run monitoring recall patterns.** `git diff HEAD`, `git diff`, and `git diff --cached` now trigger bash-output recall hints when prior output is cached (full diffs can be many KB; `git diff --stat` is excluded as it produces small output). `npm run test`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm run check`, and `npm run spec` are now covered by monitoring recall — these invoke vitest/eslint/tsc under the hood but weren't matched by the direct-invocation patterns.

- **codex and glm.sh monitoring recall patterns.** `codex exec` and `~/.claude/bin/glm.sh` invocations are now tracked as monitoring commands; when prior output is cached and exceeds 2 KB, a recall pointer is injected.

- **cat source-file recall hint.** Repeated `cat <file>` calls on source files now emit a `token-goat read 'file::Symbol'` suggestion rather than a generic shell recall hint.

### Fixed

- **post_tool_use Bash hook was missing.** `getBashOutputId` always returned null in production because the Bash post-hook was never registered, silently disabling all monitoring and build recall hints. The hook is now wired up and bash output caching works end-to-end.

## [2.0.1] - 2026-06-25

### Added

- **Language-agnostic read-suppression and build-tool recall pattern table.** `src/hints/lang_patterns.ts` adds a data-driven table covering 13 lock-file types (pre-read deny + section offer), 16 manifest/config types (section/config-get nudge on re-read), generated build-output directories (read suppression), and 12 build-tool stdout patterns (bash-output recall). The table is the single source of truth consumed by the pre-read and pre-bash hooks.

- **npm-specific hook improvements.** `package-lock.json` triggers a pre-read deny with a `token-goat section` offer; `node_modules/` reads are suppressed; `package.json` re-reads emit a section/config-get nudge; `npm install`, `npm test`, `npm run`, `npm ci`, and `npm audit` stdout is cached and recalled via `bash-output --grep`.

- **TypeScript and JavaScript hook patterns.** `tsconfig.json` section hint on re-read; `.d.ts` files in `dist/` suppressed; `tsc`/`tsc --watch` and Vite/esbuild/webpack build output cached; vitest/jest output cached with `--grep FAIL`; `dist/`, `out/`, `.next/`, `.nuxt/`, `build/` directories suppressed; `*.min.js` and `*.bundle.js` files suppressed.

- **Process-monitoring command recall hints.** Pre-bash intercept for repeated monitoring commands: `gh run watch/view`, `gh run view --log`, `gh pr checks`, next dev/build, vite, nuxt dev, vitest/jest watch, pytest, cargo test, go test, docker logs, nodemon, air, cargo watch, watchexec, eslint, prettier, ruff, clippy. When a prior run is cached and its output exceeds 2 KB, a recall pointer is injected instead of re-running the command.

- **Large markdown file interception with heading-tree hints.** Markdown files ≥ 8 KB with three or more headings are intercepted on pre-read (block: true). The hook extracts ATX H1–H3 headings (capped at 40), formats a heading tree with `#2`/`#3` disambiguation suffixes, and injects it with `token-goat section` shortcuts. Well-known files (README.md, CHANGELOG.md, CONTRIBUTING.md, CLAUDE.md, CLAUDE.arch.md) receive pre-populated section shortcuts. Post-edit on markdown files injects a `token-goat section` re-read suggestion.

- **Universal large-file interception for PDF, HTML, TXT, Office, and CSV files.** `src/hints/file_type_handler.ts` dispatches on extension. PDF and Office binaries (.docx/.xlsx/.pptx/.odt/.ods) are fully blocked with pandoc/docx2txt extraction suggestions. HTML ≥ 50 KB is intercepted with title + heading index; minified HTML is flagged. TXT/log files ≥ 20 KB show line count plus first/last five lines with head/tail/grep offers. CSV/TSV ≥ 10 KB shows column headers, row count, and three sample rows with a DuckDB suggestion. Any file ≥ 100 KB hits a generic catch-all with byte/line count.

### Fixed

- **(921ffab) parseInt radix, YAML frontmatter close regex, ANSI strip scope.** `parseInt(env, 10)` in `ask.ts` prevents octal interpretation on leading-zero values. `memory_prune.ts` tightens the frontmatter closing delimiter from bare `indexOf('\n---')` to `/\n---(?:\n|$)/` so `\n---extra` lines no longer terminate frontmatter early. `overflow_guard.ts` replaces the SGR-only local `stripAnsi` with the full-coverage `stripAnsiCodes` from `bash_compress.ts`, which handles OSC, DCS, and cursor sequences.

- **(a4caffe) Falsy-zero timeout, missing maxHints guard, and hint suppressor logic.** `ask.ts` `parseTimeoutSecs()` replaces `parseInt(env) || DEFAULT` so a timeout of `"0"` is honoured rather than treated as falsy. `hints.ts` adds an early-return guard for `maxHints <= 0`. `buildIndexOnlyFileHint`, `buildStructuredFileHint`, and `buildPackageManifestHint` change `hasOffset && hasLimit` to `hasOffset || hasLimit` so a read with only offset (or only limit) also suppresses the hint. Ten regression tests added.

## [2.0.0] - 2026-06-25

### Changed

- **Full migration to TypeScript; published to npm.** The entire codebase has been ported to TypeScript and promoted to the repository root. The Python source and PyPI package have been retired. Install via `npm install -g token-goat`.

### Fixed

- **(76f4eab) TypeScript port correctness fixes.** `findIndex` out-of-bounds check, compact token count divisor, and method lookup corrected in the TS port.
- **(75a5b16) TypeScript atomic write and sort fixes.** `atomicWriteCore` temp file leak plugged; undefined key output and sort key mismatch corrected.
- **(7c5dccf) TypeScript hint dedup and line-count fixes.** Dup-hint summary overwrite and line count off-by-one corrected.
- **(8182789) TypeScript token estimation and heading detection fixes.** Per-entry token rounding corrected, code-fence heading detection improved, and unnecessary type assertions removed.

## [1.9.9] - 2026-06-24

### Added

- **Close-match auto-redirect for `token-goat section`.** A heading lookup that misses now mirrors the `symbol` command: when exactly one indexed heading is a high-confidence match (difflib ratio ≥ 0.75, or the query is a clean substring/prefix of a single heading), the section is served transparently with a `(redirected from: …)` marker (and a `redirected_from` field in `--json`). Ambiguous or low-confidence misses still list "Did you mean" suggestions, now annotated with their similarity scores. This keeps the agent on the surgical-read path instead of falling back to a full-file Read on a paraphrased heading.

- **Grep-on-sidecar `bash-output --grep` hint.** When the Grep tool targets a cached tool/task sidecar (`tool-results/<id>.txt` or `tasks/<id>.output`), the pre-Grep hook now emits an advisory suggesting `token-goat bash-output <id> --grep "<pattern>"`, which filters the cached copy without loading the full file into Grep context. Advisory only — never blocks the Grep. Deduplicated by `(id, pattern)` so a new pattern on the same sidecar still surfaces. Complements the existing Read-path sidecar hint.

- **`gh api` scope-error and large-JSON hints.** After any `gh api` command, the post-bash hook checks stdout for GitHub permission error phrases ("Must have push access", "Resource not accessible by integration", "Must be an admin") and for non-zero exits on security endpoints (`/security_advisories`, `/advisories`, `security_events`). When either fires, a system message suggests `gh auth refresh -s security_events`. A separate hint fires when the JSON response is a dict with 15 or more keys, recommending `--jq` filtering.

- **`gh api` URL field stripping in bash compress.** The `gh` compress filter now strips boilerplate `*_url` fields from `gh api` JSON responses — `followers_url`, `gists_url`, `starred_url`, and about a dozen others. Four fields are preserved: `html_url`, `avatar_url`, `clone_url`, `ssh_url`. The noise keys `gravatar_id` and `site_admin` are also removed. A stripped-count note is appended to the output. User and repo objects typically shrink 60–80%.

- **Bash `cat`/`bat`/`type`/`Get-Content` → surgical-read hint.** When a Bash command reads an entire source file (`cat src/auth.py`, `bat module.ts`, `Get-Content config.py`) and the file is in the project index, the pre-Bash hook emits an advisory suggesting `token-goat read "file::Symbol"`, `skeleton`, or `section` — whichever fits the file type. Covers `cat`, `bat`, `batcat`, `type`, and PowerShell `Get-Content`/`gc`. Advisory only; never blocks the command. Deduplicated per file per session.

- **Bash `grep -r`/`rg`/`find` → semantic-search hint.** When a Bash command runs a recursive code search (`grep -rn pattern src/`, `rg getUserById`, `find . -name "*.py"`), the pre-Bash hook suggests `token-goat symbol <name>` and `token-goat semantic "<query>"` as indexed alternatives. The existing hint covers repeated grep runs; this one fires on initial searches and routes toward the symbol index instead of a full directory walk.

- **Read-path sidecar hint for cached tool/task output files.** When the Read tool targets a Claude Code sidecar file (`tool-results/<id>.txt` or `tasks/<id>.output`), the pre-Read hook emits an advisory suggesting `token-goat bash-output <id> --tail N` / `--grep PATTERN` / `--section H`. The sidecar filename stem is the output ID. Advisory only, deduplicated per path per session.

- **`serve_diff_on_reread` advisory hint.** When a file that was previously read and then edited in the same session is read again with `serve_diff_on_reread` currently disabled, the pre-Read hook emits a one-time advisory: enabling `TOKEN_GOAT_SERVE_DIFF_ON_REREAD=1` would inject a unified diff instead of the full re-read — typically 90% smaller. Fires at most once per path per session.

### Changed

- **Watchdog log shows elapsed ms, budget ms, and tuning hint.** The timeout log previously showed only the watchdog budget; it now shows the actual elapsed time too (`watchdog tripped after 342ms (budget: 300ms)`) and appends `Tune with TOKEN_GOAT_HOOK_TIMEOUT env var.`

### Fixed

- **Console window flash eliminated on Windows.** Hook calls previously spawned `tg-hook.cmd`, causing Windows to start `cmd.exe`; in Electron (which has no console), this produced a visible popup window on every hook invocation. `token-goat install` now writes `token-goat-hook.EXE` (a GUI-subsystem binary) to `settings.json` instead. Windows never allocates a console for GUI-subsystem processes. The `.cmd` wrapper remains as a fallback when the binary is absent.

- **Hook-command detection uses anchored regex.** The markers used to identify and strip token-goat hook entries from `settings.json` previously matched as plain substrings. A user hook at a path like `/my-tg-hook-config/tool` would be silently removed on reinstall or uninstall. All three markers (`token_goat`, `tg-hook`, `token-goat-hook`) now require a word/path boundary on both sides of the match, so hooks whose names merely contain a marker as part of a longer string are left alone.

- **Session read-cache normalizes path separators and drive-letter case.** The dedup cache backing "already read" hints and `serve_diff_on_reread` was keyed on the raw path string. On Windows, the same file read as `C:\Projects\foo.py` versus `C:/Projects/foo.py` (or via WSL as `/mnt/c/Projects/foo.py`) appeared as three distinct entries, disabling dedup. Paths are now canonicalized before they enter the cache — separators unified, drive letter lower-cased — so all three spellings unify to a single entry.

## [1.9.8] - 2026-06-23

### Fixed

- **TOCTOU double-stat race in `cmd_clean` session sweep.** The old list comprehension called `.stat()` twice per file (once for mtime, once for size), with no error handling between calls. A single `stat()` call now accumulates both values atomically, and `OSError` from concurrent file deletion is caught and skipped.

- **Missing-key guards in `bash_cache`, `compact`, and `paths`.** `bash_cache` now uses `isinstance` to guard the `exit_code` field before conversion instead of a bare dict access that raised `KeyError` on malformed entries. `compact` sidecar parsing uses `.get()` with safe defaults for `sha`, `fp`, and `ts` fields. `paths` catches `FileNotFoundError` explicitly alongside the existing `OSError`.

- **Graceful degradation logging in `arch.py` and `worker.py`.** `logging` is now imported at module level in `arch.py` via a named `_log` logger; the two `except Exception` blocks in cycle detection and DAG depth calculation log failures at DEBUG instead of silently swallowing them. `worker.py` wraps `executor.shutdown()` to prevent unexpected exceptions from propagating.

- **Redundant content-size marker removed from `web_cache.store_output`.** The added marker used pre-processing byte counts and duplicated the accurate `_TRUNC_MARKER` already injected by `truncate_tail_preserve`; removed to avoid misleading byte-count claims.

### Changed

- **WebFetch post-fetch pipeline deduplicates consecutive identical lines.** `_deduplicate_consecutive_lines()` collapses repeated lines (cookie banners, breadcrumbs, repeated CTAs) after HTML stripping, typically saving 5–15% additional tokens on fetched content. Failures are logged at DEBUG rather than silently swallowed.

- **Compact manifest excludes JSONL and task-state files.** Session transcripts and task-state files are no longer included — they change every session but carry no useful context for the model. A shared content-type helper now drives both the compact and hints modules.

- **Small-file hint threshold raised to 60 lines.** Files under 60 lines (up from 30) are treated as cheap direct reads; the suppression hint is no longer emitted for them, reducing noise on small utility modules.

- **mypy typecheck added to pre-commit.** `uv run mypy src` now runs alongside ruff lint on every staged `.py` file, catching type errors at commit time rather than accumulating until the pre-push full suite.

## [1.9.7] - 2026-06-22

### Added

- **Duplicate-heading disambiguation hint.** When `token-goat section` is called with a heading that appears more than once in a document, it now emits an inline hint showing the available indexed positions (e.g., `Setup#2`, `Setup#3`) so the caller can address the exact occurrence without re-reading the whole file.

- **`bash-output` and `web-output` handle empty or whitespace-only cached content.** Passing an empty string or a string of only whitespace to `--grep` or `--tail` no longer raises; both commands return an empty result rather than erroring.

- **`token-goat read` accepts `@N-M` line-range prefix.** The first windowed bash read on a file now emits a hint showing the `@N-M` syntax so the caller can request a narrower range on follow-up reads.

### Changed

- **Hook session updates are now batched.** Multiple hints emitted in a single hook cycle are flushed in one write rather than one per hint. The session file is not loaded at all when early-exit conditions eliminate all candidates before it is needed. The grep advisory is deferred past the early exits.

- **Hint config is loaded once per hint cycle.** `config.load()` is no longer called per-hint inside hot-path hint functions — the config object is loaded once at cycle start and passed through.

- **Hooks cache the path/symbol split and guard context-pressure on a null cache.** The split is computed once and reused; the context-pressure check no longer crashes when the session cache has not been populated yet.

- **Session hint eviction is batched; bash bonus scales with output size.** Eviction processes all stale entries in a single pass, and the bash-output savings bonus is proportional to actual output size rather than a flat value.

- Internal: extracted `strip_lower()` helper applied across 14 modules; consolidated `json.load` and `db.record_stat` boilerplate into shared helpers; removed dead `strip_bom()` and the `utf8_bytes` alias; inlined single-use `_tokens_from_bytes` and `_cost_file` helpers; named constants for falsy/truthy env-value sets; fast-tier tests mock file and DB I/O to cut local loop time.

### Fixed

- **`file::symbol` target splitting used the first `::` instead of the last.** All target-parsing sites in `read_commands.py` and in `hints.py` now use `rpartition`/`rsplit` to split on the last `::`. On Unix, file paths can legally contain `::`, so splitting on the first occurrence produced a wrong file path and a malformed symbol name.

- **`min_session_hint_savings_bytes` access raised `AttributeError` when the config attribute was absent.** `hints.py` now guards the access with `getattr`.

- **`token-goat config-get` emitted Python `True`/`False` for boolean values.** Output is now lowercase `true`/`false`, matching TOML and JSON conventions.

- **`token-goat skeleton` produced an inconsistent JSON object format and an inaccurate empty-file hint.** The JSON output now follows a uniform structure across all symbol kinds.

- **Dirty-queue byte-cap check in `worker.py` raced against concurrent writers.** The check now uses a single `try/except` around `os.path.getsize`, with `FileNotFoundError` distinguished from other `OSError` subtypes so each case is logged accurately.

- **`query_worker_status` swallowed exceptions silently.** Exception handlers now log at DEBUG level, and catch clauses are narrowed to the specific exception types they handle.

## [1.9.6] - 2026-06-21

### Added

- **Hermes Agent compatibility.** `token-goat install --hermes` confirms that hooks are active for Hermes-delegated Claude Code sessions and reports the result. `detect_harness()` now returns `"hermes"` when `HERMES_SESSION_ID` or `HERMES_HOME` is set, evaluated before the Claude Code check so the subprocess inheritance of `ANTHROPIC_API_KEY` does not mask it. `detect_installed_harnesses()` includes a `"hermes"` key. `--target hermes` and `--target all` are wired through `install_all` and `plan_install`.

- **Per-project timeout circuit-breaker.** When a project's index job times out three consecutive runs, the worker backs off exponentially: 2ⁿ minutes per attempt, capped at 8 hours. A persistently slow project no longer monopolizes a thread-pool slot on every worker tick. Back-off clears when the project is garbage-collected or the daemon restarts.

- **`token-goat project list/exclude/prune` — manage tracked projects from the CLI.** `project list` shows all indexed roots with file counts; roots on the blocklist appear tagged `[excluded]`. `project exclude <path>` writes the resolved absolute path to `[worker] blocked_roots` in `config.toml` — the worker skips it on the next daemon cycle. `project prune` drops roots that no longer exist on disk; `--dry-run` previews without touching the database. All three accept `--json`.

### Fixed

- **`_prune_stats_table()` crashed when the global DB was opened read-only.** It now catches `OperationalError` and logs at DEBUG, returning 0 instead of raising.

- **Bash cache flag sorting reordered value-taking flags.** A flag like `--output file` was treated as a standalone flag during sort, moving its value to the wrong position. The sort now guards against value-taking flags.

- **Watchdog globals in `hooks_common` were unguarded.** Concurrent hook firings could race on the watchdog thread and stop-event globals. Both are now protected with a `threading.Lock`.

- **Context advisory prefix produced `[CONTEXT ~90% full. /compact now. edits: 3]` — missing the `|` separator.** The hook now uses a unified list-join that inserts `|` between the advisory and summary parts, matching the documented format.

## [1.9.5] - 2026-06-21

### Added

- **`token-goat ask "<question>"` — out-of-band codebase Q&A (experimental).** Retrieves the relevant slices, synthesizes a short answer in token-goat's own process, and returns only that answer plus pointer-citations, so the primary model never pays for the slice bodies. When the `claude` CLI (Claude Code) is on PATH, ask synthesizes with Haiku, its cheapest tier, out of the box; `codex` falls back to its own configured default model. Set `TOKEN_GOAT_ASK_MODEL=<model>` or `--model` to pick a different model, or `TOKEN_GOAT_ASK_CMD="<command>"` (prompt piped via stdin) for a custom backend. With no CLI on PATH it makes no network call and degrades to `context-for`-style read pointers. Answers cache across sessions, keyed on the question plus the content hashes of the cited slices, so a repeat question reuses the stored answer and skips the backend entirely; the key self-invalidates when any cited slice changes. `--scope` restricts retrieval to a glob or path substring, `--budget` caps the slice tokens sent to the backend, `--show-sources` dumps the exact slices, and `--json` reports the answer with `tokens_in`/`tokens_out`/`saved_tokens`/`cached`. Hidden while it proves out against the subagent baseline; every failure mode degrades to pointers rather than erroring.

### Fixed

- **`_apply_context_gutter` in `read_commands.py` injected a spurious 2-space indent on matched lines.** The function prefixed every non-context (matched) line with `f"  {line}"`. Only context lines should be indented; the padding has been removed from matched lines.

- **`token_estimate_header` in `read_replacement.py` overcounted lines by 1 for text ending with a newline.** The function added 1 unconditionally to the newline count. It now adds 1 only when the final character is not `\n`, matching the actual line count.

- **`shrink()` in `image_shrink.py` raised `ValueError` on images with a near-zero dimension.** PIL's `resize()` rejects a zero-dimension target. Very thin images (e.g., 1×2000 px) hit this when scaling rounded one side to 0. Both dimensions are now clamped to at least 1 before the resize call.

- **Window chunks in `embeddings.py` could overlap an already-covered range.** The chunking loop did not stop before a range already indexed. The window start is now clamped so chunks do not extend into covered regions.

- **Deletion-only `git diff --stat` entries leaked into the manifest summary.** `compact.py`'s `build_manifest` included lines such as `foo.py | 1 -` that describe only deletions. These are now filtered out before the summary section is written.

- **`_collapse_to_count` in `bash_compress.py` returned the full line list when `keep_last >= n`.** The early-exit path short-circuited with the original list instead of the collapsed count. The path now returns the collapsed count as intended.

- **`server_close()` in `hook_relay.py` could mask the original exception on cleanup failure.** An `OSError` raised during cleanup replaced the exception in flight. The call is now guarded, a liveness check was added, and the path has test coverage.

- **Stale-flock eviction in `hooks_session.py` spun indefinitely on a stale lock file.** The eviction loop did not advance `elapsed_ms` before the `continue` that followed a stale-lock removal. The timer now advances correctly so eviction terminates.

- **`repomap.py` left stale cache entries when `map_worthy_files` is empty.** When no files were worth mapping, cache eviction bailed out early without clearing existing entries. All entries are cleared when the file list is empty.

- **Path substring check in `compact.py`'s `infer_session_goal` caused false matches.** The function used `in` to test whether a relative path appeared in an absolute path, so `src/foo` matched `tools/src/foo`. The check now compares dot-notation path segments exactly.

- **`infer_session_goal` in `compact.py` used only the last commit for goal inference.** Recent commits were sliced with `[-1:]`. Changed to `[-2:]` so the two most recent commits are available.

- **`hook_relay.py` typed the raw webhook payload as `dict[str, Any]`.** The parameter is now annotated as `HookPayload` for consistency with the rest of the type surface.

### Changed

- **Pre-push hook consolidated into a single bash wrapper.** Replaced lefthook's parallel-mode command configuration (which triggered `filepath.EvalSymlinks` canonicalize failures on Windows) with a single `all-checks` command that runs typecheck, Windows tests, and WSL tests in parallel via bash background jobs. The wrapper anchors to `$(git rev-parse --show-toplevel)` so lefthook's working-directory ambiguity cannot break script resolution.

## [1.9.4] - 2026-06-20

### Added

- **`token-goat tokens [patterns]` — per-file token footprint table.** Scans matched files and prints each file's token estimate alongside its line count, sorted largest-first by default. `--tree` groups results by directory with per-directory subtotals and percentages of the total. `--top N` limits the view to the N largest files. `--asc` reverses the sort order. `--json` emits a structured object with `total_tokens`, `total_files`, and a `files` array. `--no-ignore` bypasses `.tokengoatignore`. Omit patterns to scan the entire project.

- **`token-goat note set/get/unset/list/clear` — persistent per-project notes.** Stores short key-value facts in a per-project TOML file. Token-goat injects them into the context at session start and after compaction so they survive conversation rollover without being repeated in the chat history. Keys are alphanumeric with hyphens and underscores (max 80 chars). `note list --json` for machine-readable output; `note clear` wipes all notes at once.

- **`token-goat pack --strip-comments` — strip comments before packing.** Removes language-appropriate comments from source files before bundling. Covers Python `#` line comments, JS/TS/Go/Rust/Java/C/C++ line and block comments, SQL `--` comments, Ruby/shell hash comments, and CSS/SCSS block comments. Shebangs (`#!`) are preserved. Cuts token count on comment-heavy codebases; language detection is extension-based with no extra install.

- **`token-goat pack --scan-secrets` — check for credentials before emit.** Scans packed files for patterns matching AWS access and secret keys, GitHub tokens, private key PEM blocks, Stripe and OpenAI keys, Slack webhook URLs, Google API keys, database connection strings, bearer tokens, and password literals. Exits 2 and prints per-file, per-line warnings when any pattern fires; a clean pack exits normally. Binary and image extensions are skipped automatically.

- **`token-goat call-chain <symbol>` — trace the full call path to a symbol.** Walks the call graph upward from *symbol* and prints each transitive caller layer, from immediate callers out to entry points. Pairs with `callers` (one hop) and `impact` (downstream direction).

- **`token-goat hot [--limit N] [--project dir]` — cross-session file frequency ranking.** Tallies read and edit counts from all stored sessions and ranks files by total activity. Useful for identifying which files dominate token spend across your whole history, not just the current conversation. `--json` for structured output; `--project` to filter to a specific project directory.

- **`token-goat impact <symbol>` — downstream blast-radius estimate before a refactor.** Walks the reference graph forward from *symbol* and lists every file and function that directly or transitively depends on it, with the hop depth and dependency type (call, type annotation, or import). Run it before changing a function signature to see what breaks without starting a build.

- **`token-goat context-for <task>` — minimal context bundle for a task.** Takes a natural-language task description, runs semantic search across the indexed codebase, and emits a prioritized list of `token-goat read` commands trimmed to a token budget. Fetches only the slices relevant to the task instead of loading entire files. `--budget N` sets the token ceiling; `--top N` limits the file count; `--json` for structured output.

- **`token-goat dead` — surface symbols with no known callers.** Queries the project index for functions, methods, async functions, and classes that have no recorded call-site references. Private symbols (names starting with `_`) and common entry-point names (`main`, `app`, `create_app`, etc.) are excluded from results by default. `--include-private` lifts the underscore filter; `--kind` narrows to specific symbol types; `--top N` caps the list; `--json` for structured output. Results are heuristic leads: dynamic dispatch and external callers are not visible to static indexing.

- **`token-goat coverage-gaps` — find callables not referenced by any test file.** Scans indexed functions and methods in non-test source files for names that never appear in a test file's reference records. Dunder and private names are excluded. `--top N` limits the list; `--json` for structured output. Useful for spotting untested surface area before a refactor or release; results should be read as leads, not verdicts.

- **`token-goat pack --budget N` — fail the pack if it would exceed a token budget.** Exits with code 3 when the estimated token count of the collected files exceeds N, so a shell script or CI step can treat an oversized context as an error rather than silently passing it to the model. `--budget 0` (the default) imposes no limit.

- **`token-goat skeleton` — file line count in the output header.** The skeleton header now shows total line count alongside symbol count: `# Skeleton: src/token_goat/cli.py  (80 symbols, 9,394 lines)`. Gives an immediate size gauge before deciding whether to read a file in chunks or in full.

- **Injection detector — three new patterns.** `forget-instructions` catches "forget [all] [your] previous instructions/directives/guidelines" (requires "previous" to avoid false positives on documentation phrases like "forget to include instructions from step 1"). `pretend-no-restrictions` catches roleplay jailbreak framing ("pretend you have no restrictions/limitations/constraints"; requires "you have no" to skip game-design prose). `exfil-conversation` catches attempts to extract the full conversation or chat history ("print the entire chat history", "dump the message history"); requires "the" before the noun so code comments and variable references do not fire.

- **Large-file read hints — skeleton suggestion for files with many indexed symbols.** When the read hint fires and more than three symbols are indexed for the file, the hint now shows the total symbol count and suggests `token-goat skeleton "file"` before opening a specific one. Previously the overflow appeared as `...` with no count and no browse path. The skeleton command in the hint is quoted to handle paths with spaces.

### Performance

- **`pre_read` hook now uses a read-only DB connection for symbol lookup.** `_get_indexed_symbols_and_line_count` was opening a write-capable connection (`db.open_project()`) that loads the sqlite-vec extension, sets WAL mode, and runs schema DDL on every call. Switching to `db.open_project_readonly()` eliminates those steps, cutting the function from ~9.8 ms to ~1.4 ms. Every Read tool call passes through `pre_read`, so the saving applies to every hook invocation. Fail-soft behavior is unchanged.

### Fixed

- **Stale `.jsonl` session sidecars now get cleaned up.** The cleanup pass only matched files ending in `.json`, so `.jsonl` sidecars piled up and were never removed. The suffix filter now covers both extensions.

- **Writer lock no longer leaves an empty lock file behind.** When the `os.write` after an `O_EXCL` create failed, the freshly created lock file was orphaned on disk. The failure path now deletes it.

- **Skeleton brace-skipper counts braces inside literals correctly.** A `}` or `{` inside a string, comment, or backtick template literal was counted as a real brace, which leaked body lines into the skeleton. Those contexts are now skipped, and regex literals are handled, too.

- **Embedding dimension validation runs for custom models.** The check that the model's vector width matches the stored index was skipped for any non-default model. It now runs regardless of which model is configured.

- **A closing `---` in YAML front matter is no longer read as a heading.** The front-matter terminator was parsed as a setext H2 heading, which invented a phantom section. Markdown parsing now recognizes the fence.

- **MCP server name is read consistently in the transcript tool tally.** The tally pulled the server name from two different places, so one server could show up under more than one label. Extraction is now uniform.

- **WSL path normalization drops the doubled slash.** Normalizing a Windows drive path produced a redundant slash after the drive letter, such as `/mnt/c//foo`. The extra slash is gone.

- **Combined `--head` and `--tail` recall returns both ends.** Passing `--head` and `--tail` together returned only the head slice. Recall now returns the head and the tail.

- **`compact-hint --diff` ignores timestamp-only changes.** A manifest whose only difference was a refreshed `# as-of:` timestamp was reported as a real change. The diff now treats a timestamp-only tick as no change.

## [1.9.3] - 2026-06-18

### Added

- **`token-goat callers <symbol>` — show which functions call a given symbol.** Groups results by caller: for each function that references the symbol, shows the file, caller name, and every line where it invokes the symbol. Complements `refs` by showing the call chain rather than raw usage lines.

- **`.tokengoatignore` — per-project exclusion file at project root.** Add gitignore-style glob patterns (one per line, `#` comments supported) to skip files and directories from indexing, on top of built-in skip lists. Run `token-goat ignores` to see what's active.

- **`token-goat semantic --mode keyword|hybrid` — two new search modes.** `--mode keyword` runs BM25 keyword search over indexed chunk text — no embedding model needed. `--mode hybrid` combines BM25 and vector rankings via reciprocal rank fusion, which helps when a query has distinctive terms that pure semantic matching would drift past. The default (`--mode vector`) is unchanged.

- **`token-goat arch` — project-wide import graph summary.** Shows hub modules (sorted by how many files import them), entry-point files that nothing imports, and circular import chains — all derived from the existing `imports_exports` index with no extra indexing step. For per-file depth, use `token-goat deps <file>`.

- **`token-goat pack <patterns>` — bundle files into a single LLM-ready output.** Collects files matching glob patterns and writes them as Markdown (default), XML, or plain text, with a manifest table of per-file line and token counts. `--line-numbers` prefixes each line; `--instruction-file` appends a task prompt; `--output` writes to a file instead of stdout; `--no-ignore` bypasses `.tokengoatignore`. Reads file paths from stdin when no patterns are given and stdin is not a tty. Path traversal and symlink escape are both checked.

- **`token-goat budget <patterns>` — token-cost estimate for a file set.** Reads each matching file, calculates a rough token count (~4 chars/token), and prints results sorted by cost descending. `--context <N>` shows what percentage of an N-thousand-token window each file would fill. `--json` for machine-readable output. Run before `pack` to decide what to include.

- **`token-goat todo [--kinds K] [--group file|kind]` — scan indexed files for TODO-family markers.** Reads file paths from the project index and scans each for `TODO`, `FIXME`, `HACK`, `XXX`, and `NOTE` comment markers. Groups by file by default; `--group kind` to group by marker type; `--kinds` to filter to a subset; `--json` for machine output. Markers in string literals and non-comment lines are excluded.

- **`token-goat failures [src]` — extract failing test blocks from test runner output.** Parses pytest, Jest, Go, and Cargo output and returns each failure as a labeled block; passing tests and preamble are dropped. Reads stdin by default; pass a file path for saved output. `--json` emits a structured array.

- **`token-goat trace [src]` — condense Python exception tracebacks to project-owned frames.** Strips library, stdlib, and virtualenv frames, keeping only the frames in your code. Chained exceptions preserve their cause notes; bare exceptions without a message (e.g. `KeyboardInterrupt`) are handled. `--keep N` (default 5) caps the frame count. `--json` for structured output.

- **`token-goat lockdeps [path]` — summarize lock file dependencies as a compact table.** Reads poetry.lock, uv.lock, requirements.txt, Pipfile.lock, package-lock.json, Cargo.lock, and yarn.lock. Returns direct dependencies only — optional packages and nested transitive entries are excluded. `--json` for structured output.

- **`token-goat logfold [src]` — collapse consecutive duplicate log lines.** Consecutive runs of identical or structurally equivalent lines fold to a single `[Nx] line` entry. Normalizes ISO timestamps, UUIDs, IPs, and short hex IDs before comparing so the same event logged with different values folds correctly. `--tail N` keeps the last N lines after folding; `--no-normalize` disables normalization; `--json` for structured output.

### Fixed

- **Path traversal bypass in `_is_system_path()`.** `bash_parser.py` appended `..` even at root of an absolute path, letting `/../../etc/passwd` slip past the system-path block. Now discards `..` at root. Four regression cases: `/../etc/passwd`, `/../../etc/passwd`, `/etc/./../../etc/passwd`, `/sys/../../../sys/kernel`.

- **SQL identifier quoting in `db._count()`.** Table names are now `[bracket]`-quoted — defense-in-depth behind the existing allowlist.

### Changed

- **Hook dispatcher watchdog: `asyncio.wait_for` replaces `Thread.join` + `is_alive()`.** `Thread.join(timeout) + is_alive()` doesn't guarantee the watchdog fires at exactly the budget — OS thread scheduling introduces jitter. `asyncio.wait_for` raises `TimeoutError` precisely at the deadline. The handler's result comes back via `asyncio.Future` + `call_soon_threadsafe`; `threading.Lock` is gone. All handlers remain synchronous; external behavior is unchanged.

## [1.9.2] - 2026-06-18

### Changed

- **Default hook watchdog timeout reduced from 5000 ms to 700 ms.** `HooksConfig.watchdog_ms` and all fallback constants now default to 700 ms. The adaptive doubling-on-timeout mechanism (capped at 30 000 ms) is unchanged — slow CI machines or cold-cache environments will still recover automatically. A new `HOOKS_WATCHDOG_DEFAULT_MS` constant in `config.py` is the single source of truth used by `HooksConfig`, the TOML fallback path, and `hooks_common.py`, so the value only needs to change in one place.

### Performance

- **Surgical-read hint memoized by file path and mtime.** `_try_surgical_read_hint` now caches its DB query result keyed by `(abs_path, mtime_ns, req_start, req_end, limit_is_sentinel)`. Repeated reads of the same file range within a session skip the SQLite lookup entirely. The cache is invalidated automatically when the file changes (mtime differs). The per-session cache is also cleared between tests via the `tmp_data_dir` fixture to prevent cross-test contamination.

- **Symbol-not-found retry command.** When `token-goat read file::symbol` finds no exact match but exactly one close suggestion exists, the output now includes a ready-to-run `token-goat read "file::ClosestSymbol"` command rather than a plain name list, so the next attempt requires no manual editing.

## [1.9.1] - 2026-06-17

### Added

- **Prompt injection and exfiltration protection for web content.** `hooks_fetch.py` now runs `flag_external_content()` on every fetched page (head + tail window scan) before caching. When a pattern matches, a warning prefix is prepended to the cached body so every future recall inherits the flag without a re-scan. All fetched content is also wrapped in an `=== BEGIN/END UNTRUSTED WEB CONTENT ===` fence. The log line names the matched pattern (`ignore-all-instructions`, `exfil-api-key`, etc.).

- **Eight injection-detection improvements in `injection.py`.** NFKC normalisation + invisible-char stripping on a detection-only copy; Unicode Tag-block (U+E0000–E007F) detection as a smuggling signal; `_SEP = [\s\W]{1,4}` bounded separator that handles markdown bold and punctuation without bridging across words; named `(label, pattern)` tuples so every log line identifies which pattern fired; `_classify()` returning a 3-tuple `(inj, exf, label)`; `flag_external_content()` with head+tail windowing; `wrap_external_content()` for the deterministic fence; and `check_hint_for_injection()` which redacts only the matched span (never prepends a multi-line banner) and checks only exfil + Tag-block in hint text.

- **New exfiltration-to-URL pattern.** Catches `send/post/exfiltrate secrets … to https://…` and `… to webhook` phrases.

- **`InjectionConfig` config toggle.** `[injection] enabled = false` in config TOML or `TOKEN_GOAT_INJECTION_ENABLED=0` env var disables all injection scanning. Default: enabled.

- **pi-coding-agent extension bridge.** `token-goat install --pi` writes a TypeScript extension to `~/.pi/agent/extensions/token-goat.ts` that bridges pi's extension events (`session_start`, `tool_call`, `tool_result`, `session_before_compact`, `session_compact`) to token-goat's subprocess hook protocol. Read/grep/glob/bash/fetch tool calls fire pre- and post-hooks; arg names are remapped between pi's camelCase API and token-goat's snake_case wire format. Compaction is handled via pi's replace-only model: the token-goat manifest is captured at `session_before_compact` and injected as a `nextTurn` message after `session_compact` so it survives into the new context window. `token-goat uninstall --pi` removes the extension. Project-local installs are supported by passing a `target_dir` directly to `token_goat.bridges.install_pi_plugin`. Original implementation by [@eSaadster](https://github.com/eSaadster).

## [1.9.0] - 2026-06-16

### Added

- **`TerraformFilter` extended: `terraform show` compression and plan data-source detection.** `terraform show` output now strips noise attributes (id, arn, timeouts, tags blocks) per resource block and appends a suppression note; only meaningful fields survive. `terraform plan` unchanged-block detection now covers data-source read-during-apply blocks in addition to managed-resource no-op blocks.

- **`KubectlFilter` extended: event grouping and describe compression.** `kubectl events` output groups events by `REASON` with a per-group count and a field-selector hint. `kubectl describe` collapses label and annotation blocks to line counts, preserves the Conditions table in full, and retains container resource (requests/limits) fields.

- **`NpmInstallFilter` extended: warn collapsing and verbose line suppression.** `npm warn` lines after the first 3 are collapsed to a suppression note. Verbose timing, sill, http, and verb lines are suppressed entirely. Braille spinner reify progress lines are stripped.

- **Three-layer watchdog budget resolution.** `_resolved_watchdog_ms()` now reads `config.load().hooks.watchdog_ms` (default 5000 ms) when no `TOKEN_GOAT_HOOK_WATCHDOG_MS` env var is set. Previously it fell straight through to the 2000 ms compile-time constant, ignoring whatever `[hooks].watchdog_ms` was set to. Resolution order: (1) env var, (2) project config baseline (process-level mtime-cached, one `os.stat()` on the fast path), (3) `_HOOK_WATCHDOG_MS = 2000 ms` compile-time fallback. Values below the 100 ms floor are clamped regardless of layer.

- **Reread-deny hint shows real indexed symbols.** `_handle_reread_deny` now queries the project DB for up to 8 non-import, non-variable symbols in the denied file and emits exact `token-goat read "path::Symbol"` commands in the hint instead of the static `::SymbolName` placeholder. The lookup uses `find_project` from the file path, so no `cwd` parameter is required. If the file is not indexed or the query fails, the hint falls back to the generic placeholder silently.

- **`_handle_doc_compact` auto-spawns `compact-doc` in the background.** When the section-map path fires for a large markdown file, it now launches `compact-doc <file>` as a fire-and-forget subprocess so the compact sidecar is ready on the next read. A per-file session fingerprint (`compact_doc_spawned:<path>`) prevents re-spawning for the same file within a session. If `token-goat` is not on PATH or the spawn fails, the hook continues normally.

### Fixed

- **`TerraformFilter._compress_terraform_init` head/tail fallback.** When `terraform init` progress lines (e.g., `Installing plugin N`) did not match the provider-specific regex, all lines passed through unchanged. The method now applies head=5/tail=5 compression whenever `len(non_empty) > 12` after provider-line collapsing.

## [1.8.0] - 2026-06-13

### Added

- **Pressure-scaled `pre_read` deny threshold.** The oversized-read deny gate (`hints.large_read_redirect_bytes`, default 45 KB) now tightens automatically as the context window fills. A new `_pressure_scaled_threshold(base, tier)` helper applies tier multipliers — cool 1.0×, warm 0.67×, hot 0.33×, critical 0.18× — giving effective thresholds of ~45 KB / 30 KB / 15 KB / 8 KB on the 45 KB default. The tier is derived from the `ContextPressure` already computed once per `pre_read` invocation and threaded to the fallback deny call at no extra I/O cost. The catastrophic ≥10 MB early call (which passes `floor=_LARGE_FILE_HINT_SKIP_BYTES`) is never tier-scaled — `_handle_large_read_redirect` guards scaling behind `floor == 0`. Windowed reads, binary files, and a disabled threshold are all still exempt. Works identically across Claude Code, Codex CLI, and Gemini-CLI via the shared session JSON.

- **Pressure-scaled bash compress output token cap.** `bash_runner.py` now reads `ContextPressure` before running a filter and scales the per-command output token cap: cool 1.0×, warm 0.75×, hot 0.5×, critical 0.25×. At critical pressure a 20 000-token default cap drops to 5 000 tokens, protecting the context floor for commands like `pytest -v` or `cargo build` that can produce megabyte outputs. Scale factors apply after the filter's own cap, so the lower of the two wins. Config: `[bash_compress] output_token_cap` sets the cool baseline; the env var `TOKEN_GOAT_BASH_OUTPUT_TOKENS` overrides it per process.

- **WebFetch dedup deny at warm+ context pressure.** `hooks_fetch.py` now tracks fetched URLs in the session cache (`fetch_history`). When the same URL is re-fetched and `ContextPressure` is warm or above, `pre_fetch` denies the call and redirects the model to use `token-goat web-output <id>` to retrieve the prior result surgically. At cool pressure the hook emits an advisory hint instead, so fresh re-fetches still work when content may have changed. Config: `[hints] fetch_dedup = true` (default on).

- **Hint text trimmed to first paragraph at hot/critical pressure.** `hints.py` exposes a `trim_to_first_paragraph(text, tier)` helper that strips everything after the first blank line in a hint body when `tier >= HOT`. All advisory hints in `hooks_read.py` that carry multi-paragraph explanatory prose — the large-read redirect, bash-dedup, grep-dedup, and reread-deny hints — pass their output through the trimmer. At cool/warm the model gets the full hint; at hot/critical only the actionable first sentence does. The trimmer is a pure string op, zero I/O.

- **Inline symbol skeleton in large-read deny context.** When `_handle_large_read_redirect` denies a Read, it now appends a token-goat skeleton of the target file as `additionalContext` so the model can navigate to specific symbols without a follow-up round-trip. It uses the same indexed path as `token-goat skeleton`, capped at 2 000 tokens. If the file is not indexed or the skeleton call fails, the deny fires without it (fail-soft). Adds one DB read per deny but eliminates the near-certain follow-up symbol lookup.

- **Jupyter notebook output stripping.** `pre_read` now intercepts `.ipynb` reads and strips all code-cell `outputs` and `execution_count` fields via the new `notebook_compact.py` module before the content reaches the model. Cell source (code and markdown) and metadata are preserved. A typical notebook shrinks 60–95%; a 2 MB notebook with heavy matplotlib outputs becomes ~40 KB. The stripped JSON becomes the Read result; the notebook's path is recorded in session for reread-deny tracking. Binary files (non-UTF-8 notebooks) fall through unchanged.

- **Duplicate-content read denial via cross-file SHA fingerprinting.** `pre_read` maintains a `file_content_seen` ring in `SessionCache` (cap `FILE_CONTENT_SEEN_MAX = 256` entries, evict oldest on overflow). After each successful Read, `pre_read` records the content SHA-256 alongside the path. When a later Read of a different path has a matching hash, `pre_read` denies it and tells the model the content is a duplicate of an already-read file. This catches symlinks, copied configs, vendored files, and generated duplicates without re-reading. The hook fingerprints only files at or below `_CONTENT_DEDUP_MAX_BYTES` (default 500 KB); binary and very large files are exempt.

- **Glob-cache hybrid sample + directory rollup.** The previous Glob result handler truncated the file list to a fixed count when it exceeded the cache limit, silently dropping paths. The new handler switches to a two-part representation: a random sample of individual file paths (≤ 200 entries) followed by a per-directory rollup that shows `dir/ (N files)` for every directory with unsampled members. One `Counter` pass generates the rollup with no extra filesystem I/O. The model sees a representative sample plus a complete directory-level view, rather than a silent hard cutoff.

- **Grep result direct-serve on re-runs.** `_handle_grep_dedup` now tries to inline the prior Grep result as `additionalContext` before falling back to the advisory hint. On a repeat Grep where the prior output is within the staleness window and ≤ 8 KB, the result is embedded directly and the Grep tool doesn't re-run. On larger prior outputs the advisory hint ("retrieve via `token-goat bash-output`") fires as before. The size and staleness thresholds match the Bash direct-serve path.

- **Pytest failure delta injection.** After a `pytest` run, `post_bash` extracts the failure lines from stdout and merges them into `SessionCache.pytest_failures` (keyed by `cmd_sha`). On the next matching pytest invocation, `_handle_pytest_delta` diffs the current failure set against the last-seen set and injects only the **new** failures as `additionalContext` (prefixed `⚠ New failures:`) and resolved failures (`✓ Now passing:`). A run with no change emits a one-liner confirming parity. This eliminates re-reading the full test log to find what changed between two runs. The merge uses a CAS over a session-stored SHA so concurrent pytest shards don't drop each other's failures.

- **Directory-listing map inject after three listings.** After the third Glob/directory-listing command in a session, `pre_read` injects a `token-goat map --compact` snapshot of the project tree as `additionalContext`. The inject fires once per session (gated by a `map_injected` sentinel in `SessionCache`) so it doesn't repeat on every subsequent listing. The compact map is generated synchronously and capped at 4 000 tokens; if map generation fails the hook continues without it. Cuts repetitive `eza --tree` / `ls -R` calls once the agent knows the layout.

- **Bash output direct-serve for small cached commands.** `_handle_bash_dedup` now calls `_try_bash_dedup_serve` before the advisory hint path. On the first repeat (`run_count == 1`), if the cached output is within the staleness window and ≤ 8 192 bytes, it embeds directly as `additionalContext` — the command doesn't re-run. On `run_count > 1` the function yields to the advisory path so loop-detection warnings still fire for habitually repeated commands. The staleness and size thresholds mirror the Grep direct-serve path.

- **`PytestFilter` collapses `pytest -v` verbose PASSED lines.** `pytest --verbose` emits path-first progress lines (`tests/foo.py::test_bar PASSED [ 1%]`) that the existing `_PYTEST_FAIL_LINE_RE` (a status-first pattern) did not match, so every PASSED line fell through to `kept.append()` — a 1 000-test `-v` run retained ~1 000 otherwise-useless lines. A new `_PYTEST_VERBOSE_LINE_RE` (`^\S.+::\S+[ \t]+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:[ \t]|\Z)`) detects path-first verbose progress lines and counts PASSED into the existing `passed_count` accumulator; `FAILED`/`ERROR`/`SKIPPED`/`XFAIL`/`XPASS` verbose lines are kept for context. The `^\S` anchor prevents indented captured output (e.g. lines inside a traceback that happen to contain `::test PASSED`) from being misclassified; the `not in_failures and not in_errors` guard provides the same protection inside `= FAILURES =` / `= ERRORS =` sections.

- **`post_bash` compresses `curl -v` / `--verbose` output.** When `curl` exits zero and the output contains curl verbose markers (`* `, `> `, `< `), `post_bash` now strips TLS handshake noise, connection metadata, all request headers, and redundant response headers (date, cache-control, x-* etc.), keeping only the request line, HTTP status, content-type, and response body. The compressed output is emitted as `systemMessage`; the full original is cached so `token-goat bash-output <id>` can retrieve it. Fires only on 10+ line outputs to avoid false positives on short responses. Requires exit code 0 — errors pass through unmodified so the model sees the full curl error context.

- **`post_bash` compresses `jest`/`vitest` verbose PASS-suite lines.** When jest or vitest runs with `--verbose`, each passing test emits a `✓ test name` or `✔ test name` line. On large suites these can number in the thousands. The new `JestVerboseFilter` collapses consecutive passing-test lines under a `PASS <file>` banner into a single count line (`N tests passed`), while preserving all `FAIL`/`✕` lines, error output, and the final summary. Typical savings on a passing 500-test suite: 95%.

- **`post_bash` parses JUnit XML and emits a structured summary.** When a command writes JUnit XML to a file path printed in its stdout (`--junit-xml=path`, `--junitxml=path`, `PYTEST_JUNIT_XML=path`), `post_bash` now parses the XML and emits a compact summary: total tests, passed, failed, error, skipped, and elapsed time, followed by the names and messages of every failed/errored test case. The XML file is not read via the Read tool — it is parsed directly from disk so it never enters the model's context as raw XML. Fires only when the XML exists and parses successfully; any failure falls through to the normal output path.

- **`pre_read` detects Claude task-output temp files and redirects to `bash-output`.** Claude Code writes async-task output to temp files like `claude/…/<sha>.output`. When `pre_read` sees a Read targeting one of these paths, it redirects the model to `token-goat bash-output <id>` (which supports `--head`, `--tail`, `--grep`, `--section` for surgical recall) rather than dumping the full file. Saves the typical 10–200 KB raw output from entering context on every task-completion check.

- **`post_bash` elides long lines from `grep`/`rg` hits on minified JS/CSS.** When grep or ripgrep returns a match from a `.min.js`, `.min.css`, `.bundle.js`, or `.map` file, the matching line can be hundreds of kilobytes (entire minified bundle on one line). `post_bash` now detects these and truncates each matching line to 200 characters, appending `… [minified, truncated]`. The filename and line number are preserved so the model still knows where the match is.

- **`pre_read` suppresses redundant re-read hints after conversation compaction.** After Claude Code compacts the conversation, the compaction summary injected into the new context already lists recently-touched files. Previously `pre_read` would still fire re-read deny hints for those files as if they were repeat reads, adding noise without value. The hook now checks whether the current session started with a compacted context (detected via the `isCompactSummary` marker in the session JSON) and suppresses re-read hints for a configurable grace period (`[hints] post_compact_grace = 3`, default 3 reads) so the model can re-orient without being blocked.

- **`post_bash` compresses `go test -v` clean PASS lines.** `go test -v` emits one `--- PASS: TestName (Ns)` line per passing test. On a large Go module with hundreds of tests these lines dominate the output. The new `GoTestVerboseFilter` collapses `--- PASS:` lines under each package header into a count, while preserving `--- FAIL:`, `FAIL`, panic output, and the final per-package timing lines. `--- SKIP:` lines are also collapsed into a count. Typical savings: 90% on a clean run.

- **`post_bash` compresses `make`/`cmake`/`ninja` build progress output.** Long builds emit hundreds of `[N%] Building …` / `[ N%] Linking …` progress lines that are pure noise when the build succeeds. The new `MakeBuildFilter` collapses these progress lines into a single count, while preserving compiler warnings, errors, linker errors, and the final `Built target` / `make: *** Error` lines. `cmake --build` and `ninja` output is covered by the same filter (both produce `[N%]`-prefixed progress). Typical savings on a clean build: 85%.

- **`post_bash` compresses Python script crash tracebacks.** When a Python script or `python -c` invocation raises an unhandled exception, the full traceback can run to dozens of lines. The new `PythonTracebackFilter` collapses intermediate `File "…", line N, in …` / `    code_line` frame pairs into a count, keeping the outermost frame, the exception type and message, and any `During handling…` chained-exception context verbatim. The model sees the root cause immediately rather than scrolling through a deep frame chain.

- **`post_bash` compresses `tsc` (TypeScript compiler) output.** `tsc --noEmit` or `tsc --build` on a large project can emit hundreds of type-error lines. The `TscFilter` groups errors by file, emits a representative sample (up to 3 per file), and appends a per-file count for files with more errors. The summary line shows total-error and file counts. Build-info progress lines (`… emitted`, `… unchanged`) are dropped on success. Typical savings: 70–90% on a project with widespread type errors.

### Fixed

- **Pytest suffix regex tightened; failure merge uses session CAS.** The regex that identifies pytest output lines was matching non-pytest commands whose filenames contained `test_`. The pattern now requires the pytest binary name at the start of the command string. `post_bash`'s failure-merge previously overwrote `SessionCache.pytest_failures` blindly; it now does a compare-and-swap over the stored SHA so concurrent pytest shards don't drop each other's failures.

## [1.7.1] - 2026-06-11

### Fixed

- **Bash-compress disable hint is now shell-neutral.** The `TOKEN_GOAT_BASH_COMPRESS=0` form shown in the hint is POSIX-shell `VAR=value` prefix assignment — valid only when prefixing a command, and broken in PowerShell and cmd.exe. All 34 runtime hint strings in `bash_compress.py` and both in `hooks_read.py` now read `disable via TOKEN_GOAT_BASH_COMPRESS` (set it to `0`, `false`, `no`, or `off`). Env-var semantics are unchanged; only the hint text changed.

- **Bash pre-hook fast-path via `bash_detect` (Code-10 / P2-3).** The Bash pre-hook previously imported `bash_compress` (~75 ms) on every invocation to identify which filter to apply, even for commands that match no filter. A new `bash_detect` module contains a 227-entry binary→filter-name dict; the pre-hook now does a `<1 ms` dict lookup first and only imports `bash_compress` when `detect()` returns a filter name or the command contains `&&`. Unrecognized commands skip the import entirely.

- **`enqueue_dirty` is now append-only with a byte-based cap (P1-1 / P2-5).** The previous implementation read the full queue file, filtered duplicate entries, and rewrote it on every Edit/Write hook — O(queue size) per call and vulnerable to a POSIX rename race. `enqueue_dirty` now does a single `stat()` to check the queue size against `DIRTY_QUEUE_MAX_BYTES` (2 MB) and appends the new entry atomically. When the queue is at cap, new entries are silently dropped until the worker drains it; no read, no rewrite, no race.

- **Corrupt `.draining` file is quarantined instead of raising (P1-2).** When `drain_dirty_queue` could not read its renamed `.draining` file (e.g. another process renamed it after the check), it raised an `OSError` and left the worker in a broken state. The file is now renamed to `.corrupt-<timestamp>` and the drain cycle continues with an empty result; if the rename also fails the cycle is deferred silently without data loss or crash.

- **`post_bash` uses a single session load/save round-trip (P2-4).** The previous implementation called `session.load()` / `session.save()` up to four times per `post_bash` invocation — once per `mark_*` helper. All helpers now accept a `cache=` kwarg and share the single object returned by `session.safe_load()` at the top of the function; one `session.save()` at the end writes the merged result.

- **Output size cap applied before payload work in `post_bash` (P2-6).** `_apply_output_size_cap` was previously called after grep filtering and session writes, so a 4 MB stdout triggered the full expensive pipeline before being truncated. It now runs immediately after `_sanitize_surrogates`, before any downstream processing.

- **Cache eviction is throttled to at most once per 60 seconds (P2-7).** `store_output` previously called `evict_old_entries` on every write, triggering an O(n) `iterdir` + `lstat` scan of the cache directory (up to 4 096 entries × 2 for body + sidecar). A module-level `_last_eviction_ts` timestamp gate now skips eviction when called within `_EVICTION_THROTTLE_SECONDS` (60 s) of the last run.

- **`normalize_path` handles WSL paths with embedded Windows backslashes (P3-8).** A WSL path like `/mnt/c/foo\bar` was returned as-is because the WSL branch only replaced the `/mnt/<drive>/` prefix and left `\` separators intact. The function now replaces `\` with `/` after the prefix substitution, so `/mnt/c/foo\bar` normalizes to `c:/foo/bar` and collides with the same file accessed via a Windows path.

- **`pre_read` Bash branch uses `session.safe_load()` instead of `session.load()` (P3-9).** A corrupt or partially-written session file caused the Bash pre-hook to raise, blocking the tool call. The branch now calls `safe_load()`, which returns `None` on any error, and the hook proceeds with no-op recovery hints rather than crashing.

- **`_index_spawn_active` guards against PID recycling.** The function checked only `psutil.pid_exists(pid)` to decide whether an indexing spawn was still running. Within the 10-minute `INDEX_SPAWN_TTL` the OS can reuse a finished indexer's PID for an unrelated process, blocking fresh indexing spawns for up to 10 minutes. The check now reads the running process's cmdline and returns `False` when it lacks `token_goat`, falling back to trusting the PID when the cmdline is unreadable (permission denied / sandboxed).

- **`kill_duplicate_daemon` now unlinks the stale PID file after a successful kill.** The "already dead" early-exit path already removed the file; the success path did not, leaving `--check` and `is_worker_alive()` reporting stale state until the next `ensure_running` cleanup pass.

- **`get_context_pressure` avoids a redundant `safe_load` when a cache is already in scope.** Both `build_manifest_adaptive` and `post_read` loaded `SessionCache` before calling `get_context_pressure`, which performed a second `safe_load` from disk. The function now accepts an optional `cache=` kwarg; callers that already hold a loaded cache pass it in and skip the extra I/O.

- **`normalize_path` docstring corrected.** The step-by-step description had steps 2 (backslash replacement) and 3 (WSL detection) listed in the wrong order relative to the actual execution order. Inline comments had the same transposition.

## [1.7.0] - 2026-06-10

### Fixed

- **Skill dedup permanently disarmed after first compaction.** `post_skill`'s early-return path (duplicate body already in session) returned without calling `session.mark_skill_loaded()`, leaving `skill_ts` frozen at the initial load time. After any compaction sidecar update, `_compaction_occurred_after(skill_ts)` returned `True` permanently, so `pre_skill` passed every subsequent load through without deduplication. Fix: `mark_skill_loaded` is now called before the early return, advancing `skill_ts` past the current sidecar mtime so the next load is correctly deduped. The early-return is also gated on a `content_sha` equality check — if the skill body changed between loads, the code falls through to the normal `store_output` path so the new body is cached with a correct `output_id`/`content_sha`.

### Added

- **`post_compact_full_loads` config knob** (`[skill_preservation] post_compact_full_loads`, default `false`). With the default, `pre_skill` serves the cached compact even after a compaction event (dedup stays armed for the whole session). Set to `true` to restore the pre-1.7 behaviour of allowing one full body reload per compaction epoch. When `false` and no compact is cached for the skill (new install, no `<!-- COMPACT_END -->` marker, and auto-extract hasn't run yet), the hook falls back to allowing the full reload so the model is never left without operative rules.

- **Stable-doc compact serving** (`token-goat compact-doc`). Large reference markdown documents (`.md`/`.markdown`) can now be pre-compacted into a sidecar summary that `pre_read` serves in place of the full file, saving 80–95% of context tokens on the first read of each new session. The compact is built extractively (headings + first N lines per section, no LLM) and stored in the token-goat data dir as a SHA-keyed sidecar. On reads, `pre_read` checks for a fresh sidecar (source hash match) and deny-redirects to it when found; stale sidecars (emitted when the source file is edited) trigger an advisory instead. `skill_cache.invalidate_for_path` automatically marks the sidecar stale after an edit so the model is never silently served an outdated compact. Config: `[hints] stable_doc_compacts = true` (default on). CLI: `token-goat compact-doc <path> [--force] [--sentences N] [--show]`.

- **MCP screenshot deny-redirect.** `pre_screenshot` hook (new `PreToolUse` matcher `mcp__.*take_screenshot|mcp__.*browser_take_screenshot`) denies chrome-devtools and playwright screenshot calls that don't include a `filePath`/`file_path` argument, redirecting the model to re-issue with `filePath` and then Read the saved file. The subsequent Read flows through the existing image-shrink pipeline, which compresses the result before it reaches the model (~39K tokens/call raw). Calls that already provide `filePath` pass through unchanged. Config: `[images] screenshot_redirect = true` (default on).

- **Baseline v2: skill listing cost + per-server MCP rows + `--usage` flag.** `token-goat baseline` now costs the skill listing injected on every session start and subagent spawn (estimated at ~71 tok/entry from SKILL.md frontmatter where available), replacing the single aggregate "MCP instruction blocks" row with one row per configured server so each appears as an individually removable line item. The new `--usage` flag streams project transcripts to annotate each skill and MCP row with historical call counts, flagging zero-use entries as removal candidates. New public API: `scan_transcript_usage(projects_root)` → `({skill: count}, {mcp_prefix: count})`.

- **Session window denial for in-context file reads.** `pre_read` now denies re-reads of file content already present in the current context window, redirecting the model to use the already-loaded text or a surgical `token-goat read` command instead. Triggered when a file's post-read record is present in the session cache. Config: `[hints] deny_reread = true` (default on).

## [1.6.0] - 2026-06-09

Three changes, all aimed at the fixed context floor a spawned subagent inherits before it does any work: a deny-redirect guard that stops oversized reads and content-mode greps at the tool boundary before they overflow the window, a new `token-goat baseline` command that measures and attributes that floor source by source, and an opt-in SessionStart advisory that surfaces it once when it crosses a configured budget.

### Oversized-read deny-redirect guards subagent context windows

A spawned subagent inherits a large fixed baseline before it does any work — the full CLAUDE.md, the memory index, every loaded skill body, the MCP instruction blocks, and any SessionStart hook dumps from other plugins. That baseline alone can nearly fill the window, so the first attempt to Read a 47–86 KB recon dump, or to grep a 73 KB transcript in `content` mode, overflows the window and kills the agent. An advisory hint is too weak to prevent it; the read has to be stopped at the tool boundary.

`pre_read` now denies a full Read whose on-disk size is at or above `hints.large_read_redirect_bytes` (default 45000 / ~45 KB) and redirects to the surgical alternatives — `token-goat skeleton`/`section`/`semantic`/`symbol` — or to re-issuing the Read with `offset`/`limit` to window it. The guard runs in two tiers so it never preempts a richer, type-specific redirect: a catastrophic ≥10 MB tier fires early (these files are dropped wholesale by the hint pipeline and reach no handler, and the early position also covers sessionless and cache-load-failure reads), while the 45 KB–10 MB band fires as a fallback only after the skill-body, index-only, structured-file, and serve-diff/diff handlers have had first claim. A Read that already sets `offset` or `limit` is exempt — it is deliberately windowed, and exempting it also prevents a redirect loop since the deny itself points there. Binary files are exempt (surgical reads cannot help). Setting the threshold to 0 disables the guard; `TOKEN_GOAT_LARGE_READ_BYTES` overrides it per environment.

The same threshold gates a content-mode Grep over a single oversized file: `output_mode=content` with no `head_limit` over one file at or above the threshold is denied and redirected to a bounded search (`head_limit`, an `offset`/`limit` window, or `token-goat semantic`/`section`). The cheap `files_with_matches` default, an explicit `head_limit`, directory targets, and small files all pass through unchanged.

### `token-goat baseline` — the session expense report

The deny-redirect above treats the symptom (the fatal read) but leaves the cause — the large fixed baseline a session inherits — invisible and unattributed, so "why did that subagent overflow at hello?" stays a guess. The new `token-goat baseline` command makes that baseline a measured, attributed report. It scans the four source classes token-goat can see on disk — every plugin's persisted SessionStart/UserPromptSubmit hook dump (`hook-*-stdout.txt`), both CLAUDE.md files, the project's MEMORY.md, and the configured MCP servers — costs each at `bytes // 4` so the totals reconcile with `token-goat doctor` rather than contradicting it, and renders a table ranked by token cost. Each row is tagged by owner (`you` / `harness` / `plugin:<name>` / `plugin:unknown`), a concrete fix (`slim` / `disable-hook` / `disable-mcp` / `lazy-load` / `none`), and kind (`fixed`, recurring every session start, vs `variable`, a one-off prompt-driven push). Identical hook dumps re-fired across compactions are deduped by content hash and shown once with a `xN fires` note, because a fresh subagent pays that cost only once. Every scanner is fail-soft: a missing or unreadable source becomes a note, never an exception. Flags: `--json` for the machine-readable view, `--subagent` to show only the fixed sources a freshly spawned agent inherits (framed as its starting fill), `--window` to set the pct-of-window denominator (default the 200k model window), and `--session-id` to override session detection. Skill-catalog cost is deliberately not re-measured here — `token-goat doctor` already does that well — so the report points there instead of drifting.

### Opt-in SessionStart baseline advisory

A new `[hints] baseline_budget_tokens` knob (default `0` = off; `TOKEN_GOAT_BASELINE_BUDGET_TOKENS` overrides it; clamped to `[0, 10_000_000]`) gates a one-line SessionStart advisory. When the budget is positive and the cheap fixed baseline exceeds it, `session_start` appends a single quiet line pointing at `token-goat baseline` for the per-source breakdown. Only the fixed/recurring total is gated on — a variable one-off push never trips it — and the line fires at most once per session via a sentinel written only when the advisory actually emits, so an under-counting cold start (hook dumps not yet on disk) can still trip on a later resume. The whole path is fail-soft; any error leaves the session start untouched.

## [1.5.3] - 2026-06-08

Four improvements: compact directives that tell the compaction LLM to suppress regenerated noise, compound-command bash compression, repetitive-JSON diff hunk compression, and a new `indexing.skip_dirs` config option.

### Compact directives suppress skill_listing and hook_success reproduction

After compaction, the conversation often refills quickly because the compaction LLM faithfully reproduces the `skill_listing` blob (the full skills catalog, ~14–28K tokens) and every `hook_success`/`hook_error` telemetry event. These are autoregenerating noise — `skill_listing` is re-injected fresh at every session start and hook events are ephemeral status lines — but the compaction LLM has no way to know that without being told.

`build_manifest()` now appends a `### Compact Directives` footer after the sidecar SHA write (so the fingerprint is unaffected) instructing the compaction LLM to replace each `skill_listing` message with `[skill_listing: auto-injected]` and collapse all `hook_success`/`hook_error` events to a single `[N hook events]` line. A `_DIRECTIVE_TOKEN_RESERVE` is subtracted from `max_tokens` before building the manifest body, so the total output stays within the caller's budget.

### Compound `&&` command bash compression

The bash compress hook previously skipped commands it couldn't recognize as a single filter — a compound like `git diff && git log` matched no single `detect_from_command` rule, so both halves ran uncompressed. The hook now falls back to `bash_compress.try_wrap_compound_segments`, which splits the command on `&&` boundaries and wraps each recognizable segment with its own filter. Segments that don't match any filter pass through unchanged. Unrecognized compound commands are skipped as before, so there are no false positives.

### Repetitive-JSON diff hunk compression

`_compress_git_diff_body` now detects diff hunks where ≥75% of added lines parse as JSON dicts and all parsed objects share ≤5 distinct key-sets — the signature of machine-generated JSONL (audit logs, test fixtures, mutation records). These hunks are replaced with a one-line summary (`[token-goat: N repetitive JSON-object lines omitted]`) instead of head+tail truncation, so a 500-line JSONL diff becomes one line rather than 60 lines.

### `indexing.skip_dirs` config option

`config.toml` now supports `[indexing] skip_dirs = ["dir1", "dir2"]`. These basenames are merged with the built-in `SKIP_DIRS` frozenset during `iter_source_files`, so project-specific generated directories — temporary venvs, build sandboxes, unusual artifact directories — can be excluded without touching token-goat source. The list is validated at load time; non-string entries are silently dropped with a warning.

## [1.5.2] - 2026-06-08

Three fixes: Codex hook wire-format compatibility, and two Windows coarse-`mtime` correctness issues in the cache and session layers.

### Codex hook responses now pass schema validation

Codex 0.137.0 validates every hook response against embedded JSON schemas with `additionalProperties: false`, so any unrecognised key causes "hook returned invalid … JSON output" for the entire response — including `SessionStart`, `PreToolUse`, and `PostToolUse`. The root cause was `_tg_elapsed_ms` (and sibling `_tg_handler`/`_tg_error` fields) added by the internal `dispatch()` function and then emitted verbatim. The `denormalize_response` Codex branch now strips all `_tg_*` keys before output. The same path also injects the required `hookEventName` const field into `hookSpecificOutput` — Codex requires it on every `hookSpecificOutput` shape and token-goat was not emitting it because Claude Code does not require it. A `_codex_hook_event_name()` helper resolves the correct value (e.g. `"pre-read"` → `"PreToolUse"`) from the hook registry. The old camelCase→snake_case key conversion (`_translate_hso_to_codex`) is no longer applied — Codex 0.137.0+ uses camelCase throughout `hookSpecificOutput`.

Two Windows coarse-`mtime` correctness fixes. Both reproduce only when two writes land close enough together to share a filesystem timestamp — common on NTFS under load — which is why they surfaced as intermittent CI flakes rather than deterministic failures. Each ships with a deterministic regression test that fails on the pre-fix code and passes on the fixed code.

### Freshest cache entry survives its own store call's eviction

`evict_cache_dir` sorts eviction candidates oldest-first by `float(st_mtime)` with a stable sort. When the just-written (MRU) entry shares a coarse `st_mtime` with older siblings, the stable sort falls back to arbitrary `iterdir` order, which on NTFS can place the newest file first and evict it — so a `store_output` call could delete the very entry it had just written. `evict_cache_dir` now accepts a `protect_ids` set that is excluded from the victim list regardless of timestamp, and `skill_cache.store_output` passes the id it just wrote. Protected bytes still count toward the cap, so other candidates keep evicting; if only protected entries remain over cap the loop stops best-effort rather than deleting the fresh entry or looping forever. This is correct MRU policy and deterministic independent of `mtime` granularity.

### save() refreshes the process-local load cache

`session.load()` caches `(object, mtime)` per session and serves the cached object whenever `cached_mtime == current_mtime`. When a later `save()`'s post-write timestamp aliased the mtime a previous `load()` had cached, the proc-cache kept serving the stale pre-save object on the next in-process `load()` even though the on-disk JSON was correct and complete. `save()` now overwrites an existing proc-cache entry with the object it just persisted on every successful write, so the freshest state always wins. Only existing entries are refreshed — inserting new keys here would bypass `load()`'s LRU-cap accounting. The concurrency test that exercised this path also drops the proc-cache entry before its final assertion so it reads authoritative disk truth, and its barrier/join timeouts were widened so heavy xdist CPU contention cannot misread thread-scheduling latency as a lost edit.

## [1.5.1] - 2026-06-08

A round of correctness fixes for the cache size accounting, surgical reads, path normalization, and the Gemini hook bridge, plus two documentation corrections. No behavior changes to the happy path — these close gaps that surfaced under mixed-case names, uppercase WSL drives, compressed cache entries, and the Gemini wire format.

### Cache size accounting counts compressed bodies

Compressed cache entries store a zero-byte `<id>.txt` stub next to the real payload in an `<id>.gz` sibling. The size-accounting paths that iterate over `.txt` stubs — `evict_cache_dir`, `list_cache_outputs`, and the metadata stat loader — were measuring only the stub, so a cache full of compressed entries reported a near-zero footprint and never tripped LRU eviction. A single `gz_companion_size()` helper now lstats the `.gz` sibling and is added wherever iteration is filtered to `.txt` stubs, so the byte cap and oldest-first eviction see the true on-disk size. The whole-directory `iterdir()` sums in `doctor`, `clean-cache`, and `prune-cache` deliberately do not call it — they already count the `.gz` file as its own entry, and adding the companion there would double-count.

### Surgical reads cap oversized docstrings

`truncate_symbol_body` leaked an un-capped docstring through its small-body guard: a symbol with a short code body but a 60-plus-line docstring skipped the line cap entirely and returned the whole thing. The guard now applies the cap to the docstring independently of the code body, and the signature-boundary tuple it returns is corrected so the trailing class/def line is preserved rather than dropped.

### Uppercase WSL drive letters normalize

`normalize_path` converted `/mnt/c/...` to `c:/...` but its WSL regex matched only a lowercase `[a-z]` drive, so an uppercase `/mnt/C/...` matched neither the WSL branch nor the Windows drive-lowercasing branch and was returned fully unnormalized — fragmenting the session and cache key for the same physical file depending on how WSL reported the mount. The regex now accepts `[a-zA-Z]` and lowercases the captured drive, so `/mnt/C/foo` and `/mnt/c/foo` collapse to one canonical key.

### Compacts purge for mixed-case skill names

`invalidate_for_path` rebuilt the compact-file purge suffix from the raw skill name, but `_compact_file_id` lowercases the safe-name segment when it writes the file. A mixed-case skill such as `userSettings:brainstorming` was stored under `...-usersettings_brainstormingn-compact` while the purge suffix kept the original casing, so the `endswith` match missed and a stale compact survived the edit — `--compact` recall then served pre-edit content. The purge path now lowercases the segment the same way the writer does.

### Gemini hook bridge preserves systemMessage

The Gemini wire-format response handling dropped the hook `systemMessage` and folded everything into one channel. It now preserves `systemMessage` and routes `additionalContext` to Gemini's native channel, so compaction manifests and read hints reach the model the way they do under Claude Code and Codex.

### Documentation

- Install docs advertised a phantom `--gemini` flag; the supported path is `install --target gemini`, and the docs now say so.
- The worked example in the README referred to `shrink-image`; the command is `image-shrink`.

## [1.5.0] - 2026-06-07

Context-pressure awareness: one source of truth for how full the window is, and hints that get terser as it fills. Ships alongside three install fixes that restore hook forwarding under editable installs and silence a recurring `doctor` warning.

### Centralized context-pressure model

`get_context_pressure(session_id)` in `compact.py` is now the single place that answers how close a session is to autocompaction. It returns a frozen `ContextPressure` — a `fill_fraction` paired with a `tier` of `cool`, `warm`, `hot`, or `critical`. The estimate sums the known context contributors (loaded skill bodies, the ~10,800-token skills catalog, and per-event costs for bash history, web history, and read files) and divides by the fixed 660,000-token autocompact budget rather than the model's raw window, so the fraction carries the same meaning no matter which model is driving the session. The old `_estimate_context_fill` helper and the inline calculation in the session hook both defer to it, retiring the copies of the 660 K constant that had spread across half a dozen call sites in favor of one shared `CONTEXT_AUTOCOMPACT_TOKENS`.

### Named tier boundaries

The fraction-to-tier mapping lives in `tier_for_fraction()`, backed by three named constants: `CONTEXT_TIER_WARM` (0.50), `CONTEXT_TIER_HOT` (0.70), and `CONTEXT_TIER_CRITICAL` (0.85). The bands are cool below 0.50, warm up to 0.70, hot up to 0.85, and critical at or above it. With the magic numbers pulled out of the band checks, the boundaries are defined once and the tests pin them directly.

### Pressure-aware surgical-read hints

The pre-read hook tightens its large-file threshold as the window fills. A file earns a surgical-read suggestion past 500 lines while the session is cool, 350 when warm, 200 when hot, and 50 when critical. It also folds a single per-tier note into the read's additional context: "Context warming" at warm, "Context pressure" at hot, "CONTEXT CRITICAL" at critical. The note is fingerprinted by tier, so it fires once per band rather than on every read. Cool sessions get no note.

### Smaller manifests under pressure

`compute_adaptive_budget` now weighs context pressure when it sizes the compaction manifest. Once the window runs hot the budget is capped at 500 tokens, and at critical it drops to 300, so the manifest stops adding to the very problem it exists to summarize.

### Install robustness

**Hooks no longer silently disable themselves under an editable install.** The `tg-hook` wrapper carries an `if not exist "<sentinel>"` gate that short-circuits to a bare `{"continue":true}` during the `uv tool install --reinstall` race, when the venv's `token_goat` module is briefly absent. The sentinel used to be a hardcoded `site-packages/token_goat/__init__.py` path, which never exists under an editable install (`uv sync`, the project `.venv`), so the gate stayed permanently true and every hook no-op'd — the whole tool went dark with no error. The wrapper now resolves the sentinel through `importlib.util.find_spec("token_goat").origin`, which points at `src/token_goat/__init__.py` for editable installs and `site-packages/...` for regular ones, and falls back to an ungated wrapper when no sentinel resolves. A live handler emits `{"continue": true, "_tg_elapsed_ms": N}`; the `_tg_elapsed_ms` field is the tell that forwarding actually ran.

**Re-install purges orphaned `tokenwise` entries.** After the `tokenwise` → `token-goat` rename, a re-install left the old hook and permission lines stranded in `settings.json` and the Codex `config.toml`, so both harnesses kept invoking a binary that no longer existed. `patch_settings_json` and `patch_codex_config` now strip any pre-rename `tokenwise` command and permission entry before writing the current ones.

**Hook wrapper is written as bytes to stop CRLF doubling.** `hook_wrapper_content()` hand-bakes platform-correct line endings — `\r\n` on Windows — then was written through `atomic_write_text`, whose text-mode handle translated every `\n` to `\r\n` a second time, doubling each line ending to `\r\r\n` on disk. `cmd.exe` tolerated the stray carriage return so forwarding still worked, but `doctor` does a byte-exact compare of the on-disk wrapper against the regenerated content and warned `differs from expected — run token-goat install to refresh` on every run, a nag that reinstalling could never clear because it rewrote the same doubled bytes. The wrapper now goes through `atomic_write_bytes`, preserving the authored endings verbatim.

### Session-cache integrity

**Concurrent session saves no longer drop an edit.** The `save()` fast path skipped its compare-and-swap re-read and merge whenever the on-disk `(st_mtime, st_size)` fingerprint still matched the one captured at load. That fingerprint aliases: two caches whose keys are the same length serialize to byte-identical JSON sizes, and a float `st_mtime` rounds two sub-microsecond writes to the same value. When two writers collided on both fields the second skipped the merge and overwrote the first, losing exactly one edit — the 200-edit concurrency stress test intermittently saw 199. The fast path now consults an in-process version registry so a same-process writer that already advanced the version forces the stale save back through the merge, and the fingerprint is taken from integer `st_mtime_ns` instead of the rounded float, so a cross-process skip now requires a true nanosecond-and-size collision rather than a rounding coincidence.

## [1.4.1] - 2026-06-06

Three bug fixes surfaced by the pre-push WSL test suite.

### Bug fixes

**Compact file ID case normalization on Linux.** `_compact_file_id` and `get_compact_any_session` now both lowercase the skill name before constructing the compact file path suffix (`-freshskill-compact` rather than `-freshSkill-compact`). On case-sensitive Linux/WSL filesystems the mismatch caused `compact_coverage_score` to return 0 for mixed-case skill names (store wrote the file; lookup missed it) and the stale-fraction calculation in `_compute_stale_compact_fraction` to return 1.0 (cross-session glob matched nothing). Both code paths are now consistent with `store_compact`'s write path.

**`type: ignore` error code correction in `cli.py`.** Two `# type: ignore[arg-type]` comments on `int(compact_quality["score"])` and `list(compact_quality.get("issues", []))` suppressed the wrong error code. mypy reports `[call-overload]` for `int(object)`, not `[arg-type]`, so the annotations were no-ops and the errors surfaced when `warn_unused_ignores` is active. Changed to `# type: ignore[call-overload]`. Two parallel defaults in `hooks_skill._gen_compact_bg` were also corrected from `str | None` to `str` to clear `[assignment]` and `[union-attr]` errors.

**psutil `[import-untyped]` suppression.** `psutil` is now listed in the `[[tool.mypy.overrides]]` `ignore_missing_imports = true` group in `pyproject.toml`, clearing `[import-untyped]` errors in the five source files that import it.

## [1.4.0] - 2026-06-06

Forty-iteration self-improvement pass across four focus areas: context tracking depth, compact quality, output efficiency, and DRY/test hygiene.

### Context tracking depth (10 iterations)

`doctor --context` gains a richer, more actionable context footprint report. Fill is now shown as a visual bar with severity color (ok / warn / high / URGENT). The per-component breakdown lists every token source (skills catalog, loaded skill bodies, CLAUDE.md+MEMORY.md, conversation estimate) so the dominant cost is immediately visible. Session-to-session growth trends are derived from precompact sentinels: the report projects how many sessions remain until URGENT fill and shows the growth rate per session. Tiered compaction recommendations (Tier 0–4) surface the exact commands to run, ordered by impact. A Tier 0 over-capacity warning fires immediately when fill exceeds 100%. Conversation estimate is now tool-output-aware, incorporating bash and web history bytes for a more realistic fill figure. Edge cases (zero-byte sentinels, empty skill catalogs, missing sentinel files) are handled with graceful degradation and per-field error annotations.

### Compact quality and trigger improvements (10 iterations)

`score_compact()` — a new quality scorer — evaluates each compact on coverage density, heading structure, goal-marker presence, and rule-line signals. Scores are exposed in `skill-list --json` (`compact_quality_score`, `compact_coverage_score`, `compact_coverage_pct`) and in `skill-list` output via `[poor]`/`[fair]` flag annotations. SHA-staleness detection warns when the cached compact was built from a superseded body version; `skill-list --json` now includes a `compact_stale` boolean. Lazy injection falls back to cross-session compacts when the current-session compact is absent. `compact_age_secs` is added to skill-list output via a new `get_compact_mtime()` helper. Corrupted and empty compact files are guarded with explicit fallbacks in `get_compact` and `get_compact_any_session`. The skills directory listing inside `get_compact_any_session` is cached to eliminate redundant `glob()` calls per render. The stale compact fraction feeds an adaptive budget calculation for skill-degraded sessions.

### Output efficiency (10 iterations)

High-frequency output strings are compressed throughout the codebase. `tokens est.` → `~N tok` (saves ~6 chars per read header); `Referenced by:` → `Refs:` (saves 10 chars per symbol footer); `tokens` → `tok` normalized across all hint strings and the `_TERSE` substitution table. The `lang_breakdown` footer is suppressed for single-language projects and when the summary line already encodes language info, eliminating a redundant line in the vast majority of `map` outputs. Skeleton/outline savings accounting eliminates a double-format pass. Bash/web cache hint text is compressed. Manifest hint-telemetry shortened (`(N hints emitted)` → `(N hints)`). Unchanged-file and no-symbols-indexed hint text trimmed.

### DRY and test hygiene (10 iterations)

Repeated helper patterns extracted to shared modules: `make_bash_entry`, `make_bash_history`, `make_file_entry`, `make_cache` in compact test helpers; `apply_filter` from `filter_test_helpers` replaces 8 local `_compress` definitions; `_reset_cfg_cache` (9×) and `make_fake_session_cache` (2×) consolidated in test_config; `_call` (7×) and `_write_sentinel` (6×) hoisted to module-level in `test_context_growth_changes`; `FilterTestMixin` (9× `test_empty_input`, 4× `test_empty_output`) and `clear_process_guard` (4×) added to test infrastructure; `_strip_comments` (3×) extracted to `common.strip_cstyle_comments` in language adapters; `post_edit_sync` extracted to `hook_helpers`, `SkillPathsMixin` for 7 isolate copies; `make_symbol_emitter` factory eliminates 3× `_emit` closures in language adapters; `DataDirMixin` eliminates 35× `_isolate` fixture across 8 compact test files; `DirListingMixin` eliminates 5× `_isolate` in dir-listing tests.

## [1.3.0] - 2026-06-05

Context growth audit — four changes that cut session context size and make overhead visible.

### Context footprint in `doctor`

`token-goat doctor --context` now prints a **Context footprint** section measuring every token source that pads the context window each turn: the skills catalog (~10,800 tokens/turn for a typical install), loaded skill bodies accumulated in `system-reminder` injections, `CLAUDE.md` + `MEMORY.md` meta-files, and the rolling conversation estimate. The section shows fill % against the 660,000-token autocompact threshold, an ETA in turns at the current growth rate, and an **Actions** block naming the exact commands to run when any loaded skill above 2,000 tokens is missing a compact.

Auto-shown when estimated fill exceeds 40 % or any loaded skill > 2 K tokens lacks a compact; always shown with `--context`.

### Compact pre-generation at install time

`token-goat install` now runs `skill-compact --all` as a final step, so compacts are ready before the first session — no post-install warm-up turn required. A sentinel file (`skill_pregen_sentinel.json`) records the catalog count; the doctor section uses it to detect skills added after the last pre-gen pass.

### Per-skill compact advisory in `post_skill`

When a skill body lands in context, the `post_skill` hook now reports the compact's token savings inline (pre-generated compacts, sync-generated compacts for bodies < 40 KB, background-generated for larger bodies, info-only when no worker is running). Advisory fires only for bodies above 8 KB to stay silent for tiny skills.

### Threshold-crossing context advisory in `user_prompt_submit`

A lightweight ETA advisory fires the first time estimated context fill crosses 50 % and again at 70 %. The message is appended to the existing status line (bracket-joined, not a separate injection) and references `/compact now` at 70 %. Resets after each compact. Configurable via `hints.context_threshold_advisory = false`.

## [1.2.0] - 2026-06-05

14 commits since v1.1.0. Output overflow guard, cross-platform path normalization fixes, and a reliability pass.

### Output Overflow Guard

Surgical-read commands (`symbol`, `read`, `section`, `bash-output`, `web-output`, and the rest) now cap oversized output before it reaches the model. When estimated tokens exceed the cap, the output is head-truncated on a line boundary. A marker line is appended naming the cap, the truncation ratio, and the narrowing action — `symbol` users get directed toward `file::Class.method` lookups, `section` users toward sub-headings, cached-output users toward `--grep`/`--tail`.

Default cap: 25,000 tokens. Configure via `[overflow_guard] max_tokens` in `config.toml`, override with `TOKEN_GOAT_OVERFLOW_MAX_TOKENS=<n>`, or disable with `TOKEN_GOAT_OVERFLOW_GUARD=0` / `[overflow_guard] enabled = false`.

The estimator is deliberately conservative — 3 chars/token, same rate as the compaction manifest — so the cap is never under-applied. ANSI escapes are stripped before estimation since color codes inflate length without adding model-visible tokens. A single-line blob (no internal newlines) is sliced at the char budget so it cannot pass through whole.

### Cross-Platform Path Normalization

Two fixes that make path-keyed caches work correctly across Windows, WSL, and Linux:

**`normalize_path` / `paths.normalize_key`** — Drive-letter lowercasing (`C:` → `c:`) is now unconditional. The previous guard `sys.platform == "win32"` meant a WSL process that emits a Windows-format path (`C:/Users/…`) produced a different cache key than a native Windows process reading the same file. Both now produce `c:/users/…`.

**`hooks_skill.post_skill`** — Windows-style backslash paths like `C:\Users\user\.claude\skills\ralph` were not stripped on Linux because the inline guard used `_os.sep` (`/` on Linux) instead of the string literal `"\\"`. The inline block is now a call to `_normalize_skill_name`, which hardcodes `"\\"` and handles both separator styles on every platform.

### Reliability

- **Worker dirty-queue torn writes.** Concurrent `_append_dirty` calls could produce truncated or concatenated JSON lines under write contention. An OS-level file lock (`fcntl` on POSIX, `msvcrt` on Windows) now serializes appends, same as the session cache.
- **SQLite WAL checkpoint mode.** Changed from `RESTART` to `PASSIVE` on connection open. `RESTART` waited for all readers to drain, blocking hook subprocesses for hundreds of milliseconds during active indexing. `PASSIVE` checkpoints cooperatively and does not wait.

## [1.1.0] - 2026-06-04

57 commits since v1.0.1. Six new language indexers, twenty-plus new CLI commands and flags, a pre-skill hook that cuts repeat skill loads from 40–65k tokens to ~400, pnpm/yarn/bun compress filters, rg/grep dedup hints, double-daemon prevention, and a reliability pass with 400+ new tests.

### Skill Re-load Prevention

The most wasteful thing a long session does is load the same large skill twice. `/ralph`, `/superman`, `/improve` — each injects 40–65k tokens every time. By the third invocation you've paid for three full copies of the same rules.

A new `PreToolUse(Skill)` hook now fires before every Skill invocation. When a skill was already loaded in the current session and no compaction has fired since, the reload is blocked. The cached compact form (~400 tokens) is served via `additionalContext` instead. Falls back to a recall-pointer message when no compact is available.

Compaction awareness: the manifest-SHA sidecar's mtime is compared against the skill's session load timestamp. If compaction fired more recently, the hook allows the reload rather than blocking it — the skill may have been evicted from context.

An opt-in `first_load_compact` flag (default: off) extends this to first loads for skills with a `<!-- COMPACT_END -->` marker. Only the curated compact section is served; the full body stays accessible via `token-goat skill-body <name>`. Enable only after verifying your skill compacts are functional standalones.

Config: `[skill_preservation] pre_skill_enabled = true` (default on), `first_load_compact = false`. Disable via `TOKEN_GOAT_PRE_SKILL=0`.

### New CLI Flags

- **`symbol --context N`** — emit N lines of surrounding source around each match in both text and JSON output.
- **`symbol --json`** — structured `{file, line, kind, snippet}` output for downstream tooling.
- **`outline --min-lines N`** — filter sections by minimum body size; skip stub headings.
- **`outline --max-depth N`** — cap tree depth.
- **Outline line counts** — each section header now shows its line span.
- **`web-output --list`** — show all cached web responses with size, age, and URL.
- **`map --filter GLOB` / `--since-minutes N`** — focus map output to recently-changed or name-matched files.
- **`stats --since DAYS`** — alias for `--window`.
- **`token-goat recent`** — session-aware file recency: edited → read this session → git history, with cross-tier deduplication.
- **Bash history exit codes** — non-zero exits now show `[exit:N]` in the history entry; commands truncated to 100 chars.

### Package Manager Filters

pnpm, yarn, and bun bash compress filters added. `pnpm run`/`yarn run` now route through their own filters instead of falling through to the generic handler. `pnpm exec`/`dlx` pass through unchanged (were incorrectly matching the install filter).

### Context Savings

- **`rg`/`grep`/`ag` dedup.** Bash `rg` and `grep` invocations now fire dedup hints and record to `session.greps` the same way the native Grep tool does. Repeat searches return a cached match-count hint instead of re-running.
- **Top-5 file guarantee.** The five most-accessed files always appear in the compaction manifest, in a protected section that survives the safety trim.
- **Scope for new file types.** CSS, SQL, GraphQL, and Makefile symbols now participate in scope resolution via `token-goat scope`.
- **Web content-type stored.** The sidecar now carries content type so `web-output --section` can route heading-based lookups correctly.
- **Session hint min-savings threshold** configurable — suppress hints that would save fewer than N tokens.
- **Glob tracking.** File paths from Glob calls are tracked in session history for dedup hints.
- **Pre-read skips binary/large files** to avoid wasted processing on non-text content.
- **HTML stripping** for web output before section extraction.

### Reliability

- **Stale .flock sidecar eviction.** `.flock` and `.tmp` files left by crashed hook processes are now swept during session cleanup.
- **WSL path guards in bash_parser.** Backslash normalization and Windows system path detection work correctly on WSL-mounted paths (`/mnt/c/windows/`, `/mnt/c/program files/`).
- **BOM stripping.** `decode_source_text` strips UTF-8 BOM for all new indexers.
- **Worker stale PID cleanup.** `kill_duplicate_daemon` now removes the stale PID file rather than leaving it for the next startup to trip over.
- **CI harness detection.** `TOKEN_GOAT_HARNESS_OVERRIDE` env var lets CI runners force `detect_harness()` to return a specific value, fixing 113 test failures that appeared when running without a Claude Code session.
- **sqlite3.Row end_line fix.** `symbol --json` was using `.get()` on `sqlite3.Row` objects, which don't support attribute-style access; fixed with a proper column-name key lookup.

### Quality and Tests

- **400+ new tests** across all changed modules.
- Session fixture isolation: `tmp_data_dir` prevents the 5-9s WAL checkpoint overhead per test that appeared when tests touched the production global.db.
- `uv --version` subprocess mocked in doctor tests: eliminates the 6s overhead per invocation.
- Synthetic image dimensions reduced from 1600×1200 to 1100×825 in image tests: long edge still exceeds `MAX_LONG_EDGE` so all shrink behavior is exercised, but pixel generation drops ~60%.
- `uv` dependency caching added to CI: `enable-cache: true` + `cache-dependency-glob: uv.lock` eliminates 2–5 min of package install per run.

### New Language Indexers

- **CSS/SCSS.** Extracts class, id, keyframe, mixin, function, and variable selectors; emits `@import`/`@use`/`@forward` as refs.
- **SQL.** Extracts `CREATE TABLE/VIEW/INDEX/PROCEDURE/FUNCTION/TRIGGER` symbols; identifies DML refs.
- **GraphQL.** Extracts type, interface, union, enum, input, fragment, and directive definitions; emits field and argument refs.
- **Protobuf.** Extracts message, enum, service, rpc, and option definitions; emits field and import refs.
- **`.env` files.** Extracts variable names as symbols for surgical reads.
- **Makefile.** Extracts rule targets as symbols; emits prerequisite refs.
- **`.mts`/`.cts` extensions.** Registered as TypeScript variants for tree-sitter dispatch.

### New CLI Commands and Flags

- **`token-goat refs --callers`** — resolves the enclosing function for each reference site via a SQL JOIN on the symbols table, so a single call gives you "called from `foo()` at line N" context.
- **`token-goat changed --symbol`** — shows which symbols changed between HEAD and working tree.
- **`token-goat config-get FILE KEY`** — dot-notation value extraction from TOML/YAML/JSON/INI (e.g. `config-get pyproject.toml project.version`).
- **`token-goat version`** — shortcut showing installed version.
- **`token-goat install --check`** — shows autostart registration status and whether the entry matches the current interpreter.
- **`token-goat stats --by-command`** — per-command-type savings breakdown (`symbol`, `refs`, `changed`, etc.).
- **`token-goat index --ext`** — selective re-indexing by file extension (repeatable: `--ext py --ext ts`).
- **`token-goat bash-output/web-output --section HEADING`** — retrieve one section from a cached output by heading rather than reading the whole blob.
- **`token-goat worker --kill-duplicate`** — kills a running worker whose interpreter path differs from the current Python executable (handles the cross-interpreter double-daemon case).
- **`token-goat worker --status`** — shows running worker PID, interpreter path, uptime, and pool size.
- **`--quiet` flag on `symbol`, `refs`, `changed`, `outline`** — suppress prose preamble, emit JSON only.
- **Unified `{"query":…,"results":[…],"total":N}` JSON envelope** across `symbol`, `refs`, `outline`, `changed`, `exports` — downstream tooling parses a consistent shape.

### Double-Daemon Prevention

- **JSON PID file format.** `_write_pid()` now writes `{"pid":N,"started_at":"…","interpreter":"…","version":"…"}` instead of a bare integer. `_read_pid_info()` parses both the new JSON format and the legacy plain-integer format for backward compatibility.
- **Cross-interpreter startup guard.** When `_try_claim_worker_slot()` returns `None`, `run_daemon` reads the PID file to surface the competing worker's interpreter path in a `WARNING` log entry. Users can immediately identify a multi-interpreter collision via `token-goat doctor` or the log file.
- **Post-write PID verification.** After `_write_pid()`, `run_daemon` re-reads the file and compares the PID to `os.getpid()`. If another process raced and overwrote it (theoretically impossible with the O_EXCL claim file but defensively guarded), the daemon exits before entering the main loop.
- **`install --check` and autostart dedup.** Re-installs detect an existing autostart entry pointing to a different interpreter and replace it, preventing multi-interpreter accumulation in the registry/systemd/XDG layer.
- **11 new regression tests** covering each prevention path: claim-slot held, WARNING log with interpreter, PID race window exit, normal startup when PID matches, and the full PID file format round-trip.

### Cross-AI and Harness Improvements

- **OpenCode bridge error guards.** `spawnSync` failures and non-zero exit codes are handled gracefully in both the opencode and openclaw bridges.
- **Gemini WebFetch key-map fix.** Gemini harness passes `url` instead of `input`; remapped at the hook boundary.
- **Codex unknown-tool WARNING.** Unrecognized Codex tool names now emit a single WARNING instead of silently dropping the hook event.
- **`UnicodeDecodeError` in hook payloads.** Non-UTF-8 hook payloads previously propagated the exception; now treated as `{}` at the read boundary.
- **Install docs updated.** `CLAUDE_MD_CONTENT`, `SKILL_MD_CONTENT`, and `CODEX_AGENTS_MD_CONTENT` document the new commands added this cycle.

### Reliability

- **Atomic sentinel writes.** All sentinel files in `hooks_cli.py` now use `paths.atomic_write_text()` (temp + `os.replace`) to eliminate partial-write corruption.
- **Worker pool size cap.** `[worker] max_pool_workers` config key (default 4, ceiling 8, `TOKEN_GOAT_WORKER_MAX_POOL` env override) prevents runaway thread spawning on large repos.
- **WAL checkpoint on DB close.** Non-fatal `PRAGMA wal_checkpoint(TRUNCATE)` added to write-session close; bounds WAL file growth between worker cycles.
- **`with_timeout` row factory fix.** `sqlite3.Row` row_factory was missing from the `with_timeout` connection path; affected callers got plain tuples instead of named-column rows.
- **Snapshot truncation at 50 KB.** Large-file snapshots are capped at `SNAPSHOT_TRUNCATE_BYTES` (50 KB) to bound disk use; SHA integrity check added to `symbol_changed_since_read()` so corrupt snapshots are treated as missing rather than emitting phantom diff hints.
- **Multi-file `cat`/`Get-Content` detection.** `bash_parser.py` now returns all paths from a multi-file `cat a b c` or `gc f1 f2` command, not just the first one. `post_bash` marks every file in session history so the "already read" dedup hint fires on repeat access of any file in the batch.
- **PowerShell `Get-Content` extended.** `bash_parser` now handles `Sort-Object`, `ForEach-Object`, `Tee-Object`, `Measure-Object`, `Group-Object`, and `ConvertTo-*` as passthrough cmdlets; `Where-Object -notmatch`/`-notlike`; `-Wait` flag (tail -f equivalent); `-Include`/`-Exclude`/`-Filter`/`-Stream`/`-ReadCount` as unconditional arg-consumers so glob patterns and stream names are never mistaken for file paths. Install content (CLAUDE_MD, SKILL_MD, CODEX_AGENTS_MD) and routing table now include `Get-Content` as a read-equivalent alongside `cat`/`bat`.
- **`_enforce_char_budget` off-by-one fix.** Budget counted N newlines for N kept lines instead of N-1, overcounting by 1 character per line. On tight budgets this caused manifest sections to be truncated earlier than necessary.
- **Dirty-queue `UnicodeDecodeError` fix.** Binary or truncated `dirty.txt` entries no longer crash the worker; `errors="replace"` applied on read.
- **macOS `LaunchAgent` `KeepAlive`.** Changed from `true` (always restart) to `{SuccessfulExit: false}` (restart only on crash).
- **WSL detection helper.** `is_wsl()` extracted to `util.py`; crontab availability pre-checked on POSIX before attempting CronCreate hook.

### Context Savings

- **Session-aware `recent` tier.** `token-goat recent` now shows a "read this session" tier between edited and git-history tiers, with cross-tier deduplication.
- **Branch name in compact manifest.** Manifest header includes `branch: <name>` via `git symbolic-ref`; detached HEAD handled gracefully.
- **Surgical-read hints for new indexers.** `hints.py` emits per-type hints for CSS/SCSS, SQL, GraphQL, Proto, `.env`, and Makefile files with per-type size thresholds.
- **Fuzzy file matching with did-you-mean.** `read_commands.py` falls back to fuzzy basename matching when a file is not found; suggests candidates in both text and JSON output.
- **Manifest section ordering.** Fixed to `edited → recent_commits → symbols → key-files → skills`; cross-section symbol dedup regression guard added.

### Quality and Tests

- **200+ new tests** across all changed modules.
- **Parametrized indexer dispatch tests.** 22 individual dispatch tests converted to `@pytest.mark.parametrize` in `test_parser_*.py`.
- **Cross-platform compat tests extended.** `test_cross_platform_compat.py` now covers the `languages/` directory (26 files) with type-alias-statement, deprecated-stdlib, and `tomllib` fallback checks.
- **Unified JSON schema consistency tests.** `test_json_schema_consistency.py` verifies the `{"query":…,"results":…,"total":…}` envelope across all affected commands.
- **Per-language index breakdown.** `token-goat index` shows a per-language file count when multiple types are present.
- **Config type validation.** Numeric config values are validated with actionable error messages; `doctor` shows the config file path.

## [1.0.1] - 2026-06-02

Bundles two 50-commit improvement runs: a skill-cache / context-savings accuracy loop (source_sha stale-compact detection, separate compact/body eviction buckets, sidecar schema v2, lazy skill injection, gzip web-cache compression, serve-diff-on-reread, session-hint cooldown) and a general quality loop (type safety, error handling, performance, security, test coverage, code clarity, DRY, docs, observability, imports). Also fixes broken stats accounting for `bash_output_cached`, `skill_cached`, `web_output_cached`, `symbol`, `map`, and `semantic` lookup savings, and adds RuffFilter and MypyFilter bash-compress support.

### Bash compression

- **Nine new filters (22 → 31 total).** `eza` / `exa` / `ls` (directory listings trimmed to header + 25 + 5 entries; `--tree` mode keeps 40 + 10), `tree` (50 + 10 + final summary line), `fd` / `fdfind` (path lists trimmed to 35 + 5), `bat` / `batcat` (strips ANSI chrome and box-drawing borders, caps at 50 lines), `delta` (strips decorative separators, caps at 80), `jq` (caps at 200 preserving closing brackets), `yq` (caps at 150), `fzf` (compact selection output, caps long upstream pipes at 50), `lazygit` (detects TUI mode and returns an actionable note instead of raw control sequences).
- **GhFilter list truncation.** `gh pr list`, `gh run list`, and `gh issue list` tabular output is now capped at 30 rows with a count summary.
- **`_head_tail_compress` helper.** Shared head + tail + marker slicing extracted from 8 filter classes, eliminating repeated boilerplate.
- **RuffFilter and MypyFilter.** New filters compress ruff check and mypy output, stripping redundant context lines and capping verbose diagnostic blocks.

### Reliability

- **`project not yet indexed` diagnosis.** `spawn_index_detached` now routes stderr to `index-spawn.log` instead of `DEVNULL`, making silent AV/import failures visible. `_not_indexed_hint` distinguishes three states: *indexing in progress* (PID alive), *spawn failed* (marker exists, PID dead), and *not yet started*. `_auto_index_if_needed` now warns in logs when the spawn returns no PID.
- **Consistent LRU eviction for `hints_seen` cap.** `mark_hint_seen` and `_merge_session_caches` now apply the same LRU strategy (evict lowest-count entries) when `hints_seen` exceeds the 500-entry cap, preventing dedup state thrashing.
- **Type annotation shadow fix.** Variable shadowing in `compact._allocate_manifest_budgets` eliminated; `no-redef` mypy error resolved.
- **Hook dispatcher error logging.** Clarified the top-level exception safety net in `hooks_cli` dispatcher to log via `_LOG.exception()` instead of silently swallowing errors.

### DRY

- **`load_session_safe` helper in `hooks_common`.** Centralises the repeated `try/except(OSError, ValueError)` session-load pattern from `hooks_read`, `hooks_edit`, and `hints` into a single fail-soft helper.
- **`hints.py` dedup guard helpers.** `_check_dedup_preconditions`, `_check_entry_staleness`, `_check_dedup_min_threshold`, and `_record_dedup_hint_emitted` extracted from the four dedup builders, eliminating ~150 lines of duplicated guard logic.

### Compaction

- **Clearer manifest section headers.** `Syms` → `Symbols Accessed`, `Ran` → `Recent Commands`, `Web` → `Web Fetches`, `Grep` → `Patterns Searched`.

### Tests

- **~20% test suite wall-time reduction.** Eviction tests reduced from 4098 to 100 files; session-cache parameter added to manifest-trim and line-range loops to avoid repeated disk I/O.
- **Integration tests for new filters.** Nine integration tests verify each new filter family dispatches correctly through the hook pipeline.
- **Edge case coverage for `_not_indexed_hint`.** Tests cover malformed marker files and missing locks directory.

### Skill cache

- **`source_sha` in compact headers.** Embedded SHA enables stale-compact detection: the pre-read hook emits an advisory when a skill body changes on disk after the compact was cached.
- **Separate eviction buckets.** Compact slices (1 MB cap) and full bodies (5 MB cap) evict independently so a large body cannot push out all compact entries.
- **Sidecar schema v2.** Forward-compatible sidecar metadata with graceful migration for v1 entries.
- **Lazy skill injection.** The compaction manifest emits a `token-goat skill-body --compact` recall pointer instead of the full compact text; reduces manifest token cost for sessions with many loaded skills. Opt-out via `TOKEN_GOAT_LAZY_SKILL_INJECTION=0`.
- **Gzip body compression for skills ≥ 16 KB.** Transparent decompression on read; reduces eviction pressure.

### Context savings

- **Stats accounting fixed.** `bash_output_cached`, `skill_cached`, and `web_output_cached` now record actual `bytes_saved`; previously always 0. `symbol`, `map`, `section`, and `semantic` lookup stats record `estimated_full_size − slice_size` as savings.
- **Serve diff on re-read (opt-in).** `[read_hints] serve_diff_on_reread = true` intercepts re-reads of changed files and returns a unified diff instead of the full content.
- **Gzip compression for web-cache bodies ≥ 16 KB.** Same pattern as skill body compression; reduces disk footprint and eviction churn.
- **Session-hint cooldown.** Each file's session hint is suppressed after first emission within the session; `session_hint_suppressed` stat tracks the bypass rate.
- **Unified token formula.** `max(1, bytes // 3 + 1)` replaces inconsistent `bytes // 4` across all accounting sites.
- **Stats category grouping.** `token-goat stats` groups kinds by Read / Bash / Cache / Hints / Skills / Other.

### Quality

- **Type signatures strengthened.** `Any` parameters replaced with concrete types; `_lookup_in_cache` and `_render_section` made generic with `TypeVar`.
- **Exception chaining.** `raise ... from e` added at key error propagation points; bare `except` clauses replaced.
- **Regex patterns hoisted.** 16 in-function `re.compile()` calls in `bash_compress.py`, `compact.py`, and `bash_cache.py` moved to module/class level (pre-bash and pre-compact hot paths).
- **File permission hardening.** Lock files and session contention marks set to `0o600` (previously `0o644` or implicit umask).
- **DRY helpers.** `path_mtime_key()` added to `cache_common`; `_extract_grep_args()` and `_get_bash_command_from_payload()` extracted in `hooks_read`.
- **Debug log coverage.** Silent decision points in `bash_compress`, `cache_common`, `compact`, and `hooks_cli` now emit DEBUG records.
- **55 new tests** covering coverage gaps, error-handling paths, permission modes, and DRY helper contracts.

## [1.0.0] - 2026-05-29

Bundles the work from the 35-iter `/improve` run (six themed loops, 2026-05-25 → 2026-05-26): compaction hardening, doctor visibility, opt-in observability, four new bash-compress filters, and a stack of reliability fixes. First stable release under Semantic Versioning.

### Compaction

- **`compact-hint` mirrors live PreCompact gates.** The CLI preview now applies the same `enabled` flag, trigger membership, compact-skip sentinel fast-path, `min_events` gate, sidecar cache, and `auto_trigger_multiplier` boost as the live hook, so the previewed output matches what would actually be emitted. New `--trigger auto|manual` option simulates each trigger class (`4d0a618`).
- **Pressure-aware manifest sizing.** Auto-trigger compactions (Claude Code's context-pressure-fired `/compact`) get a `auto_trigger_multiplier`-scaled budget (default 2.0×). Manifests gain a `RESUME` pointer and a blocker-error preview block so the post-compact recovery hint can surface the in-progress work and the most recent error without a round-trip (`c827767`, `09d2dc5`).
- **Priority-aware safety trim.** When the per-section budget split is still over budget after row-level compaction, low-signal sections are dropped wholesale rather than soft-truncated mid-row (`305a650`).
- **Activity floor + configurable TTL on compact-skip sentinel.** `[compact_assist] compact_skip_ttl_secs` (default 300 s) replaces the hard-coded fast-path window; the sentinel is busted whenever session mtime > sentinel mtime, so an idle session can short-circuit aggressively while an active session always re-evaluates (`0c1beea`).
- **Manifest sidecar hardening.** Sidecars with future-dated `emit_ts` or corrupt headers are rejected and re-emitted from scratch rather than served as stale cache hits (`8f5c003`).
- **Opt-in decision log.** New `[compact_assist] decision_log` surfaces the agent's recent reasoning as a manifest section, so post-compact the LLM can pick up the why behind the last batch of edits (`0ffb741`).
- **Manifest budget telemetry.** Per-emit budget / actual-tokens / scaled-budget triples are recorded as stat kinds and surfaced in `doctor` (`48d477b`).

### Doctor

- **Installation-status section.** `doctor` now reports each of the four install targets (settings.json, CLAUDE.md, skill, autostart) with present / drift / missing, plus a fastembed ONNX model file check (`f2fa89c`).
- **Cold-import timing + cache hit rates.** Surfaces the first-call import budget for the heavy modules (`compact`, `session`, `parser`) and the cache hit rate per cache type, so degraded performance is visible at a glance (`fc19a1c`).
- **Opt-in flag inventory.** `doctor` lists every opt-in flag's current value (json_sidecar, decision_log, skill_preservation, …) with the durable hash format used to detect drift between runs (`008e937`).
- **`canonical_root` sanity.** Doctor confirms project root → canonical-root → project-hash round-trips cleanly, catching the cross-platform path-normalisation edge cases tested in `tests/test_paths.py::test_normalize_key_*` (`97a9af2`).

### Bash compression

- **Four new filters.** `gh` (GitHub CLI output, with progress-line and JSON-block awareness), `go test` (test result grouping with `--- FAIL` block preservation), `ansible` (play-recap + task summary), and `pre-commit` (hook-by-hook grouping with full diff preservation). Filter count: 18 → 22 (`22d501f`, `bb63b40`).
- **Filter base refactor.** Shared `_finalize` and `_emit_notes` helpers extracted onto `Filter` base; eliminates ~120 lines of per-subclass boilerplate (`a8db957`).

### Hints + recovery

- **Opt-in structured-JSON sidecar.** `[hints] json_sidecar` (or `TOKEN_GOAT_HINT_JSON_SIDECAR=1`) prepends a single-line JSON sidecar to every dedup / re-read / unchanged-file / structured-file hint. Prose lines are preserved verbatim — dedup fingerprints, curator metrics, and tests stay intact (`3a2b102`).
- **Post-compact recovery hint upgrades.** Surfaces current-blocker error preview, `RESUME` anchor, and per-file edit badges (`09d2dc5`).
- **Predictive snapshot attribution.** Predictive prefetched snapshots are tagged so diff-hint records can be attributed back to the prefetch path; new `predictive_prefetch_hit` stat kind captures the win (`c79aca5`). Snapshots also survive `TYPE_CHECKING` blocks and multi-line imports (`b8211a1`).

### Reliability

- **`paths.ensure_dir` on hot-path mkdirs.** Eliminates the residual race-tolerant-mkdir bug class on Windows under heavy disk pressure (`e0a34e4`).
- **`paths.has_windows_drive_prefix` promoted to public API.** Single canonical check used by `safe_join`, `canonical_root`, and doctor (`97a9af2`).
- **Snapshot SHA-verification before diff hint.** A corrupt snapshot file no longer fires a phantom diff hint; SHA is validated against the recorded hash before the bytes are trusted (`0192634`).
- **Orphan `json.lock` sidecar reaping.** `session.cleanup_stale` now also removes orphaned session lock sidecars; was leaking sidecars on hard process kills (`21fbdcf`).
- **`worker.heartbeat_stale_threshold()` derived from interval.** No more magic numbers — staleness threshold is `2× worker interval`. New `is_heartbeat_stale_for_nudge()` consumer for the session-start "worker is down" nudge (`42615e5`).
- **Operator-tunable hook watchdog.** `TOKEN_GOAT_HOOK_WATCHDOG_MS` overrides the hook deadline for slow CI / cold-cache machines (`0f6ee8f`).
- **Cache truncation respects UTF-8 boundaries.** Byte-bounded cache writes now truncate on a valid UTF-8 codepoint boundary; orphan-sweep gains an ownership guard so a foreign sidecar in the cache dir is never deleted (`a1a3990`).
- **Marketplace skill plugin path resolution.** `skill_cache` now also resolves the `~/.claude/plugins/<marketplace>/skills/...` layout, with a walk-based eviction fallback for skills that escaped the LRU index (`5d54b6d`).

### Stats

- **Surgical-read adoption surface.** New stat kinds (`<read>_lookup` and `<read>_overhead` per `symbol|read|section|semantic|map`) track each surgical-read command's adoption + per-call overhead. `doctor` now warns on unmapped kinds so silent stat drift is loud (`a775c11`, `bf8f45b`).
- **Bash + web telemetry.** `bash_dedup_stale`, `web_dedup_stale`, `bash_output_recall_miss`, `web_output_recall_miss` stat kinds added (`cecdb68`).
- **Repomap cache-pollution fix.** Filter cache pollution at the source; scale `compact_top_n` instead of using a flat constant; new `map_lookup` stat kind (`8a652f2`).
- **Format-aware image-shrink threshold.** Per-format byte thresholds (PNG vs JPEG vs WebP) prevent over-eager compression; new `image_shrink_skipped` stat kind tracks the bypass rate so the threshold can be tuned against data (`a47ad53`).

### Security

- **SSRF audit gaps closed.** WebFetch now blocks `172.16.0.0/12`, `127.0.0.0/8`, CLI-supplied bypass attempts, and a DNS-rebinding edge that previously slipped through the resolver pin (`8060f67`).

### Refactors

- **Shared pre-read hint pipeline.** Pre-read hint sequence + stats denominators extracted into a shared helper; eliminates the four near-duplicate pipelines (`37843fd`).
- **Install hooks merge/strip + color-stream helpers extracted** (`cccece1`).
- **`scan_flat_headers` unifies the flat-config index loop** across `toml_idx`, `yaml_idx`, `json_idx`, `ini_idx`, and `dockerfile_idx` (`517133e`).

### CI / test infra

- **Per-test timeout raised 30 → 60 s** for the lock-loop tests that trip Windows runner load (`3130f79`).
- **`xdist` stdio reconfigure removed.** A `sys.stdout.reconfigure(...)` call in `conftest.py` was corrupting the `execnet` pipe pytest-xdist uses to talk between controller and workers on Windows. Replaced with a worker-scoped skip + `contextlib.suppress` (`72fab20`, `136c983`, `4ef6e64`).
- **`MSYS_NO_PATHCONV` documented** for Git Bash `gh api /repos/...` calls (`4e43ab8`).

## [0.9.0] - 2026-05-25

Bundles three improvement loops landed since 0.8.0 (37-iter context/compaction on 2026-05-25, 68-iter reliability/perf on 2026-05-24, 55-iter context-savings baseline). Headlines: SSRF DNS-rebinding fix, hook registry single-source-of-truth with startup alignment gate, race-tolerant Windows `mkdir`, manifest format shortening + delta tracking, CI split into fast/slow tiers, and cross-harness wire-format compatibility coverage.

_From the 37-iteration loop (2026-05-25):_

### Security

- **DNS rebinding window closed in SSRF guard.** `webfetch.py` now resolves once via a new `_resolve_and_validate_ip()` and pins the connection to that IP via a custom `_make_pinned_transport()`. Previously a hostile DNS server could return a public IP to the validation query and a private IP (e.g. 169.254.169.254 IMDS) to httpx's reconnect (`22bcd56`).
- **`paths.safe_join()` promoted as canonical fragment joiner.** Two raw joins that took user-controlled session_ids now flow through it; sanitises null bytes, `..`, absolute paths, and Windows-illegal colons (`197acd9`).
- **`dispatch()` ensures `continue=true`.** Handlers returning `{}` or any dict missing `"continue"` would otherwise become harness-blocking responses. Crash-sink boundary now sanitises tracebacks before all three sinks (stderr, logger, file), not just the file write (`b04eee5`).

### Reliability

- **Surrogate-escape crash fix.** `post_bash` was crashing 1,311 times/week in production with `UnicodeEncodeError: 'utf-8' codec can't encode character '\udcXX'`. New `util.sanitize_surrogates` applied at the boundary in `post_bash` right after `_extract_bash_response` (`6fdba43`).
- **Hook registry consolidated to single source of truth.** New `hook_registry.py` declares each event once; five derived tables read from it. A startup `_assert_hook_registry_aligned()` raises `ImportError` if any registry event lacks a matching `@hook_app.command` decorator. Eliminates the recurring drift bug class. Bridge TS event tables get an alignment regression test (`930033c`, `1408673`).
- **Persistent hook wrapper survives `uv tool install --reinstall`.** A `.cmd` at `data_dir/bin/tg-hook.cmd` lives outside the uv tool venv; checks for `token_goat/__init__.py` on disk before forwarding to pythonw, otherwise emits `{"continue":true}` and exits 0. Drift surfaced in `doctor` (`e53d553`, `48193ad`).
- **Orphaned project GC.** Worker removes global.db rows + per-project `.db`/`.db-wal`/`.db-shm` for missing-root projects with 30-min safety window. Race-safe DELETE with `last_seen` predicate prevents TOCTOU loss (`ec60af0`, `009d2ba`). Reclaims 2.3 GB on the audited install.
- **`save_locked` no longer proceeds without lock on timeout.** After 3 consecutive `_acquire_session_lock` timeouts, `cache.unavailable = True` and the writer short-circuits (`6453310`).
- **Session schema version enforced on load.** Cached mismatch drops the cache and starts fresh (`e6f40b2`).
- **Worker SIGTERM handler.** Explicit `_graceful_shutdown` wired for SIGTERM + SIGINT on POSIX (`47a4faf`).
- **TOML config schema warning.** `config.py` warns on unknown top-level sections (catches `[compact_assit]` typos) (`479b763`).
- **`hooks-stderr.log` test isolation.** 230 KB / 316 crash blocks of test garbage were polluting the production crash sink. Autouse conftest fixture redirects test runs to `tmp_path` (`4e940d7`).

### Token Savings — hints / manifest / hot path

- **Manifest format shortening bundle.** `_format_ranges` emits `L:X-Y` not `lines X-Y`; cold/recent bash entries drop the `id=` label and shorten `exit=` to `e=`; `_MAX_TODO_SUBJECT_CHARS` lowered to 50. ~71 tokens/manifest (`f9b583f`).
- **Active-skills section collapsed.** Per-skill bullets with full recall → single `**Skills:** name1, name2, … — recall via token-goat skill-body <name>`. ~160 tokens/6-skill manifest (`3564410`).
- **Adaptive `_MAX_BASH_ENTRIES`.** Scales with bash_history length instead of fixed at 6 (`e60c867`).
- **Clean-repo session brief one-liner.** When in-sync on stable branch with no uncommitted, brief collapses to `"<branch> (clean)"` from a multi-line structured block (`3970702`).
- **status_lines cap.** 50 entries max + `(+N more files)` summary; dirty-tree SessionStart was emitting 3-5 KB (`e5347a8`).
- **Failed-tiny-bash signal.** Tiny output + exit ≠ 0 now appends to `bash_history` so manifest's Current Blockers picks it up (`70a3066`).
- **Single rev-list + adaptive git-log entry count.** Two rev-parse subprocesses collapsed into one `rev-list --left-right --count`; in-sync repos skip the git-log section entirely (`a234855`).
- **Glob-dedup cache capped at 20 paths + grep-after-edit hint capped at 5** (`08dd016`).
- **user-prompt-submit short-circuit on prompts <8 chars** (`022330a`).
- **Long grep patterns truncated in hints + micro-diff one-liner** (`3d13252`).
- **Basename in already-read hint prose + proximity check** to suppress false positives when the agent is reading a far section of a file (`076bacb`).
- **Snapshot-diff hint range-overlap check** suppresses the hint when read range doesn't overlap edited range (`71088db`).
- **Repomap collapses low-PageRank tail** to `(+N minor files)` in compact mode (`a7c90ad`).
- **Image alt-text drops `→ N KiB` when savings ratio < 4×** (`b71cf83`).
- **WebFetch HTML strip before caching** — 60-90% byte reduction for HTML pages (`2b4caea`).
- **web-output --grep recall hint once-per-session** (`a4e67c7`).
- **Process-local LRU on `session.load()`** mtime-keyed, cap 4 — skips JSON parse for back-to-back hooks (`5ea945f`).
- **Pytest banner + ruff success suppression in bash_compress** (`d0a29cd`).

### Performance

- **Test suite 22% faster.** Eviction tests were doing 200-500 real disk writes each. `patch.object(session, "save")` makes them in-memory; round-trip persistence covered separately (`9798981`).
- **Hot-path utf8 byte-length simplification** + **11 lazy session imports consolidated** in hooks_read.py (`e7f165b`).
- **`cli_doctor` global.db connection reuse** between sections 14/14b (`4c77089`).
- **Bash-outputs file-count cap + always-on orphan sweep.** `evict_cache_dir` gained `max_file_count=4096`; orphan-sidecar sweep moved before the early return. Doctor flags file-count overage (`09a527a`, `b64a714`).
- **DB contention metric in doctor.** Scans worker-stderr.log for `session slow` warnings in last 24 h (`1b11b49`).

### DRY

- **16 git subprocess sites → `util.run_git()`.** Always sets `--no-optional-locks` + UTF-8 with `errors="replace"`. Regression test asserts no other bare git subprocess calls remain (`2d18337`).
- **`cache_common.safe_cache_op` context manager** (`c4b9e54`) + **`cache_common.store_blob` for atomic blob writes** (`58306b9`).
- **`cache_common.short_content_hash()` unifies hash logic** across bash/web/skill caches (`47072d6`).
- **`paths.safe_join()` canonical fragment joiner** — sanitises null bytes, `..`, absolute paths, Windows-illegal colons (`197acd9`).
- **`paths.hook_wrapper_path()` persistent hook wrapper** survives `uv tool install --reinstall` (`e53d553`, `48193ad`).
- **`util.ellipsize` + `compact._render_cache_meta` helpers** (`a9f363a`).
- **`hints._require_cache`, `cli._lazy_import`, `cli_doctor._check_step`, `session._load_or_empty_json`** helpers (`9636d2d`, `fd10af4`, `582001d`).

### Tests

- **Hook registry alignment test class** asserts every event has a matching `@hook_app.command`; also checks codex and lazy-getattr table coverage (`930033c`).
- **bash_compress dispatch + golden-output tests** +151 tests across all 17 filters. Two dispatch bugs surfaced: `py.test` never dispatched and `uv pip install` was over-stripped (`d241f6e`, `1817f7e`).
- **Bridge TS event-table alignment.** Asserts every event in OPENCODE_PLUGIN_TS + OPENCLAW_PLUGIN_TS exists in `hook_registry.all_events()` (`1408673`).
- **`paths.safe_join` regression tests** (`197acd9`).
- **Hypothesis property tests for range-overlap arithmetic.** 300-500 cases per property, no violations (`f6b54a7`).
- **`test_extractor_crash_returns_none` flake fix** — `_RESULT_CACHE` shared mutable state across tests (`142fad0`).

### Docs

- **`docs/audit-2026-05-24-coupled-registries.md`** — catalog of 8 coupled-registry patterns ranked by silent-vs-loud break risk (`930033c`).
- **`docs/test-speed-deferrals.md`** — formally defers `test_compact.py` split and `test_read_replacement.py` fixture-scope flip with measurements (`ce53586`).

### Dependencies

- **`hypothesis>=6.0.0`** added to `[dependency-groups].dev`. Was missing — `tests/test_parser_malformed.py` erred at collection time. Unlocks 71 previously-uncollected tests (`2cad7f9`).

### Stats hygiene

- **Compact-recovery zero-value rows dropped** (`1e69346`, `ed43859`).
- **Bash-compress noise-threshold suppression.** `MIN_RECORD_STAT_BYTES = 32` skips `record_stat` for whitespace-only compressions that polluted stats with "0.0% savings" buckets (`d5cbd9a`).

**Suite at end of loop: 4965 pass (started at 4598; +367 tests added).**

_From the 68-iteration loop (2026-05-24):_

### Security

- **webfetch sidecar path-traversal fix.** `webfetch.py` now validates that `shrunk_path` resolves inside the cache roots before writing or serving the sidecar, closing a path-escape vector on redirect chains (`2bc071b`).

### Reliability

- **PIL decode-bomb cap.** `image_shrink.py` sets `PIL.Image.MAX_IMAGE_PIXELS` to prevent multi-gigapixel decompression bombs from crashing the hook subprocess (`608080f`).
- **Worker OSError broadening.** `psutil` calls in `worker.py` now catch `OSError` in addition to `psutil.NoSuchProcess` (`dc7b7ce`).
- **Session CAS re-applies size caps after merge.** `session.py` enforces byte caps after every optimistic-CAS merge so a race cannot inflate the JSON beyond limits (`040c36c`).
- **Windows console-ctrl handler.** `worker_daemon.py` installs a `SetConsoleCtrlHandler` callback (with `atexit` fallback) so the daemon flushes state cleanly on Ctrl-C / service stop (`08028c0`).
- **Hook crash log.** All hook subprocesses now persist uncaught exceptions to `hooks-stderr.log` (100 KB cap, `.prev` rotation), making silent failures diagnosable (`a6a7057`).
- **Concurrent dirty-queue write coverage.** New test covers cross-process `fcntl`/`msvcrt` lock contention on `dirty.txt` (`b96fbc8`).

### Token Savings — compaction / hints / manifest

- **Manifest bold-label bundle.** H3 headers inside the manifest (`### Edited:` etc.) replaced with inline bold labels (`**Edited:**`, `**Syms:**`), saving ~4 tokens per section heading (`de96cd1`, `0b632e3`).
- **Manifest SHA sidecar cache.** `pre_compact` writes a `sentinels/manifest_sha_<session>` sidecar; the manifest is rebuilt only when the session SHA differs, cutting redundant manifest work to near zero (`e1fcbb0`).
- **Manifest tightening bundles.** Two passes removed redundant framing tokens, collapsed multi-line stat rows, and tightened section separators (`04dd25d`, `825312b`).
- **Cross-session grep dedup.** `hooks_read.py` records grep patterns in `global.db::grep_patterns`; repeat patterns across sessions surface a dedup hint without a live session match (`803789b`).
- **`extract_image_summary` helper.** `image_shrink.py` gained `extract_image_summary(path)` returning a structured alt-text dict (dimensions, format, byte size, SHA) so hooks inject a lean summary instead of a raw path (`5ace3a9`, `272ab20`).
- **Ruff filter for bash compression.** `bash_compress.py` gained a `RuffFilter` compressing `ruff check` output to per-rule summaries (≤3 examples each), matching the eslint/mypy filter shape (`d3435d2`).
- **Web dedup `--grep` nudge.** Dedup hint for cached responses ≥5 KB appends a `--grep PATTERN` usage example (`98dbcc6`).
- **Session brief collapsed to one-liner.** Drops the `##` header and `Branch`/`Recent` labels, saving ~6 tokens per session start; git status + branch merged into a single `git status -z -b` call (`105ec45`, `4325849`).
- **Precision recall flags.** `bash-output`, `web-output`, `skill-body`, `read`, and `section` gained `--offset`/`--limit` flags for line-range recall (`3745514`).

### Performance

- **Compact-speed 5-item bundle.** Session JSON carries three new cache fields (`_disk_mtime`, `_pending_hint_save`, `_brief_cache`) eliminating redundant disk round-trips in the hot PreCompact path; manifest skipped when SHA sidecar matches (`dbd1244`).
- **`_resolve_file_rel_db` LIKE cap + suffix fast-path.** Caps LIKE query at 50 rows and adds basename-suffix index probe, cutting worst-case lookup from O(N) to O(log N) (`569b284`).
- **Embeddings chunk-hash scoped to file subset.** `_load_existing_chunk_hashes` filters by `file_id` before loading, avoiding a full-table scan on large DBs (`608080f`).
- **Zero-saving stat rows skipped.** `hooks_common.py` skips the SQLite write when both `tokens_saved` and `bytes_saved` are zero (`04dd25d`).

### DRY

- **`session.py` 6-item bundle.** Extracted `safe_load`, `_merge_lists`, `_cap_dict`, `_bump_read_count`, `_session_path`, and `_atomic_write` helpers from repeated inline patterns (`2f240d3`).
- **paths / config / cli / render / compact bundle.** Deduplicated `_data_root` resolution, `_config_singleton`, CLI option constants, render palette entries, and `_manifest_preamble` fragments (`6943b61`).

### Tests

- Aligned mock stubs and assertions to bold-label manifest format and `-z -b` session brief shape (`0b632e3`).

### Docs

- README top section rewritten for new-user readability; install-first flow and before/after comparison moved above the fold (`6d21153`).

---

_From the 55-iteration baseline:_

### Added

- **Terse-mode hint substitution.** All `session_hint`, `diff_hint`, `bash_dedup_hint`, `grep_dedup_hint`, and `web_dedup_hint` text is processed through terse-mode character replacements (logical units compacted to abbreviations) to reduce token overhead while preserving readability.
- **Output ID suffix in hints and manifest.** Bash, web, and skill cache IDs are rendered as 8-char suffixes in hints and manifest sections (e.g. `b4a2f7d1`) instead of full paths, 60% shorter without loss of clarity or discoverability.
- **Manifest MUST_PRESERVE sealed block.** The compaction manifest prepends a `### MUST_PRESERVE` section sealing critical context that must survive compaction — edited files, key symbols, recent test outcomes — so the summarizer LLM treats it as a load-bearing invariant.
- **Bash dedup-vs-hint filtering.** `token-goat compress` now acts as a filter between dedup hints and command execution: when a cached output exists, the filter surfaces `token-goat bash-output <id>` without re-running the command. One-call access to either cached copy or fresh output.
- **Inline skill checklist in recovery hint.** The post-compaction recovery hint now lists loaded skills inline with a checkbox-style format (🧠 skill_name) so the agent can quickly verify which skills are available for recall.
- **Skip bash snippet when recall available.** When a cached bash output qualifies for the recovery hint, the old bash-snippet copy is omitted and a single `token-goat bash-output <id>` reference is injected instead, cutting noise.
- **Pre-Read structured-file hint.** CSV, JSON, JSONL, and log files now produce a format-aware hint on re-read (e.g. CSV headers, JSON top-level keys, log entry count) instead of a full-file suggestion, ~70% smaller.
- **Pre-Read index-only file suppression.** Lockfiles (`package-lock.json`, `yarn.lock`, etc.), source maps (`*.map`), and build artifacts (`dist/*`, `build/*`) are flagged with a Pre-Read hint that skips file content unless explicitly edited.
- **AVIF image-shrink support.** When Pillow includes libaom, the image-shrink pipeline produces AVIF instead of WebP on suitable content (~15% smaller than WebP); WebP fallback for older builds.
- **Hint fingerprint includes file path.** Session-level dedup hints now incorporate the file path in the fingerprint, preventing false positives when the same range is accessed in different files.
- **What Worked section in manifest.** The compaction manifest gains a `### What Worked` section listing the most recent green test runs (up to 2), surface to the summarizer that prior turns succeeded and context should preserve recent successful patterns.
- **Curator pass skips dedup when ignored.** When the agent's preceding sequence of actions indicates it will ignore dedup hints (e.g., proceeding to re-read immediately after a warning), the curator pass suppresses the hint to save tokens.
- **3-item bundle for cold outputs.** The recovery hint aggregates three categories of activity: (1) activity floor (at least 1 per kind), (2) cap at 12 total items, (3) mature cold outputs (bash/web/skill cache entries with zero recent access). Bundles together related cache hits.
- **Session-level hint budget caps.** Hard per-kind ceilings on re-read hints (5 files max), bash dedup (3 max), web dedup (2 max), skill recalls (4 max). Prevents hint spam while prioritizing the highest-value hints.
- **Inline git diffs + skip git log on clean main.** The compaction manifest now embeds `git diff HEAD` output when files differ from the last commit; when on a clean main branch, git history is entirely skipped.
- **Token-savings benchmark.** A new regression test suite (`test_savings_benchmarks.py`, slow-marked) measures concrete wins: WebP compression ratio, repomap density, hook cold-start latency, DB reindex speed, and manifest coverage. Locks in evidence before release.
- **TODOs section from TaskList.** The compaction manifest now surfaces outstanding tasks from Claude Code's TaskList (`### TODOs`) so the summarizer knows which work is pending and can preserve context around in-flight tasks.
- **Semantic compact output mode.** `token-goat map` defaults to semantic mode (one result per line, ranked by importance) and preserves the old `--full` format for verbosity; applies to `compact-hint` and other list-like outputs for consistency.
- **Unchanged-file Pre-Read short-circuit.** When a file's content SHA matches the cached value, the Pre-Read hook skips hint generation entirely and lets the Read proceed without noise — saves tokens on stable working files.

### Reliability

- **`fail_soft` catches `BaseException` to match contract.** The decorator now catches all base exceptions including `MemoryError`, `SystemExit`, and `KeyboardInterrupt` (re-raised for process-control signals), ensuring the fail-soft invariant holds regardless of lazy-imported module behavior (commit 9c37736).
- **Session cache writes use optimistic CAS to prevent edit-count loss.** Concurrent hook processes can no longer lose mutations; save operations detect `mtime` changes and retry the load-mutate cycle up to 3 times (commit bf95c5a).
- **Dirty-queue append protected by OS file lock.** Concurrent `enqueue_dirty` calls now use `fcntl.flock` (POSIX) / `msvcrt.locking` (Windows) to prevent JSON line interleaving on concurrent writes (commit 30d0e24).
- **Worker claim file auto-recovers from crashes via mtime staleness.** A claim file empty/malformed for >60 seconds is reclaimed as stale, unblocking worker startup after a crash between `O_EXCL` create and `pid` write (commit f6b1dc3).
- **Cross-process contention dedup moved to disk.** The in-process `_REPORTED_CONTENTION` set (meaningless across hook processes) is replaced with touch-files under `contention_marks/`, preventing duplicate stat rows under disk pressure (commit 3d23f19).
- **`safe_run` splits output serialization into its own try block.** `denormalize_response` failures no longer lose the entire hook payload; worst case the harness receives camelCase keys it ignores but still gets the image redirect / hint (commit 3d11a4f).
- **Atomic write in `paths.py` finally-block guards against file clobbering.** The temp-file unlink only fires when rename fails, preventing accidental deletion of unrelated files (commit 3d11a4f).

### Performance

- **Lazy imports in `hooks_session.py`.** Heavy modules (`cache_common`, `compact`) are now imported inside the handler functions rather than at module top-level, cutting the cold-start cost of the PreCompact subprocess from ~190 ms to ~110 ms (~42% faster).
- **Deferred session import in `compact.py`.** `session.py` (which pulls in `sqlite3` and path helpers) is no longer imported at `compact` module load time; moved to the call site that actually needs it, shaving another ~15 ms off cold-start.
- **Compact-skip sentinel.** `hooks_session.pre_compact` writes a touch-file after emitting a manifest. On the next call, if the session file is <5 min old and no edits have been logged since the sentinel, the subprocess exits in <1 ms without loading any session or compact modules — skipping the subprocess entirely on fresh sessions.
- **Skip git ops when `cwd` is not a repo.** `compact.build_manifest()` now checks `git rev-parse --is-inside-work-tree` once and skips all `git diff` / `git log` calls when the working directory is outside any repo, saving 60–100 ms per hook fire in non-repo contexts.
- **Drop `ThreadPoolExecutor` from manifest build.** The two parallel `git diff` + session-load futures were serialised by the GIL anyway on CPython; removed the executor and ran the calls sequentially, eliminating thread-pool overhead.
- **`pytest-xdist --dist=loadscope`.** CI and local test runs now use `xdist` with `loadscope` distribution so tests in the same module share a worker, keeping module-scoped fixtures alive across their module without cross-contamination.
- **Module-scoped fixtures for read-only groups.** `conftest.py` promotes fixtures that set up read-only DB state (project index, parser caches) from function scope to module scope, amortising the 80× reindex cost across all tests in a module.
- **`make_fake_git_repo` helper.** A lightweight helper in `conftest.py` creates a marker-only fake repo directory (no actual `git init`) for tests that need a project root without triggering real git history indexing.
- **`pytest-randomly` + `pytest-rerunfailures`.** Random seed ordering exposes order-dependent flakes; `--reruns 1` retries a single failing test once before marking it failed, absorbing transient OS/filesystem timing issues without hiding real failures.

### DRY Consolidation

- **`extract_tool_response_text` unifies bash/web/skill response extraction.** The three PostToolUse handlers shared identical `payload["tool_response"] → text` walks; extracted into `hooks_common.extract_tool_response_text()` with sibling `extract_tool_response_pair()` for exit codes / status codes (commit 3d23f19, 3d11a4f).
- **Per-cache `_OutputStatDict` and `_safe_join` consolidated.** The bash/web/skill caches duplicated `class _OutputStatDict` byte-for-byte; exported from `cache_common` and reused via `functools.partial` (commit d24a5b4).
- **`cache_common.short_content_hash()` replaces triplicate hash helpers.** Bash, web, and skill caches each had their own `sha256(text)[:16]` logic; unified into a single `short_content_hash(text)` (commit 47072d6).
- **`_run_history_listing_command` unifies bash/web/skill history listing.** The three `list_outputs`→JSON/text rendering paths shared identical slicing, paging, and sidecar assembly (commit 985ea60).
- **`_run_output_recall_command` merges bash/web output recall.** The two `cmd_*_output` commands duplicated slicing, grep, head/tail, and recall stat recording; collapsed into a single dispatcher (commit a5c68d4).
- **`humanize_bytes` moved to `render/ansi.py` for cross-module reuse.** The compact/cli_doctor/stats modules each had their own bytes-formatter; canonical version now in `render/ansi` (commit 6e1ba74).
- **Language decorator walker extracted to `common.extend_starts_for_decorators()`.** Python and TypeScript adapters shared the same decorator-offset iteration skeleton (commit 8aa1c30).
- **`session.safe_load()` consolidates try/except for session loading.** Five hook locations had identical `try: load() except (OSError, ValueError): return None` blocks (commit 9c3d8d1).
- **`cache_common.get_cache_dir()` + `sidecar_path_for()` extracted.** Per-cache `_X_outputs_dir` and `sidecar_meta_path` wrappers unified (commit df41374).
- **`util.humanize_bytes()` canonical bytes formatter.** Replaces duplicates in compact.py, cli_doctor.py, stats.py (commit bcfe025).
- **`hooks_common.run_dedup_hint()` template collapses four dedup handlers.** Bash/grep/glob/web dedup handlers shared 35 lines × 4 of load-session-build-hint-record-stat glue (commit 809aed4).

## Improve loop summary — 2026-05-24

- **Scope.** 55 iterations across four design areas: context savings (20+ items), reliability (7 items), DRY refactoring (11 items), and compaction/test-suite speed (9 items). Design docs: `docs/plans/2026-05-23-{context-savings,reliability,dry,speed}-design.md`.
- **Commits landed.** ~30 commits from `c2db365` to `3ddf1ab`, covering fixes, refactors, perf improvements, and test infrastructure.
- **Token-savings claims.** Per design-doc estimates: hook cold-start 190 ms → 110 ms (−42%); pre-compact skipped entirely on fresh sessions (<1 ms); git ops skipped in non-repo dirs (60–100 ms saved); bash/grep/web dedup hints 40% shorter via terse-mode; hint budget caps prevent spam (5/3/2/4 per kind); structured-file hints ~70% smaller than full-file suggestion.
- **Reliability wins.** `fail_soft` now catches `BaseException`; session CAS prevents edit-count loss under concurrent hooks; OS file lock guards dirty-queue appends; worker claim auto-recovers from crash; cross-process contention dedup moved to disk.
- **DRY wins.** ~600 lines of duplication removed: unified tool-response extractor, consolidated cache helpers, single `humanize_bytes`, collapsed dedup-hint template, unified CLI output/history commands, shared language decorator walker, and `safe_load` session helper.

## [0.8.0] - 2026-05-23

### Added

- **Skill preservation through compaction.** Every `PostToolUse(Skill)` invocation captures the loaded skill body to a persistent on-disk cache (`data_dir() / "skills"`, 5 MB LRU-evicted) keyed by `(session, skill_name, content_sha)`. The compaction manifest gains an `### Active Skills` section listing every loaded skill with a `token-goat skill-body <name>` recall hint, and the post-compact recovery hint surfaces the same list under `**Skills**:`. Solves the "I forgot parts of the skill after compaction" problem — load-bearing prose (Ralph's DoD gates, /improve's iteration sequence, any multi-thousand-token protocol skill) is recoverable without re-invoking the skill, which would replay any side effects and pollute the conversation with a fresh tool-result block. Configurable via `config.toml [skill_preservation]` (`enabled`, `max_cache_bytes`) or disabled at runtime via `TOKEN_GOAT_SKILL_PRESERVATION=0`.

- **`token-goat skill-body <name>`** — retrieve a cached skill body by name. Defaults to a head+tail view for large bodies; pass `--full` for everything, or narrow with `--head N`, `--tail N`, `--grep PATTERN`. Falls back to reading the original `~/.claude/skills/<name>/SKILL.md` (or plugin-path equivalent) when the cache entry has been evicted but the source path was recorded.

- **`token-goat skill-history`** — list cached skill bodies (newest first) with their IDs, byte sizes, ages, and skill names.

- **Skill marker (🧠) in the compaction manifest legend** — joins `edited=✎`, `read=→`, `stale=⚠`, `cold=❄` so the compaction LLM has a stable glyph vocabulary for every section type.

- **4-section recovery hint allocator.** `_allocate_recovery_slots` now distributes 18 total slots across Files / Bash / Web / Skills with skill loads taking priority in the greedy expansion pass (they're the load-bearing protocol prose the feature exists to preserve — files/bash/web survive compaction better than skill bodies do).

## [0.7.0] - 2026-05-20

### Added

- **Grep output compression.** Large `grep`/`rg`/`ag`/`ack` results (>30 lines) are compressed to a file-level summary: top 20 files by match count, totals included, full output cached for `token-goat bash-output` recall. Typical savings: ~80%.

- **Bash loop-detection escalation.** The same command run twice triggers a "ran 2×" escalation; three or more repeats produce a "WARNING: ran N×" advisory. Stops runaway loops from burning context unnoticed.

- **Session-wide hint deduplication.** Identical hints are suppressed after their first injection within a session. SHA-256 fingerprinting with a JSON-persisted `hints_seen` set means the agent never gets nagged twice for the same file.

- **Session orientation brief.** At session start in a dirty git repository, a compact block (~50 tokens) is injected: current branch, modified/staged/untracked counts, and the five most-recent commits. Disable via `TOKEN_GOAT_SESSION_BRIEF=0` or `[session_brief] enabled = false` in config.toml.

- **Adaptive PreCompact manifest budget.** The manifest budget scales from 200 to 600 tokens based on edit count, symbol accesses, and bash activity. Sessions with little activity get a lean manifest; complex ones get the full picture.

- **Git diff --stat in PreCompact manifest.** A `git diff --stat HEAD` summary (capped at 8 lines / 200 chars) is now included in the compaction manifest. The compaction LLM always sees which files drifted from the last commit, even when the session cache doesn't list them as edited.

- **Symbol names in re-read hints.** Re-read hints now include up to three symbol names previously accessed in the flagged file (e.g., `[symbols: login, get_user, Session]`), so the agent can decide whether `token-goat read file::symbol` is sufficient.

- **Error-preserving smart truncation.** When bash output exceeds the size cap, the trimmed view keeps: first 10 lines + up to 10 error-signal lines with 2-line context + last 10 lines, separated by `--- N lines omitted ---`. Errors are never lost to truncation.

- **Loaded version in `token-goat stats`.** The stats report now shows the running token-goat package version: a header line in the ANSI renderer (`token-goat  v0.6.1`), the version in the rich fallback renderer's panel title, and a top-level `version` field in `--json` output. Confirms at a glance which build produced the numbers.

### Fixed

- **Git-history indexing batches its writes in one transaction.** `_index_history_inner` inserted up to 200 commit rows on an autocommit connection (`isolation_level=None`), so every `INSERT` committed on its own and the trailing `conn.commit()` was a no-op: 200 separate fsyncs and 200 writer-lock acquisitions per reindex sweep. The batch now runs inside a single `BEGIN`/`COMMIT`, acquiring the lock and committing once. The `last_indexed_at` staleness marker is also written only when at least one commit stored, so a batch that wholly failed (for example, a database that stayed locked throughout) no longer stamps itself "indexed" and suppresses the retry for an hour.

- **`project_writer_lock` acquisition is now atomic.** `_try_acquire` checked `lock_path.exists()` and then `write_text` — a check-then-write with a TOCTOU window: two callers that both observed the file absent each wrote the lock and each believed it held it, so two `index_project` runs could write the same per-project database concurrently. Acquisition is now a single `os.open(O_CREAT | O_EXCL)` create — the atomic-mutex pattern the worker slot claim already uses — and `_stale` falls back to the lock file's mtime so the brief create-then-write window can't be misread as a dead lock.

- **Git-history indexing moved to the background worker.** The SessionStart hook spawned `git_history.index_project_history` on a `daemon=True` thread inside the hook process, which exits within milliseconds — killing the thread before the indexing finished. Git-history hints are now refreshed by the worker's periodic reindex sweep, which runs in a durable process; `index_project_history` is idempotent and staleness-gated (1 h), so the move adds no measurable cost.

- **Worker claim-slot no longer wedges on a write failure.** If `os.write` failed after `_try_claim_worker_slot` created the claim file, the file descriptor leaked and an empty claim file was left on disk. `_worker_claim_is_stale` treats an empty claim as not-stale (to protect the create-then-write window), so that orphan could never be reclaimed and the single-worker slot stayed blocked. The fd is now closed and the empty file removed on a write failure. Separately, `run_daemon` wrapped its claim-file cleanup in a `finally` whose `try` began only after `_write_pid` / `_register_autostart` / `cleanup_on_startup`, so an exception in any of those skipped the cleanup — the `try` now covers all startup work.

- **Session-start git brief is capped by one shared deadline.** `_build_session_brief` ran three git subprocesses (`rev-parse`, `status`, `log`) sequentially, each with a fixed 2 s timeout, so a slow or pathological repository could stack a ~6 s pause onto session start. The three calls now share a single ~2.5 s wall-clock budget, and a call is skipped once the budget is spent.

- **A deferred dirty-queue drain no longer slows re-indexing.** On Windows a concurrent `enqueue_dirty` can hold `dirty.txt` open, making `os.replace` fail with a sharing violation; `drain_dirty_queue` retries and then defers. It returned `[]` for that case — indistinguishable from a genuinely empty queue — so the worker counted a deferred drain as an idle cycle and let adaptive back-off drift re-indexing toward its 10 s maximum while edits piled up. `drain_dirty_queue` now returns `None` on a deferral, and the worker resets the idle counter instead of incrementing it.

- **`token-goat doctor` no longer integrity-checks the production database.** The stats summary opened `global.db` through the read-write path, which runs `PRAGMA integrity_check` on connect — multi-second on a large `global.db`, and it created the database file as a side effect when one did not exist yet. The summary now reads through `open_global_readonly()`, so `doctor` stays fast regardless of database size and never mutates the database it is diagnosing.

- **`token-goat stats` breakdown rows now rank by share.** The "By kind", "By day", and "By project" tables emitted rows in byte-sorted order while the share column they display is token-derived, so the share percentage zig-zagged whenever bytes and tokens ranked rows differently (an image-heavy day saves bytes but ~0 tokens). Each section renderer now orders its rows by the same share metric it displays — "By source" already did this.

- **Unbounded `global.db` WAL growth.** Every hook writes stat rows to `global.db`, and under a heavy multi-agent burst its passive autocheckpoints were perpetually blocked by overlapping readers, so the write-ahead-log file only ever grew — one session reached an 11 GB `global.db-wal`, after which every hook (including the SessionStart hook that runs on `/compact`) stalled for minutes scanning it. Connections now set `PRAGMA journal_size_limit` so the WAL file is truncated after each checkpoint, and the worker force-runs a `wal_checkpoint(TRUNCATE)` on `global.db` every maintenance cycle. A `tests/test_wal_growth_guard.py` regression suite, wired into the pre-commit hook, locks both halves of the fix in place.

- **Temp files and automation artifacts excluded from PreCompact manifest.** Paths under `/tmp/`, Windows `%APPDATA%`, `.improve-state-*.json`, and `improve_commit_msg_*` are filtered before the manifest renders. Previously they leaked into "Files Edited" and wasted manifest budget on entries the compaction LLM couldn't use.

## [0.6.1] - 2026-05-19

### Changed

- **Token-savings tuning across the hint, compaction, and output surfaces.** Three internal improvement sweeps tightened the text Token-Goat injects into the conversation: shorter session read-hints and bash / grep / web dedup hints, leaner PreCompact manifest framing, a more compact post-compaction recovery hint, terser `token-goat map` output framing, and budgeted git-history and project-memory injections. The CLAUDE.md / SKILL.md / AGENTS.md directive blocks written by `token-goat install` were condensed without dropping any guidance. The result is the same hints for fewer tokens.
- **Command `--json` output is now compact single-line JSON.** `stats`, `map`, `config`, `bash-output`, `web-output`, `bash-history`, `web-history`, `compact-hint`, and the surgical-read commands emit `--json` with no indentation whitespace. JSON written to disk (settings.json and config files) stays pretty-printed for human editing.
- **`bash-output` and `web-output` recall now default to a smart head-and-tail view** for large cached outputs, with `--full` to retrieve the whole thing.
- **DRY pass on the output-cache layer.** `bash_cache` and `web_cache` were near-parallel implementations; their shared pieces (the cache-filename pattern, session-id sanitization, JSON-sidecar loading, and LRU disk-cap eviction) now live in one `cache_common` module. No user-visible behavior change. Regression tests were added across the token-savings, stat-accounting, and cache surfaces.

### Fixed

- **`compact_recovery` stat accounting.** The post-compaction recovery hint recorded no injection overhead and was bucketed under the `other` source instead of `compact`. It now records a `compact_recovery_overhead` row consistent with the `session_hint`, `diff_hint`, and `bash_dedup_hint` siblings, and both `compact_recovery` kinds map to the `compact` source bucket.
- **`bash-output` and `web-output` recalls were credited no savings.** Retrieving a cached output instead of re-running a command, or a cached response instead of re-fetching a URL, now records a `bash_output_recall` or `web_output_recall` stat. This closes a measurement gap where thousands of cache hits showed zero tokens saved.

## [0.6.0] - 2026-05-19

### Added

- **Bash output compression.** PreToolUse hook on Bash detects compressible commands and rewrites them to flow through `token-goat compress`, which runs the original through the system shell, captures stdout + stderr, applies a per-tool filter, and prints a compressed view that surfaces failures first. Twelve filters cover the noisiest dev commands: `pytest`, `jest` / `vitest`, `cargo`, `npm` / `pnpm` / `yarn` / `bun`, `docker` / `buildah` / `podman`, `kubectl` / `helm`, `aws`, `ruff` / `eslint` / `mypy` / `pyright` / `pylint` / `stylelint` / `biome` / `tsc`, `git`, `make` / `ninja` / `gradle` / `mvn` / `bazel` / `go`, `terraform` / `tofu`, `pip` / `pipx`. Typical savings: pytest 80-97%, npm 88%, docker 75%, linters 80%. Each filter strips ANSI, collapses `\r` progress bars, dedupes consecutive lines, groups linter issues by rule (3 examples per code), keeps every error and warning block verbatim, and caps total output at 1000 lines / 64 KiB. The wrapper preserves the original exit code, kills the process group on timeout (SIGTERM then SIGKILL after a grace period on POSIX), and caps each stream capture at 32 MiB. Configurable via `[bash_compress]` in config.toml (`enabled`, `disabled_filters`, `max_lines`, `max_bytes`, `timeout_seconds`) or disabled with `TOKEN_GOAT_BASH_COMPRESS=0`. Savings are recorded per filter as `bash_compress:<name>`. New CLI subcommand `token-goat compress` for previewing compression on any command.
- **Post-compaction recovery hint.** ``SessionStart`` now detects ``source == "compact"`` and emits a one-shot ``additionalContext`` block listing the most recently-read files, cached Bash outputs (``token-goat bash-output <id>``), and cached WebFetch responses (``token-goat web-output <id>``) from the *pre*-compaction session.  The cache is intentionally preserved across the compact so the recovery hint has data to draw from; the cache reset still fires on every other source value (startup / resume / clear / unknown).  When the prior session was empty, no hint is emitted — the recovery path is silent until it has something worth surfacing.
- **Grep dedup hint.** A repeat ``Grep`` invocation with the same ``(pattern, path)`` pair within the staleness window now produces a ``"this ran ~Ns ago and matched N lines"`` advisory.  Same mechanism as the bash and web dedup hints but pointed at the existing ``session.greps`` history — no new disk store is involved.  Suppressed when the prior result was below 50 matches (the hint preamble would approach the saving).
- **WebFetch result cache.** A new ``PostToolUse(WebFetch)`` hook persists non-image response bodies to ``data_dir() / "web_outputs"`` and records the ``(url_sha → output_id)`` mapping in the session cache.  On a repeat fetch of the same URL the pre-fetch hook emits a dedup hint pointing at ``token-goat web-output <id>``, mirroring the bash-cache pattern.  Two new CLI commands surface the cache: ``token-goat web-output`` (with the same ``--head`` / ``--tail`` / ``--grep`` slicers as ``bash-output``, plus ``numbered_lines`` in JSON mode) and ``token-goat web-history``.  Disk store is byte-capped (32 MB default) with oldest-first eviction + paired sidecar cleanup.
- **Dockerfile section extractor.** ``Dockerfile``, ``Containerfile``, and ``*.dockerfile`` now produce one ``Section`` per ``FROM`` build stage, so ``token-goat section Dockerfile::builder`` extracts a single stage instead of forcing a full-file read.  Multi-stage builds resolve by ``AS <name>`` alias when present; unnamed stages fall back to the image reference so they remain addressable.
- **Pre-Grep matcher + pre-Bash matcher in install.** ``PreToolUse`` now fires on ``Read|Grep|Bash`` (matcher widened from the prior ``Read|Bash``) so the new Grep dedup hint actually runs alongside the Bash compression rewriter from the prior entry.
- **``token-goat doctor`` cache visibility.** A new ``Caches`` section reports the size, file count, and oldest-entry age for ``bash_outputs/``, ``web_outputs/``, and ``session_snapshots/``.  Each row warns when the directory has grown more than 10% over its byte cap, surfacing potential eviction gaps without needing to grep the data directory by hand.
- **Close-match auto-redirect on ``token-goat symbol``.** When a symbol query returns zero results and the project has exactly one close-match candidate at high confidence (difflib ratio ≥ 0.85), the lookup is automatically re-run against that candidate.  The redirected response carries a ``redirected_from`` field in JSON output and a ``(redirected from: …)`` marker in plain-text output so the substitution is auditable.  Pass ``--strict`` to disable the redirect and get the previous "Did you mean: …?" suggestion list behaviour.
- **``bash`` and ``web`` source buckets in stats.** ``token-goat stats`` now attributes ``bash_*`` kinds to a visible ``bash`` bucket (orange in the fancy renderer) and ``web_*`` kinds to a new ``web`` bucket (yellow), so the new mechanisms get first-class lines in the by-source panel instead of falling into the ``other`` catch-all.  ``grep_dedup_hint`` lands in the existing ``hint`` bucket because it prevents a Read-equivalent burst (consistent with ``diff_hint``).
- **Bash output interception.** A new `PostToolUse(Bash)` hook persists large stdout/stderr to disk under `data_dir() / "bash_outputs"` and records the command in the session cache. When the same command is about to run again in the same session, the pre-Bash hint suggests `token-goat bash-output <id>` (optionally with `--head N`, `--tail N`, or `--grep PATTERN`) instead of re-executing — avoiding both runtime cost and duplicated tokens. The store is byte-capped (16 MB default) with oldest-first eviction; outputs above 2 MB are tail-preserved with a truncation marker. Two new CLI commands surface the cache: `token-goat bash-output` retrieves a sliced view, `token-goat bash-history` lists cached entries newest-first.
- **Diff-aware re-read.** `post_read` now writes a per-session content snapshot (under `data_dir() / "session_snapshots"`, capped at 256 KB per file and 150 snapshots per session) so a follow-up `Read` after a `Write`/`Edit`/`MultiEdit` can be answered with a unified diff hint instead of a `pre_read` blocking message that silently allowed the full re-read. The diff is bounded to 4 KB and only fires when the realised saving exceeds ~250 tokens; below that the existing session-cache hint path runs unchanged. Stats record both the realised saving (`diff_hint`) and the hint's injection cost (`diff_hint_overhead`) for honest accounting.
- **TOML, YAML, JSON, INI, CFG, and dotenv section extraction.** `token-goat section pyproject.toml::tool.ruff` (and equivalents for `.yaml`, `.yml`, `.json`, `.ini`, `.cfg`, `.env`, and `.envrc`) now extract a single table/key block instead of forcing a full-file read. The TOML scanner emits one `Section` per `[table]` and `[[array]]` header; the YAML scanner emits top-level keys plus one nested layer (`spec.replicas`-style) computed from the file's detected indent; JSON gains depth-1 section detection on pretty-printed files; INI/CFG indexes one section per `[name]` header; `.env`/`.envrc` index each `KEY=value` assignment as a symbol. None of the six pulls in an extra dependency — all use line-scanners and the existing stdlib parsers. The parser dispatcher gained a basename-keyed table (alongside the existing suffix table) so dotfiles with empty extensions (`.env`, `.envrc`) resolve correctly.
- **Stale-data sweeps in the background worker.** `cleanup_on_startup` now also drops snapshot directories older than 24 hours and enforces the bash-output byte cap, so a long-lived install does not accumulate per-session debris.
- **Compaction manifest gained a "Commands Run" section.** The PreCompact manifest now surfaces the most recent meaningful Bash invocations (cmd preview, exit code, byte size, cache ID) so the test/build context that drives the next agent turn survives compaction. Each entry includes the `token-goat bash-output <id>` cache key for surgical recall. `event_count` includes `bash_history` so a session whose only activity is a cached test run still clears the `min_events` threshold.
- **`token-goat bash-output --json` now surfaces line numbers.** The JSON shape adds `numbered_lines` (a 1-based, original-body-anchored `[{lineno, text}]` list) and `total_lines`, mirroring the surgical-read response shape elsewhere in the codebase. Agents can now `--head` / `--tail` / `--grep` filter and still map back to positions in the original output.
- **Hardened PostToolUse Bash payload extraction.** `_extract_bash_response` now tolerates every documented Bash result shape: dict-with-named-fields (Claude Code), MCP `CallToolResult` content arrays, bare-string blobs, top-level flattening (no `tool_response` wrapper), `tool_result`/`response` aliases, `returncode` and string-typed `exit_code` variants. Each shape is covered by a dedicated regression test in `test_post_bash_payloads.py`.

### Changed

- **`reset_session`** now also removes per-session content snapshots, matching the existing JSON-cache reset semantics.
- **Codex Bash matcher in `~/.codex/config.toml`** now points at the new `post-bash` hook instead of `post-read`; under Codex, `post-read` previously did nothing for `Bash` calls (no branch in the handler), so this is a strict gain.
- **`bash_cache.evict_old_entries`** removes body + sidecar pairs together, and runs a second pass to sweep any orphan sidecars left over from out-of-band deletion. Previously, manual `rm` of a body file or a write race could leave a `.json` sidecar with no matching body that lived forever.
- **README "Updating" subsection.** New `### Updating` block under `## Install` consolidates the three update paths (weekly auto-update via scheduled task/crontab, on-demand `uv tool upgrade`, force-reinstall via `uv tool install --reinstall --force`) plus how to disable the auto-update entry. The miss-suggestions feature row and the prose footnote previously implied "Did you mean?" was the only miss-handling path; both now name the `symbol` auto-redirect (with `--strict` opt-out) alongside the "Did you mean?" fallback on `read` / `section`.
- **Internal DRY pass across the install, languages, bridges, hooks, and CLI surfaces.** Routing-table rows (Claude / Codex / skill) now compose from one `_ROUTING_ROWS` list with per-harness "Not this" columns. The config-file language adapters (TOML, INI, YAML, Dockerfile) share `decode_source_text`, `bom_strip_first_line`, and `assign_flat_end_lines` helpers in `languages/common`. The openclaw and opencode TS bridges now both route post-tool events through the same `POST_HOOK` table shape, and the four `install_/uninstall_*` plugin functions delegate filesystem work to `_write_plugin_file` / `_remove_plugin_file`. The Windows registry path lives in one `_HKCU_RUN_PATH` constant and the open/close pairs are now context-managed. Typer's `--json` and `--context` options collapse to two module-level `_OPT_JSON` / `_OPT_CONTEXT_LINES` constants reused across 19 commands. `tests/conftest.py` now exports a single `patched_home` fixture replacing the per-file `_fake_home` / `_patch_home` boilerplate. No user-visible behavior changes; the rendered AGENTS.md / CLAUDE.md content is byte-identical to the previous output.

### Fixed

- **`paths.open_log_file` returned a `StreamHandler` instead of a `FileHandler` on POSIX.** The type hint and docstring claimed `FileHandler`, but the implementation wrapped `os.fdopen()` in a bare `StreamHandler` to apply 0o600 permissions, breaking `isinstance(handler, FileHandler)` checks (such as the `test_setup_logging_skips_console_handler_when_not_tty` worker test). Replaced with a private `FileHandler` subclass that overrides `_open` to apply the tighter mode at open time, preserving the type identity callers depend on.
- **`test_canonicalize_drive_case_collapsed` and `test_canonicalize_cross_shell_paths_produce_same_hash` failed on POSIX.** Both assert Windows-shell drive-letter normalisation invariants that only fire when `Path.resolve()` returns an absolute Windows path; on POSIX `Path("C:/Projects/foo").resolve()` becomes `cwd + "/C:/Projects/foo"` and the assertions test against synthesised POSIX paths. Now skipped on non-Windows with an explanatory message.
- **Latent winreg handle leak in `install_worker_task` and `uninstall_tasks`.** The manual `OpenKey` / `CloseKey` pairs left the registry key open if `SetValueEx` or `DeleteValue` raised before the `CloseKey` line. Switched to `with`-statement context managers so the handle releases on the unhappy path too.

## [0.5.2] - 2026-05-17

### Fixed

- **"Did you mean?" suggestion paths no longer crash when the per-project DB has not been created yet.** The four suggestion code paths (`read_commands._close_symbol_matches`, `read_commands._close_section_matches`, `cli._project_close_symbol_matches`, `cli._global_close_symbol_matches`) caught `sqlite3.OperationalError` and `sqlite3.DatabaseError` but not `FileNotFoundError`. `db.open_project_readonly` raises `FileNotFoundError` when the project DB has not been indexed, so a `token-goat read` against an unindexed project that resolved via `find_in_all_projects` would surface a hard crash instead of a clean miss message. Suggestions are best-effort polish — they must always degrade silently.

## [0.5.1] - 2026-05-17

### Added

- **`token-goat --version` / `-V` flag.** Prints the installed version and exits. Required by SECURITY.md, which instructs vulnerability reporters to include this command's output; the flag did not previously exist and the command errored out, blocking the reporting flow.
- **`config` sub-Typer help string.** `token-goat --help` previously rendered the Config panel with an empty description; the group is now self-describing.

### Changed

- **Shipped routing tables refreshed for 0.5.0 features.** The blocks `token-goat install` writes to `~/.claude/CLAUDE.md`, the token-goat skill, and `~/.codex/AGENTS.md` now mention qualified `Class.method` reads, `Heading#N` section ordinals, `map --compact`, `gdrive-sections`, `--all-projects`, `semantic --max-distance` / `--no-rerank`, and the "Did you mean?" miss suggestion. Agents installed against 0.5.0 had no way to discover these from the shipped guidance.
- **`token-goat gdrive-sections` is no longer hidden in `--help`.** The 0.5.0 routing tables advertise it as a user-facing command; an agent verifying via `--help` would have concluded it did not exist.
- **`read` / `section` argument help now documents `Class.method` and `Heading#N` syntax** inline so the qualified-lookup and ordinal-disambiguation forms are discoverable from `--help` alone.
- **PyPI description tightened** to mention the surgical-read CLI (`symbol` / `read` / `section` / `semantic` / `map`), not only the automatic hook features.

### Fixed

- **`map --compact` help text said the threshold was ~200 tokens; the code constant is 300** (`repomap._AUTO_COMPACT_BUDGET`). Iteration 17 raised the threshold but missed the help string. Help now matches code.

## [0.5.0] - 2026-05-17

### Added

- **WebP encoding as the default image-shrink format** — ~39% smaller than the previous JPEG output on screenshots, ~97% smaller than raw PNG. Anthropic's Vision API natively supports `image/webp`. The cache key version was bumped so older shrunk artifacts are not served.
- **Install-time image-codec probe.** `token-goat install` now records `image codecs: ok|FAIL` as a normal install step and, when any codec is missing or WebP encode fails, prints a banner-delimited warning with platform-specific install commands (`apt-get` / `dnf` / `pacman` / `apk` / `brew`) plus the `uv tool install --reinstall token-goat` follow-up. AIs driving the install can resolve the gap as part of the same task instead of discovering it months later via missing savings.
- **New CLI flags and commands.** `token-goat install --dry-run` previews changes; `--verify` audits an existing install. `token-goat map --compact` fits a 300-token budget. `token-goat semantic` accepts `--max-distance <float>` and `--no-rerank`. `token-goat gdrive-sections <file-id>` lists the heading outline of a Google Doc without fetching the body.
- **Qualified `Class.method` lookups** in `token-goat read`, plus `Heading#N` ordinal disambiguation for `token-goat section` when a doc has duplicate headings.
- **"Did you mean…?" suggestions** on surgical-read misses — a typo costs one extra glance instead of a re-read.
- **`<details><summary>`, setext headings, h1-h6 with anchor IDs, and `__frontmatter__`** are all recognised as Markdown sections.
- **PowerShell read-then-filter pipelines** (`Get-Content | Select-String / Where-Object / Select-Object`, including `-First` / `-Tail` ranges) now surface to the image-shrink and session-hint paths via `bash_parser`. Also adds `xxd`, `od`, `wc`, `type`, and stdin-redirect (`cmd < FILE`) read detection.
- **Stats "By source" panel.** `token-goat stats` now shows a per-source rollup (image / hint / read / compact / other) with a distinct palette in the fancy renderer.
- **Regression benchmark suite** (`tests/test_savings_benchmarks.py`) locks in the measured wins: WebP ratio >=20%, repomap density >=20%, `write_file_index` <200 ms, hook cold-start <1.5 s, composite indexes present, markdown sections cover frontmatter / ATX / setext / `<details>`, and `package-lock.json` is excluded by default.

### Changed

- **DB reindex is ~80x faster** (84 s -> ~1 s for 100 files) - `parser.write_file_index` now wraps writes in an explicit `BEGIN`/`COMMIT` transaction and the schema picks up composite indexes (`idx_symbols_file_name`, `idx_sections_file_heading`).
- **Hook dispatch cold-start ~65% faster** (~86 ms -> ~30 ms) via lazy submodule imports in `hooks_cli` and PEP 562 `__getattr__` deferring `importlib.metadata.version()`. Unknown hook events return in <1 ms.
- **Repomap output ~30-40% denser** - short labels (`r=X.XXX`, `cls`/`fn`/`m`), tighter line composition, and an auto-compact mode that fits 300 tokens.
- **Semantic-search rerank pipeline.** `token-goat semantic` over-fetches `k*4`, boosts verbatim-token matches on camelCase / snake_case splits, demotes generated paths (`dist/`, `*.min.js`, sourcemaps, lockfiles), and applies a default distance threshold of 1.2.
- **Image cache is real LRU, not FIFO.** `os.utime()` bumps the cache file on every hit so eviction sorts by real access recency. Eviction is also lockfile-guarded (`O_CREAT | O_EXCL`) so concurrent workers cannot race.
- **Worker adaptive back-off.** Idle poll interval grows from 2 s -> 10 s after five consecutive empty drains.
- **Compact manifest noise filter and recency markers.** `compact.build_manifest` filters noise paths, prefixes activity markers (edited/read), recency-ranks symbols, and dedupes across sections so an edited file isn't repeated under "read."
- **Hint suppression smarter.** Already-read hints now suppress when the file was edited after the last read, when the prior read is >30 minutes old, and when the new read is a narrow explicit range.
- **Per-session and parser result caches.** `parser` keeps a 256-entry SHA-keyed LRU so unchanged content skips tree-sitter entirely; each session keeps a 100-entry FIFO so repeat `read`/`section` queries cost zero.
- **Webfetch content-hash dedup.** Different URLs that resolve to the same bytes share one shrunk artifact via a `web_cache_dir/by_content/<sha>.idx` pointer.
- **Cross-shell project hash unified.** `C:\Projects\foo`, `/mnt/c/Projects/foo` (WSL), `/cygdrive/c/Projects/foo` (Cygwin), and `/c/Projects/foo` (Git Bash) now hash to the same project ID, so the SQLite index is no longer split across shells.
- **Default exclude patterns.** Lockfiles (`package-lock.json`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `composer.lock`), minified bundles (`*.min.js`, `*.min.css`), and sourcemaps (`*.map`) are skipped at index time.
- **JSON indexer permissive fallback.** Minified JSON with no newlines now picks up keys via `_ANY_KEY_RE`, and large structured configs emit one nested layer of `parent.child` symbols plus `[].key` schema peeks on arrays of objects.
- **Config tuning.** `compact_assist.min_events` drops from 5 to 3 so short sessions still get a manifest.

### Fixed

- **Markdown setext / `<details><summary>` / HR disambiguation / blockquote prefixes** previously produced wrong section boundaries. The Markdown adapter now handles all four cases and emits one `__frontmatter__` section per YAML frontmatter block.
- **TypeScript decorator post-pass** walks bracket balance so multi-line `@Component({...})` no longer truncates the next symbol.
- **`gdrive-fetch` filename-hint routing** is now capped at 256 chars and sanitised so a hostile filename cannot inject prompt fragments.

### Security

- Tighter sanitisation on the Google Drive filename hint and the webfetch URL -> content-hash mapping; both surfaces now refuse oversized or malformed values rather than passing them through.

## [0.3.1] - 2026-05-16

### Added

- **Linux and WSL support.** The worker now registers as a `systemd --user` service (`~/.config/systemd/user/token-goat-worker.service`) when systemd is available, with an XDG autostart `.desktop` fallback elsewhere. On WSL without systemd, the SessionStart hook starts the worker at the beginning of every Claude Code session. Data directory: `~/.local/share/token-goat/`. The install/uninstall flow, doctor checks, weekly auto-update (via `crontab`), and hook entry-point are platform-aware end-to-end.
- **macOS support** (untested). The worker registers as a LaunchAgent at `~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist`, loaded via `launchctl`. Data directory: `~/Library/Application Support/dfk-helper/token-goat/`. Weekly auto-update uses the same crontab path as Linux.
- **PyPI Trusted Publishing.** A `Publish to PyPI` GitHub Actions workflow builds and publishes on GitHub Release via OIDC, replacing long-lived API tokens stored as repo secrets. PyPI's docs explicitly call out the security and usability advantages of OIDC-based publishing.
- **README `What gets installed?` and `Security, privacy, and uninstall` sections** enumerating every file, hook, autostart entry, scheduled task, and data path the installer writes — and how each is reversed.
- README badges for PyPI version and CI status (in addition to the existing Python version and license badges).
- Lefthook git hooks for local lint / type-check / test parity with CI.
- PyPI project URLs, classifiers, and keywords surfaced in `pyproject.toml`.

### Changed

- Data directory namespace renamed from `DFK Helper LLC` to `dfk-helper` for cross-platform path hygiene (matches the platformdirs convention on every OS). A reinstall will recreate the index at the new path; the old directory can be removed by hand.
- Author / namespace migrated to `DFK Helper LLC` across the project (replaces a personal username in metadata and packaging fields).
- CI slimmed to Python 3.13 on Windows for `ruff`, `mypy`, and `pytest`. The package itself still declares support for 3.11–3.13.
- README rewritten with a before/after comparison table and stat callouts.

### Fixed

- Python 3.13 changed how `stat()` reports paths that contain a null byte; existing tests and a defensive check in `paths.py` were updated to accommodate the new error type.
- Three Windows-runner CI test failures resolved.
- Ruff caught a handful of orphaned imports left over from the iteration sweeps — all removed.
- `token-goat stats` no longer charges suggestion-only hints with an overhead "saving" they did not earn.
- `token-goat stats` bar-scale and share-% now use separate denominators so a single dominant kind no longer flattens the rest of the chart.

### Security

- Continued hardening of input validation in `paths.py` (`is_safe_rel_path`, hash-traversal guards in `project_db_path` and `session_cache_path`) so no rel-path can escape the data directory under any caller.

### Removed

- Legacy `tokenwise` launcher binaries (`tokenwise`, `tokenwise-hook`, `tokenwise-worker`) are now removed during install and uninstall when they sit alongside the current `token-goat` launchers.
- Provisional application number stripped from the patent notice.

## [0.2.3] - 2026-05-14

### Changed

- **`token-goat stats` reorders its table columns.** In the by-kind, by-day and by-project tables the `share` percentage now sits directly after `tokens saved`, ahead of the raw `events` count. The share is the at-a-glance "how much of the total is this" number; the event count is supporting detail — so the eye lands on share first and the column order matches that priority.
- **The worker now restarts on a same-version reinstall.** Its version-self-restart compared only the installed version *string*, so `uv tool install --reinstall` without a version bump — the common case during development — left the worker running stale code until something restarted it manually. `run_daemon` now also compares a content fingerprint of the installed package (a hash over the size and mtime of every `.py` file in the package directory), captured at boot and re-read on the same once-a-minute cadence. A change in either the version string or the fingerprint triggers the graceful slot-release-and-respawn. Fails soft: a fingerprint that can't be computed falls back to the version-string check.
- **Daily log files are now size-capped.** The `worker.log` and hook daily logs used a plain `FileHandler` with no size bound — they were bounded in *count* (date-named, 7-day retention sweep) but a single pathological day, e.g. a worker stuck in a fast error loop, could still bloat one file. Both handlers, and the `worker-stderr.log` crash sink, now share `paths.roll_log_if_oversized()`, which rolls a log over to a `.prev.log` sibling once it passes its cap (5 MB for daily logs, 1 MB for the crash sink) before the handler is attached. Best-effort under Windows multi-process contention — the roll is suppressed if another process holds the file and retried by the next opener — and `.prev.log` ends in `.log` so the retention sweep still reaps it.

## [0.2.2] - 2026-05-14

### Added

- **Skills and plugins indexing.** `token-goat index --root <path>` indexes any directory — no `.git` or project marker required. Shorthand flags: `--skills` indexes `~/.claude/skills/`, `--plugins` indexes `~/.claude/plugins/`. After indexing, `token-goat section "superman/SKILL.md::Plan Gate"` and `token-goat read "ralph/SKILL.md::symbol"` work from any directory, and `token-goat symbol --all-projects` picks up symbols defined in skills. Run once and forget — incremental re-indexing keeps skills current as you update them.
- **Cross-project file resolution.** `token-goat section` and `token-goat read` now fall back to searching all indexed projects when the file is not found in the current project. This means `token-goat section "superman/SKILL.md::Plan Gate"` works from inside any project directory, not just from inside `~/.claude/skills/`.

- **Compaction assist.** Before Claude Code compacts the conversation, a new `PreCompact` hook builds a structured session manifest and injects it as `systemMessage` so the compaction LLM can preserve edited files, accessed symbols, and frequently read files in its summary. The manifest stays under a configurable token budget (default 400 tokens). Configure via `[compact_assist]` in `config.toml` or set `TOKEN_GOAT_COMPACT_ASSIST=0` to disable entirely.
- `token-goat compact-hint --session-id <id>` debug command shows exactly what the `PreCompact` hook would emit for any session.
- `session.py` now tracks which files were edited this session (`edited_files: dict[str, int]`). The `post_edit` hook (previously a no-op) now calls `session.mark_file_edited()` on every Write/Edit/MultiEdit. Edited files are listed first in the compaction manifest — they are the most critical context to preserve.
- `token-goat doctor` now reports worker-watchdog state: the single-worker claim file (held / stale / absent), any index-spawn markers (`locks/{hash}.indexing`) and whether they are active or stale, and the dirty-queue depth (flagged when a backlog suggests the worker is down or behind). These cover the failure modes introduced with the worker claim file and index-spawn deduplication.
- `token-goat doctor --fix` clears the stale `.indexing` spawn markers doctor flags — the on-demand counterpart to the worker's startup reaping, for when the worker is down. It only ever removes markers `spawn_index_detached` already reads as inactive, so an in-flight indexer is never disturbed.

### Changed

- `token-goat stats` now reports the **net** token impact of the pre-read hook, not just its upside. Injecting a hint as `additionalContext` costs tokens in the conversation; the `session_hint` event now records `realized_saving − injection_cost`. Dedup hints (re-read warnings) stay net-positive; pure suggestion hints record a small negative — the honest signal that they cost tokens now and pay off later via the `read_replacement` stat `token-goat read` records if the agent acts on them. Summing the kind answers "is the pre-read hook net-positive?" directly.
- Pre-read hints are leaner. The purely-informational "FYI, you read this file earlier, proceeding" note — emitted on a non-overlapping re-read — is suppressed entirely: it carried nothing actionable and only cost tokens. The "large file, use `token-goat read`" suggestion no longer enumerates every indexed symbol; it carries one example command and lets `token-goat symbol`/`map` provide the full list on demand.

- Incremental indexing is now O(N × stat) instead of O(N × file-read + SHA) for unchanged projects. The previous path called `index_file()` — reading file bytes and computing SHA256 — for every file in the project just to determine nothing had changed. The incremental path now loads `(rel_path, mtime, content_sha256)` from the DB, checks `stat().st_mtime` first, and skips `index_file()` entirely when mtime is unchanged. The SHA check is preserved as a secondary guard for same-mtime content changes (e.g., `touch` + overwrite). This makes the 10-minute worker sweeps over skills and plugins near-instant when nothing has changed.

- `token-goat stats` startup time reduced from ~10 s to ~2 s. Root cause was N `PRAGMA integrity_check` + N DDL `executescript` calls per registered project on every invocation. `stats.py` now uses new read-only DB openers (`db.open_global_readonly()` / `db.open_project_readonly()`) that open SQLite with `?mode=ro` URI flag, skipping integrity checks, DDL, WAL activation, and sqlite-vec loading.
- `token-goat stats` bar widths and share percentages now reflect token savings rather than bytes saved. Event kinds that cannot produce a token estimate (webfetch and Drive image downloads, which report raw bytes with no token equivalent) fall back to bytes for their bar, with visual distinction.
- `image_shrink` events now correctly show token savings in `token-goat stats`. The tokens column was hardcoded to `—` despite the data being present in the DB.
- The worker's periodic reindex now sweeps every recently-active project, not just `marker='manual'` skills and plugins. Previously, normal git projects only reindexed when a file was edited *through Claude Code* (via the `post_edit` hook → dirty queue); a file edited in an IDE or by another tool would never be picked up, so `token-goat read`/`symbol`/`map` returned stale results indefinitely. The sweep is bounded to projects seen within the last 7 days, and `last_seen` is now bumped by the `SessionStart` hook so the window tracks real usage rather than the worker's own reindex cadence.

### Fixed

- **The worker-stderr crash sink grew without bound.** `spawn_detached` opens `logs/worker-stderr.log` in append mode on every worker spawn (one per `SessionStart` hook), and the daily-log retention sweep never catches it — each append refreshes the file's mtime, so it never ages past the 7-day cutoff. An actively-written crash log therefore grew forever. `spawn_detached` now rolls the file over to `worker-stderr.prev.log` once it passes `STDERR_LOG_MAX_BYTES` (1 MB), bounding the crash sink at ~2 MB while still retaining recent crash output.
- **Edits made while a project was first being indexed were silently dropped.** `index_project` registered the project in the global `projects` table only *after* the full file walk and index completed. For a large tree that window is minutes long — and never closes if the index spawn hangs or crashes. During it, the worker's dirty-queue drain looked up the project hash, found nothing, logged `dirty queue refers to unknown project hash`, and discarded the entry — so any file edited mid-index was never reindexed. The project is now registered in the global registry up front, before the walk; the final registry update still fills in the real `file_count`/`languages` once indexing finishes, and a crashed initial index now self-heals via the normal incremental drain and periodic reindex. (Surfaced in the field by a stray `.git` at a directory that is a container of repos, which made the entire supertree index as one project.)
- **The test suite deleted the user's real worker-autostart Run key.** `test_install_uninstall_round_trip` exercises `install_all()`/`uninstall_all()` — which call `winreg.SetValueEx`/`DeleteValue` on `HKCU\...\Run` directly — without mocking `winreg`, despite its "hermetic round-trip" docstring. Every `pytest` run therefore wrote and then *deleted* the real `token-goat-worker` autostart entry, so `token-goat doctor` reported `NOT INSTALLED` after any test run (which looked like an autostart bug but was the tests eating their own machine's registry). A new `isolate_registry` autouse fixture replaces `winreg` with an in-memory fake for the whole suite, so no test — present or future — can touch the real registry.
- **The worker had no autostart after `uv tool install --reinstall`.** The HKCU Run key that launches the worker at logon was only ever written by `token-goat install`; a `uv tool install --reinstall` — the normal way to deploy code changes — never touches it, and nothing else does either. Once the key was absent or cleared, the worker survived only as long as a Claude Code hook kept respawning it, and never came back after a reboot. `run_daemon` now self-registers the Run key on every startup (the claim-winning worker only), so autostart is self-healing and the registered command stays current. Fail-soft: a registry error is logged and ignored, never crashing the worker.
- **A worker that crashed during startup left no trace.** `spawn_detached` wired the spawned worker's stderr to `DEVNULL`, so any failure before the logging `FileHandler` was attached — an import error, a crash in `_setup_logging` — vanished completely, which is what made silent worker deaths impossible to diagnose. The worker's stderr now goes to `logs/worker-stderr.log`. The console `StreamHandler` — pointless for a detached daemon with no console, and now just routine-log noise in that file — is dropped for non-interactive runs, so the crash log captures only genuine escaped tracebacks.
- **The image cache missed for re-used images.** `image_shrink._cache_key` hashed `(absolute_path, mtime, size)`, so the cache entry was tied to one exact path at one exact mtime. Claude Code stages prompt-attached images to a fresh temp filename every prompt — so the same image re-used across prompts, or even referenced twice in one prompt, was re-shrunk from scratch each time and stored as a separate cache file. The key is now the sha256 of the image's *content*: identical bytes share one cache entry regardless of path, a re-used image is a cache hit, and a bare mtime touch no longer invalidates the entry while a real content change still does.
- **The first edit in a never-indexed project was silently dropped.** When the worker drained the dirty queue and the project's hash was not yet in `global.db` — the normal state for a project edited before it was ever indexed — `_process_dirty_entries` logged `dirty queue refers to unknown project hash` and discarded the entry. Nothing else triggered an initial index, so the edit was lost and the project stayed unindexed. The dirty-queue entry now carries `project_root` and `project_marker`, making it self-sufficient: on an unknown hash the worker reconstructs the project from the entry and runs a first full index (which self-registers it) instead of dropping the edit. Legacy entries with no recorded root still drop, but now with an explicit reason in the log.
- **A stray `.git` could make an entire directory of repos index as one project.** `find_project` walks up looking for a project marker; an accidental `git init` at a container directory (e.g. `C:\Projects` holding a dozen unrelated checkouts) made it return the whole supertree, and everything underneath indexed as a single giant project. `find_project` now skips a candidate root that looks like a *container* of repos — three or more immediate child directories with their own `.git` — and keeps walking up. A real project, including a monorepo whose packages share one root `.git`, does not match the container signature. This was the environmental trigger behind the field report of the mid-index-drop bug above.
- **Dirty-queue drain dropped entries appended mid-drain.** `drain_dirty_queue` read `dirty.txt` and then truncated it; a `post_edit` hook calling `enqueue_dirty` in the window between the read and the truncate had its line truncated away, so that file was never reindexed. The drain now atomically renames `dirty.txt` to a private `.draining` file before reading it — a concurrent append either travels in `.draining` or lands in a fresh `dirty.txt` for the next cycle, and can never be lost. A `.draining` file left behind by a worker that crashed mid-drain is recovered on the next call.
- **A reinstalled worker kept running stale code.** `uv tool install --reinstall` replaces the on-disk package but cannot touch an already-running worker process, so the daemon kept executing the old code until something external restarted it. The daemon now checks the installed version once a minute and, on a change, releases its single-worker slot and respawns — the successor loads the new code fresh from disk and claims the slot cleanly.
- **Stale `.indexing` spawn markers were never reaped.** `spawn_index_detached` writes a `locks/{hash}.indexing` marker and treats a present, *active* marker as "an index is already running" — but the marker was only ever cleared implicitly, via the PID-liveness + TTL check in `_index_spawn_active`. A marker whose indexer finished or crashed without its PID being recycled lingered on disk indefinitely (16 were found in the field). The worker's `cleanup_on_startup` — run on startup and every maintenance cycle — now reaps them with the exact predicate `spawn_index_detached` uses, so it can never remove a marker still doing its job.
- `post_edit` hook was registered but never called any session-tracking logic. It now records file edits, which feeds both the compaction manifest and future session-aware features.
- Double `@fail_soft` decorator on `post_edit` (applied twice, causing the decorator to wrap itself). Reduced to a single application.
- **Incremental reindex never ran for normal projects.** `post_edit` recorded edits to the session cache but never appended them to the dirty queue, and `enqueue_dirty()` — the function meant to do this — was defined but called from nowhere. The entire incremental-reindex path was dead code for git-detected projects: a project's symbol index went stale the moment you edited a file, so `token-goat read "file::symbol"` returned the wrong function body and the pre-read hint showed stale line numbers. `post_edit` now resolves the edited file's project and enqueues it; the worker drains and reindexes within ~2 s.
- **Runaway `index --full` pileup.** `spawn_index_detached` (called by every `SessionStart` hook) had no deduplication. Its `file_count == 0` guard was racy — concurrent indexers contended on the 30 s writer lock, timed out, exited *without writing*, so `file_count` stayed 0 and the next session spawned yet another. Observed in the field as 44 concurrent processes holding ~41 GB of paged memory. The spawn is now idempotent via a per-project marker (PID + timestamp, with a TTL and PID-liveness check).
- **Duplicate worker daemons.** `run_daemon`'s `is_worker_alive()` → `_write_pid()` sequence was a check-then-act race; two workers starting in the same window both passed the check and both ran the main loop, draining the same dirty queue. Replaced with an atomic `os.open(O_CREAT | O_EXCL)` claim keyed on the process's create-time, so exactly one worker can hold the slot and a crashed worker's claim is correctly reclaimed.
- **Deleted files lingered in the index forever.** `index_project` walked the files on disk but never pruned rows for files that had been removed or renamed. It now prunes them after indexing (the foreign-key cascade cleans up the file's symbols, refs, sections, and chunks).
- **Every token-goat command crashed under Codex's unelevated sandbox.** The sandbox cannot create the WAL shared-memory file, so `PRAGMA journal_mode = WAL` and the first real query failed with `unable to open database file`. `_connect()` and `_connect_readonly()` now fall back to an immutable read-only connection that bypasses WAL coordination entirely; schema-ensure and `record_stat` tolerate read-only connections; `conn.close()` errors in `finally` blocks are suppressed (the WAL checkpoint on close also fails); and the hook logger falls back to a `NullHandler` when the log directory is read-only. Fallback notices are logged at `INFO` so CLI and hook stderr stay clean.
- **`token-goat stats` overstated savings.** The pre-read hook recorded a `session_hint` saving for *every* hint it emitted — including pure suggestions like "this file is large, consider `token-goat read`" — at a flat "25 % of the file" estimate, whether or not the agent acted on it. Hints now carry the genuine avoided cost: suggestion hints record nothing (if followed, `token-goat read` records the real `read_replacement` saving itself), and only dedup hints that warn about re-reading already-cached content record a saving, sized to the actual overlapping lines.
- **A worker that crashed or hung mid-session was never replaced until the next session.** `SessionStart` starts the worker, but nothing noticed a death *during* a session — the dirty queue would silently stop draining. The `post_edit` hook (which feeds the queue) now runs a cheap mid-session watchdog: a single `stat()` on the heartbeat file, and only on the rare stale path does it import `worker` and call `ensure_running()`. `ensure_running()` itself now distinguishes a crashed worker (process gone — respawn), a hung worker (alive but heartbeat stale beyond any plausible busy period — reap, then respawn), and a merely-busy worker (alive, moderately stale — left untouched, since a duplicate would just lose the claim race and clearing its pid file would orphan it). Hung-worker reaping verifies the process command line first, so a recycled PID is never killed.

## [0.2.0] - 2026-05-12

### Added

- Session hint events in `token-goat stats`. When the agent tries to re-read a file already pulled into the current session, Token-Goat now records the savings estimate alongside the existing reminder. The hints show up in the stats output next to image-shrink and read-replacement counts.
- Automatic first-time indexing at session start. The first time Token-Goat sees a new project, it kicks off a background symbol index so the next `token-goat symbol`, `token-goat read`, and `token-goat section` calls return data instead of an empty result.
- "Project not yet indexed" hint in `token-goat symbol`, `ref`, `read`, and `section`. The old response was "No matches", which made it look like Token-Goat was broken when the index was still warming up.
- Token-Goat logo (`assets/logo.png`) and a Windows multi-size icon (`assets/token-goat.ico`). README now opens with the logo centered.
- Availability line in the README footer for engineering inquiries.

### Changed

- Hook commands and the worker auto-start command now invoke `pythonw.exe -m token_goat.cli ...` directly from Token-Goat's uv tool venv. The previous launcher .exe approach tripped behavioral heuristics in several major antivirus and EDR products; the signed Python interpreter plus module invocation does not. See Security below.
- `token-goat stats` redesigned. A one-line headline summary at the top, unicode bar charts proportional to bytes saved, and separate breakdowns by event kind, day, and project below.
- Image-shrink events now include a token-savings estimate at one token per four bytes saved, so the headline counter reflects token impact and not just bytes on disk.
- License changed from MIT to PolyForm Noncommercial 1.0.0. Token-Goat stays free for personal and noncommercial use; commercial use requires a separate license. See LICENSE for full terms.
- CLAUDE.md, Codex AGENTS.md, and SKILL.md directives sharpened. Imperative phrasing, before-and-after tables that show the token-cost difference between `token-goat symbol` and `grep`, and a verification cue at the bottom.
- Python version pin widened to support 3.14.
- Continuous integration now runs `mypy` alongside `ruff` and `pytest`.

### Fixed

- "hook exited with code 1" errors in Codex and Claude Code. Hook entry points now eat unknown arguments, catch every exception class including `SystemExit`, and always exit zero with valid JSON on stdout, even when the harness passes arguments the typer entry point did not expect.
- Database integrity check no longer treats a locked or busy SQLite file as corruption. The previous behavior tried to quarantine the file, failed because Windows held the file lock, and surfaced as `token-goat map` or `token-goat stats` exiting 1.
- Test runs no longer write to the production hook log file. An autouse fixture isolates the hook logger for the duration of each test.
- `read_payload` coerces non-dict JSON (`null`, lists, scalars) to an empty dict so hook handlers can safely call `payload.get(...)` regardless of what the harness sends on stdin.
- Pillow `Image.LANCZOS` replaced with `Image.Resampling.LANCZOS` to remove the deprecation warning on Pillow 10 and newer.
- Rust and Go extractor error fallbacks now return the four-tuple the extractor protocol requires. The previous three-tuple return crashed downstream and was caught by fail-soft, so Go and Rust files never indexed when extraction failed.
- Variable-name shadowing in `embeddings.py` chunk extraction. Caught by mypy, not a runtime bug, but cleaner now.

### Security

- Hook and worker spawn pattern reworked so antivirus and EDR products do not behavior-flag Token-Goat. The previous design spawned a small PyInstaller-style launcher .exe from a user-writable directory (`~/.local/bin/`), which matched the textbook payload-drop signature those products monitor for. Hooks now invoke the Python Software Foundation signed `pythonw.exe` from Token-Goat's uv tool venv directly, with `-m token_goat.cli`. This is the most boring spawn pattern on Windows and gets treated as benign by Bitdefender, Defender, Norton, McAfee, Kaspersky, Sophos, and ESET.

## [0.1.0] - 2026-05-12

First public release.

### Added

- Image shrinking on local file reads. When the agent opens a large PNG or JPEG, Token-Goat returns a compressed copy in place of the original. A 3.3 MB screenshot from one test session arrived at 84 KB.
- Image shrinking on Google Drive image downloads. Activates only when the user has already authorized Google Drive through Claude Code's built-in connector. Token-Goat never asks for its own Drive auth.
- Session-aware read hints. When the agent tries to read a file already pulled into the current session, it gets a short reminder of the prior read and a nudge to grab a narrower slice instead.
- Targeted symbol reads via `token-goat read "file.py::function_name"`. Pulls one function or class, not the whole file.
- Targeted section reads via `token-goat section "doc.md::Heading"`. Pulls one Markdown section by heading.
- Semantic search via `token-goat semantic "<query>"`. Find code by meaning, not by filename. First call downloads a small embedding model into `%LOCALAPPDATA%\dfk-helper\token-goat\models\`.
- Repo orientation via `token-goat map`. A compact, ranked overview of the most important files in a repository.
- Cumulative savings tracking via `token-goat stats`.
- Install and uninstall flow for Claude Code, with `--codex` flag to patch Codex CLI in the same pass.
- Diagnostic command `token-goat doctor` confirms the install is healthy.
- Background worker that auto-starts at logon, runs without a console window, and survives reboots.

### Notes

- Licensed under PolyForm Noncommercial 1.0.0. See LICENSE for full terms.
- Windows 10 and 11 only.
- Python 3.11, 3.12, 3.13, and 3.14 supported.

[Unreleased]: https://github.com/DFKHelper/token-goat/compare/v1.9.9...HEAD
[1.9.9]: https://github.com/DFKHelper/token-goat/compare/v1.9.8...v1.9.9
[1.9.4]: https://github.com/DFKHelper/token-goat/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/DFKHelper/token-goat/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/DFKHelper/token-goat/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/DFKHelper/token-goat/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/DFKHelper/token-goat/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/DFKHelper/token-goat/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/DFKHelper/token-goat/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/DFKHelper/token-goat/compare/v1.5.2...v1.7.0
[1.5.2]: https://github.com/DFKHelper/token-goat/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/DFKHelper/token-goat/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/DFKHelper/token-goat/compare/v1.3.0...v1.5.0
[1.3.0]: https://github.com/DFKHelper/token-goat/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/DFKHelper/token-goat/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/DFKHelper/token-goat/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/DFKHelper/token-goat/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/DFKHelper/token-goat/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/DFKHelper/token-goat/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/DFKHelper/token-goat/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/DFKHelper/token-goat/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/DFKHelper/token-goat/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/DFKHelper/token-goat/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/DFKHelper/token-goat/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/DFKHelper/token-goat/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/DFKHelper/token-goat/compare/v0.4.0...v0.5.0
[0.3.1]: https://github.com/DFKHelper/token-goat/compare/v0.3.0...v0.3.1
