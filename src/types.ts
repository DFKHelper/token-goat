/**
 * Wire shapes and discriminated unions shared across token-goat modules.
 *
 * This file is a pure type/constant leaf: it must not import from any other
 * local module so every layer above can depend on it without cycles.
 */

/**
 * Result of a hook handler.
 *
 * A discriminated union on `hookType` so every switch site is exhaustively
 * checked by the compiler. Adding a new variant forces every consumer to
 * handle it (or fail to compile).
 *
 * - `deny`    — block the tool call and surface `message` to the agent.
 * - `context` — let the call proceed but inject `context` as extra context.
 * - `rewriteInput` — let the call proceed but replace the tool input wholesale
 *   with `updatedInput` (a `PreToolUse` rewrite). Used by the bash-compression
 *   hook to transparently wrap a command in `token-goat compress`; the object
 *   replaces the entire `tool_input`, so it must carry every original field.
 * - `rewriteOutput` — the tool already ran; replace the result text the model
 *   sees with `updatedOutput` (a `PostToolUse` rewrite, wire field
 *   `updatedToolOutput`). Confirmed against https://code.claude.com/docs/en/hooks
 *   (verified 2026-07-12): MCP-tool support has existed since before v2.1.121;
 *   support for built-in tools (Bash, Read, Edit, ...) was added in v2.1.121.
 *   token-goat emits this for MCP tools (`hooks_mcp.ts`'s `postMcpHandler`,
 *   unconditional aside from the `TOKEN_GOAT_MCP_COMPRESS=0` opt-out) and for
 *   WebFetch (`hooks_fetch.ts`'s `postFetchHandler`, the injection-scan fence).
 * - `pass`    — no-op; let the call proceed unchanged.
 */
export type HookOutput =
  | { readonly hookType: 'deny'; readonly message: string }
  | { readonly hookType: 'context'; readonly context: string }
  | { readonly hookType: 'rewriteInput'; readonly updatedInput: Record<string, unknown> }
  | { readonly hookType: 'rewriteOutput'; readonly updatedOutput: string }
  | { readonly hookType: 'pass' }

/**
 * Hook event names token-goat reacts to.
 *
 * This is a subset of the full Claude Code / Codex hook surface; expand as
 * later layers add handlers. Declared `as const` so `HookEventName` is the
 * exact literal union rather than `string`.
 */
export const HOOK_EVENTS = [
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'user_prompt_submit',
  'subagent_stop',
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
  /** Kill the git process if it runs longer than this (ms). Used by opportunistic,
   *  advisory-only callers (e.g. hooks_session.ts's hint-computation git calls) that must
   *  never stall a hook; omit for functional git calls that need to complete regardless
   *  of duration. */
  readonly timeoutMs?: number
}
