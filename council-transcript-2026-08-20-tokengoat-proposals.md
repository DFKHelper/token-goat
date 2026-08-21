# Council Transcript — token-goat mined-proposal prioritisation

run_timestamp: 2026-08-20

## Run integrity record

```
mode: full
advisors_count_configured: 6
reviewers_count_configured: 3
reviewers_status: configured
run_timestamp: 2026-08-20
role_swap: none
role_swap_pattern_action: not triggered (no prior council transcripts found in this workspace — pattern could not be checked)
exclusions: none
cross_model_baseline_family: Anthropic (Claude)
cross_model_routes_checked: [litellm localhost:4000 -> glm-5.3 (answered, auth-gated but reachable via claude CLI wrapper), ollama localhost:11434 -> qwen3.8:27b-iq4_nl (answered)]
cross_model_families_used: [Zhipu GLM, Qwen]
cross_model_roles_used: [Contrarian (Qwen, local-GPU cap 1), Adversary (GLM-5.3)]
chairman_tier: opus (strongest available: sonnet/opus/haiku/fable)
language: English
evidence_dispatch: none (framed question broadcast identically — the proposal set is compact enough to send whole)
style_normalization: skipped
low_diversity_flag: (set after step 3 scan)
```

## Frame manifest

```
mode: full
neutral_frame_present: Y
raw_question_separated: Y
provenance_tags: complete
sycophancy_shield: applied
risk_laundering_reread: done
premise_check: flagged — proposal 8's root cause is explicitly an unverified hypothesis, and proposals 9/10 measure behaviour without the counterfactual; the frame carries these as stated unknowns rather than premises
alt_framings_considered:
  - "which of these 13 do we build" (the asked frame)
  - "what is the single highest-leverage GAP CLASS these 13 are all instances of" (folded in as a named alternative)
  - "is measured-bytes-in-transcript even the right currency, versus billed tokens" (folded in — proposal 1 turns on exactly this)
lenses_run: [vanishing-options, assumption-reversal, combination/sequencing, domain-transplant, provocation, random-entry, null]
options_in_frame: [13 user proposals] + [widened: W1 unified shell-target classifier, W2 measure-before-build probe, W3 root-cause 8 first as a diagnostic, W4 do nothing this round] + null:Y
option_order_seed: timestamp-hash 2026-08-20 -> presentation order recorded per advisor spawn
prior_outcome_notes: none — no prior council transcripts exist in this workspace
clarifying_question_used: N
```

## Framed question (broadcast to all advisors)

See the advisor prompt body reproduced below; responses follow.

## Advisor responses (step 2)

### Advisor: The Contrarian (routed cross-family to Qwen `qwen3.8:27b-iq4_nl` via local ollama)

**Route degradation, recorded rather than silently re-run:** the local model emitted unseparated chain-of-thought and hit its length ceiling before producing a clean final block. Inside that reasoning it drafted a complete, correctly-structured response; that draft is reproduced verbatim below and used as this advisor's contribution. It is a genuine cross-family voice, but it did not survive the transport cleanly, and that is a real reduction in this advisor's reliability weight.

> Live considerations:
> - P3 is the only item whose saving is already in billed text tokens and has no agency/quality trade (FACT/INFERENCE). It cuts against my skepticism because it is cheap and likely real.
> - P10/P9 are the biggest billed-token tax, but P9's effect is unmeasured and P10 is not hook-implementable (FACT/UNKNOWN), which cuts against any shell-patch order that ignores compaction.
> - The shell items are one parser surface; each new wrapper/pipe rule adds future misclassification risk (INFERENCE).
>
> Core claim: build only unit-honest, low-surface fixes, not the breadth. Do P3 first; then P4 as cumulative hint (not deny) because telemetry proves the floor is dead and hint efficacy is measured; then P7 only because it closes a known cat escape hatch with existing deny. Kill/defer P1, P2, P5, P6, P8, P9, P10, P11, P12, P13. P8 must be diagnosed before any build; P9 needs counterfactual; P1 needs quality measurement and P5 defect fix before any image edge change.
>
> If right: token-goat avoids shipping a shell parser and an unmeasured quality/agency trade, while capturing the only savings that are already billed and testable.
>
> FLIP: P9's ~400-token manifest actually suppresses post-compact re-searching enough to dwarf P3+P4+P7.
> POSITION: implement P3, then P4 (hint-only cumulative), then P7; kill P1, P2, P5, P6, P8, P9, P10, P11, P12, P13 this round.

