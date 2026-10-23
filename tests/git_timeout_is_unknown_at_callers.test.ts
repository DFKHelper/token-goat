// Provenance: HAND-DERIVED for the git answers. A killed git is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node 24.12 ETIMEDOUT CAPTURE in src/util.ts::runGit); a git that ran and refused is a non-zero exit without timedOut; the `cat-file --batch-check` rows (`<oid> <type> <size>`, `<query> missing`) are git's documented batch-check output (git-cat-file(1)). Which caller reads which field is the contract under test, so it is stated here, not read off the callers. The git boundary is replaced by a function the test controls, because a real git cannot be made slow on an event on every platform; the real-git side of the timeout is tests/run_git_default_timeout.test.ts and tests/run_git_timeout_reaps_git.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as util from '../src/util.js'

const git = vi.hoisted(() => ({ answer: (_args: readonly string[]): unknown => undefined as unknown }))
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof util>()
  return { ...actual, runGit: (args: string[]) => git.answer(args) }
})

import { cmdIndex } from '../src/cli.js'
import { formatCommandError } from '../src/command_error.js'
import { buildImportGraph } from '../src/import_graph.js'
import { isIndexedRoot } from '../src/indexed_roots.js'
import { formatInstallIndexResult, queueInstallIndex } from '../src/install_index.js'
import { resolveProjectRoot } from '../src/project.js'
import { runChanged } from '../src/read_git.js'
import { reconcileProject } from '../src/reconcile.js'
import { listTrackedFiles, requireTrackedFiles } from '../src/repomap.js'
import { indexableDir } from './helpers/temp-config.js'

const KILLED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, unfinished: true, timedOut: true }
const SIGNAL_KILLED: GitResult = { stdout: '', stderr: 'git was killed by SIGKILL', exitCode: -1, unfinished: true, signal: 'SIGKILL' }
const REFUSED: GitResult = { stdout: '', stderr: 'fatal: not a git repository', unfinished: false, exitCode: 128 }
const ok = (stdout: string): GitResult => ({ stdout, stderr: '', unfinished: false, exitCode: 0 })

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

describe('queueInstallIndex when git cannot be started', () => {
  it('reports git-timeout, not not-git, when no git binary can be found', async () => {
    // Provenance: HAND-DERIVED. The real runGit runs with PATH emptied, so the spawn fails with ENOENT and no git runs: a nonexistent-binary path, not a mocked answer.
    const realUtil = await vi.importActual<typeof util>('../src/util.js')
    git.answer = (args) => realUtil.runGit([...args])
    const dir = indexableDir()
    const savedPath = process.env['PATH']
    process.env['PATH'] = ''
    let result: ReturnType<typeof queueInstallIndex>
    try {
      result = queueInstallIndex(dir)
    } finally {
      process.env['PATH'] = savedPath
    }
    expect(result).toMatchObject({ status: 'skipped', reason: 'git-timeout' })
  })
})

describe('callers that read the tracked-file list when git does not answer', () => {
  it('index refuses with a git-timeout error, also under --walk, instead of reading "no tracked files"', async () => {
    const dir = indexableDir()
    git.answer = () => KILLED
    await expect(cmdIndex(dir, { walk: true })).rejects.toThrow(/git did not answer in time/)
    await expect(cmdIndex(dir)).rejects.toThrow(/git did not answer in time/)
  })

  it('prints the directory in the timeout error display-safe, where a name can carry an escape sequence', () => {
    // Provenance: HAND-DERIVED. A directory name may hold any byte but NUL and a slash; the control character here is the one a terminal would act on.
    git.answer = () => KILLED
    let thrown: unknown
    try { requireTrackedFiles('/project/\u001b[31mred') } catch (e) { thrown = e }
    expect(formatCommandError(thrown)).toMatch(/git did not answer in time while listing the tracked files under \/project\//)
    expect(formatCommandError(thrown)).not.toContain('\u001b')
  })

  it('index still says "no tracked files" when git ran and refused', async () => {
    git.answer = () => REFUSED
    await expect(cmdIndex(indexableDir())).rejects.toThrow(/no tracked files found/)
  })

  it('the import graph (arch, affected, deps) refuses instead of building an empty graph', () => {
    git.answer = () => KILLED
    expect(() => buildImportGraph(indexableDir())).toThrow(/git did not answer in time/)
    git.answer = () => REFUSED
    expect(buildImportGraph(indexableDir()).files).toEqual([])
  })

  it('reconcile reports a killed listing as unknown, and a refused one as not killed', () => {
    const dir = indexableDir()
    git.answer = () => KILLED
    expect(reconcileProject({ cwd: dir, dryRun: true }).gitTimedOut).toBe(true)
    git.answer = () => REFUSED
    expect(reconcileProject({ cwd: dir, dryRun: true }).gitTimedOut).toBe(false)
  })

  it('install does not record the root as indexed when the listing is killed on the second call', () => {
    const dir = indexableDir()
    let listings = 0
    // The first listing (install's own non-git check) answers; reconcile's listing is the one git then fails to finish.
    git.answer = (args) => {
      if (args[0] !== 'ls-files') return REFUSED
      listings += 1
      return listings === 1 ? ok('a.ts\n') : KILLED
    }
    const result = queueInstallIndex(dir)
    expect(listings).toBe(2)
    expect(result).toMatchObject({ status: 'skipped', reason: 'git-timeout' })
    expect(isIndexedRoot(dir)).toBe(false)
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

  it('offers no hint when the batch probe is killed by a signal', () => {
    git.answer = hintAnswers(SIGNAL_KILLED, REFUSED)
    expect(runChanged({ ref: 'nosuchref', projectRoot: '/project', projectRootResolved: true })).toBe(1)
    expect(stderr.join('')).not.toMatch(/Hint:/)
  })

  it('offers no hint when the per-ref probes are killed by a signal after a failed batch', () => {
    git.answer = hintAnswers(REFUSED, SIGNAL_KILLED)
    expect(runChanged({ ref: 'nosuchref', projectRoot: '/project', projectRootResolved: true })).toBe(1)
    expect(stderr.join('')).not.toMatch(/Hint:/)
  })
})

describe('a git killed by a signal is unknown at the other callers', () => {
  it('listTrackedFiles reads a signal-killed ls-files as unknown, not as an empty list', () => {
    git.answer = () => SIGNAL_KILLED
    expect(listTrackedFiles('/project')).toEqual({ files: [], timedOut: true })
  })

  it('queueInstallIndex reports git-timeout when the top-level probe is killed by a signal', () => {
    const dir = indexableDir()
    git.answer = (args) => (args[0] === 'ls-files' ? ok('') : SIGNAL_KILLED)
    expect(queueInstallIndex(dir)).toMatchObject({ status: 'skipped', reason: 'git-timeout' })
  })

  it('resolveProjectRoot says so once on stderr when git is killed by a signal', () => {
    const dir = indexableDir()
    git.answer = () => SIGNAL_KILLED
    resolveProjectRoot({ project: dir })
    expect(stderr.filter((line) => line.includes('git did not answer while finding the project root'))).toHaveLength(1)
  })
})
