/** The `toolPattern` every MCP tool name matches, shared by hooks_mcp.ts's PostToolUse registration and cli_doctor.ts's unmapped-tools cleanup so the two can never drift into two different spellings of "is this tool MCP". A standalone leaf module (no other token-goat import) so a consumer that only needs the literal -- unlike registerHook itself -- never pulls in hooks_mcp.ts's full dependency graph (mcp_compress_packs.ts, secret_redact.ts, injection_scan.ts, etc.) or re-runs its module-load-time registerHook side effects. */
export const MCP_TOOL_PATTERN = '^mcp__'

/** `literal` as regex source matching it in any letter case without the `i` flag, which a Claude Code hook matcher cannot carry: the harness compiles the matcher string as given and matches it case-sensitively. Each ASCII letter becomes a two-letter class and every other character is escaped, so `anyCaseSource('mcp__')` is `[mM][cC][pP]__`. A handler whose own test ignores case builds its matcher fragment through this, which keeps the fragment a superset of what the handler accepts. */
export function anyCaseSource(literal: string): string {
  let source = ''
  for (const ch of literal) source += /[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source
}
