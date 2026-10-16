/** Every tool `createMcpServer` registers, and the `TOKEN_GOAT_MCP_TOOLS` value that switches all of them on. The server advertises only a core subset when the variable is unset, so a test that calls an opt-in tool (brief, grep, handoff_*, ...) sets this first. Provenance: FORMAT-DERIVED from the `server.registerTool(` calls in src/mcp_server.ts at e67dddc6a; tests/mcp_server.test.ts asserts a live `tools/list` equals this list under this value, so a tool added later fails there instead of being silently filtered out. */
export const ALL_MCP_TOOLS: readonly string[] = [
  'read',
  'symbol',
  'section',
  'outline',
  'skeleton',
  'semantic',
  'index_status',
  'refs',
  'brief',
  'map',
  'changed',
  'grep',
  'imports',
  'exports',
  'compress_text',
  'retrieve_text',
  'handoff_create',
  'handoff_resolve',
]

export const ALL_MCP_TOOLS_ENV: string = ALL_MCP_TOOLS.join(',')
