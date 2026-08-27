# Improvement-loop ledger

Durable state for the improvement-loop program. Briefs carry a pointer to this file plus the
delta since the last loop, never the whole list. Read one section with
`token-goat section "docs/loop-ledger.md::<Heading>"`.

Three lists and a yield record. The first two are load-bearing: they stop re-sweeping ground
already covered and stop re-fixing decisions taken deliberately. They previously existed only
in rolling brief text, one compaction away from losing every entry.

Writers echo `lists: consulted <rev>` in the commit message. A conflict between a loop's target
and an entry here ESCALATES to the orchestrator, and is never resolved silently by the writer.

## Swept Clean

Surfaces audited and found sound. Do not re-sweep without a recheck condition firing.

| id | loop | scope | recheck when |
|---|---|---|---|
| SC-01 | 1-21 | All 22 language adapters; `languages/common.ts` incl. `findBlockOpenBrace` | a new adapter lands |
| SC-02 | 1-21 | `index_prune.ts`, `embeddings.ts`, `fingerprint.ts` | schema change |
| SC-03 | 1-21 | `parser.ts` markdown extractor and all TOML handling | new markup kind |
| SC-04 | 1-21 | `section_reader.ts::findTableHeaders`; the `::` spec parser; `projectScopeClause` | spec syntax changes |
| SC-05 | 1-21 | `worker.ts` end to end incl. injected-seam audit | queue or drain change |
| SC-06 | 1-21 | `index_reader.ts` query builders | new query shape |
| SC-07 | 1-21 | `paths.ts::resolveIndexPath` and `normalizePath` mount handling | new platform |
| SC-08 | 1-21 | `config.ts::mergeRawConfig`, `stripLockedProjectKeys` | new lock-list key |
| SC-09 | 22 | `url_policy.ts`; `zip_bounds.ts::unzipBounded`; `neutralizeFenceMarkers`; `redactGhBase64Content` statefulness; `isInsideRoot` | any redact/fence/confine edit |
| SC-10 | 24-27 | All of `graph_commands.ts` including its full bound table | new command in the file |
| SC-11 | 20,32 | All of `read_commands.ts` incl. `resolveSymbolSpec`, `formatAmbiguity`, `runSemantic`, `runBrief`, `runCsvQuery`, and the structured-file readers | new reader command |
| SC-12 | 28-31 | All hooks, for ACCOUNTING and PARTITION defects only | new hook or stat kind |
| SC-13 | 30-33 | All four stat-registry mirrors now guarded by tests | guard allowlist grows |
| SC-14 | 38-39 | `resident_context.ts` (`readTaskList`, `collectInvokedSkills`, `skillNameFromBody`); `waste.ts::parseTranscript`/`extractResultText`; `session_read.ts::toTurnBlocks`/`streamTurns`; `hooks_agent_spawn.ts` naming; `hooks_cli.ts::normalizePayload` claude path; `hooks_common.ts` key lists for Bash/WebFetch/TaskOutput | harness payload shape changes |
| SC-15 | 34-37,40 | Filters verified against REAL captured output: ruff (single and multi file), golangci-lint, pylint, bandit, pre-commit, ktlint | the tool ships a major version |
| SC-16 | 37,40 | Verified against authoritative source docs: swiftlint, clang-tidy matcher, cppcheck (non-defect, documented) | as above |
| SC-17 | 9-13,33-34 | `base.ts`, `generic.ts`, `helpers.ts`, dispatch, `EnvFilter`, `MySQLFilter`, all ten AI CLI configs, `TrivyFilter`, `CodexExecFilter`, `BiomeFilter`, `compressGhList`, `TailTruncFilter`, `SeverityLogFilter`, `JsonArrayFilter`, `makeLinterFilter`, `TscFilter`, `_compressEslintStanza`, `OxlintFilter`, `shell_file.ts` caps, `build.ts` caps | a filter's tool changes format |
| SC-18 | 40 | `helpers.ts::maybeNote` and the 203-site note-pluralisation family | new note family |
| SC-19 | 44 | The re-read divert seam, measured end to end on the real corpus (8,545 files, 2026-08-27): 4,463 full serves >=10 KiB split into 4,027 first reads (90.2%, excluded by design), 347 ranged repeats (deliberate paging), 89 whole-file repeats of which 41 in hooked sessions of which 35 post-compaction (correct by design), leaving 6 corpus-wide unexplained. No fixable defect pool exists in the divert seam | divert or compaction-epoch policy changes |

## Deliberately Left

Confirmed real, judged not worth changing. Do NOT "fix" these. A writer that believes one is
wrong escalates rather than acting.

