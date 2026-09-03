/**
 * Pull the rewritten body out of a `hookSpecificOutput.updatedToolOutput` on the Claude Code wire.
 *
 * Claude Code requires that field to match the tool's own result shape, so for a built-in tool it
 * is an OBJECT: the original `tool_response` with one text-bearing field replaced. A bare string is
 * only correct when the tool's result is itself a string (MCP). This helper asserts that shape and
 * returns the replaced text, so a test can keep asserting on the body without re-deriving the
 * envelope in four places.
 *
 * Provenance: the envelope rule is CAPTURE — recorded Claude Code sessions reject a string with
 * "PostToolUse hook returned updatedToolOutput that does not match <Tool>'s output shape; using
 * original output" (337 Bash, 52 WebFetch, 32 WebSearch, 10 Grep occurrences).
 */
export function rewrittenBody(updated: unknown): string {
  if (updated === null || updated === undefined) {
    throw new Error('updatedToolOutput is absent; expected an object carrying the rewritten body')
  }
  if (typeof updated === 'string') {
    throw new Error(
      `updatedToolOutput is a bare string, which Claude Code rejects for a built-in tool: ${JSON.stringify(updated).slice(0, 120)}`,
    )
  }
  if (typeof updated !== 'object') {
    throw new Error(`updatedToolOutput has unexpected type ${typeof updated}`)
  }
  const obj = updated as Record<string, unknown>
  const nestedFile = obj['file']
  const source = nestedFile !== null && typeof nestedFile === 'object' ? (nestedFile as Record<string, unknown>) : obj
  for (const key of ['output', 'content', 'text', 'body', 'stdout', 'stderr', 'result']) {
    const v = source[key]
    if (typeof v === 'string' && v !== '') return v
  }
  throw new Error(`updatedToolOutput carries no non-empty text field: ${JSON.stringify(obj).slice(0, 200)}`)
}

/** The keys of an object-shaped `updatedToolOutput`, for asserting the original ones survived. */
export function rewrittenKeys(updated: unknown): string[] {
  if (updated === null || typeof updated !== 'object') return []
  return Object.keys(updated as Record<string, unknown>)
}
