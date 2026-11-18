// Fixture provenance: FORMAT-DERIVED from src/hook_registry.ts EVENTS_WITH_RAW_STDOUT_CONTEXT (raw).
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import { selftestRegisteredCommands, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'

const RAW = 'When summarizing this session, keep the file paths exactly as written.'
const MARKER = path.join(os.tmpdir(), 'tg-raw-precompact-marker')

function nodeOnly(event: string): string {
  return buildGuardedCommand({
    shell: 'sh',
    native: ['/usr/bin/node', '/h/shim.cjs', event, '/e/token-goat.mjs'],
    safe: '{}',
    marker: MARKER,
  })
}

function withClient(harness: string, event: string): string {
  return buildGuardedCommand({
    shell: 'sh',
    native: [
      '/h/tg-hook', '--harness', harness, '--event', event, '--entry', '/e/t.mjs',
      '--', '/usr/bin/node', '/h/shim.cjs', event, '/e/t.mjs',
    ],
    safe: '{}',
    marker: MARKER,
  })
}

afterEach(() => setHookSelftestRunnerForTesting(undefined))

describe('hook self-test accepts the raw pre_compact answer only where the host reads it raw', () => {
  it('accepts plain text from a Node-only pre_compact registration', () => {
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: RAW, stderr: '' }))
    expect(selftestRegisteredCommands([nodeOnly('pre_compact')]).failures).toEqual([])
  })

  it('accepts plain text from a claudecode pre_compact registration on both routes', () => {
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: RAW, stderr: '' }))
    const out = selftestRegisteredCommands([withClient('claudecode', 'pre_compact')])
    expect(out.failures).toEqual([])
    expect(out.tested).toBe(1)
  })

  it('accepts empty output only where the registered safe answer is empty too', () => {
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '', stderr: '' }))
    const quiet = buildGuardedCommand({
      shell: 'sh',
      native: ['/usr/bin/node', '/h/shim.cjs', 'pre_tool_use', '/e/token-goat.mjs'],
      safe: '',
      marker: MARKER,
    })
    expect(selftestRegisteredCommands([quiet]).failures).toEqual([])
    expect(selftestRegisteredCommands([nodeOnly('pre_tool_use')]).failures.join('\n')).toContain('not a valid')
  })

  it('still rejects plain text from any other event', () => {
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: RAW, stderr: '' }))
    const out = selftestRegisteredCommands([nodeOnly('pre_tool_use')])
    expect(out.failures.join('\n')).toContain('not a valid answer')
  })

  it('still rejects plain text from a harness whose pre_compact answer is JSON', () => {
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: RAW, stderr: '' }))
    const out = selftestRegisteredCommands([withClient('copilot_cli', 'pre_compact')])
    expect(out.failures.join('\n')).toContain('not a valid answer')
  })
})
