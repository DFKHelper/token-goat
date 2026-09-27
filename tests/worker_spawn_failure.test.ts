/** Regression: a daemon spawn that cannot start (its working directory or the Node executable gone) does not throw. Node returns a child with no pid and emits the cause as an 'error' event after `spawn` has returned. `startDetachedWorker` turned the missing pid into a throw, which `ensureWorkerAlive` catches and logs, but nothing listened for the event, and an 'error' event nobody hears is thrown as an uncaught exception, outside that try/catch. So an edit or index hook that happened to trigger the auto-restart crashed instead of failing open. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Replaced with vi.mock rather than spied: Node's ESM namespace bindings for a builtin are not configurable. The factory hands out whatever child the current test put in `state`.
const state = vi.hoisted(() => ({ child: null as unknown }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(() => state.child) }
})

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { ensureWorkerAlive, workerPidPath } from '../src/worker_lifecycle.js'

/** What `spawn` returns for a process that never started: no pid, and the cause still to come as an 'error' event. */
class FailedChild extends EventEmitter {
  readonly pid = undefined
  unref(): void {}
}

const enoent = (): Error => Object.assign(new Error(`spawn ${process.execPath} ENOENT`), { code: 'ENOENT', errno: -4058, syscall: `spawn ${process.execPath}` })

let dir: string
let savedNoSpawn: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spawn-fail-'))
  state.child = new FailedChild()
  vi.mocked(spawn).mockClear()
  // isolate-home.ts turns the auto-restart off suite-wide; this file is about exactly that path.
  savedNoSpawn = process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
  delete process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
})

afterEach(() => {
  if (savedNoSpawn === undefined) delete process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
  else process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = savedNoSpawn
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a worker spawn that fails after returning', () => {
  it('does not crash the hook whose auto-restart started it, and leaves the failure in the worker log', () => {
    expect(() => ensureWorkerAlive(dir)).not.toThrow()
    expect(spawn).toHaveBeenCalledTimes(1)
    // Delivered after the call returned, as Node delivers it: with no listener, emit throws, which in a hook process is an uncaught exception.
    expect(() => (state.child as FailedChild).emit('error', enoent())).not.toThrow()
    expect(fs.readFileSync(path.join(dir, 'worker-errors.log'), 'utf8')).toContain('spawn produced no pid')
    expect(fs.existsSync(workerPidPath(dir))).toBe(false)
  })

  it('is tried again by the next health check once the rate limit has passed', () => {
    ensureWorkerAlive(dir)
    ;(state.child as FailedChild).emit('error', enoent())
    // Age the rate-limit marker past its five-minute interval rather than deleting it, so the retry is the one a later hook would really make.
    const marker = path.join(dir, 'worker-healthcheck.marker')
    const past = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(marker, past, past)
    state.child = new FailedChild()
    ensureWorkerAlive(dir)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(() => (state.child as FailedChild).emit('error', enoent())).not.toThrow()
  })
})
