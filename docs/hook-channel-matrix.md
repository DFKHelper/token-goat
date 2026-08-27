# Hook output channel matrix

Loop 51. Which of token-goat's emitted hook output shapes actually reach the model, on each
supported harness. Four separate mechanisms have shipped silently dead on the Copilot bridge,
each found long after release; this table is the partition that stops a fifth. It enumerates the
shapes the PRODUCERS create (every handler that returns a non-pass `HookOutput`, via
`serializeOutput` in `src/hook_registry.ts`), not the type union, and states what each harness
does with each shape.

`BRIDGE_CAPABILITY_MATRIX` in `src/bridges_status.ts` records event-level wiring per harness.
This document is finer-grained: an event being wired says nothing about which of its RESPONSE
shapes the harness honors, and for several harnesses the difference is the whole story.

## Producer channels

From `serializeOutput` plus a full producer enumeration (`rg "contextOutput\(|denyOutput\(|emitRewrite\(|hookType: 'rewrite"` over `src/`), the shapes and the events that produce them:

| channel | wire shape | producing events (handlers) |
|---|---|---|
| deny | `{"decision":"block","reason"}` | pre_tool_use only (hooks_read, hooks_bash, hooks_fetch url policy, hooks_mcp dedup, hooks_screenshot, hooks_skill, hooks_websearch, hooks_glob/grep dedup) |
| context, raw stdout | bare text on stdout | pre_compact on claudecode only (`EVENTS_WITH_RAW_STDOUT_CONTEXT`) — the manifest becomes summarizer input |
| context, systemMessage | `{"systemMessage"}` | pre_compact on every other harness (`EVENTS_WITHOUT_ADDITIONAL_CONTEXT`; `notification` is in the set but has zero producers) |
| context, additionalContext | `{"hookSpecificOutput":{"hookEventName","additionalContext"}}` | pre_tool_use (bash advisory hints, image-shrink payload, hooks_write); post_tool_use (agent report notice, bash recall/gh/test-failure hints, hooks_edit, pendingContext drain); post_tool_use_failure (repeat-failure brake); session_start (routing reminder); user_prompt_submit (session hints) |
| rewriteInput | `{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput"}}` | pre_tool_use only (agent-spawn briefing, bash command wrap) |
| rewriteOutput | `{"hookSpecificOutput":{"updatedToolOutput"}}` | post_tool_use only (WebFetch fencing/redaction/compression, websearch, bash/bashoutput/taskoutput/grep compression, mcp compression, browser-image dedup, agent-report compaction, exitplanmode) |

`subagent_stop` and `post_compact` handlers only ever return pass (side effects only). `notification`
and `stop` have zero registered handlers. `hermes` has no bridge row in `BRIDGE_CAPABILITY_MATRIX`
and is out of scope here.

## Verdicts per harness

Codes: **M** reaches the model; **D** dropped (by the harness or by the bridge, with the drop
recorded); **X** event not wired on that harness; **?** unverified. Evidence classes:
**(d)** dogfooded/observed live, **(c)** corpus or one-off live capture, **(w)** the harness's own
bundle/source/schema read directly, **(doc)** the harness's published docs only, **(b)** this
repo's bridge code (which itself cites its sources), **(u)** unverified — a finding, not a gap to
paper over.

