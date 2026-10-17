/** The manifest's git dirty-state probe must not spawn git for a directory outside every work tree. CI run 38987886278 failed tests/compact.test.ts on Windows with EBUSY from rmSync of a scratch project directory: the two failing tests were the only ones that both pass a cwd and exceed the manifest cap, which is what runs `git diff` and `git status` there under the 50 ms hints.git_hint_max_ms bound. A spawn that is killed at that bound is not finished with the directory it started in, and in a non-repository the spawn could only ever answer "nothing". */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CAN_JUNCTION } from './helpers/can-symlink.js'

import { importSessionState, recordFileEdit, recordFileRead } from '../src/session.js'
import { saveSessionState } from '../src/session_store.js'
import { buildManifest } from '../src/manifest.js'
import { runGit } from '../src/util.js'

// No real git runs in this file: the probe's argument and cwd are what is asserted, so the answer cannot depend on how fast a process starts.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, runGit: vi.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })) }
})

const runGitMock = vi.mocked(runGit)

// HAND-DERIVED: every fixture is built on disk by this file (a bare `.git` marker, a junction to a folder holding one) and the expected probe calls follow from what git itself walks up for, not from reading the matcher.

/** The nearest ancestor of `dir` that holds a `.git` entry, or null when none does. */
function gitAncestor(dir: string): string | null {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    if (path.dirname(cur) === cur) return null
  }
}

/** A session whose manifest is well past the default 1600-character cap, so the cap engages and the adaptive bonus (the git probe) is consulted. */
function seedLongSession(sessionId: string): void {
  recordFileEdit('/proj/src/edited.ts')
  for (let i = 0; i < 45; i++) recordFileRead(`/proj/src/read-only-file-number-${i}.ts`)
  saveSessionState(sessionId)
}

describe('manifest git probe needs a work tree', () => {
  const dirs: string[] = []
  let prevGitDir: string | undefined

  beforeEach(() => {
    importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
    runGitMock.mockClear()
    prevGitDir = process.env['GIT_DIR']
    delete process.env['GIT_DIR']
  })

  afterEach(() => {
    if (prevGitDir === undefined) delete process.env['GIT_DIR']
    else process.env['GIT_DIR'] = prevGitDir
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-manifest-gitprobe-'))
    dirs.push(dir)
    return dir
  }

  it('spawns no git for a directory outside every work tree, even when the cap engages', () => {
    const projectDir = scratch()
    const ancestor = gitAncestor(projectDir)
    expect(ancestor, `precondition: the temp directory ${os.tmpdir()} must sit outside every work tree, but ${String(ancestor)} holds a .git entry; point TMPDIR/TEMP at a folder outside it`).toBeNull()
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}')
    seedLongSession('no-worktree-session')

    const manifest = buildManifest('no-worktree-session', projectDir)

    expect(manifest, 'the cap must engage, or this asserts on a manifest that never consulted the probe').toContain('manifest truncated at ')
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('still probes git when the directory itself is a work tree', () => {
    const projectDir = scratch()
    fs.mkdirSync(path.join(projectDir, '.git'))
    seedLongSession('worktree-session')

    const manifest = buildManifest('worktree-session', projectDir)

    expect(manifest).toContain('manifest truncated at ')
    const probes = runGitMock.mock.calls.map(([args, opts]) => [args[0], opts?.cwd])
    expect(probes).toEqual([['diff', projectDir], ['status', projectDir]])
  })

  it('still probes git when a work tree is an ancestor of the directory', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../elsewhere')
    const projectDir = path.join(root, 'packages', 'app')
    fs.mkdirSync(projectDir, { recursive: true })
    seedLongSession('nested-session')

    buildManifest('nested-session', projectDir)

    expect(runGitMock.mock.calls.map(([args]) => args[0])).toEqual(['diff', 'status'])
  })

  it.skipIf(!CAN_JUNCTION)('still probes git when the directory is a junction into a work tree', () => {
    const repo = scratch()
    fs.mkdirSync(path.join(repo, '.git'))
    const target = path.join(repo, 'app')
    fs.mkdirSync(target)
    const outside = scratch()
    const link = path.join(outside, 'link')
    fs.symlinkSync(target, link, 'junction')
    expect(gitAncestor(outside), `precondition: ${outside} must sit outside every work tree, but ${String(gitAncestor(outside))} holds a .git entry`).toBeNull()
    seedLongSession('junction-session')

    try {
      buildManifest('junction-session', link)
    } finally {
      fs.rmSync(link, { recursive: true, force: true })
    }

    expect(runGitMock.mock.calls.map(([args]) => args[0])).toEqual(['diff', 'status'])
  })

  it('still probes git when GIT_DIR names the repository', () => {
    const projectDir = scratch()
    process.env['GIT_DIR'] = path.join(projectDir, 'elsewhere.git')
    seedLongSession('git-dir-session')

    buildManifest('git-dir-session', projectDir)

    expect(runGitMock.mock.calls.map(([args]) => args[0])).toEqual(['diff', 'status'])
  })
})
