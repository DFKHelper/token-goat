// Provenance: HAND-DERIVED. The empty command line is the answer src/resident_process.ts::queryProcessCommandLine documents for a process that exists but whose command line the system will not show (the doc comment of CommandLineQuery names it); the EPERM denial is planted by tests/helpers/denied_worker.ts from kill(2); the exit code is the one src/cli.ts::guard sets for a thrown CliError.
/** A live worker whose command line Windows hides (an elevated worker asked from a normal shell) is an unknown, not a stranger: the stop makes its single kill, and when that is denied it keeps the pid file, says the worker is left running and exits 1. */
import * as fs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { performUpgrade } from '../src/cli_upgrade.js'
import { dataDir } from '../src/constants.js'
import type * as ResidentProcess from '../src/resident_process.js'
import { stopWorkerDetailed, workerLeftRunningNote, workerPidPath } from '../src/worker_lifecycle.js'
import { DENIED_WORKER_PID, plantDeniedWorker } from './helpers/denied_worker.js'
import { runCliExitCode } from './helpers/run-cli.js'
import { spyOnWrite } from './setup/spy-stdio.js'

// The process exists and the system shows no command line for it: the `found` answer with an empty line.
vi.mock('../src/resident_process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ResidentProcess>()
  return { ...actual, queryProcessCommandLine: () => ({ status: 'found', commandLine: '' }) }
})

let undo: (() => void) | null = null

afterEach(() => {
  undo?.()
  undo = null
  vi.restoreAllMocks()
})

describe('a live worker whose command line the system hides', () => {
  it('is not read as another program: the denied stop reports it left running and keeps its pid file', () => {
    undo = plantDeniedWorker(dataDir())
    const result = stopWorkerDetailed(dataDir(), undefined, { queryCommandLine: () => ({ status: 'found', commandLine: '' }) })
    expect(result, 'a found process with an empty command line was read as a stranger and its pid file dropped').toEqual({ stopped: false, leftRunning: DENIED_WORKER_PID })
    expect(fs.existsSync(workerPidPath(dataDir())), 'the pid file of a worker left running was removed').toBe(true)
  })

  it('makes `worker stop` exit 1 with the note and keeps the pid file', async () => {
    undo = plantDeniedWorker(dataDir())
    const stdout: string[] = []
    const stderr: string[] = []
    spyOnWrite(process.stdout, stdout)
    spyOnWrite(process.stderr, stderr)
    const code = await runCliExitCode(['worker', 'stop'])
    vi.restoreAllMocks()
    expect(code, 'worker stop exited with a success code though the worker kept running').toBe(1)
    expect(stderr.join(''), 'the left-running note was not on stderr').toContain(workerLeftRunningNote(DENIED_WORKER_PID))
    expect(fs.existsSync(workerPidPath(dataDir())), 'the pid file of a worker left running was removed').toBe(true)
  })

  it('makes the upgrade print the note and carry on', async () => {
    undo = plantDeniedWorker(dataDir())
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const onSync = vi.fn(async () => undefined)
    const result = await performUpgrade(onSync, { file: process.execPath, prefix: ['-e', 'process.exit(0)', '--'] })
    vi.restoreAllMocks()
    expect(errors.join('\n'), 'the upgrade did not say the hidden worker kept running').toContain(workerLeftRunningNote(DENIED_WORKER_PID))
    expect(result, 'the install did not go on after the denied stop').toEqual({ ok: true })
  })
})