| id | scope | reason |
|---|---|---|
| DL-01 | Six `bash_compress:recall` advisory-hint credits | advisory by design |
| DL-02 | `MavenFilter.compress` subcommand routing, and its failure branch reordering earlier errors after the tail | low traffic |
| DL-03 | `_compressKubectlDescribe` `Conditions:` branch | rarely load-bearing |
| DL-04 | `SnykFilter` uncollapsed `Info:` line and global `treeLines` budget | acceptable |
| DL-05 | `GenericCIFilter.matches()` substring over-match | over-match is the safe direction |
| DL-06 | `MySQLFilter._compressDump` note not naming collapsed structures | cosmetic |
| DL-07 | `TrivyFilter` ASCII-only table assumption | modern trivy emits box-drawing; unverified without install |
| DL-08 | Advisory `limit: 50`-then-filter at `read_commands.ts:763`/`:798` | advisory output |
| DL-09 | `types --limit N` per-kind; `callers` text-mode truncation notice; `applyTypedRefsTier` after the SQL cap | documented behaviour |
| DL-10 | Zig `test "..."` blocks unindexed; `findBlockOpenBrace` statement-start detection | known adapter gaps |
| DL-11 | `skeleton`/`outline --json` omitting `hiddenByGrep`; `renderRefsTargets` `annotateHiddenByGrep` | json consumers do not use it |
| DL-12 | `runSectionMulti` collapsing `file::A,A`; `resolveHeaderPos` on `Heading#0`; `openapi-outline` on a non-OpenAPI file | degenerate inputs |
| DL-13 | `pdf-extract` clamp asymmetry; `xlsx-range` empty-row noise; `xlsx-query` header-only sheet | cosmetic |
| DL-14 | Bounded prose over-credit on pre-read serve/diff branches | bounded, documented |
| DL-15 | `redactGhBase64Content` not accepting `\r`, not descending nested objects; orphaned `redactSecrets` docblock | narrow |
| DL-16 | Nine bound sites classified harmless in loop 26; loop 28's three (`postReadHandlerInner` out-of-root drop, `capManifestChars` notice overflow, `adaptiveCharBonus` `* 3`) | measured harmless |
| DL-17 | Reverse-guard allowlist (6 entries, size pinned) and grouping-guard allowlist | each registered with a reason |
| DL-18 | `filterRefsForSymbol` name-attribution heuristic | heuristic by design |
| DL-19 | golangci-lint capture recorded `clearsShippingFloor: false` | stated rather than papered over |
| DL-20 | No upper ratio bound in the real-output guard | a ceiling is satisfied by bumping a number; a must-not-drop entry is not |
| DL-21 | `extractExitCode` stays dormant | 186,335 recorded Bash results carry no exit-code field; the only status field marks benign non-zero exits |

## Blocked On Evidence

Not swept, and not to be attempted by inference. Each needs a real capture or a live harness.

| id | scope | unblocked by |
|---|---|---|
| BE-01 | All of `cloud.ts` (gcloud, aws, azure, ansible, pulumi, cdk, vault, packer, nix, wrangler, hardhat, serverless, fly, forge) | installing the tool, or a real captured run |
| BE-02 | `phpstan` filter | PHP plus composer |
| BE-03 | A real cppcheck capture, to build the source/caret collapse | cppcheck install (needs elevation) |
| BE-04 | A real clang-tidy capture | LLVM install |
| BE-05 | `hooks_bashoutput.ts` envelope | zero `BashOutput` results exist corpus-wide; needs the interactive client |
| BE-06 | Codex, Gemini, Grok, Kimi wire maps | those harnesses |
| BE-07 | RESOLVED loop 44: the join key exists. Every lane file has a sibling `agent-<id>.meta.json` carrying `agentType`, `parentAgentId`, `spawnDepth` and `toolUseId`; `toolUseId` joins to the `tool_use` block (name `Agent`/`Task`) in `agent-<parentAgentId>.jsonl` or the main transcript, verified on a real sample, and `agentType` alone gives the typed-vs-unrestricted split with no join at all. `session-audit` now reports a per-agentType lane rollup: general-purpose (2,793 lanes) median prefix 93,076 tokens vs researcher 32,392 and token-goat-bugfixer 28,753, so the sub-40k mode of the spawn-prefix histogram is the lean typed agents and the 60k+ mode is general-purpose/coder/workflow lanes | closed |
| BE-08 | Program-vs-ordinary-dev split of the token-goat project's own 1.41B billed input-equivalents | nothing: the split needs transcript content, which the privacy invariant forbids; treat as permanently confounded and say so when citing project-share numbers |

## Yield Ledger

One line per loop, written by the ORCHESTRATOR and never by the writer. Seam labels freeze at
first use. Severity is judgment and is marked as such. Reachability is mechanical: was the
defect present at the last release tag, or introduced during this program.

Activation gate: score loops 33-40 retroactively first. If the unit cannot discriminate within
that batch (cosmetic finds low, the hooks/Bash field defect high), the unit is wrong and the
trip rule stays off, with the ledger kept as a record only.

Trip rule, once calibrated: two consecutive low-yield lines in one seam trigger a survey. A
survey that does not change the aim does not reset the counter. Two aim-unchanged surveys in a
row go to the user.

| loop | commit | seam | severity | reachable at tag | spend (ktok) |
|---|---|---|---|---|---|
| 41 | 47681a46 | session-audit | n/a (new command) | n/a | 127 |
| 42 | 023e0eb3 | session-audit | high (65% of corpus unscanned) | yes | 170 |
| 43 | 181cf7a7 | session-audit | n/a (survey) | n/a | 152 |
| 44 | 707cdd3b | session-audit | n/a (survey, clean sweep) | n/a | 208 |
