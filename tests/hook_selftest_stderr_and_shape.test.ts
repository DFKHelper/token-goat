import { afterEach, describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import { selftestRegisteredCommands, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'

// Provenance: HAND-DERIVED. The runner is stubbed with the exact run a broken registration would produce.
const COMMAND = buildGuardedCommand({
  shell: 'sh',
  native: ['/x/tg-hook', 'hook', '--harness', 'claudecode', '--event', 'post_tool_use'],
  safe: '{}',
  marker: '/x/marker',
})

afterEach(() => {
  setHookSelftestRunnerForTesting(undefined)
})

function failuresFor(run: { status: number; stdout: string; stderr: string }): string[] {
  setHookSelftestRunnerForTesting(() => run)
  return selftestRegisteredCommands([COMMAND]).failures
}

describe('the self-test judges stderr and the answer shape, not only the exit status', () => {
  it('passes a clean run with the safe answer', () => {
    expect(failuresFor({ status: 0, stdout: '{}', stderr: '' })).toEqual([])
  })

  it('fails a run that exits 0 with the safe answer but wrote to stderr', () => {
    const failures = failuresFor({ status: 0, stdout: '{}', stderr: 'Error: Cannot find module' })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('wrote to stderr: Error: Cannot find module')
  })

  it.each([
    ['empty stdout for a harness that answers {}', ''],
    ['a bare array', '[]'],
    ['a JSON null', 'null'],
    ['plain text', 'oops'],
    ['text after the answer', '{}\nstray'],
  ])('fails %s', (_name, stdout) => {
    const failures = failuresFor({ status: 0, stdout, stderr: '' })
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]).toContain('not a valid answer')
  })
})
