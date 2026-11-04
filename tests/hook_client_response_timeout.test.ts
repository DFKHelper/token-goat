import { afterEach, describe, expect, it, vi } from 'vitest'

import { responseTimeoutFor } from '../src/hook_client.js'
import type { ServerRequest } from '../src/hook_ipc.js'

function hookRequest(harness: string): ServerRequest {
  return {
    kind: 'hook',
    event: 'pre_tool_use',
    input: '{}',
    elapsedMs: 0,
    env: { TOKEN_GOAT_HARNESS_OVERRIDE: harness },
    cwd: process.cwd(),
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('Copilot hook client response timeout', () => {
  it('uses a fast default, honors a configured timeout, and stays below the harness limit', () => {
    vi.stubEnv('TOKEN_GOAT_COPILOT_HOOK_CLIENT_TIMEOUT_MS', '')
    expect(responseTimeoutFor(hookRequest('copilot_cli'))).toBe(12_000)

    vi.stubEnv('TOKEN_GOAT_COPILOT_HOOK_CLIENT_TIMEOUT_MS', '5000')
    expect(responseTimeoutFor(hookRequest('copilot_cli'))).toBe(5_000)

    vi.stubEnv('TOKEN_GOAT_COPILOT_HOOK_CLIENT_TIMEOUT_MS', '60000')
    expect(responseTimeoutFor(hookRequest('copilot_cli'))).toBe(45_000)
  })

  it('does not apply the Copilot-specific override to other harnesses', () => {
    vi.stubEnv('TOKEN_GOAT_COPILOT_HOOK_CLIENT_TIMEOUT_MS', '5000')
    expect(responseTimeoutFor(hookRequest('codex'))).toBe(120_000)
  })
})
