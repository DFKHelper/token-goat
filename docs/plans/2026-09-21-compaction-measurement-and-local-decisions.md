# Compaction, measurement, and local decisions

Status: A1-A6, B1-B4 implemented 2026-09-22. B5 is decided in
`2026-09-22-function-hook-surface-decision.md` (do not adopt, with reopening triggers).
C stays a design note: `2026-09-21-local-decision-model.md`, whose ordering section now
records what B3's calibration does and does not settle.

Every item below is justified by evidence from this repository, its ledger, or the
shipping Claude Code binary on the development machine. Line numbers are as of
commit `71c7a659`.

## A. Defects, ready to implement

### A1. Copilot drops every hint that rides along with a compressed output

`src/bridges/copilot_cli.ts:584` branches `else if`. When a tool result carries both a
rewritten body and a context hint, the context fold is skipped, and the
`additionalContext` fallback assigned four lines later is dropped on Copilot's JS path,
which the same file's comment at line 579 already states.

The test at `tests/install_copilot_cli.test.ts:890` asserts the hint arrives through
`additionalContext`. That is the field documented as dropped, so the test proves our shim
emits it and proves nothing about Copilot reading it. It is green while the hint is lost.

Fix: append the context to the rewritten body, so a rewrite and a hint can both survive.
Re-point the test at `modifiedResult.textResultForLlm`, which is the honored channel.

### A2. `pending_context` warns about a channel that has since been routed around

`src/pending_context.ts:16-33` tells the reader the delivery channel is not confirmed on
Copilot and closes with "the hints are known to arrive on Copilot today. They are not."
The `postToolUse` branch now folds context into `modifiedResult.textResultForLlm`, which
is honored. The warning is stale and discourages the work in B1.

Fix: rewrite the caveat to describe the fold, and keep the parts that are still true.

### A3. Two manifest builders, and the richer one never reaches compaction

`src/compact.ts::_buildManifestText` does goal inference, noise-path filtering and
per-directory grouping. `src/hooks_compact.ts::buildManifest` does none of those and is
the one the `pre_compact` hook uses. The richer text is reachable only from
`token-goat compact-hint`, so a user can preview a manifest the summarizer never sees.

Fix: pick one builder. Decide deliberately whether goal inference belongs in the injected
text, and record the reason either way.

### A4. Most `compact_assist` keys are dead on the hook path

`src/hooks_compact.ts` reads only `max_manifest_chars` and `summary_budget_chars`. The
other keys (`min_events`, `max_manifest_tokens`, `noise_floor_tokens`,
`edited_dir_group_threshold`, `max_section_lines`, `wide_session_threshold`,
`orchestrator_commit_threshold`, `compact_skip_ttl_secs`, `auto_trigger_multiplier`,
`harness`) are consumed only by the CLI-only path in A3. A user setting
`max_manifest_tokens` is configuring the preview, not compaction.

Fix: after A3, either wire them or remove them. A key that configures nothing is worse
than a missing key, because it reads as a decision.

### A5. `docs/architecture.md` describes a compaction subsystem we do not have

Verified against the code, the following claims in that file are wrong:

- The manifest carries test outcomes and git diffs. It carries neither. Git state only
  sizes the budget, through `adaptiveCharBonus`.
- There is a `### MUST_PRESERVE` sealed block. There is no such block.
- The manifest is injected as `systemMessage`. That form was the broken one: it shipped
  the serialized object. The live path prints raw stdout, which Claude Code joins into
  `newCustomInstructions`.
- The budget is 400 tokens. That key is dead on this path. The live cap is
  `max_manifest_chars`, default 1600.
- SessionStart emits a post-compaction recovery hint listing cached Bash and Web entries.
  No such hint exists.
- Line 116 refers to `compact.build_manifest()` and `skill_cache.py`, which are Python
  names in a TypeScript repository.

Fix: rewrite the section against the code. Treat the whole file as suspect until audited.

