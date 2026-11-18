// HAND-DERIVED: expected head computed from the D1F brief rule, not from the implementation under test.
import * as fs from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { tempConfigPath } from './helpers/temp-config.js'

const _testConfigPath = tempConfigPath('tg-generic-head-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { invalidateConfigCache } from '../src/config.js'
import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

function preEvent(command: string, raw: Record<string, unknown> = {}): HookEvent {
  return makeHookEvent({
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 's',
    raw: { tool_name: 'Bash', tool_input: { command }, ...raw },
  })
}

function headCalls(): unknown[][] {
  return vi.mocked(recordStat).mock.calls.filter((call) => String(call[0]).startsWith('bash_generic_head'))
}

describe('bash_generic_head stat', () => {
  beforeEach(() => {
    vi.mocked(recordStat).mockClear()
    fs.rmSync(_testConfigPath, { force: true })
    invalidateConfigCache()
  })

  it('records one row per command, naming the head and not the secret assignment before it', () => {
    preBashHandler(preEvent('API_KEY=[REDACTED:generic_secret_assignment] rollup -c'))
    const calls = headCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['bash_generic_head:rollup'])
    expect(JSON.stringify(vi.mocked(recordStat).mock.calls)).not.toContain('sk-123')
  })

  it('records nothing for a command the generic filter never sees', () => {
    preBashHandler(preEvent('echo hello'))
    expect(headCalls()).toHaveLength(0)
  })

  it('records nothing when the generic filter is disabled in config', () => {
    fs.writeFileSync(_testConfigPath, '[bash_compress]\ndisabled_filters = ["generic"]\n')
    invalidateConfigCache()
    const result = preBashHandler(preEvent('rollup -c'))
    expect(result.hookType).toBe('pass')
    expect(headCalls()).toHaveLength(0)
  })

  it.skipIf(process.platform !== 'win32')('records nothing when the rewrite is refused as too long', () => {
    const result = preBashHandler(preEvent(`rollup ${'x'.repeat(20000)}`, { _tg_harness: 'copilot_cli' }))
    expect(result.hookType).toBe('pass')
    expect(headCalls()).toHaveLength(0)
  })
})