Its pre-mortem, recorded from the same reasoning: token-goat shipped a pile of shell classifiers and an image edge change, but token burn remained high because compaction summaries and MCP base64 text still dominated; tests were green but dogfooding showed agents re-reading and re-searching after every compact, and the new target-extraction layer misparsed WSL and pipes, causing false denies.

### Advisor: The First Principles Thinker (Claude, haiku)

Core claim: the question asks for 13 independent decisions when there are three or four interdependent architectural choices. The byte-to-token currency gap is not measurement noise: P1 exists because the provider downscales before tokenizing, so resizing to 1568 saves wire bytes and zero billed tokens, and the repo's own recurring defect class is crediting savings in the wrong unit (FACT). W1 covers P2, P6, P7, P12 and possibly P8 as one architecture fix rather than five patches (INFERENCE). Everything else is either noise (P3, P10, P11, P13), an unknown root cause (P8), or a hidden quality/agency trade with no counterfactual (P1, P4, P5, P9).

Named the consideration cutting against itself: P3 is about ten lines in an already-registered hook and P12 is free if bundled, so breadth genuinely is fast and safe.

Order: kill P3, P10, P11, P13; diagnose P8; build W1; defer P1, P4, P5, P9 until counterfactuals are measured.

FLIP: if P8's root is already known or trivial, and the shell gaps really are independent, breadth-first patching is cheaper than one architecture pass.

POSITION: no listed option fits cleanly; closest is W3 chained to W1, with the rest deferred. Kills W4/null.

### Advisor: The Outsider (Claude, haiku)

Core claim: do not order these 13 yet. Four of the thirteen are effectively unusable on the frame's own admission (P10 not implementable, P13 already handled, P8 root cause unverified, P9 and P11 counterfactuals unmeasured), and the ordering is being asked for in a currency (bytes) the frame itself says diverges from the unit that bills (FACT). Whether the byte savings in P2, P6, P7 actually suppress the agent's next action or merely move cost downstream is UNKNOWN.

Sequence: kill P10 and P13; root-cause P8 to learn whether it unifies P2/P6/P7; instrument P9 and P11's counterfactuals; only then order the residue by the unit that bills, with explicit reversal conditions for P1 and P5.

The diagnosis gates the ordering: if P8's root is one silently-failing gate type, W1 ships P2/P6/P7 for the cost of one and covers the next unlisted wrapper free; if P8 is noise, P2 jumps to priority.

FLIP: if P9 and P11's counterfactuals can be proved in parallel with the P8 diagnosis, a 13-item ordering becomes defensible.

POSITION: W3 plus W2 before any ordering. Kill P10, P13. Defer P1 pending quality measurement.

### Advisor: The Expansionist (Claude, haiku)

Core claim: the ceiling is not 108 KB or 4.4 MB, it is compaction. P10's tax outweighs every patch on the list and has been written off as not implementable, which is an ASSUMPTION about where the harness boundary sits, not a finding. If that constraint is soft it dominates priority; if it is genuinely hard, the right move is filing a constraint-removal request upstream rather than optimising below it.

Bracketing that: P2, P6, P7, P12 and likely P8 are one hole class, and building the target-extraction layer once gives a one-to-many multiplier over every wrapper the agent invents next quarter.

Its distinct contribution, which no other advisor produced: invert the discovery pipeline. The project currently mines transcripts after the fact to find classifier gaps. Build a shell-command corpus generator instead (pipes, wrappers, line-range arguments, alternate binaries) and run the existing classifier suite against it. P8's root cause becomes traceable, the next thirteen gaps become visible immediately, and future proposals evaluate themselves.

Kills: P1 (quality trap), P4, P11, P13, and P5 unless genuinely latent.

FLIP: if compaction is immovable from the harness side, everything else is rearranging deck chairs.

