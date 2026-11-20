// Provenance: HAND-DERIVED. The expectation is an identity on the child's environment, read from `!env` output.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runGitAsync } from '../src/git_async.js'
import { runGit } from '../src/util.js'

const SWITCHES = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'] as const
// A shell alias runs with the environment git was given, so `!env` prints exactly what the child saw.
const DUMP = ['-c', 'alias.envdump=!env', 'envdump']
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]))
  for (const k of SWITCHES) process.env[k] = '1'
})

afterEach(() => {
  for (const k of SWITCHES) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function childSees(stdout: string, name: string): string | undefined {
  return stdout.split(/\r?\n/).find((l) => l.startsWith(name + '='))?.slice(name.length + 1)
}

describe('both git runners switch the pathspec environment off for the child', () => {
  it.each(SWITCHES)('runGitAsync: %s set to 1 in the parent reaches the child as 0', async (name) => {
    const r = await runGitAsync(DUMP)
    expect(r.exitCode, r.stderr).toBe(0)
    expect(childSees(r.stdout, name)).toBe('0')
  })

  it.each(SWITCHES)('runGit: %s set to 1 in the parent reaches the child as 0', (name) => {
    const r = runGit(DUMP)
    expect(r.exitCode, r.stderr).toBe(0)
    expect(childSees(r.stdout, name)).toBe('0')
  })

  it('the parent environment is unchanged after either runner returns', async () => {
    await runGitAsync(DUMP)
    runGit(DUMP)
    for (const k of SWITCHES) expect(process.env[k], k).toBe('1')
  })
})
