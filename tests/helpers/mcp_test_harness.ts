import { vi } from 'vitest'

/** These tests exercise the generic MCP path; hook-enabled hosts intentionally hide MCP tools. */
export function neutralizeMcpHarnessSignals(): void {
  vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'generic')
  vi.stubEnv('COPILOT_HOME', undefined)
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined)
  vi.stubEnv('TERM_PROGRAM', undefined)
}