POSITION: W1, with the corpus generator as follow-up; closest named option is W3, endorsing the diagnostic method applied to the whole class at once rather than to P8 alone.

### Advisor: The Executor (Claude, haiku)

Core claim: P3 is the Monday-morning move and P8 is the diagnostic gate to everything else. P3 is about ten lines in an existing hook, measured in the billed currency, zero quality trade, no counterfactual needed (FACT). P8's claim is that a net-benefit gate declines the single-file case then fails to emit a hint; if true that is a small reorder bug whose fix also unblocks confidence in P2/P7/P12, and if false the 575 calls are acceptable noise. Either way you learn whether these are one defect or five, which changes both the build order and whether W1 or instance patches is correct. ASSUMPTION: instrumenting P8 takes under two hours; at eight hours of tracing this breaks.

P1 is a quality trap wearing a savings hat: wire bytes drop, billed tokens do not, and if small on-screen text regresses the model re-asks and wipes the 35 percent.

P5 and P1 are order-dependent. P5's anti-saving cannot fire until P1 makes the shrink gate qualify these images, so P5 is premature now.

Kills: P10 (harness-level, not a token-goat hook), P13 (already handled), P6 (platform-specific to one workflow), P11 (79 dupes against an existing dedup at 14.8 percent), P9 (unproven counterfactual).

FLIP: if instrumenting P8 costs over four hours and surfaces no bug, ship P2/P7/P12 as-is and accept the gate-decline risk.

POSITION: P3, then P8 as a diagnostic, then P4, then P2 and P12 bundled, then P7. Kill P1, P5, P6, P9, P10, P11, P13. No W2. Revisit W1 only after a third wrapper pattern appears in the wild.

### Advisor: The Architect (Claude, haiku)

Core claim: the build order should reclassify the problem. The 13 are not 13 problems, they are three. P2, P6, P7, P12 all instantiate the identical defect, a shell classifier matching on the surface string and missing wrappers, pipes and alternate paths (FACT). P8 flags a net-benefit gate silently declining one case with no fallback (FACT). P1 and P5 are coupled: P1 fires P5, and P5 anti-saves 16x by returning text where it should return an image (FACT).

Its sharpest structural observation: the project weights the indexer and worker critical path above hooks, yet four of the top-six time consumers here (P2, P4, P6, P7) are classifier patches, and the root cause may not be the classifiers at all but the currency divergence, meaning the whole list may be solving the symptom (INFERENCE).

Named the consideration cutting against deferral: P3's 108k text tokens and P2's credible 40 to 70 percent of 2.7 MB are not hypothetical, and deferring them while perfect measurement arrives is analysis paralysis.

Sequence: ship P3 immediately, alone, as table stakes with zero blast radius. Then measure the counterfactuals: does a suppressed read stay suppressed (P4, P2 and P7 all assume yes, and if the answer is no they are waste), does P9's manifest change post-compact search behaviour, does P1 save anything once P5 is fixed. Then build P2, P6, P7, P12 as a single target-extraction layer in one commit rather than five patches. Root-cause P8 as a diagnostic. Kill P13 and P11.

ASSUMPTION flagged as unverified by the advisor itself: that one target-extraction layer costs no more than four separate classifiers. Structurally sound, needs validation.

FLIP: if counterfactual measurement shows suppressed reads do not prevent re-work (the agent re-asks and pays twice), then classifiers are waste and the real return is image plus compaction only.

POSITION: closest to W2 (measure counterfactuals first, build only what is confirmed) plus a rider to ship P3 solo immediately. Then W3. Then W1 as one commit, once counterfactuals confirm re-work suppression actually works.

## Step 3: substance-convergence scan and anonymization

### Convergence (counted on substance, not on wording)

