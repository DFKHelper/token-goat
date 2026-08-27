# Loop 43 billed-unit survey (2026-08-27)

Denominator, pinned: 8,544 transcript files (2,502 main sessions, 6,042 subagent lanes),
1,512,531 lines, 4.52 GB, scanned 2026-08-27 by `token-goat session-audit` (0 unreadable).
Claude Code retention prunes this corpus continuously (11,555 -> 8,541 mid-loop-42), so any
comparison at loop 50 must restate its own denominator rather than assume this one.

Units. "Billed input-equivalents" price-weights the measured usage ledger: uncached input x 1,
cache-write x 1.25, cache-read x 0.1, output x 5. "Billed-equiv (modelled)" is session-audit's
residency model (write x 1.25, re-read x 0.1 per later call until the compact boundary on that
lane). Hand-extrapolated numbers are marked HAND and never mixed into a modelled column.

Corpus total: 7.25B billed input-equivalents (measured usage, deduplicated per API response).
Sidechain share: 4.01B (55%).

## Survey table

Ranked by billed size within addressability class.

### Harness-owned / operator-behavior

| Owning seam | Addressability | Observed defect instance | Severity (judgment) | Billed size |
|---|---|---|---|---|
| Sidechain spawn prefix (the input a subagent lane carries on its first API call: system prompt, tool + MCP manifests, inherited instruction files, task brief) | operator-behavior (typed/lean subagents) + harness-owned (manifest injection); token-goat can measure and advise, not shrink | No token-goat defect. Observed: mean prefix 90,228 tok, median 92,899, p90 131,224 over 5,993 lanes; task brief is ~1.8k tok = ~2% of it; prefix histogram is multimodal (778 lanes under 40k, 4,831 lanes at 60k+), so the lean mode exists and is ~50-70k tok cheaper per spawn | dominant: largest single block in the corpus | 2.466B billed-equiv (modelled, emitted by session-audit) = ~34% of corpus billed input-equivalents, 61% of all sidechain billed spend |
| Main-lane harness attachments (skill_listing 289.0M, task_reminder 174.2M, invoked_skills 103.3M, agent_listing_delta 92.9M, file 66.8M, rest 71.8M) | harness-owned mostly; invoked_skills partially operator (skill-compact) and writer (hooks_skill); listings shrink only by installing fewer skills/agents | No token-goat defect; sample = the full 316,206-injection census. task_reminder re-injects byte-identically 8,038 of 8,841 times: a harness inefficiency worth reporting upstream, not writer-fixable | high | 798.0M billed-equiv (modelled) |
| tool_use inputs (generated command/file content in tool calls) | operator-behavior (write-file --from, shorter commands); billed as output (x5) when generated | none found; sample = all 307,914 tool_use blocks, sized only | medium | 79.7M est tokens; HAND: ~400M billed-equiv if weighted as output + residency |

### Writer-fixable

| Owning seam | Addressability | Observed defect instance | Severity (judgment) | Billed size |
|---|---|---|---|---|
| Bash tool results (tool-filter seam, loops 33-40) | writer-fixable | none new; SC-15/SC-17 swept. The real finding is fire-rate, below | high pool, low product leverage observed | 111.3M est tokens over 220,298 calls; HAND: ~437M billed-equiv at the census's 3.93x residency multiplier |
| Read tool results (surgical-read seam) | writer-fixable (re-read divert) + operator (surgical-read adoption; hooks only installed in a few projects) | none new. Observed: interception is 3.0% (672 of 22,381 Read results are divert markers); 4,463 full serves >= 10 KiB carry 109.3 MB, and the deny path fires only on re-reads and special files, so most of that pool is first reads the product only advises on | high pool, product working as designed on the slice it claims | 55.4M est tokens; HAND: ~218M billed-equiv; addressable full-serve pool ~36.4M est (~143M billed-equiv HAND) |
| token-goat's own hook channel | writer-owned | none: token-goat PreToolUse stdout is 28.3 MB across 85,747 fires with 0 context-bytes on the hook_success channel (its denials ride the tool_result, counted under the tool) | low | ~3.9M billed-equiv (hook_success census) |

