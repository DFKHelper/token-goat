// HAND-DERIVED: expected head computed from the D1F brief rule, not from the implementation under test.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

function preEvent(command: string): HookEvent {
  return makeHookEvent({
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 's',
    raw: { tool_name: 'Bash', tool_input: { command } },
  })
}

function headCalls(): unknown[][] {
  return vi.mocked(recordStat).mock.calls.filter((call) => call[0] === 'bash_generic_head')
}

describe('bash_generic_head stat', () => {
  beforeEach(() => {
    vi.mocked(recordStat).mockClear()
  })

  it('records the command head, not the secret assignment before it, when the generic filter applies', () => {
    preBashHandler(preEvent('API_KEY=sk-123 rollup -c'))
    const calls = headCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['bash_generic_head', 0, 0, undefined, 'rollup'])
    expect(JSON.stringify(vi.mocked(recordStat).mock.calls)).not.toContain('sk-123')
  })

  it('records nothing for a command the generic filter never sees', () => {
    preBashHandler(preEvent('echo hello'))
    expect(headCalls()).toHaveLength(0)
  })
})