| Claim | Advisors holding it | Note |
|---|---|---|
| Kill P13 (post-compaction re-reads) | 6 of 6 | Unanimous. Already handled per project memory. |
| Diagnose P8 before building any shell classifier | 6 of 6 | The Contrarian reaches it by a different route (do not build on an unverified hypothesis) but lands in the same place. |
| Kill P11 (repeated deterministic Bash output) | 5 of 6 | Only the Outsider withholds, and only to instrument it rather than to build it. |
| Kill or defer P1 (image resize edge) | 6 of 6 | Nobody wants it now. Reasons differ: quality trade, wrong billing unit, or coupled to P5. |
| P10 is not actionable this round | 4 of 6 | **Genuine clash.** The Expansionist argues it dominates every other item and that "not implementable" is an unexamined assumption about the harness boundary, not a finding. |
| P2, P6, P7, P12 are one defect, not four | 4 of 6 | The Executor defers the unification until a third wrapper appears in the wild; the Contrarian actively opposes it as a parser surface with no base rate. |
| Ship P3 first, alone | 3 of 6 explicitly | **Genuine clash.** The First Principles Thinker classifies P3 as noise to be killed, while the Architect, Executor and Contrarian all independently name it the single safest, most unit-honest win on the list. |
| P5 cannot fire until P1 makes it fire | 2 of 6 | Only the Executor and Architect noticed the ordering dependency; neither was contradicted. |

low_diversity_flag: **not set.** Two substantive clashes (P3 and P10) with advisors on both sides, plus a real split on whether to unify the shell classifiers or patch them. The panel did not converge into one voice.

### Anonymization mapping (recorded for audit; not shown to reviewers)

```
A = The Architect
B = The Executor
C = The Contrarian (Qwen, cross-family)
D = The Expansionist
E = The First Principles Thinker
F = The Outsider
```

Randomized for this run; the mapping was fixed before any reviewer was spawned and not adjusted afterwards.

### Reviewers dispatched

- **Ranker** — Claude, haiku.
- **Blind Spot Hunter** — Claude, haiku.
- **Adversary** — routed cross-family to GLM-5.3, so the cross-family voice reaches an adversarial role rather than only an advisory one. This is what can unlock a high-confidence tag on the near-unanimous points.

## Peer reviews (step 3)

### Reviewer: The Ranker (Claude, haiku)

FINAL RANKING: B > A > D > F > C > E

CLOSE CALL flagged: B and A are near-equal. B wins on delivering what the frame asked for (a concrete ordering with named billing units and reversals); A wins on structural insight but defers critical decisions.

NOVELTY: Response D's shell-command corpus generator, inverting the discovery pipeline so future gaps are self-revealing rather than mined from transcripts after the fact.

Per-response, condensed to the load-bearing halves:
- **A** strongest for naming three structural defects and proposing a testable sequence; weakest for building its whole ordering on an assumption it itself flags as unverified, with "counterfactual measurement" left operationally undefined (no data, threshold or sample named).
- **B** strongest for anchoring P3 on the billing unit the frame says is critical; weakest for asserting P8 takes under two hours when the root cause is explicitly unknown, and for dismissing P9 as unproven when the frame notes P9 might dwarf P3, P4 and P7 combined.
- **C** strongest for the same billed-currency read on P3 and a precise pre-mortem; weakest for killing ten of thirteen and over-correcting away from W1.
- **D** strongest for the corpus-generator inversion; weakest for making P10 the only game-changing lever without giving an ordering for the case where P10 really is immovable.
- **E** strongest for reducing 13 decisions to three architectural ones; weakest for killing P3 as noise while P3's 108,111 tokens are already billed, which contradicts its own unit-honesty anchor.
- **F** strongest for identifying that four of thirteen are not orderable on the frame's own terms; weakest for punting entirely, which is honest but does not produce the ordered build list the frame asked for.

### Reviewer: The Blind Spot Hunter (Claude, haiku)

1. **Shared assumption across all six:** that the shell-command gaps (P2, P6, P7, P12) share one underlying mechanism. The frame marked this framer-inferred and explicitly challengeable, and all six accepted it without testing it. Response D builds a corpus generator to verify it but still does not challenge whether the inference is sound before committing.
2. **What none of them questioned:** whether the mining itself (69,657 calls, 190 MB, 12 sessions) is still representative and current, or how much of it is duplicate-run noise rather than real inefficiency.
3. **Unchallenged framer-inferred constraint:** the four-way categorisation of the 13, and specifically the claim that group (a) shares one mechanism. Flagged challengeable in the frame, accepted by every response.
4. **Why it matters:** if the shell gaps do not actually unify, W1 is premature architecture and serial patches are faster. If the mining is stale or captures artifacts rather than patterns, the entire priority list reverses and re-mining supersedes all six recommendations.
5. **ACH pass, non-diagnostic evidence:** "P3 is 10 lines in billed currency" is equally compatible with ship-first, defer-until-after-diagnostics, and kill-as-noise; it supports "low-risk if shipped", not "first". "P8's gate declines one case with no fallback" describes the behaviour without distinguishing a real defect from correct design or from masking of an upstream issue.