### A6. There is no post-compaction recovery, and `resume` omits WebFetch

Recovery is `token-goat resume`, which is CLI-only and never invoked by a hook. Its
packet is built in `src/resume.ts:66-135` and never reads the `webFetches` field of the
same session blob, so fetched pages are unrecoverable through it. It also includes only
the last two bash outputs.

Fix: decide whether recovery should be automatic after a compaction, and add WebFetch to
the packet either way.

## B. Capability work

### B1. Deliver the manifest on harnesses whose `pre_compact` return is discarded

On Copilot, both `preCompact` call sites in the shipping bundle await the hook and never
assign its result, so the manifest is built and thrown away. The event still fires, so it
is still usable as a trigger.

`src/pending_context.ts` already exists for harnesses that discard a hook response, and
is currently called from `userPromptSubmitHandler` only.

Fix: queue the manifest at `pre_compact` where the return is known dead, and let the
existing next-tool-call delivery carry it. Depends on A1.

### B2. Content-class-aware token estimation

`src/content_store.ts:43` records a real tiktoken measurement over 120 repository files:
natural source text runs 4.0 bytes per token, base64url runs 1.45. That is a 2.8x spread
by content class, measured in this repository, and it is used in exactly one place.

Everywhere else prices bytes flat: `savedTokensFromBytes` divides by 4 and
`estimateTokensFromLength` divides by 3. So savings credited on dense output such as
JSON, hex dumps, minified payloads and base64 are under-credited by up to 2.8x, and
budget guards on the same content under-estimate its cost by the same factor.

Fix: estimate per content class rather than per byte. Keep the conservative direction
that `src/overflow_guard.ts:18` requires for guards, and the separate credit divisor that
`tests/saved_tokens_use_one_divisor.test.ts` enforces. Do not merge the two estimators.

### B3. Calibrate the estimators against billing data already parsed

`src/session_audit.ts` prints measured billed tokens from `message.usage` in one section
and the chars/3 estimate in the next, and never computes the error between them. The
oracle is already on screen next to the estimate.

Fix: compute and report the measured error. Until that number exists, no claim about
estimator accuracy in this repository is evidence-backed. This is a prerequisite for C.

### B4. Print the unit on `spent=`

`token-goat hint-stats` prints `spent=5490` with no unit. The value is a character count,
correct and correctly named in the schema and the docs, but the CLI line carries no unit
word. `docs/cli.md:323` also shows a `net=` field that `printTotals` no longer emits.

Fix: print the unit, and correct the stale example.

### B5. Evaluate the function-hook surface

Not a citation. Grepped from the locally installed Claude Code 2.1.276:
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` appears 5 times, `functionHooks` 141, and the
middleware point names include `session.compact`, `tool.call`, `session.measure`,
`session.usage`, `session.messages` and `agent.spawn`.

That surface would permit removing content from the transcript rather than advising a
summarizer, intercepting tool calls in process rather than through a shell hook, and
reading real token counts instead of estimating them.

It is undocumented, gated behind a flag, and explicitly unstable. Treat as a spike with a
written decision, not as a migration. The shell-hook path must keep working unchanged.

## C. Local decision-making

See the separate design note. The ordering constraint is that C depends on B3: a model
trained on a mismeasured label is worse than the hand-tuned rule it replaces, because it
hides the mismeasurement in weights nobody can read.

## Constraints that bind all of the above

- `dependencies` contains one package, `jsonc-parser`. `onnxruntime-node` is a
  development dependency, loaded lazily, with a message telling the user to install it
  themselves. SECURITY.md publishes package counts and a guard test measures the resolved
  tree against them. Nothing here may add a required dependency.
- `src/language_specs.ts`, `src/embed_model.ts` and the other fingerprint sources bill
  every user a full re-embed when edited. Batch any change that touches them.
- Pre-tool hooks block the tool call. Anything on that path is latency-critical.
