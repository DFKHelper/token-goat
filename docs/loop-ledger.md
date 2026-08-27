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
| SC-11 | 20,32 | CORRECTNESS DEFECTS ONLY in all of `read_commands.ts` incl. `resolveSymbolSpec`, `formatAmbiguity`, `runSemantic`, `runBrief`, `runCsvQuery`, and the structured-file readers | new reader command |
| SC-12 | 28-31 | All hooks, for ACCOUNTING and PARTITION defects only | new hook or stat kind |
| SC-13 | 30-33 | All four stat-registry mirrors now guarded by tests | guard allowlist grows |
| SC-14 | 38-39 | `resident_context.ts` (`readTaskList`, `collectInvokedSkills`, `skillNameFromBody`); `waste.ts::parseTranscript`/`extractResultText`; `session_read.ts::toTurnBlocks`/`streamTurns`; `hooks_agent_spawn.ts` naming; `hooks_cli.ts::normalizePayload` claude path; `hooks_common.ts` key lists for Bash/WebFetch/TaskOutput | harness payload shape changes |
| SC-15 | 34-37,40 | Filters verified against REAL captured output: ruff (single and multi file), golangci-lint, pylint, bandit, pre-commit, ktlint | the tool ships a major version |
| SC-16 | 37,40 | Verified against authoritative source docs: swiftlint, clang-tidy matcher, cppcheck (non-defect, documented) | as above |
| SC-17 | 9-13,33-34 | `base.ts`, `generic.ts`, `helpers.ts`, dispatch, `EnvFilter`, `MySQLFilter`, all ten AI CLI configs, `TrivyFilter`, `CodexExecFilter`, `BiomeFilter`, `compressGhList`, `TailTruncFilter`, `SeverityLogFilter`, `JsonArrayFilter`, `makeLinterFilter`, `TscFilter`, `_compressEslintStanza`, `OxlintFilter`, `shell_file.ts` caps, `build.ts` caps | a filter's tool changes format |
| SC-18 | 40 | `helpers.ts::maybeNote` and the 203-site note-pluralisation family | new note family |
| SC-19 | 44 | The re-read divert seam, measured end to end on the real corpus (8,545 files, 2026-08-27): 4,463 full serves >=10 KiB split into 4,027 first reads (90.2%, excluded by design), 347 ranged repeats (deliberate paging), 89 whole-file repeats of which 41 in hooked sessions of which 35 post-compaction (correct by design), leaving 6 corpus-wide unexplained. No fixable defect pool exists in the divert seam | divert or compaction-epoch policy changes |
| SC-20 | 47 | Token-goat's own Bash-output economy, censused per subcommand over 13,614 real invocations (33.4 MB, corpus 8,552 files, 2026-08-27; volume ranking endogenous to this program's own loops, bytes-per-invocation is not). Framing audited on the top per-invocation emitters: `read` (2,656 B/inv) and `section` (3,220) carry one header line each, `symbol` (730) is tight, `skill-body` (8,186), `mcp-output` (7,120), `bash-output` (2,278), `pdf-extract` (2,206) and `skeleton` (2,409) are requested payload, `stats`/`commands` (2.7-2.8 KB) are operator-requested surfaces. The one avoidable share found was `outline` (2,406 B/inv, third by total): its first-line docstring clip was a no-op on single-line `//` doc comments, fixed loop 47 with a 140-char word-boundary clip and visible ellipsis (11.2% of outline bytes across src/, 41% on doc-heavy files). All counts, ranges, truncation notices, filter explanations and stale warnings kept | a listing command starts rendering docstrings, or the outline text format changes |
| SC-21 | 50 | The skill-attachment economy, censused on 8,567 transcripts (2026-08-27): invoked_skills 2,493 injections / 43.2 MB raw across 25 skills, 96.4% of injections are per-turn re-injections and 98.3% of those byte-identical (harness waste, same verdict as loop 43's task_reminder); skill_listing 9,814 injections / 301.4 MB, 84% once-per-session first injections and only 44.5% of re-injections identical, wholly harness-owned (no hook fires before an attachment); slash-expansion channel small (394 injections, 165 sessions, unhookable). The compact mechanism's causal premise MEASURED TRUE: of 634 (session, skill) first-load/repeat deny events, 630 show zero invoked_skills attachments afterward, so a deny kills the whole residency stream; the 4 exceptions each had a later successful Skill call. The addressable slice is marker adoption on the operator's own oversized skills (top markerless spenders on this machine: 156 KB, 33 KB, 26 KB, 25 KB bodies = ~22 MB of the 43.2), and the surfaces that drive adoption already exist (skill-size recommendations, install pre-gen, doctor remediation); loop 50 fixed the one defect found in them (skill-compact --all silent buckets + ENOENT crash) | skill attachment shapes change, or a new skill-body channel appears |
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
| DL-22 | Loop-45 sed-hint admission stops at 80.1% of the 19,386-command corpus: single-address `sed -n 'Np' file` stays unhinted (one line is already surgical, matching the head/tail <=10 carve-out); pattern ranges (`/re/,/re2/p`, 50 corpus commands), `\| grep` pipes (a search, not a read), `>`-redirects (output never reaches context), edits, and multiline heredoc constructions reject the whole command | remaining 19.9% is out of the read class or too rare to describe safely |
| DL-23 | Loop-46 cat/awk-hint admission stops at 21.1% of 8,179 cat-headed and 23.7% of 916 awk-headed corpus commands: the cat remainder is heredoc/redirect writes (~4,500), multi-segment compounds, `\| grep` pipes (a search, per DL-22), temp-path and unknown-extension reads (.log/.output by design); the awk remainder is transforming actions (substr/length/`%.Ns`, 41), computations (102), pattern ranges `/re1/,/re2/` (11, DL-22 parity), and single/multi `NR==n` line picks (already surgical). Census note: the loop-46 brief's claimed baseline (awk 324/916 admitted, 4,044 cat pipeline misses) did NOT reproduce against the real handler: measured baseline was awk 94/916 and ~1,314 cat pipeline misses | remaining pools are out of the read class or by-design silences |

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
| BE-09 | RESOLVED loop 48, and the kill condition FIRED: the harness injects the full tool manifest regardless of subagent type, so a spawn-time advisory recommending "a typed agent" would be actively wrong and none was shipped. Evidence, 5,988 lanes joined via BE-07's meta.json key, prefix = first assistant usage minus a brief estimate: typed-but-unrestricted types sit on general-purpose (torque-implementer net 117,533, claude 69,453, coder in its unrestricted era 93,801, vs general-purpose 92,501; within-session paired gaps coder +7,054, torque-implementer -5,306, claude -3,122), so loop 43/44's typed-vs-untyped medians were confounded by which types carry a tools allowlist. The causal lever is the agent definition's tools frontmatter: claude-agents commit 6163167 added a tools line to coder.md on 2026-08-20, and coder's median net prefix fell 93,801 (n=834) to 34,972 (n=40) across that cut while general-purpose held flat (92,353 to 93,268) and never-restricted torque-implementer stayed heavy (117,533 to 112,303). No counterexample among 16 resolvable types: every within-session-cheap type (-30k to -90k) is restricted, every heavy one unrestricted; fork is a separate mechanism (inherits the parent conversation, 138,872 net, zero pre-messages). A future advisory must key on restriction, not typing; the only spawn-observable safe trigger is a missing subagent_type (defaults to general-purpose, definitionally unrestricted). Full numbers in memory: project_unrestricted_spawn_carries_mcp_manifest. Loop 49 shipped the advisory this evidence specified: postAgentHandler emits a once-per-session contextOutput (the documented PostToolUse additionalContext shape, verified on the built binary) when a finished spawn ran as general-purpose, either untyped or named explicitly (both definitionally unrestricted, an improvement over the absent-only trigger), gated on at least one tools:-restricted definition existing under ~/.claude/agents (home-level only, deliberately not cwd-relative: this repo's own .claude/agents would make a cwd gate self-firing); recorded as a zero-credit session_hint with the text stating outright that the observed spawn already ran and nothing was saved | closed |

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
| 45 | ec428146 | hooks_bash sed hint admission | medium (66.8% -> 80.1% of 19,380) | yes | 117 |
| 46 | 5ef2f7ca | hooks_bash cat/awk hint admission | medium (cat 15.1% -> 21.1% of 8,179; awk 10.3% -> 23.7% of 916) | yes | ~180 |
| 47 | 605ae10c | read_commands outline output economy | medium (outline -11.2% over src/, -41% doc-heavy) | yes | 98 |
| 48 | c2f1b165 | hooks_agent_spawn advisory premise | n/a (kill condition fired, no code) | n/a | 94 |
| 49 | 47452cc4 | hooks_agent_spawn restriction advisory | n/a (new advisory, zero credit) | n/a | 145 |