## Priority 1: sidechain economics, answered

198,191 of 300,394 API calls are sidechain; they carry 27.80B of 48.54B cache-read tokens
(~140k cache-read per call). Decomposition (now emitted by session-audit): the spawn prefix is
90,228 tok mean, of which the task brief is ~2%. Everything else is inherited environment.
Prefix carriage is 2.466B billed-equiv = 61% of all sidechain billed spend. The memory figure
of ~38,803 tok per unrestricted spawn for the MCP manifest directionally holds: the histogram
gap between the lean mode (20-40k) and the heavy mass (80-140k) is 40-100k tok, but the manifest
cannot be isolated from the rest of the prefix in the billing unit with the fields transcripts
carry, and the figure was measured in prompt tokens, which bill at 1.25x once then 0.1x per call.
Typed-vs-unrestricted split by lane needs the parent Task tool_use -> lane agentId join
(unattempted; ledger BE-07). Parent-side spawn types, hand-counted: general-purpose 1,586,
unspecified 1,236, typed the rest, so roughly half of spawns are unrestricted-ish.

Operator recommendation, concrete: a heavy spawn costs ~90k x (1.25 + 0.1 x 32) = ~400k
billed-equiv in prefix alone at the mean 33 calls/lane; a lean typed spawn saves 50-70k of that
prefix on every one of those calls.

## Priority 2: the tool-result pool re-ranked, answered

Bash 333.3 MB / 220,298 calls and Read 166.2 MB / 22,357 calls remain 92% of the pool, and in
billed equivalents (HAND, 3.93x) Bash (~437M) still outranks Read (~218M), so the eight
tool-filter loops were aimed at the largest writer-fixable pool. But the machine's own savings
ledger says the seam barely fires: all bash_compress kinds together claim ~6.3M tokens saved in
30 days (293 generic + ~580 tool-specific events), 0.7% of the ledger's 951.4M total claim,
while the indexer-backed surgical-read family (symbol/section/outline/map/read_replacement)
claims ~270M. The binding constraint on the Bash pool is fire-rate (installation, gating,
tool coverage in real sessions), not filter quality. Filter polish past loop 40 was optimizing
a branch that rarely blocks the cost.

Read interception misses, classified as far as the corpus allows without content reads: (1) the
deny path only covers re-reads and special files by design, and most full serves are first
reads; (2) hooks are installed in a minority of projects (127 of 2,502 main sessions show a
token-goat hook marker; weak proxy, direction certain); (3) inside the token-goat project
itself the divert rate is 1.6% vs 3.4% elsewhere. First-read vs re-read split of the 4,463
full serves is the missing field (proposed loop 45).

## Program self-attribution

The token-goat project's own transcripts account for 1.41B of the corpus's 7.25B billed
input-equivalents (19%): 63,412 API calls, 10.84B cache-read, 586 subagent lanes (HAND,
per-project usage sum). The improvement program's share of that cannot be split from ordinary
development without reading transcript content, which the privacy invariant forbids. Against
it, the product's ledger claims 951.4M tokens saved in the last 30 days; different unit,
different period, and the ledger's counterfactuals have historically over-credited (session_hint
alone claims 150.8M and is advisory). The honest statement: the program's own project is the
second-largest spender in the corpus it measures, and its transcripts inflate exactly the
surfaces it worked (Bash-heavy test loops), so every Bash-pool number above carries an upward
endogeneity bias for this project's share.

## Verdict on the aim

Byte share and billed share agree on one thing: the largest writer-fixable pool (Bash) is where
the program worked, so the seeded walk was not wrong by region. It was wrong by branch: the
seam's savings land only when a filter fires, and fire-rate, not filter correctness, is the
binding constraint. The largest block overall (spawn prefix) is operator-behavior, where
token-goat's leverage is measurement and advisories, both of which now exist.
