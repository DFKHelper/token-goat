// Fixture provenance: CAPTURE for the two warning lines (Node 22, seen in this suite); the rest HAND-DERIVED.
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import { selftestRegisteredCommands, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'

const WARNING = '(node:98272) [DEP0190] DeprecationWarning: Passing args to a child process with shell'
const HINT = '(Use `node --trace-deprecation ...` to show where the warning was created)'
const MARKER = path.join(os.tmpdir(), 'tg-node-warning-marker')

function command(): string {
  return buildGuardedCommand({
    shell: 'sh',
    native: ['/usr/bin/node', '/h/shim.cjs', 'post_tool_use', '/e/token-goat.mjs'],
    safe: '{}',
    marker: MARKER,
  })
}

function failuresFor(stderr: string): string[] {
  setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '{}', stderr }))
  return selftestRegisteredCommands([command()]).failures
}

afterEach(() => setHookSelftestRunnerForTesting(undefined))

describe('the install self-test and Node process warnings', () => {
  it('passes a hook whose only stderr is a process warning and its hint line', () => {
    expect(failuresFor(`${WARNING}\n${HINT}\n`)).toEqual([])
  })

  it('fails a warning followed by another stderr line, and names only the other line', () => {
    const failures = failuresFor(`${WARNING}\n${HINT}\nmodule not found: shim.cjs\n`)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('wrote to stderr: module not found: shim.cjs')
    expect(failures[0]).not.toContain('DeprecationWarning')
  })

  it('fails a loader error that merely mentions a warning in its text', () => {
    const failures = failuresFor('Error: Cannot find module x (see Warning: nothing)\n')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('wrote to stderr: Error: Cannot find module x')
  })

  it('fails a line that only looks like a warning without the process id prefix', () => {
    expect(failuresFor('DeprecationWarning: not from Node\n')).toHaveLength(1)
  })
})
