// Provenance: HAND-DERIVED. The denied worker is planted by tests/helpers/denied_worker.ts from kill(2)'s documented EPERM; the stand-in npm is `node -e "process.exit(0)" -- <argv>`, which exits 0 for any argv and prints nothing, so no real npm runs and `npm root -g` names no new copy.
/** `performUpgrade` when the operating system denies ending the old worker: the install is replaced under a live worker, so the upgrade says so and goes on. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dataDir } from '../src/constants.js'
import type * as ResidentProcess from '../src/resident_process.js'
import { performUpgrade } from '../src/cli_upgrade.js'
import { daemonEntryScript, workerLeftRunningNote } from '../src/worker_lifecycle.js'
import { DENIED_WORKER_PID, plantDeniedWorker } from './helpers/denied_worker.js'
import { workerCommandLine } from './helpers/worker_identity.js'

// The identity lookup stopWorker makes before it ends a pid-file pid: the planted pid is not a real process, so the lookup reports the command line a worker daemon has. The line is set per test, after the modules are loaded, because building it needs worker_lifecycle.ts, which imports this module.
const identity = vi.hoisted(() => ({ commandLine: '' }))
vi.mock('../src/resident_process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ResidentProcess>()
  return { ...actual, queryProcessCommandLine: () => ({ status: 'found', commandLine: identity.commandLine }) }
})

let undo: (() => void) | null = null

afterEach(() => {
  undo?.()
  undo = null
  vi.restoreAllMocks()
})

describe('performUpgrade when the operating system denies ending the worker', () => {
  it('names the worker it could not stop, and carries on with the install', async () => {
    identity.commandLine = workerCommandLine(daemonEntryScript())
    undo = plantDeniedWorker(dataDir())
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const onSync = vi.fn(async () => undefined)
    const result = await performUpgrade(onSync, { file: process.execPath, prefix: ['-e', 'process.exit(0)', '--'] })
    vi.restoreAllMocks()
    expect(errors.join('\n'), 'the upgrade did not say the denied worker kept running').toContain(workerLeftRunningNote(DENIED_WORKER_PID))
    expect(errors.join('\n'), 'the upgrade did not say it carries on').toContain('The upgrade continues')
    expect(result, 'the install did not go on after the denied stop').toEqual({ ok: true })
    expect(onSync).toHaveBeenCalledTimes(1)
  })
})
