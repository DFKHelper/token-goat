/** A branch switch rewrites files without going through any edit tool, so the Bash post hook asks git which files changed and enqueues them. When git cannot answer in the hook's budget (a spawn failure or timeout under load, or a reflog that no longer reaches back), the hook used to enqueue nothing and log nothing, and the index stayed on the old branch. It now records a reconcile request that the worker sweeps off the hook's time budget, only for a project indexed on purpose. These tests drive the production path: the real hook handler, the real request file, and `drainOnce` with no injected index callback. PROVENANCE: HAND-DERIVED for the symbol names (computed from the files each test writes). CAPTURE for the git failure: in a repository that has switched branches, deleting `.git/logs` makes `git diff --name-only HEAD@{1} HEAD` exit 128 ("unknown revision"), observed by hand against git on this machine; no seam stands in for it. The one seam is `runGit` returning exit -1 for the reflog read (what a 5 s timeout returns), because a real timeout cannot be produced on demand. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as ReconcileModule from '../src/reconcile.js'
import type * as UtilModule from '../src/util.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dataDir, globalDbPath } from '../src/constants.js'
import { appendReconcileRequest, parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import type { HookEvent } from '../src/hook_registry.js'
import { enqueueDirtyPathsSafe, getDirtyPaths, clearDirtyQueue } from '../src/hooks_index.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { querySymbols } from '../src/index_reader.js'
import { resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { foldPath } from '../src/util.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { indexableDir } from './helpers/temp-config.js'

const seam = vi.hoisted(() => ({ failReflog: false, reconcileBudgetMs: null as number | null }))

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => (seam.failReflog && args[0] === 'reflog' ? { stdout: '', stderr: 'timed out', exitCode: -1 } : actual.runGit(args, opts)),
  }
})

vi.mock('../src/reconcile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReconcileModule>()
  return { ...actual, reconcileProject: (o: Parameters<typeof actual.reconcileProject>[0]) => actual.reconcileProject(seam.reconcileBudgetMs === null ? o : { ...o, budgetMs: seam.reconcileBudgetMs }) }
})

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
  return r.stdout.trim()
}

function postBashEvent(command: string, cwd: string): HookEvent {
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: 'reconcile-fallback', raw: { tool_name: 'Bash', tool_input: { command }, tool_response: '', cwd } })
}

/** A repository whose `lib.ts` defines `alphaSym` on the original branch and `betaSym` on `feature`; it is left on the original branch. */
function repoWithTwoBranches(): { repo: string; original: string } {
  const repo = indexableDir()
  const lib = path.join(repo, 'lib.ts')
  fs.writeFileSync(lib, 'export function alphaSym(): number {\n  return 1\n}\n')
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'alpha')
  const original = git(repo, 'symbolic-ref', '--short', 'HEAD')
  git(repo, 'checkout', '-qb', 'feature')
  fs.writeFileSync(lib, 'export function betaSym(): number {\n  return 2\n}\n')
  git(repo, 'commit', '-qam', 'beta')
  git(repo, 'checkout', '-q', original)
  return { repo, original }
}

/** Index `lib.ts` through the production drain, so the index holds the original branch's symbol; mark the project indexed on purpose when asked. */
function indexOriginalBranch(repo: string, onPurpose: boolean): void {
  expect(enqueueDirtyPathsSafe([path.join(repo, 'lib.ts')])).toBe(1)
  drainOnce(dataDir())
  expect(querySymbols({ name: 'alphaSym' }).map((s) => foldPath(s.filePath))).toContain(foldPath(resolveIndexPath('lib.ts', repo)))
  if (onPurpose) recordIndexedRoot(repo)
}

function workerLog(): string {
  try {
    return fs.readFileSync(workerErrorLogPath(dataDir()), 'utf8')
  } catch {
    return ''
  }
}

function requestFile(): string {
  try {
    return fs.readFileSync(reconcileRequestPathFor(dataDir()), 'utf8')
  } catch {
    return ''
  }
}

/** Drain the way the daemon's loop does: cycles until the request is swept (a sweep that spends its time budget on a loaded machine puts its project back), then two more so what the sweep queued is indexed. */
async function drainTwice(): Promise<void> {
  for (let cycle = 0; cycle < 10; cycle++) {
    drainOnce(dataDir())
    if (requestFile() === '') break
  }
  drainOnce(dataDir())
  drainOnce(dataDir())
  await pendingEmbeddings()
}

beforeEach(() => {
  clearModuleCaches()
  clearDirtyQueue()
  fs.rmSync(reconcileRequestPathFor(dataDir()), { force: true })
  fs.rmSync(`${reconcileRequestPathFor(dataDir())}.draining`, { force: true })
  fs.rmSync(workerErrorLogPath(dataDir()), { force: true })
  seam.failReflog = false
  seam.reconcileBudgetMs = null
})

afterEach(() => {
  seam.failReflog = false
  seam.reconcileBudgetMs = null
})

