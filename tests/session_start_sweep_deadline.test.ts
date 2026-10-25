// Provenance: HAND-DERIVED. A killed git is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node 24.12 ETIMEDOUT CAPTURE documented at src/util.ts::runGit). The git boundary (runGit for session start, runGitAsyncLazy for the worker's drain) is replaced by one scripted answer; everything above it is real.
/** Session start must not wait on `git ls-files` past its deadline, and must not repeat a complete sweep minutes after the last one; the work it does not do in the hook still happens in the worker. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as util from '../src/util.js'
import { indexableDir, tempConfigPath } from './helpers/temp-config.js'

const git = vi.hoisted(() => ({
  answer: (_args: readonly string[]): unknown => undefined as unknown,
  lsFilesCalls: [] as Array<number | undefined>,
}))
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof util>()
  const answer = (args: readonly string[], timeoutMs?: number): unknown => {
    if (args[0] === 'ls-files') git.lsFilesCalls.push(timeoutMs)
    return git.answer(args)
  }
  return {
    ...actual,
    runGit: (args: string[], opts?: { timeoutMs?: number }) => answer(args, opts?.timeoutMs),
    runGitAsyncLazy: async (args: string[], opts?: { timeoutMs?: number }) => answer(args, opts?.timeoutMs),
  }
})

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    globalDbPath: () => _testDbPath,
    dataDir: () => _testDataDir,
  }
})

const _testConfigPath = tempConfigPath('tg-sweep-deadline-config.toml')
const _testDataDir = tempConfigPath('tg-sweep-deadline-data')
const _testDbPath = path.join(_testDataDir, 'global.db')

import { invalidateConfigCache } from '../src/config.js'
import { closeAllDbs } from '../src/db.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import type { HookEvent } from '../src/hook_registry.js'
import { SESSION_START_LISTING_DEADLINE_MS, sessionStartHandler } from '../src/hooks_session_start.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { resolveIndexPath } from '../src/paths.js'
import { reconcileProject } from '../src/reconcile.js'
import { drainReconcileRequestsAsync } from '../src/reconcile_requests.js'
import { SESSION_SWEEP_REUSE_MS, SLOW_LISTING_MEMORY_MS, listingKnownSlow, markListingSlow, sweptRecently, writeSweepStamp } from '../src/reconcile_stamp.js'
import { clearModuleCaches } from '../src/reset.js'

const KILLED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, unfinished: true, timedOut: true }
const ok = (stdout: string): GitResult => ({ stdout, stderr: '', unfinished: false, exitCode: 0 })

let projectDir = ''
let root = ''

function makeEvent(cwd: string): HookEvent {
  return { eventName: 'session_start', toolName: undefined, toolInput: {}, sessionId: 'test-session', agentId: undefined, raw: { cwd } }
}

async function contextOf(): Promise<string> {
  const out = await sessionStartHandler(makeEvent(projectDir))
  return out.hookType === 'context' ? out.context : ''
}

function requested(): string[] {
  try {
    return parseReconcileRequests(fs.readFileSync(reconcileRequestPathFor(_testDataDir), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

beforeEach(() => {
  closeAllDbs()
  clearModuleCaches()
  invalidateConfigCache()
  git.lsFilesCalls = []
  fs.rmSync(_testDataDir, { recursive: true, force: true })
  fs.mkdirSync(_testDataDir, { recursive: true })
  projectDir = fs.realpathSync.native(indexableDir())
  root = resolveIndexPath('.', projectDir)
  fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(projectDir, 'b.ts'), 'export const b = 2\n')
  recordIndexedRoot(projectDir, _testDbPath)
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(_testDataDir, { recursive: true, force: true })
  fs.rmSync(_testConfigPath, { force: true })
})

describe('the listing deadline at session start', () => {
  it('bounds the ls-files spawn and hands a listing that missed it to the worker', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? KILLED : ok(`${projectDir}\n`))
    const context = await contextOf()
    expect(git.lsFilesCalls).toEqual([SESSION_START_LISTING_DEADLINE_MS])
    expect(context).toMatch(/git did not answer in time/)
    expect(context).toMatch(/background worker is finishing the check/)
    expect(requested()).toEqual([projectDir])
    expect(sweptRecently(root, _testDbPath)).toBe(false)
  })

  it('does the handed-over sweep in the worker, which then stands in for the next session', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? KILLED : ok(`${projectDir}\n`))
    await contextOf()
    git.answer = (args) => (args[0] === 'ls-files' ? ok('a.ts\nb.ts\n') : ok(`${projectDir}\n`))
    git.lsFilesCalls = []
    expect(await drainReconcileRequestsAsync(_testDataDir)).toBe(1)
    expect(git.lsFilesCalls.length).toBe(1)
    expect(requested()).toEqual([])
    expect(sweptRecently(root, _testDbPath)).toBe(true)
    git.lsFilesCalls = []
    await contextOf()
    expect(git.lsFilesCalls).toEqual([])
  })
})

describe('a project whose listing missed the deadline', () => {
  it('goes straight to the worker on the next sweepless session, and tries git again once the memory ages out', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? KILLED : ok(`${projectDir}\n`))
    await contextOf()
    expect(listingKnownSlow(root, _testDbPath)).toBe(true)
    expect(git.lsFilesCalls.length).toBe(1)

    const second = await contextOf()
    expect(git.lsFilesCalls.length).toBe(1)
    expect(second).toMatch(/running in the background worker/)
    expect(requested()).toEqual([projectDir])

    markListingSlow(root, _testDbPath, Date.now() - SLOW_LISTING_MEMORY_MS - 1000)
    git.answer = (args) => (args[0] === 'ls-files' ? ok('a.ts\nb.ts\n') : ok(`${projectDir}\n`))
    await contextOf()
    expect(git.lsFilesCalls.length).toBe(2)
    expect(listingKnownSlow(root, _testDbPath)).toBe(false)
  })

  it('lists for itself when the worker request cannot be recorded', async () => {
    markListingSlow(root, _testDbPath)
    fs.mkdirSync(reconcileRequestPathFor(_testDataDir), { recursive: true })
    git.answer = (args) => (args[0] === 'ls-files' ? ok('a.ts\nb.ts\n') : ok(`${projectDir}\n`))
    await contextOf()
    expect(git.lsFilesCalls.length).toBe(1)
  })
})

describe('a complete sweep standing in for the next one', () => {
  it('skips the listing inside the window and sweeps again after it', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? ok('a.ts\nb.ts\n') : ok(`${projectDir}\n`))
    const first = await contextOf()
    expect(first).toMatch(/changed outside this session/)
    expect(git.lsFilesCalls.length).toBe(1)
    expect(sweptRecently(root, _testDbPath)).toBe(true)

    const second = await contextOf()
    expect(git.lsFilesCalls.length).toBe(1)
    expect(second).not.toMatch(/changed outside this session/)

    writeSweepStamp(_testDbPath, root, Date.now() - SESSION_SWEEP_REUSE_MS - 1000)
    await contextOf()
    expect(git.lsFilesCalls.length).toBe(2)
  })

  it('is not recorded by a budget-truncated sweep, an unfinished listing, an empty listing or a dry run', () => {
    git.answer = () => ok('a.ts\nb.ts\n')
    const truncated = reconcileProject({ cwd: projectDir, dbPath: _testDbPath, budgetMs: 0 })
    expect(truncated.budgetExhausted).toBe(true)
    expect(sweptRecently(root, _testDbPath)).toBe(false)

    git.answer = () => KILLED
    reconcileProject({ cwd: projectDir, dbPath: _testDbPath })
    expect(sweptRecently(root, _testDbPath)).toBe(false)

    git.answer = () => ok('')
    reconcileProject({ cwd: projectDir, dbPath: _testDbPath })
    expect(sweptRecently(root, _testDbPath)).toBe(false)

    git.answer = () => ok('a.ts\nb.ts\n')
    reconcileProject({ cwd: projectDir, dbPath: _testDbPath, dryRun: true })
    expect(sweptRecently(root, _testDbPath)).toBe(false)

    reconcileProject({ cwd: projectDir, dbPath: _testDbPath })
    expect(sweptRecently(root, _testDbPath)).toBe(true)
  })

  it('is ignored, with a slow-listing mark, when TOKEN_GOAT_RECONCILE_MEMORY_MS is 0', () => {
    writeSweepStamp(_testDbPath, root)
    markListingSlow(root, _testDbPath)
    expect(sweptRecently(root, _testDbPath)).toBe(true)
    expect(listingKnownSlow(root, _testDbPath)).toBe(true)
    vi.stubEnv('TOKEN_GOAT_RECONCILE_MEMORY_MS', '0')
    try {
      expect(sweptRecently(root, _testDbPath)).toBe(false)
      expect(listingKnownSlow(root, _testDbPath)).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is not recorded when the queue refused the drift the sweep found', () => {
    const refusing = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sweep-refused-')))
    try {
      fs.writeFileSync(path.join(refusing, 'a.ts'), 'export const a = 1\n')
      git.answer = () => ok('a.ts\n')
      const result = reconcileProject({ cwd: refusing, dbPath: _testDbPath })
      expect(result.added.length, 'the fixture found no drift, so the refusal proves nothing').toBe(1)
      expect(result.enqueued, 'the queue takes nothing under the OS temp dir').toBe(0)
      expect(sweptRecently(resolveIndexPath('.', refusing), _testDbPath)).toBe(false)
    } finally {
      fs.rmSync(refusing, { recursive: true, force: true })
    }
  })

  it('reads a missing, aged or future-dated stamp as not recent', () => {
    const now = Date.now()
    expect(sweptRecently(root, _testDbPath, now)).toBe(false)
    writeSweepStamp(_testDbPath, root, now - SESSION_SWEEP_REUSE_MS + 1000)
    expect(sweptRecently(root, _testDbPath, now)).toBe(true)
    writeSweepStamp(_testDbPath, root, now - SESSION_SWEEP_REUSE_MS)
    expect(sweptRecently(root, _testDbPath, now)).toBe(false)
    writeSweepStamp(_testDbPath, root, now + 60_000)
    expect(sweptRecently(root, _testDbPath, now)).toBe(false)
  })
})
