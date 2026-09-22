/**
 * The one fold applied to a tool name before it is compared to another tool name.
 *
 * A bridge that fails to rename an inbound tool passes the harness's own spelling straight through
 * -- Copilot's `bash` instead of `Bash`, `web_fetch` instead of `WebFetch` -- and that is a
 * difference of case and separators only, which is exactly what this removes. A bridge whose
 * mapping is *semantic* (Copilot's `view` -> `Read`) produces a name no fold can relate to anything,
 * and this does not pretend otherwise.
 *
 * It lives alone in a leaf module because there were three copies: one in `hooks_cli.ts`, one in
 * `bridges/copilot_cli.ts`, and one in `hook_registry.ts` that had dropped the `typeof` guard the
 * other two carry -- so the same untrusted `tool_name` that the other two answered `''` for threw a
 * TypeError there. Three copies of a comparison rule is how one of them silently stops agreeing
 * with the others, and the registry's job is to decide whether a tool was recognized at all.
 */

/** Lowercase `name` and strip underscores and dashes. A non-string folds to `''`: tool names arrive off a hook wire, so the type annotation is a claim about the caller, not about the payload. */
export function foldToolName(name: unknown): string {
  return typeof name === 'string' ? name.toLowerCase().replace(/[_-]/g, '') : ''
}
