/** Regression: the hook client autostarted `hook-server run` with no `cwd`, so the resident server began life in the directory of whichever hook call started it. The server moves itself to the temp directory at startup (hook_server.ts, `process.chdir(os.tmpdir())`), but until that line runs a hook fired inside a throwaway directory holds it open, and on Windows an open working directory cannot be deleted. The spawn itself must name the temp directory, so no window exists at all. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'
import type * as HookIpcModule from '../src/hook_ipc.js'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Under vitest the client runs from src/, where no built launcher sits beside it and startServer returns before spawning. Only the launcher path is redirected, to a file that exists; the spawn is faked so nothing really starts.
const state = vi.hoisted(() => ({
  launcher: '',
  child: null as unknown,
}))

vi.mock('../src/hook_ipc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HookIpcModule>()
  return { ...actual, launcherPath: (): string => state.launcher }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(() => state.child) }
})

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { callServer } from '../src/hook_client.js'
import { markerPath } from '../src/hook_ipc.js'

/** The fake child: an emitter, so a test can deliver the 'error' event a real failed spawn emits after `spawn` returns. */
class FakeChild extends EventEmitter {
  unref(): void {}
}

let trigger: string
let originalCwd: string
let savedServerEnv: string | undefined

beforeEach(() => {
  originalCwd = process.cwd()
  savedServerEnv = process.env['TOKEN_GOAT_HOOK_SERVER']
  process.env['TOKEN_GOAT_HOOK_SERVER'] = '1'
  trigger = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hs-trigger-')))
  state.launcher = path.join(trigger, 'token-goat.mjs')
  fs.writeFileSync(state.launcher, '')
  process.chdir(trigger)
  state.child = new FakeChild()
  // The autostart is rate-limited per slot by this marker; each test here needs its own start.
  fs.rmSync(markerPath('spawn-0'), { force: true })
  vi.mocked(spawn).mockClear()
})

afterEach(() => {
  process.chdir(originalCwd)
  if (savedServerEnv === undefined) delete process.env['TOKEN_GOAT_HOOK_SERVER']
  else process.env['TOKEN_GOAT_HOOK_SERVER'] = savedServerEnv
  fs.rmSync(trigger, { recursive: true, force: true })
})

describe('hook server autostart working directory', () => {
  it('starts the server in the temp directory, not in the directory of the hook that asked for it', async () => {
    // No server key exists in this file's fresh data directory, so the call dispatches nothing and starts slot 0.
    expect(await callServer({ kind: 'status' })).toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [, argv, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { cwd?: unknown }]
    expect(argv).toEqual([state.launcher, 'hook-server', 'run', '--slot', '0'])
    expect(opts.cwd).toBe(os.tmpdir())
    expect(opts.cwd).not.toBe(process.cwd())
  })

  // A spawn whose cwd is missing (TEMP naming a deleted directory) does not throw: Node returns a child with no pid and emits ENOENT on it afterwards. An 'error' event nobody listens for is thrown, which in a real hook process is an uncaught exception.
  it('does not let a server that fails to start take the hook call down with it', async () => {
    expect(await callServer({ kind: 'status' })).toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(1)
    const child = state.child as FakeChild
    const enoent = Object.assign(new Error(`spawn ${process.execPath} ENOENT`), { code: 'ENOENT' })
    expect(() => child.emit('error', enoent)).not.toThrow()
  })
})
