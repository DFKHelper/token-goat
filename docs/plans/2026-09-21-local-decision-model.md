# A local decision-maker for keep/drop judgments

Status: design note. Nothing here is implemented, and the recommendation is deliberately
narrower than the question that prompted it.

## The question

Can token-goat run a small model locally to decide what is worth keeping, instead of
deciding with hand-written rules?

## What the project's own constraints allow

Three facts settle most of the design space before any model is chosen.

**Runtime weight is a product constraint, not a preference.** `dependencies` contains one
package, `jsonc-parser`. Everything else is optional or development-only. Even the
embedding runtime is opt-in: `onnxruntime-node` is a development dependency, resolved
lazily through `createRequire`, and when it is absent `src/embed_model.ts:620` tells the
user to install it themselves. The project already paid to get here, migrating off
`@xenova/transformers` because it installed 80 packages against onnxruntime's 17.
SECURITY.md publishes the resulting package count and a guard test measures the resolved
dependency tree against it.

**Pre-tool hooks block the tool call.** Anything that runs before a tool runs is on the
user's critical path. Tens of milliseconds per decision, multiplied across the candidates
present at a compaction, is seconds of visible stall.

**The worker is already asynchronous.** It drains a queue every two seconds and already
performs embedding work off the critical path. Expensive judgments have a home, provided
they can be precomputed between turns rather than demanded during one.

## Options considered

**A small generative model, 0.5B class.** Rejected. Hundreds of milliseconds to seconds
per call on CPU, gigabytes of resident memory, and it would run precisely when the user is
already waiting for a compaction. It fails all three constraints at once.

**A small ONNX classifier.** Real judgment, a few megabytes of weights, single-digit to
tens of milliseconds per item. Viable only inside the worker, never on the hook path, and
only for users who opted into the optional runtime. Keep as a later tier.

**Reuse the embedding model already shipped.** Zero new dependency, already loaded in the
worker. But cosine similarity to an inferred session goal measures topical relatedness,
and the actual question is whether a thing will be needed again. Those are different
questions, and the mismatch would be invisible because the scores would still look
plausible. Weak fit for keep/drop; a reasonable fit for ranking within an
already-selected set.

**Learned weights over features already recorded, evaluated in plain TypeScript.**
Logistic regression, or a small gradient-boosted tree, exported as a coefficient table
compiled into the bundle. No new dependency, no install-size change, sub-microsecond
evaluation, safe on the blocking path, deterministic given the weights, and explainable:
the contribution of each feature can be printed next to the verdict.

## Recommendation

Take the last option first, and treat the ONNX tier as a later, optional escalation for
judgments that genuinely need semantics.

This is a real model in the honest sense. It learns from outcomes, it produces a
probability, and it is applied against a threshold, which is the same shape as any
learned keep/drop policy. What it does not do is cost the user a dependency, a download,
or a millisecond.

### Where it would decide

1. **Hint suppression.** The strongest candidate, because the policy it would replace is
   already an adaptive controller: `hint_suppression_probes` plus a backoff-threshold
   schedule, tuned by hand. The ledger already records what a learned policy needs.
2. **Ranking the discardable set in the compaction manifest**, which is currently
   presented in ledger order rather than by confidence.
3. **Choosing which lines survive a long-output truncation.** `truncateMiddleSmart`
   currently anchors on a regular expression for error signals. That heuristic was
   written from a real 2.4MB run and is good, but it is a fixed pattern list.
4. **Marginal rewrites near the 100-byte net-benefit floor**, where the current rule is a
   constant.

### The training data already exists

`hint_emissions` (`src/db.ts:192`) carries per-emission `category`, `harness`,
`correlator`, `bytes_emitted`, `calls_remaining`, `observable` and `displayed`, with
`acted_on` as the outcome and `resolved` saying whether the outcome is known. Retention is
180 days. `hint_manual_marks` holds human verdicts and is deliberately kept separate from
the automatic signal so the two are never blended.

## The riskiest bet, and why the ordering matters

The labels are inferred, not observed. This repository has already recorded that hint
efficacy figures are misread as printed: a correlator scraped from prose zeroed one
category at 61.4%, and emitted counts and detected counts differ by two orders of
magnitude.

Training on a corrupted label is worse than keeping the hand-tuned rule, because the rule
is legible and wrong in a way someone can see, while the weights are illegible and wrong
in a way nobody can. So measurement comes first: the estimator calibration in the
checklist's B3 is a prerequisite, not a parallel track.

That prerequisite is now met, partly. As of 2026-09-22, `token-goat session-audit` prints
an `Estimator calibration` section: model-visible bytes, the chars/3 estimate over them,
the billed `input_tokens + cache_creation_input_tokens` beside it, the signed error
between the two, and the bytes-per-token the corpus implies. `computeCalibration` in
`src/session_audit.ts` is where that arithmetic lives.

What it does not give is a clean number. Two effects inflate the billed side and neither
is separable from the transcript: a prefix whose cache entry expires is written again and
billed twice while the estimate counts it once, and the system prompt and tool schemas are
sent on every call but appear in the transcript only in part. The section says so in its
own output. So the error it prints is a bound on the estimator, not a correction factor,
and the honest reading is: an estimate below the billed figure is expected, and only the
magnitude carries information.

That is enough to disqualify a wildly wrong estimator and not enough to calibrate one. The
gate for training therefore tightens rather than lifts: before any labels are trusted,
run the calibration on a corpus large enough that the two inflating effects are a small
share of it, and record the number in the notes database with its corpus size and window.
A label set built against an estimator whose error was never printed is the failure this
ordering exists to prevent; a label set built against one whose error was printed and
ignored is the same failure with a receipt.

## Privacy

Training locally on the user's own ledger is fine and stays on their machine. Shipping
weights trained on a maintainer's ledger to every user exports that maintainer's usage
patterns into the artifact. If default weights ship at all, they must come from synthetic
or aggregated data, and the per-user path must be local training on local data.

## What would make this fail

- Any version that requires a dependency. The install contract forbids it.
- Any version that runs on the blocking path at millisecond cost.
- Any version that cannot explain a verdict, because a silent wrong drop is the one
  failure this tool must not have.
- Any version trained before the labels are trustworthy.
