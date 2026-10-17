// Provenance: HAND-DERIVED. A killed git is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node ETIMEDOUT CAPTURE documented at src/util.ts::runGit); the repository is a real one from tests/helpers/git-repo.ts, and only the call named by `killed` is replaced by the killed answer. Staleness expected here is derived from the requirement: a state git could not read is never equal to another state.
/** A killed `git status` or `git rev-parse` is an unknown repository state: a cached test, lint or diff result stored under it is never served as fresh, not even when the next fingerprint is killed too. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as UtilModule from '../src/util.js'

const seam = vi.hoisted(() => ({ killed: null as string | null }))
const KILLED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, timedOut: true }

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => (args[0] === seam.killed ? KILLED : actual.runGit(args, opts)) }
})

import { getBashOutput, isBashEntryStale, storeBashOutputSync } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'

beforeEach(() => {
  clearModuleCaches()
  seam.killed = null
})

async function storedUnder(killed: string | null, cmd: string, dir: string) {
  seam.killed = killed
  const id = storeBashOutputSync(cmd, 'ok\n'.repeat(40), 0, dir)
  seam.killed = null
  const entry = await getBashOutput(id)
  if (entry === null) throw new Error('the entry just stored did not come back')
  return entry
}

describe.each([
  ['status', 'npm test'],
  ['status', 'git diff'],
  ['rev-parse', 'npm test'],
])('a killed git %s fingerprinting %s', (killedCall, cmd) => {
  it('is stale when the next fingerprint reads a healthy state', async () => {
    const dir = gitRepoWithCommit()
    const entry = await storedUnder(killedCall, cmd, dir)
    expect(isBashEntryStale(entry, cmd, dir)).toBe(true)
  })

  it('is stale when the next fingerprint is killed too, where two unreadable states used to compare equal', async () => {
    const dir = gitRepoWithCommit()
    const entry = await storedUnder(killedCall, cmd, dir)
    seam.killed = killedCall
    expect(isBashEntryStale(entry, cmd, dir)).toBe(true)
  })

  it('makes a result stored under a healthy state stale while git is killed', async () => {
    const dir = gitRepoWithCommit()
    const entry = await storedUnder(null, cmd, dir)
    expect(isBashEntryStale(entry, cmd, dir)).toBe(false)
    seam.killed = killedCall
    expect(isBashEntryStale(entry, cmd, dir)).toBe(true)
  })
})