describe('a head-moving git command whose changed-file list git could not produce', () => {
  it('records a reconcile request and a log line instead of dropping the work', async () => {
    const { repo } = repoWithTwoBranches()
    git(repo, 'checkout', '-q', 'feature')
    fs.rmSync(path.join(repo, '.git', 'logs'), { recursive: true, force: true })

    await postBashHandler(postBashEvent('git checkout feature', repo))

    expect(parseReconcileRequests(requestFile()).map(foldPath)).toEqual([foldPath(repo)])
    expect(getDirtyPaths(), 'a diff git refused must not enqueue guessed paths').toEqual([])
    expect(workerLog()).toMatch(/post-bash git checkout feature in .*could not list the files it changed.*asked the worker to reconcile/)
  })

  it('leaves the index on the new branch once the worker drains, on the real default path', async () => {
    const { repo } = repoWithTwoBranches()
    indexOriginalBranch(repo, true)
    git(repo, 'checkout', '-q', 'feature')
    fs.rmSync(path.join(repo, '.git', 'logs'), { recursive: true, force: true })

    await postBashHandler(postBashEvent('git checkout feature', repo))
    await drainTwice()

    const lib = foldPath(resolveIndexPath('lib.ts', repo))
    expect(querySymbols({ name: 'betaSym' }).map((s) => foldPath(s.filePath))).toContain(lib)
    expect(querySymbols({ name: 'alphaSym' }).map((s) => foldPath(s.filePath))).not.toContain(lib)
    expect(requestFile(), 'the swept request must not be left to run again').toBe('')
    expect(fs.existsSync(`${reconcileRequestPathFor(dataDir())}.draining`)).toBe(false)
  })

  it('does not reconcile a project that was never indexed on purpose', async () => {
    const { repo } = repoWithTwoBranches()
    indexOriginalBranch(repo, false)
    git(repo, 'checkout', '-q', 'feature')
    fs.rmSync(path.join(repo, '.git', 'logs'), { recursive: true, force: true })

    await postBashHandler(postBashEvent('git checkout feature', repo))
    await drainTwice()

    const lib = foldPath(resolveIndexPath('lib.ts', repo))
    expect(querySymbols({ name: 'alphaSym' }).map((s) => foldPath(s.filePath))).toContain(lib)
    expect(querySymbols({ name: 'betaSym' }).map((s) => foldPath(s.filePath))).not.toContain(lib)
    expect(workerLog()).toMatch(/was not indexed on purpose/)
    expect(requestFile()).toBe('')
  })

  it('asks for a reconcile and still enqueues the diff when only the reflog read timed out', async () => {
    const { repo } = repoWithTwoBranches()
    git(repo, 'merge', '-q', 'feature')
    seam.failReflog = true

    await postBashHandler(postBashEvent('git merge feature', repo))

    expect(getDirtyPaths().map(foldPath), 'the diff itself succeeded, so its paths are still enqueued').toContain(foldPath(resolveIndexPath('lib.ts', repo)))
    expect(parseReconcileRequests(requestFile()).map(foldPath)).toEqual([foldPath(repo)])
    expect(workerLog()).toMatch(/git reflog: timed out/)
  })

  it('records nothing when git answers, so the success path is unchanged', async () => {
    const { repo } = repoWithTwoBranches()
    git(repo, 'checkout', '-q', 'feature')

    await postBashHandler(postBashEvent('git checkout feature', repo))

    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('lib.ts', repo)))
    expect(requestFile()).toBe('')
    expect(workerLog()).toBe('')
  })
})

describe('draining reconcile requests', () => {
  it('sweeps a repository once however many spellings of it were requested', async () => {
    const { repo } = repoWithTwoBranches()
    indexOriginalBranch(repo, true)
    const sub = path.join(repo, 'sub')
    fs.mkdirSync(sub)
    for (const dir of [repo, repo, repo.toUpperCase(), sub]) appendReconcileRequest(dataDir(), dir)
    expect(parseReconcileRequests(requestFile()), 'case variants of one directory are one request on a case-insensitive filesystem').toHaveLength(process.platform === 'linux' ? 3 : 2)

    drainOnce(dataDir())

    expect(workerLog().match(/: swept /g) ?? [], 'the repo and its subdirectory resolve to one top-level and one sweep').toHaveLength(1)
  })

  it('drops a request whose directory is not a repository any more, and says so', () => {
    const gone = path.join(indexableDir(), 'removed-checkout')
    appendReconcileRequest(dataDir(), gone)

    expect(drainOnce(dataDir())).toBe(0)

    expect(workerLog()).toMatch(/dropped, git names no repository there/)
    expect(requestFile()).toBe('')
  })

  it('puts a project back when its sweep ran out of budget, and finishes it on the next cycle', async () => {
    const { repo } = repoWithTwoBranches()
    indexOriginalBranch(repo, true)
    git(repo, 'checkout', '-q', 'feature')
    appendReconcileRequest(dataDir(), repo)
    seam.reconcileBudgetMs = 0

    drainOnce(dataDir())

    expect(workerLog()).toMatch(/budget spent, continuing next cycle/)
    // git spells the top-level with forward slashes, so compare resolved paths.
    expect(parseReconcileRequests(requestFile()).map((p) => foldPath(path.resolve(p)))).toEqual([foldPath(path.resolve(repo))])
    seam.reconcileBudgetMs = null
    await drainTwice()
    expect(querySymbols({ name: 'betaSym' }).map((s) => foldPath(s.filePath))).toContain(foldPath(resolveIndexPath('lib.ts', repo)))
    expect(requestFile()).toBe('')
  })
})

describe('the reconcile-request file format', () => {
  it('reads back what was appended, skips lines that are not JSON strings, and keeps a path with a line break whole', () => {
    // PROVENANCE: HAND-DERIVED. Lines are what appendReconcileRequest wrote plus three a person could have left: a bare word, a JSON number and an empty string.
    const odd = path.join(indexableDir(), 'with\nbreak')
    appendReconcileRequest(dataDir(), odd)
    const raw = `${requestFile()}not-json\n42\n""\n`
    expect(parseReconcileRequests(raw)).toEqual([odd])
    expect(globalDbPath()).toContain(dataDir())
  })
})
