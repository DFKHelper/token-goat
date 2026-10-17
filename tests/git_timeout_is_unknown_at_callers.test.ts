// Provenance: HAND-DERIVED for the git answers. A killed git is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node 24.12 ETIMEDOUT CAPTURE in src/util.ts::runGit); a git that ran and refused is a non-zero exit without timedOut; the `cat-file --batch-check` rows (`<oid> <type> <size>`, `<query> missing`) are git's documented batch-check output (git-cat-file(1)). Which caller reads which field is the contract under test, so it is stated here, not read off the callers. The git boundary is replaced by a function the test controls, because a real git cannot be made slow on an event on every platform; the real-git side of the timeout is tests/run_git_default_timeout.test.ts and tests/run_git_timeout_reaps_git.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as util from '../src/util.js'

const git = vi.hoisted(() => ({ answer: (_args: readonly string[]): unknown => undefined as unknown }))
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof util>()
  return { ...actual, runGit: (args: string[]) => git.answer(args) }
})

import { formatInstallIndexResult, queueInstallIndex } from '../src/install_index.js'
import { resolveProjectRoot } from '../src/project.js'
import { runChanged } from '../src/read_git.js'
import { getTrackedFiles, listTrackedFiles } from '../src/repomap.js'
import { indexableDir } from './helpers/temp-config.js'

const KILLED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, timedOut: true }
const REFUSED: GitResult = { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
const ok = (stdout: string): GitResult => ({ stdout, stderr: '', exitCode: 0 })

let stderr: string[] = []
let savedInstallIndex: string | undefined

beforeEach(() => {
  stderr = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  })
  savedInstallIndex = process.env['TOKEN_GOAT_INSTALL_INDEX']
  delete process.env['TOKEN_GOAT_INSTALL_INDEX']
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedInstallIndex === undefined) delete process.env['TOKEN_GOAT_INSTALL_INDEX']
  else process.env['TOKEN_GOAT_INSTALL_INDEX'] = savedInstallIndex
})

describe('listTrackedFiles', () => {
  it('says a killed ls-files is unknown, and a refused one is empty', () => {
    git.answer = () => KILLED
    expect(listTrackedFiles('/project')).toEqual({ files: [], timedOut: true })
    expect(getTrackedFiles('/project')).toEqual([])
    git.answer = () => REFUSED
    expect(listTrackedFiles('/project')).toEqual({ files: [], timedOut: false })
  })
})

describe('queueInstallIndex when git does not answer', () => {
  it('reports git-timeout, not not-git, when ls-files is killed', () => {
    const dir = indexableDir()
    // The top-level probe is refused, so only the killed listing can produce git-timeout.
    git.answer = (args) => (args[0] === 'ls-files' ? KILLED : REFUSED)
    const result = queueInstallIndex(dir)
    expect(result).toMatchObject({ status: 'skipped', reason: 'git-timeout' })
    expect(formatInstallIndexResult(result)).toMatch(/did not answer in time/)
  })

  it('reports git-timeout when ls-files found nothing and the top-level probe is killed', () => {
    const dir = indexableDir()
    git.answer = (args) => (args[0] === 'ls-files' ? ok('') : KILLED)
    expect(queueInstallIndex(dir)).toMatchObject({ status: 'skipped', reason: 'git-timeout' })
  })

  it('still reports not-git when git ran and refused', () => {
    const dir = indexableDir()
    git.answer = () => REFUSED
    expect(queueInstallIndex(dir)).toMatchObject({ status: 'skipped', reason: 'not-git' })
  })
})

describe('resolveProjectRoot when git does not answer', () => {
  it('says so once on stderr and still returns a root; a refusal says nothing', () => {
    const dir = indexableDir()
    git.answer = () => KILLED
    const root = resolveProjectRoot({ project: dir })
    resolveProjectRoot({ project: dir })
    expect(root.length).toBeGreaterThan(0)
    expect(stderr.filter((line) => line.includes('git did not answer while finding the project root'))).toHaveLength(1)
    stderr = []
    git.answer = () => REFUSED
    resolveProjectRoot({ project: indexableDir() })
    expect(stderr.join('')).toBe('')
  })
})

describe('changed <ref> hint when git does not answer', () => {
  // `diff` fails (the ref is unknown or git was slow), then the hint asks git whether the ref resolves.
  function hintAnswers(batch: GitResult, fallbackProbe: GitResult): (args: readonly string[]) => GitResult {
    return (args) => {
      if (args[0] === 'diff') return REFUSED
      if (args[0] === 'rev-list') return ok('3\n')
      if (args[0] === 'cat-file') return batch
      return fallbackProbe
    }
  }

  it('offers no hint when the batch probe is killed', () => {
    // The per-ref probe is refused, so only the killed batch can produce the missing hint.
    git.answer = hintAnswers(KILLED, REFUSED)
    expect(runChanged({ ref: 'nosuchref', projectRoot: '/project', projectRootResolved: true })).toBe(1)
    expect(stderr.join('')).not.toMatch(/Hint:/)
  })

  it('offers no hint when the per-ref probes are killed after a batch that failed', () => {
    git.answer = hintAnswers(REFUSED, KILLED)
    expect(runChanged({ ref: 'nosuchref', projectRoot: '/project', projectRootResolved: true })).toBe(1)
    expect(stderr.join('')).not.toMatch(/Hint:/)
  })

  it('still says the ref does not exist when git answered that it is missing', () => {
    const oid = 'a'.repeat(40)
    git.answer = hintAnswers(ok(`nosuchref missing\n${oid} commit 200\n${oid} commit 200\n`), REFUSED)
    expect(runChanged({ ref: 'nosuchref', projectRoot: '/project', projectRootResolved: true })).toBe(1)
    expect(stderr.join('')).toMatch(/Hint:.*does not exist/)
  })
})