### Reviewer: The Adversary (routed cross-family to GLM-5.3)

Outcome: **(B) attacked, and it partially held.** Reported honestly as a split rather than inflated to a decline or deflated to a thin attack.

Target: **Response A**, identified as the consensus pick because it tracks the frame's gradient on every axis at once: ships the unit-honest zero-trade win first, adopts W1, honours W2's counterfactual discipline, root-causes P8, and kills only the two weak-marked items. No other response satisfies as many of the frame's stated desiderata simultaneously.

The attack: A is defeated by its own anti-paralysis paragraph. It concedes P2's and P6's savings are not hypothetical, then inserts a counterfactual measurement campaign of unstated duration between P3 and all 10-plus MB of them, in a project where implementation is strictly serial, so the measurement blocks everything behind it. Worse, that campaign flirts with undecidability: a suppressed read's counterfactual is near-unobservable outside a controlled A/B on an autonomous agent whose run-to-run variance swamps any per-classifier effect, so it can return "ambiguous" indefinitely, which is analysis paralysis with instrumentation. Second, "one commit" for the target-extraction layer violates the frame's own strictly-serial, red-test-per-change discipline, and bundles P6 (near-zero value beyond one maintainer's workflow) into permanent surface that must stay correct for every future shell shape. Third, A's FLIP presupposes "once P5 is fixed" while its build list never schedules that fix.

What held: the core of A (P3 first, then measure, then consolidate) survives the sharpest single charge, because P3 does ship now and A explicitly weighed the tradeoff. The Adversary also self-corrected mid-review, conceding that A's measurement list entails fixing P5 as a precondition, so the P5 prong is thinner than first argued. The P6-in-W1 prong and the one-commit-versus-serial-discipline prong were left unanswered by A's text.

Flip variable: the cost and decisiveness of the counterfactual instrumentation. The P9 replay methodology already exists in-house; if it extends to deny/hint counterfactuals and yields a pre-registered go/no-go quickly, A's measure-then-build order is strictly correct and the paralysis charge collapses.

TRANSFER: only in part. B escapes the paralysis prong by rejecting W2 and time-boxing P8, but the P5 prong transfers and worsens: B kills P5 outright rather than leaving its fix unscheduled, so the 16x anti-saving defect stays armed in shipped code with nobody even presupposing its fix.

## Late-breaking verified evidence (orchestrator's own diagnostic, run after the reviews)

The Blind Spot Hunter's item 1 and item 3 named the framer's "group (a) shares one mechanism" inference as accepted-but-untested by all six advisors. That inference has now been tested directly against the installed binary, and **it is wrong in a way that reverses the build list.**

Every probe below is the real `pre_tool_use` hook on the shipping binary, from `C:/Projects/token-goat`:

```
grep -n "loadConfig" src/config.ts     -> {}
grep    "loadConfig" src/config.ts     -> rewritten to `token-goat compress`
grep -n "loadConfig" README.md         -> rewritten to `token-goat compress`
grep -n "loadConfig" src/              -> rewritten to `token-goat compress`
rg   -n "loadConfig" src/config.ts     -> rewritten to `token-goat compress`
```

The discriminator is not "a single indexed source file", as the mining report hypothesised. It is the `-n` flag together with a single indexed source file, which is the exact precondition of `extractRgSymbolSearch` at `src/hooks_bash.ts:588`. That function fires correctly, and `preBashHandlerInner:2037` builds the intended hint ("Use `token-goat symbol loadConfig` to jump directly to the definition"). The hint is then discarded before it reaches the wire.

Widening the probe shows this is not specific to grep:

```
ls -la                          -> rewrite reaches the wire
cat src/config.ts               -> deny   reaches the wire
find . -name "*.ts"             -> {}
sed -n "100,200p" src/parser.ts -> {}
grep -n "loadConfig" src/config.ts -> {}
tail -50 CHANGELOG.md           -> {}
Read src/config.ts (twice)      -> {}
```

Deny survives. Rewrite survives. **Every `contextOutput` hint dies.** The cause is `applyHintTracking` in `src/hint_stats.ts`, which converts a `context` output to `passOutput()` whenever `shouldSuppress` is true, and `token-goat hint-stats` shows every category in the product is currently suppressed:

```
category              emitted  acted-on  efficacy  suppressed
bash_redirect         27       4         14.8%     yes
bash_recall           27       4         14.8%     yes
read_reread_dedup     5        0         0%        yes
read_structural_nav   7        1         14.3%     yes
edit_reread_suggest   5        0         0%        yes
```

With `hint_stats.suppress_threshold_pct = 15` and `min_sample_size = 5` (`src/config.ts:498-499`), `bash_redirect` misses the cutoff by 0.2 percentage points on a 27-emission sample, and `read_structural_nav` by 0.7 points on a 7-emission sample.

What this does to the option set:

- **P2, P7, P8 and P12 are not classifier gaps.** `sed -n` is handled at `hooks_bash.ts:1834`. `tail`/`head` are handled at 1955 and 1963. The `grep -n` symbol case is handled at 2037. All of them already fire and are already silenced. The mining report read that silence as an absent classifier.
- **The framer's group-(a) inference is half right for the wrong reason.** These four do share one mechanism, but it is the suppression ledger, not surface-string matching.
- **W1 would ship code that is suppressed on arrival.** Any new classifier emits into `bash_redirect`, the category already below threshold; a new hint cannot raise its own efficacy before the gate reads it.
- **P4 has two independent kills, not one.** The mining report blamed the `reread_deny_min_bytes` floor. `read_reread_dedup` is also suppressed at 0% on a 5-emission sample, so lowering the floor alone would still produce silence.
- **P3 is untouched by all of this,** because it is a `rewriteOutput` on a post-tool-use MCP result, not a `context` hint. The three advisors who ranked it first for being the only unit-honest, trade-free item picked the one proposal this defect cannot reach.

This does not by itself prove the suppression is a bug rather than a working backoff correctly reporting that these hints do not earn their keep. `hints.backoff_thresholds = [1, 3, 10, 30]` means suppressed categories still emit on probe occasions, so the channel is throttled rather than dead. But it does establish that the ordering question the council was asked was built on a misread of the evidence, and that the first build item is not on the list of thirteen.

## Diagnostic addendum: the suppression is a one-way ratchet, and its documented escape hatch is dead

The first pass established that every `contextOutput` hint in the product is converted to `pass` by `applyHintTracking`, and that all five hint categories are below the 15% suppression threshold. That alone could still be a backoff working as designed, because `hints.backoff_thresholds = [1, 3, 10, 30]` is supposed to let a suppressed category re-emit on probe occasions 1, 3, 10, 30 and every 30th thereafter, so it can earn its way back.

It does not work. Thirty-five consecutive identical invocations of the real `pre_tool_use` hook on the shipping binary, same command, same session:

```
grep -n "loadConfig" src/config.ts   x35
TOTAL non-empty out of 35: 0
```

Any window of 35 consecutive occasions must contain a multiple of 30, so at least one probe was due and none fired.

The mechanism, traced to source:

1. `bumpSuppressionStreak` (`src/hint_stats.ts`) writes to `hint_suppression_probes` in the global DB.
2. That table does not exist. `C:\Users\zelys\.token-goat\global.db` reports **zero tables**.
3. The `INSERT` therefore throws, and the function's own `catch` returns `0`.
4. `isProbeOccasion(0, [1, 3, 10, 30])` checks `sorted.includes(0)` (false), then `0 > 30` (false), and returns **false**.
5. Every suppressed occasion is occasion zero, which is never a probe occasion, so no hint is ever let through.

The consequence is a ratchet that only turns one way. A category that dips below `suppress_threshold_pct` is silenced; while silenced it cannot be acted on; because it is never acted on its efficacy can never rise; and the probe path that exists specifically to break that circularity returns 0 forever. `bash_redirect` crossed the line by 0.2 percentage points on a 27-emission sample and can never come back.

Two of the product's three advertised mechanisms are affected. Session-aware read hints are entirely `contextOutput`, so they are gone. Surgical-read hints from the Bash pre-hook are gone. Image shrinking and the deny/rewrite paths are unaffected, which is why the product still visibly does something.

This also explains, without appeal to any classifier gap, why the mining report saw silence on `sed -n` ranges, `tail`/`head`, `cat | head` pipelines and single-file `grep -n`: those classifiers all exist, all fire, and all emit into a channel that has been closed since the categories crossed the threshold.

## Correction to the diagnostic addendum, and to the chairman's step 1

The addendum above asserted that the `hint_suppression_probes` table was missing, that `bumpSuppressionStreak` therefore threw and returned 0, and that `isProbeOccasion(0, ...)` was consequently always false. **That mechanism is wrong.** It was inferred from a stale, empty `global.db` at `C:\Users\zelys\.token-goat\global.db`, which is not the database the product actually uses. The real one is at `C:\Users\zelys\AppData\Local\dfk-helper\token-goat\global.db`, and it is healthy: the table exists, `user_version` is 11, and the streak counters are live and correct.

Measured directly, the counter works exactly as designed:

```
--- before ---            --- after 40 hook calls ---
bash_redirect=23000       bash_redirect=23040
```

Exactly +40. So the classifier fires, the hint is built, `shouldSuppress` returns true, and `bumpSuppressionStreak` records the occasion without error, all forty times.

The real cause is in configuration, not code. The persisted config at `C:\Users\zelys\AppData\Local\dfk-helper\token-goat\config.toml` contains:

```toml
[hints]
backoff_thresholds = []
```

`isProbeOccasion` opens with `if (sorted.length === 0) return false`, so an empty list makes every occasion a non-probe. And this is not an accident or an unhandled edge: `src/config.ts:141-145` documents it as the intended meaning of that value.

> `[]` means no probes: suppression is permanent until a manual `token-goat hint-stats --reset`.

**There is therefore no code defect in the suppression path.** The channel is silent because probes are switched off, which is a supported setting behaving exactly as its own documentation describes. The chairman's step 1 (create the missing table, make `isProbeOccasion` fail open on a streak-read error) is aimed at a mechanism that does not exist, and would change documented behaviour on the basis of a misdiagnosis. It must not be implemented as written.

### What survives the correction

The load-bearing conclusion is unaffected, because it never depended on the mechanism, only on the observable:

- Every `contextOutput` hint on this machine is silenced. Confirmed by 40 consecutive live invocations returning `{}` while the suppression counter advanced 40 times.
- **P2, P7, P8 and P12 are not classifier gaps.** `sed -n` is handled at `hooks_bash.ts:1834`, `tail` at 1955, `head` at 1963, and the `grep -n` symbol case at 2037 via `extractRgSymbolSearch` at 588. Every one of them fires. The mining report read configured silence as absent code.
- **W1 is worthless as scoped.** A new classifier emits into `bash_redirect`, a category that is suppressed with probes disabled, so its output would never reach the model.
- **P4 has two independent kills.** The `reread_deny_min_bytes` floor is one; `read_reread_dedup` being suppressed at 0% with no probe path is the other.
- **P3 remains untouched**, because it is a `rewriteOutput` on a post-tool-use result rather than a `context` hint.

### The genuine, smaller finding that replaces the invented one

`token-goat hint-stats` prints an identical `suppressed: yes` whether the category can recover or provably cannot. With `backoff_thresholds` non-empty, "suppressed" means throttled and self-healing. With `[]`, it means permanently off until someone runs `hint-stats --reset`. The two states are operationally opposite and visually identical, and the column that would distinguish them is already computable from config the command has loaded.

That is an observability gap with a measurable cost: establishing which of the two states this machine was in required tracing four source files and two databases, and an earlier pass through the same evidence produced a confidently wrong mechanism precisely because the surface reported nothing. It is a real improvement and it is honest about its size. It is not a bug in the suppression logic, and it should not be described as one.
