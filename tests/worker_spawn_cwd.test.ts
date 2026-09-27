/** Regression: `startDetachedWorker` spawned the daemon with no `cwd`, so the long-lived process inherited the working directory of whichever hook happened to start it (`ensureWorkerAlive` runs on every edit and index event). On Windows a working directory is an open handle, so a hook fired inside a temporary directory -- an evaluation harness's per-run copy of a project -- left that directory undeletable until the daemon died. The daemon must be started in the temp directory instead, where the hook server also sits. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Replaced with vi.mock rather than spied: Node's ESM namespace bindings for a builtin are not configurable. The fake child is all startDetachedWorker touches (pid, unref, its error listener); nothing is really started.
const state = vi.hoisted(() => ({
  child: { pid: 4242425, unref: (): void => undefined, on: (): void => undefined },
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(() => state.child) }
})

import { spawn } from 'node:child_process'
import { startDetachedWorker } from '../src/worker_lifecycle.js'

const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const

let trigger: string
let dataDir: string
let originalCwd: string
let savedTemp: Record<string, string | undefined>

beforeEach(() => {
  originalCwd = process.cwd()
  savedTemp = Object.fromEntries(TEMP_KEYS.map((k) => [k, process.env[k]]))
  // The directory a hook would be running in: a throwaway working copy the caller means to delete.
  trigger = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spawn-trigger-')))
  dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spawn-data-')))
  process.chdir(trigger)
  vi.mocked(spawn).mockClear()
})

afterEach(() => {
  process.chdir(originalCwd)
  for (const k of TEMP_KEYS) {
    if (savedTemp[k] === undefined) delete process.env[k]
    else process.env[k] = savedTemp[k]
  }
  fs.rmSync(trigger, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function spawnOptions(): { cwd?: unknown; env?: NodeJS.ProcessEnv } {
  expect(spawn).toHaveBeenCalledTimes(1)
  return vi.mocked(spawn).mock.calls[0]?.[2] as { cwd?: unknown; env?: NodeJS.ProcessEnv }
}

describe('startDetachedWorker working directory', () => {
  it('starts the daemon in the temp directory, not in the directory of the process that asked for it', () => {
    startDetachedWorker({ dataDir })
    const opts = spawnOptions()
    expect(opts.cwd).toBe(os.tmpdir())
    expect(opts.cwd).not.toBe(process.cwd())
    expect(opts.env?.['TG_WORKER_DATA_DIR']).toBe(dataDir)
  })

  // A spawn into a directory that does not exist starts nothing, so a stale TEMP must not cost the user their worker.
  it('starts the daemon in its data directory when the temp directory is gone', () => {
    const gone = path.join(trigger, 'deleted-temp')
    for (const k of TEMP_KEYS) process.env[k] = gone
    startDetachedWorker({ dataDir })
    expect(spawnOptions().cwd).toBe(dataDir)
  })

  it('hands the daemon an absolute data directory, since a relative one would name a different directory from where the daemon starts', () => {
    startDetachedWorker({ dataDir: 'relative-data' })
    expect(spawnOptions().env?.['TG_WORKER_DATA_DIR']).toBe(path.join(trigger, 'relative-data'))
  })
})
