import { afterAll, beforeAll, vi } from 'vitest'

/** The env keys the hooksAvailable setter in src/mcp_jsonrpc.ts reads; the guard test checks this list against the setter. */
export const MCP_HARNESS_SIGNAL_ENV_KEYS = ['COPILOT_HOME', 'CLAUDE_CODE_SESSION_ID', 'TERM_PROGRAM'] as const

/** These tests exercise the generic MCP path; hook-enabled hosts intentionally hide MCP tools. */
export function neutralizeMcpHarnessSignals(): void {
  vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'generic')
  for (const key of MCP_HARNESS_SIGNAL_ENV_KEYS) vi.stubEnv(key, undefined)
}

/** Env for a spawned `mcp-serve` child: the generic override, with the signals the hooksAvailable setter reads removed, since a child inherits the parent's process.env. */
export function genericMcpHarnessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TOKEN_GOAT_HARNESS_OVERRIDE: 'generic' }
  for (const key of MCP_HARNESS_SIGNAL_ENV_KEYS) delete env[key]
  return env
}

/** Call at the top of a test file that drives an MCP server: tests/setup/isolate-home.ts defaults the harness override to claudecode, which makes every tool call answer "disabled because hooks are available". */
export function useGenericMcpHarness(): void {
  beforeAll(neutralizeMcpHarnessSignals)
  afterAll(() => {
    vi.unstubAllEnvs()
  })
}
