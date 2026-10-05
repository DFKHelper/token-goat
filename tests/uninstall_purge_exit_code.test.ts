/** `uninstall --purge` exits nonzero when the purge did not happen. runPurge used to return nothing, so a refusal (the worker is running) and a directory that would not delete both printed their error and still exited 0, and a script checking `$?` took a purge that never ran for one that did. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HookClient from '../src/hook_client.js'
import type * as Purge from '../src/purge.js'
import type * as WorkerLifecycle from '../src/worker_lifecycle.js'
import { BUNDLE } from './helpers/bundle.js'

const state = vi.hoisted(() => ({ workerRunning: false, failed: [] as Array<{ path: string; reason: string }> }))

vi.mock('../src/worker_lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerLifecycle>()
  return { ...actual, isWorkerRunning: () => state.workerRunning }
})
vi.mock('../src/hook_client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HookClient>()
  return { ...actual, queryServers: () => Promise.resolve([]) }
})
vi.mock('../src/purge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Purge>()
  return { ...actual, purgeDataDirectories: () => ({ removed: [], absent: [], failed: state.failed }) }
})

const { runPurge } = await import('../src/cli_install.js')
const { dataDirForHome } = await import('../src/constants.js')
const { drainHeartbeatPathFor, workerPidPath } = await import('../src/worker_lifecycle.js')

let stderr: string[] = []
beforeEach(() => {
  stderr = []
  state.workerRunning = false
  state.failed = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('runPurge exit code', () => {
  it('returns 1 when it refuses because the worker is running', async () => {
    state.workerRunning = true
    expect(await runPurge()).toBe(1)
    expect(stderr.join('')).toMatch(/^token-goat: the background worker is running/)
  })

  it('returns 1 when a data directory would not delete', async () => {
    // HAND-DERIVED: the shape purgeDataDirectories reports a failed rmSync in (src/purge.ts), with an EBUSY reason as Windows gives for a held file.
    state.failed = [{ path: path.join(os.tmpdir(), 'tg-purge-held'), reason: 'EBUSY: resource busy or locked' }]
    expect(await runPurge()).toBe(1)
    expect(stderr.join('')).toMatch(/^token-goat: could not purge /)
  })

  it('returns 0 when every directory went', async () => {
    expect(await runPurge()).toBe(0)
    expect(stderr.join('')).toBe('')
  })
})

describe('uninstall --purge through the built bundle', () => {
  it('exits 1 and leaves the data directory in place while the worker is running', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-purge-exit-')))
    try {
      const dataDir = dataDirForHome(base)
      const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
      // A live pid (this test process) plus a fresh heartbeat naming it is what isWorkerRunning reads as a running worker, so no worker has to be spawned.
      fs.mkdirSync(path.dirname(workerPidPath(dataDir)), { recursive: true })
      fs.writeFileSync(workerPidPath(dataDir), String(process.pid))
      fs.mkdirSync(path.dirname(drainHeartbeatPathFor(dataDir)), { recursive: true })
      fs.writeFileSync(drainHeartbeatPathFor(dataDir), `${process.pid}\n`)
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: base,
        USERPROFILE: base,
        LOCALAPPDATA: envRoot,
        XDG_DATA_HOME: envRoot,
        APPDATA: path.join(base, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: path.join(base, '.config'),
        CLAUDE_CONFIG_DIR: path.join(base, '.claude'),
        COPILOT_HOME: path.join(base, '.copilot'),
        CODEX_HOME: path.join(base, '.codex'),
        KIMI_CODE_HOME: path.join(base, '.kimi'),
        TOKEN_GOAT_HOME: path.join(base, 'tg-home'),
        TOKEN_GOAT_HOOK_SERVER: '0',
        TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      }
      const res = spawnSync(process.execPath, [BUNDLE, 'uninstall', '--purge'], { cwd: base, env, encoding: 'utf8', timeout: 60_000 })
      expect(res.status, res.stderr).toBe(1)
      expect(res.stderr).toContain('token-goat: the background worker is running')
      expect(fs.existsSync(dataDir)).toBe(true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
