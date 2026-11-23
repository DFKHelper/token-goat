import { afterEach, describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import { selftestRegisteredCommands, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'

// Provenance: HAND-DERIVED. The copilot_cli sessionStart registration shape is the one install writes (native client, then the Node shim after --); the runner is stubbed with the exact run each case would produce.
const COPILOT_START = buildGuardedCommand({
  shell: 'sh',
  native: ['/x/tg-hook', '--harness', 'copilot_cli', '--event', 'sessionStart', '--', 'node', '/x/copilot_cli.mjs', 'session_start'],
  safe: '{}',
  marker: '/x/marker',
})

afterEach(() => {
  setHookSelftestRunnerForTesting(undefined)
})

function failuresFor(run: { status: number; stdout: string; stderr: string }): string[] {
  setHookSelftestRunnerForTesting(() => run)
  return selftestRegisteredCommands([COPILOT_START]).failures
}

describe('the copilot sessionStart self-test counts only a clean probe answer as wired', () => {
  it('passes a probe that answers the safe object with nothing on stderr', () => {
    expect(failuresFor({ status: 0, stdout: '{}', stderr: '' })).toEqual([])
  })

  it('fails a hook that writes the budget-overrun notice instead of answering, on both routes', () => {
    const failures = failuresFor({ status: 0, stdout: '{}', stderr: 'tg-hook: SessionStart failed open: startup input deadline exceeded' })
    expect(failures).toHaveLength(2)
    for (const failure of failures) expect(failure).toContain('wrote to stderr: tg-hook: SessionStart failed open: startup input deadline exceeded')
  })
})