| event / channel | claudecode | copilot_cli | codex | grok | gemini | qwen | kimi | opencode | openclaw | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| pre deny | M (d) | M (w)¹ | ? (doc, BE-06) | M (doc)² | ? (doc)³ | ? (doc)⁴ | M (w)⁵ | M (w)⁶ | M (doc) | M (w) |
| pre context (hints) | M (c) | D (w)⁷ | ? (u, BE-06) | D (b)⁸ | ? (u) | ? (doc) | ? (u)⁹ | D (b)¹⁰ | D (b)¹⁰ | D (b)¹⁰ |
| pre context (image shrink) | M (c) | **D (w)¹¹** | ? (u) | D (b) | ? (u) | ? (doc) | D (w) | M (b)¹² | D (b)¹¹ | M (b)¹² |
| pre rewriteInput | M (d) | M (doc)¹³ | ? (doc, BE-06) | D (b)⁸ | ? (u) | ? (doc) | D (w)⁵ | M (w) | M (doc) | M (w) |
| post rewriteOutput | M (d) | M (w)¹⁴ | ? (doc, BE-06) | D (doc)² | ? (u) | ? (doc) | D (w)⁵ | M (b)¹⁵ | D (b, u)¹⁶ | D (b, u)¹⁶ |
| post context | M (d) | D (w)¹⁷ | ? (u, BE-06) | D (doc)² | ? (u) | ? (doc) | D (w)⁵ | M (b)¹⁸ | D (b, u)¹⁶ | D (b, u)¹⁶ |
| failure context | X | M (w)¹⁹ | X | X | X | X | X | X | X | X |
| pre_compact context (manifest) | M (c)²⁰ | D (w)²¹ | ? (u, BE-06) | D (doc)² | ? (u) | ? (doc) | ? (u) | M (w)²² | D (b)²³ | M (w)²⁴ |
| session_start context | M (d) | M (c)²⁵ | X | X | X | X | ? (u) | X | X | X |
| user_prompt_submit context | M (d) | M (c)²⁶ | ? (u, BE-06) | D (doc)² | X | ? (doc) | M (w)²⁷ | X | X | X |

