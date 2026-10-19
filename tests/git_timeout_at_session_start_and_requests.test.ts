// Provenance: HAND-DERIVED. A killed git is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node 24.12 ETIMEDOUT CAPTURE documented at src/util.ts::runGit); `rev-parse --show-toplevel` prints the top-level path and exits 0. Which caller reads which field is the contract under test. The git boundary (runGit for session start, runGitAsyncLazy for the worker's drain) is replaced by a function this file controls, because a real git cannot be made slow on an event on every platform; the real-git side of the timeout is tests/run_git_default_timeout.test.ts.
/** A killed `git ls-files` is unknown, never "nothing drifted": session start must not stay silent over it, and a reconcile request whose sweep could not list the files must not be spent. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as util from '../src/util.js'
import { tempConfigPath } from './helpers/temp-config.js'

const git = vi.hoisted(() => ({ answer: (_args: readonly string[]): unknown => undefined as unknown }))
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof util>()
  return { ...actual, runGit: (args: string[]) => git.answer(args), runGitAsyncLazy: async (args: string[]) => git.answer(args) }
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

const _testConfigPath = tempConfigPath('tg-git-timeout-session-config.toml')
const _testDataDir = tempConfigPath('tg-git-timeout-session-data')
const _testDbPath = path.join(_testDataDir, 'global.db')

import { invalidateConfigCache } from '../src/config.js'
import { closeAllDbs } from '../src/db.js'
import { appendReconcileRequest, parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import type { HookEvent } from '../src/hook_registry.js'
import { sessionStartHandler } from '../src/hooks_session_start.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { drainReconcileRequestsAsync } from '../src/reconcile_requests.js'
import { clearModuleCaches } from '../src/reset.js'

const KILLED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, timedOut: true }
const REFUSED: GitResult = { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
const ok = (stdout: string): GitResult => ({ stdout, stderr: '', exitCode: 0 })

let projectDir = ''

function makeEvent(cwd: string): HookEvent {
  return { eventName: 'session_start', toolName: undefined, toolInput: {}, sessionId: 'test-session', agentId: undefined, raw: { cwd } }
}

beforeEach(() => {
  closeAllDbs()
  clearModuleCaches()
  invalidateConfigCache()
  fs.rmSync(_testDataDir, { recursive: true, force: true })
  fs.mkdirSync(_testDataDir, { recursive: true })
  projectDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-timeout-session-')))
  recordIndexedRoot(projectDir, _testDbPath)
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(_testDataDir, { recursive: true, force: true })
  fs.rmSync(_testConfigPath, { force: true })
})

describe('session start when git does not finish listing the files', () => {
  it('says the drift check could not find new files, where a refused listing stays silent', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? KILLED : REFUSED)
    const killed = await sessionStartHandler(makeEvent(projectDir))
    expect(killed.hookType).toBe('context')
    if (killed.hookType === 'context') expect(killed.context).toMatch(/git did not answer in time/)

    git.answer = () => REFUSED
    const refused = await sessionStartHandler(makeEvent(projectDir))
    if (refused.hookType === 'context') expect(refused.context).not.toMatch(/git did not answer in time/)
  })
})

describe('a reconcile request whose sweep git could not list', () => {
  // An absent file is an empty list, so a dropped request fails the assertion that expects it back instead of throwing ENOENT; any other read error still throws.
  const requested = (): string[] => {
    try {
      return parseReconcileRequests(fs.readFileSync(reconcileRequestPathFor(_testDataDir), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  it('goes back for the next cycle when ls-files is killed', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? KILLED : ok(`${projectDir}\n`))
    appendReconcileRequest(_testDataDir, projectDir)
    expect(await drainReconcileRequestsAsync(_testDataDir)).toBe(1)
    expect(requested()).toEqual([projectDir])
  })

  it('goes back for the next cycle when rev-parse is killed, and is dropped when git names no repository', async () => {
    git.answer = (args) => (args[0] === 'rev-parse' ? KILLED : ok(''))
    appendReconcileRequest(_testDataDir, projectDir)
    expect(await drainReconcileRequestsAsync(_testDataDir)).toBe(0)
    expect(requested()).toEqual([projectDir])

    fs.rmSync(reconcileRequestPathFor(_testDataDir), { force: true })
    git.answer = () => REFUSED
    appendReconcileRequest(_testDataDir, projectDir)
    expect(await drainReconcileRequestsAsync(_testDataDir)).toBe(0)
    expect(fs.existsSync(reconcileRequestPathFor(_testDataDir))).toBe(false)
  })

  it('is spent when git ran and listed nothing', async () => {
    git.answer = (args) => (args[0] === 'ls-files' ? ok('') : ok(`${projectDir}\n`))
    appendReconcileRequest(_testDataDir, projectDir)
    expect(await drainReconcileRequestsAsync(_testDataDir)).toBe(1)
    expect(fs.existsSync(reconcileRequestPathFor(_testDataDir))).toBe(false)
  })
})
