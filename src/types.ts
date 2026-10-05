/** Wire shapes and discriminated unions shared across token-goat modules. This file is a pure type/constant leaf: it must not import from any other local module so every layer above can depend on it without cycles. */

/** Result of a hook handler. A discriminated union on `hookType` so every switch site is exhaustively checked by the compiler. Adding a new variant forces every consumer to handle it (or fail to compile). - `deny`    — block the tool call and surface `message` to the agent. - `context` — let the call proceed but inject `context` as extra context. - `rewriteInput` — let the call proceed but replace the tool input wholesale with `updatedInput` (a `PreToolUse` rewrite). Used by the bash-compression hook to transparently wrap a command in `token-goat compress`; the object replaces the entire `tool_input`, so it must carry every original field. - `rewriteOutput` — the tool already ran; replace the result text the model sees with `updatedOutput` (a `PostToolUse` rewrite, wire field `updatedToolOutput`). Per https://code.claude.com/docs/en/hooks: MCP-tool support has existed since before v2.1.121; support for built-in tools (Bash, Read, Edit, ...) was added in v2.1.121. What the docs do not say, and what made this field silently dead for built-in tools, is that the VALUE must match the tool's own output schema: `updatedOutput` is a string, but only a tool whose result is itself a string (MCP) accepts one. For an object-shaped result the harness rejects the rewrite outright and keeps the original. Measured on the recorded session corpus: 412 of 412 built-in-tool emissions rejected, 0 accepted, on every version present; 13 MCP rewrites accepted. `serializeOutput` (hook_registry.ts) therefore clones the original `tool_response` and replaces only its text-bearing field. A string is not the only accepted MCP shape, though, and reading the above as if it were is what kept image and audio blocks getting dropped: an ARRAY of MCP content blocks is accepted verbatim for an MCP tool (see `tests/fixtures/mcp_bare_array_payloads.ts`, where `updatedToolOutput: [{type:'text',...}]` reached the model unchanged). `updatedBlocks` carries that shape: when set, it is emitted in place of the string for Claude Code, so a rewrite of a mixed text+image result can put the rewritten words in a text block and still hand back the picture. Other harnesses read `updatedOutput` into a text block themselves and never see it. Only `postMcpHandler` sets it -- a blanket rebuild in `serializeOutput` would restore the original image blocks behind `postBrowserImageHandler`, whose whole job is to replace them with shrunk ones. token-goat emits this for MCP tools (`hooks_mcp.ts`'s `postMcpHandler`, unconditional aside from the `TOKEN_GOAT_MCP_COMPRESS=0` opt-out) and for WebFetch (`hooks_fetch.ts`'s `postFetchHandler`, the injection-scan fence). - `pass`    — no-op; let the call proceed unchanged. */
export type HookOutput =
  | { readonly hookType: 'deny'; readonly message: string }
  | {
      readonly hookType: 'context'
      readonly context: string
      /** The file path(s) this hint points at, supplied by the builder rather than regex-scraped back out of `context` by hint_stats.ts's extractPathCorrelator -- see that function's doc comment for the failure mode this field exists to end. Measurement only: relay.ts rebuilds the context output without it before anything reaches a harness, so it can never reach the model. Empty/absent means "this builder has no path to give", which is not the same as "no path could be found" and is treated as unobservable rather than as a failed hint (see logHintEmission). */
      readonly correlators?: readonly string[]
      /** Words for the user, never the model: Claude Code's top-level `systemMessage`. claude.exe 2.1.284's hook runner turns it into a `hook_system_message` attachment, shown as "<hook> says: ..." and skipped when the conversation is sent to the API, so it costs no tokens. Other harnesses have no such channel and drop it. */
      readonly notice?: string
    }
  | {
      readonly hookType: 'rewriteInput'
      readonly updatedInput: Record<string, unknown>
      /** Whether Claude Code may be told `permissionDecision: "allow"`: true only when rewrite_permission.ts proved the ORIGINAL call would run without a prompt anyway. Claude Code checks its rules against `updatedInput`, so an unconditional allow skipped the user's prompt for any rewritten call; false leaves the rewritten call to the normal permission flow. */
      readonly approve: boolean
    }
  | {
      readonly hookType: 'rewriteOutput'
      readonly updatedOutput: string
      readonly updatedBlocks?: readonly Record<string, unknown>[]
      /** Words of token-goat's own to deliver beside the rewritten result rather than inside it: PostToolUse `additionalContext`, which Claude Code shows as its own message next to the result: claude.exe 2.1.281's PostToolUse runner yields `updatedToolOutput` and then, independently, a `hook_additional_context` message from the same hook result, so the two travel together. For a rewrite whose body cannot carry them, because the harness numbers that body by position and every line of ours in it would push the file's lines down a number (see `harnessNumbersReadContent`). Other harnesses read only `updatedOutput`, which is why the one producer sets this only on the Claude Code Read envelope. */
      readonly context?: string
    }
  | { readonly hookType: 'pass'; readonly notice?: string }

/** Hook event names token-goat reacts to. This is a subset of the full Claude Code / Codex hook surface; expand as later layers add handlers. Declared `as const` so `HookEventName` is the exact literal union rather than `string`. */
export const HOOK_EVENTS = [
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'post_compact',
  'user_prompt_submit',
  'subagent_stop',
  'subagent_start',
  'session_start',
  'post_tool_use_failure',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

/** Result of spawning git via `runGit`. */
export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Options accepted by `runGit`. */
export interface RunGitOptions {
  readonly cwd?: string
  /** Kill the git process if it runs longer than this (ms). Used by opportunistic, advisory-only callers (e.g. hooks_session.ts's hint-computation git calls) that must never stall a hook; omit for functional git calls that need to complete regardless of duration. */
  readonly timeoutMs?: number
}