1. Bundle-verified 1.0.80: native string table carries `permissionDecision`/`permissionDecisionReason`; app.js sets `{textResultForLlm: reason, resultType: "denied"}` per denial (`src/bridges_status.ts` copilot docblock).
2. Grok's hooks doc: only `pre_tool_use` is blocking; every other event's stdout is ignored. The shim forwards passive-event responses verbatim anyway, which is harmless. Wiring (hooks fire, env set) was observed live on grok 0.2.93; the deny path itself is doc-based.
3. Gemini docs confirm `block` as a deny alias; no live run recorded.
4. Qwen wires `token-goat hook` responses verbatim per QwenLM/qwen-code hooks.md; never live-tested.
5. Read from MoonshotAI/kimi-code source: `HookJsonOutputSchema` reads only `message` and `permissionDecision(-Reason)`; `runPreToolUse` returns only a block reason and `notifyPostToolUse` is fire-and-forget, so rewriteInput/rewriteOutput and every post_tool_use response have no channel at all on Kimi.
6. `tool.execute.before` throws to abort; opencode's own docs demonstrate the pattern.
7. `translate()` in `src/bridges/copilot_cli.ts` returns `{}` for a preToolUse context response, because Copilot's preToolUse output schema has no `additionalContext` field. Honest drop: the harness has no channel.
8. Dropped by the shim itself: `GROK_HOOK_SCRIPT` translates only the deny shape on pre_tool_use and answers `{"decision":"allow"}` for everything else, per Grok's documented response schema (`decision`/`reason` only).
9. The Kimi shim folds hints into the top-level `message` field Kimi's schema reads, but WHERE `message` lands per event (model context vs UI) is only pinned for user_prompt_submit; see BE-11 in `docs/loop-ledger.md`.
10. No pre-tool context-injection channel exists in the plugin API.
11. **Image shrinking is dead on Copilot CLI and OpenClaw.** The shrink payload rides pre_tool_use additionalContext, which their pre-tool responses cannot carry. opencode and pi prove the reroute (footnote 12): materialize the shrunk copy to a temp file and rewrite the path argument — Copilot honors `modifiedArgs` and OpenClaw honors `params`, so the same reroute is buildable on both. Recorded as the top candidate for a next loop, not silently.
12. `materializeShrunkImage` in the opencode/pi bridges decodes the data-URL payload to a temp file and rewrites the path arg, so the model reads the shrunk copy.
13. `modifiedArgs` is documented on Copilot's preToolUse and forwarded verbatim by the shim. Caveat: the agent-briefing rewrite keys on a `prompt` arg; Copilot's `task` toolArgs shape is unverified, and if the key differs the handler no-ops (safe).
14. Bundle-verified 1.0.80: `postToolExecution` assigns the returned `toolResultJson` in place (offsets 2043150/2032350/1793926).
15. Fixed this loop: the plugin's `tool.execute.after` used to apply only the context append and silently dropped `updatedToolOutput` — the whitelist shape (`project_copilot_shim_canonical_builder_is_a_whitelist`) on the receive side. WebFetch injection fencing, secret redaction and output compression never reached an opencode session. The fix mutates `output.output`, the same mechanism the append already relied on; not yet run against a live opencode instance.
16. The bridge fires post_tool_use for token-goat's side effects and ignores the response. Whether OpenClaw's `after_tool_call` / pi's `tool_result` could mutate the result at all is unverified (BE-12); until then the drop is the honest state, not a gap to code around.
17. Dropped on the JS path in the 1.0.80 bundle: no `onAdditionalContext` supplier, no `additional_contexts` key in the event's native return payload. Native residual unverified (BE-10). The shim's `out.additionalContext` stays as cheap best-effort; nothing may depend on it. Loop 49's unrestricted-spawn advisory did — fixed this loop by gating it off on copilot_cli (`buildUnrestrictedSpawnAdvisory`), for the channel reason and because its `subagent_type`/`~/.claude/agents` semantics are Claude Code's Task schema, wrong for Copilot's `task` regardless of delivery. The agent-report recall-pointer notice on the annotate-only branch is likewise dropped there; the compaction branch survives via modifiedResult. Left recorded: rerouting the notice into modifiedResult would put a rewrite in front of task's unverified result shape, which the bridge's own comments rule out.
18. Appended to `output.output` as `[token-goat] <context>`.
19. Bundle-verified: app.js 2043380 folds additionalContext into `textResultForLlm` or pushes `{content, source: "system"}` onto `toolResult.newMessages`. The opposite of its success sibling; neither generalizes to the other.
20. Claude Code PreCompact stdout is summarizer instructions (`project_precompact_stdout_is_summarizer_instructions`): the manifest reaches the compaction prompt, which is its design target.
21. Notification-only by construction: both dispatch sites call the hook in statement position and drop the result (app.js 2467452, 2571216). A future manifest injection here would silently do nothing; the buildable path is prompt-submit drainage, deferred (compaction frequency measured zero).
22. `experimental.session.compacting` pushes the manifest onto `output.context`.
23. Observe-only: OpenClaw's `before_compaction` has no reinjection channel.
24. pi's replace-only compaction: the bridge captures the manifest at `session_before_compact` and re-injects it via `pi.sendMessage(..., {deliverAs: "nextTurn"})` after `session_compact`.
25. Verified live on Copilot 1.0.77; caveat: sessionStart completes after the first `user.message` in one-shot `-p` mode.
26. Demonstrated once on 1.0.80 (marker in `transformedContent` plus the billing delta); one of two turns delivered and the rate is unknown. Copilot's own docs say the output is dropped — the docs are wrong for additionalContext.
27. Kimi's `userPromptHookMessage` fallback reads it, per kimi-code source.

## What this table exposed, and what was done

- **Loop 49's unrestricted-spawn advisory** rode post_tool_use additionalContext, dropped on
  Copilot (footnote 17), while burning the once-per-session hint budget and recording a
  `session_hint` stat for text nobody received — and its content was wrong for Copilot's `task`
  schema even if delivered. Gated off on copilot_cli this loop; every other harness is left
  ungated because suppressing them would rest on inference (their task-tool wire shapes are
  BE-06).
- **opencode dropped every post_tool_use rewriteOutput** (footnote 15). Fixed this loop.
- **Image shrinking is dead on Copilot CLI and OpenClaw** (footnote 11). Recorded; the
  materialize-to-temp-file reroute both opencode and pi already use is the identified fix for a
  future loop.
- Grok (deny-only), Kimi (no rewrite channels, post fire-and-forget), OpenClaw/pi post-response
  drops: harness-design limitations, recorded here and in the bridges' own comments, deliberately
  not coded around.
- Every `?` cell is an unverified finding: Codex/Gemini/Grok/Kimi wire maps are BE-06; Qwen
  response honoring is BE-13; the specific residuals are BE-10/BE-11/BE-12.
