// Provenance: HAND-DERIVED. The repository is built by tests/helpers/git-repo.ts (one commit holding a.txt); what `git ls-files` prints for it, and that `--error-unmatch` exits non-zero for an untracked file, were observed against the git on this machine. Every case runs the real git through both runners and compares their answers, so a disagreement between them fails here rather than being asserted against a restatement of the implementation.
/** The worker lists tracked files without blocking (listTrackedFilesAsync) and sweeps over that listing (reconcileProjectWith); the CLI and session start keep the blocking forms. The two must give one answer for every input. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { reconcileProject, reconcileProjectWith } from '../src/reconcile.js'
import { listTrackedFiles, listTrackedFilesAsync } from '../src/repomap.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'

const scratch: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

describe('listTrackedFilesAsync answers as listTrackedFiles does', () => {
  it('lists the tracked files of a repository directory', async () => {
    const repo = gitRepoWithCommit()
    const listed = await listTrackedFilesAsync(repo)
    expect(listed).toEqual(listTrackedFiles(repo))
    expect(listed.files).toEqual([path.join(repo, 'a.txt')])
  })

  it('resolves a single tracked file to just that file, and an untracked one to nothing', async () => {
    const repo = gitRepoWithCommit()
    const untracked = path.join(repo, 'new.txt')
    fs.writeFileSync(untracked, 'x\n')
    const tracked = path.join(repo, 'a.txt')
    expect(await listTrackedFilesAsync(tracked)).toEqual({ files: [tracked], timedOut: false })
    expect(await listTrackedFilesAsync(untracked)).toEqual(listTrackedFiles(untracked))
    expect((await listTrackedFilesAsync(untracked)).files).toEqual([])
  })

  it('reports nothing tracked, not a timeout, for a directory that is no repository or does not exist', async () => {
    const plain = scratchDir('tg-listasync-plain-')
    expect(await listTrackedFilesAsync(plain)).toEqual({ files: [], timedOut: false })
    expect(await listTrackedFilesAsync(path.join(plain, 'missing'))).toEqual({ files: [], timedOut: false })
  })
})

describe('reconcileProjectWith over a supplied listing', () => {
  it('finds what reconcileProject finds when handed the listing reconcileProject would take', () => {
    const repo = gitRepoWithCommit()
    const dbPath = path.join(scratchDir('tg-reconcile-with-'), 'global.db')
    const opts = { cwd: repo, dbPath, dryRun: true }
    const { elapsedMs: _a, ...whole } = reconcileProject(opts)
    const { elapsedMs: _b, ...split } = reconcileProjectWith(opts, listTrackedFiles(repo))
    expect(split).toEqual(whole)
    expect(split.added, 'an empty index owes the one tracked file').toEqual([path.join(repo, 'a.txt')])
  })

  it('reads a listing git did not finish as unknown, and examines nothing', () => {
    const repo = gitRepoWithCommit()
    const dbPath = path.join(scratchDir('tg-reconcile-with-'), 'global.db')
    const result = reconcileProjectWith({ cwd: repo, dbPath, dryRun: true }, { files: [], timedOut: true })
    expect(result.gitTimedOut).toBe(true)
    expect(result.scanned).toBe(0)
    expect(result.added).toEqual([])
  })
})
