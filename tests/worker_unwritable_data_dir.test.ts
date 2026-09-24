import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'
import type * as FsModule from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Both builtins are replaced with vi.mock rather than spied: Node's ESM namespace bindings for a builtin are not configurable, so vi.spyOn(fs, 'writeFileSync') throws. State lives in vi.hoisted so the hoisted factories and the tests share it; with `refuse` null the fs mock is a pass-through.
const state = vi.hoisted(() => ({
  refuse: null as ((p: string) => boolean) | null,
  child: { pid: 4242424, unref: (): void => undefined },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>): void => {
    const p = String(args[0])
    if (state.refuse?.(p)) {
      // FORMAT-DERIVED: the shape of the error Node's fs raises for a write the OS refuses (libuv's uvException: message `EACCES: permission denied, open '<path>'`, with code, errno, syscall and path set).
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES', errno: -13, syscall: 'open', path: p })
    }
    actual.writeFileSync(...args)
  }
  return { ...actual, writeFileSync, default: { ...actual, writeFileSync } }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(() => state.child) }
})

import { spawn } from 'node:child_process'
import { WorkerDataDirUnwritableError, ensureWorkerAlive, startDetachedWorker, workerPidPath } from '../src/worker.js'
import { checkWorker } from '../src/cli_doctor.js'

let dir: string
let savedNoSpawn: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-unwritable-'))
  state.refuse = null
  state.child = { pid: 4242424, unref: vi.fn() }
  vi.mocked(spawn).mockClear()
  savedNoSpawn = process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
})

afterEach(() => {
  state.refuse = null
  vi.restoreAllMocks()
  if (savedNoSpawn === undefined) delete process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
  else process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = savedNoSpawn
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Refuse every write into `dir`, the way a directory mode 0555 or an ACL denying the user does. */
function refuseWritesUnder(target: string): void {
  state.refuse = (p) => path.resolve(p).startsWith(path.resolve(target) + path.sep)
}

describe('a worker whose data directory refuses writes', () => {
  // Regression: the pid-file claim was the first write, and it ran after the spawn, so an unwritable directory threw there with a daemon already running and still referenced by the parent. `worker start` then hung on that reference and the daemon had no pid file for `worker stop` to find.
  it('is refused before anything is spawned, with an error naming the directory', () => {
    refuseWritesUnder(dir)
    let thrown: unknown
    try {
      startDetachedWorker({ dataDir: dir })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(WorkerDataDirUnwritableError)
    expect((thrown as Error).message).toContain(dir)
    expect((thrown as Error).message).toContain('EACCES')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('kills and lets go of a daemon whose pid-file claim throws after the spawn', () => {
    // The probe write passes and only the pid file is refused: the directory turning unwritable between the two, which the pre-check cannot rule out.
    const pidPath = path.resolve(workerPidPath(dir))
    state.refuse = (p) => path.resolve(p) === pidPath
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(() => startDetachedWorker({ dataDir: dir })).toThrow(/EACCES/)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(4242424)
    expect(state.child.unref).toHaveBeenCalled()
  })

  it('is not respawned by the hook auto-restart', () => {
    delete process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
    refuseWritesUnder(dir)
    ensureWorkerAlive(dir)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('is reported by doctor as unable to start, not merely stopped', () => {
    refuseWritesUnder(dir)
    const result = checkWorker(dir)
    expect(result.status).toBe('fail')
    expect(result.message).toContain('cannot start')
    expect(result.message).toContain('EACCES')
  })

  it('is reported by doctor as merely stopped when the directory takes writes', () => {
    expect(checkWorker(dir)).toEqual({ name: 'Worker', status: 'warn', message: 'not running' })
  })
})
