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
 * - `update`  — replace the tool result body with `content`.
 * - `rewriteInput` — let the call proceed but replace the tool input wholesale
 *   with `updatedInput` (a `PreToolUse` rewrite). Used by the bash-compression
 *   hook to transparently wrap a command in `token-goat compress`; the object
 *   replaces the entire `tool_input`, so it must carry every original field.
 * - `pass`    — no-op; let the call proceed unchanged.
 */
export type HookOutput =
  | { readonly hookType: 'deny'; readonly message: string }
  | { readonly hookType: 'context'; readonly context: string }
  | { readonly hookType: 'update'; readonly content: string }
  | { readonly hookType: 'rewriteInput'; readonly updatedInput: Record<string, unknown> }
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
  'session_start',
  'user_prompt_submit',
  'subagent_stop',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

/**
 * Canonical tool names token-goat intercepts.
 *
 * Harness-specific aliases are normalized to these before lookup. Kept as a
 * `ReadonlySet` so membership checks are O(1) and the set cannot be mutated.
 */
export const CANONICAL_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'Agent',
])

/** Result of spawning git via `runGit`. */
export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Options accepted by `runGit`. */
export interface RunGitOptions {
  readonly cwd?: string
}
