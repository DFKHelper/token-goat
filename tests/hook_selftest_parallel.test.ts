// Fixture provenance: HAND-DERIVED; the registered commands are built here and run in the host's shell.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import {
  realShellRunner,
  selftestRegisteredCommands,
  setHookSelftestRunnerForTesting,
} from '../src/hook_selftest.js'

const HAS_SH = realShellRunner('sh', ': probe', '') !== null
let dir: string
let script: string

function command(event: string): string {
  return buildGuardedCommand({
    shell: 'sh',
    native: [process.execPath.split(path.sep).join('/'), script.split(path.sep).join('/'), event],
    safe: '{}',
    marker: path.join(dir, 'marker').split(path.sep).join('/'),
  })
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-par-'))
  script = path.join(dir, 'hook.cjs')
  // Answers a JSON object for every event but `garbled`, which prints text no host accepts.
  fs.writeFileSync(script, "process.stdout.write(process.argv[2] === 'garbled' ? 'not json' : '{}')\n")
})

afterAll(() => {
  setHookSelftestRunnerForTesting(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.runIf(HAS_SH)('the self-test runs several registered commands at once in the real shell', () => {
  it('passes every command that answers and names only the one that does not', () => {
    setHookSelftestRunnerForTesting(undefined)
    const out = selftestRegisteredCommands([command('preToolUse'), command('garbled'), command('postToolUse')])
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toContain('garbled')
    expect(out.failures[0]).toContain('not a valid answer')
    expect(out.tested).toBe(3)
    expect(out.skipped).toEqual([])
  })

  it('passes when every command answers', () => {
    setHookSelftestRunnerForTesting(undefined)
    const events = ['preToolUse', 'postToolUse', 'sessionStart']
    const out = selftestRegisteredCommands(events.map(command))
    expect(out.failures).toEqual([])
    expect(out.tested).toBe(3)
  })
})
