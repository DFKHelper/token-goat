/** Storing the output of a git-mutable command fingerprints the repository's state (HEAD plus `git status --porcelain`), which costs two git spawns. The store used to read that state three times for one call (the output id, the command-hash key, the stored fingerprint), so every cached `git status` paid six spawns, and under a loaded machine's ~2.5 s spawn the scoped-status recall test in hooks_bash.test.ts ran into its 60 s limit. Expected values below are HAND-DERIVED: two spawns for one store, and an id equal to the one bashOutputIdSync names for the same inputs. */
import type * as UtilModule from '../src/util.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({ calls: [] as string[][] }))

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => (seam.calls.push(args), actual.runGit(args, opts)) }
})

import { bashOutputIdSync, commandHashSync, computeBashFingerprints, getBashOutput, storeBashOutputSync } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'

const GIT_STATE_READS = [
  ['rev-parse', 'HEAD'],
  ['status', '--porcelain'],
]

beforeEach(() => {
  clearModuleCaches()
  seam.calls.length = 0
})

describe('storeBashOutputSync git state reads', () => {
  it('reads the repository state once for a git-mutable command, and keeps the id and fingerprint it always named', async () => {
    const dir = gitRepoWithCommit()
    const cmd = 'git status --porcelain -- a.txt'
    const output = ' M a.txt\n'.repeat(80)

    const id = storeBashOutputSync(cmd, output, 0, dir)

    expect(seam.calls).toEqual(GIT_STATE_READS)
    seam.calls.length = 0
    expect(id).toBe(bashOutputIdSync(cmd, output, dir))
    const separate = computeBashFingerprints(cmd, dir)
    expect(separate?.git).toBeTruthy()
    expect((await getBashOutput(id))?.fingerprints?.git).toBe(separate?.git)
    expect(commandHashSync(cmd, dir)).not.toBe(id)
  })

  it('reads the state for a command that only fingerprints it, not for the command hash', () => {
    const dir = gitRepoWithCommit()

    storeBashOutputSync('npm test', 'ok\n', 0, dir)

    expect(seam.calls).toEqual(GIT_STATE_READS)
  })

  it('spawns no git for a command whose key and fingerprints do not depend on the repository', () => {
    const dir = gitRepoWithCommit()

    storeBashOutputSync('echo hello', 'hello\n', 0, dir)

    expect(seam.calls).toEqual([])
  })
})
