// Provenance: HAND-DERIVED. The exit code is the one src/cli.ts::guard sets for a thrown CliError (a token-goat: line on stderr, exit 1); the denied worker is planted by tests/helpers/denied_worker.ts from kill(2)'s documented EPERM.
/** `worker stop` against a worker the operating system will not let it end: the stop did not stop, so the command fails and says so on stderr. */
import * as fs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { dataDir } from '../src/constants.js'
import type * as ResidentProcess from '../src/resident_process.js'
import { daemonEntryScript, workerLeftRunningNote, workerPidPath } from '../src/worker_lifecycle.js'
import { DENIED_WORKER_PID, plantDeniedWorker } from './helpers/denied_worker.js'
import { workerCommandLine } from './helpers/worker_identity.js'
import { runCliExitCode } from './helpers/run-cli.js'
import { spyOnWrite } from './setup/spy-stdio.js'

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

describe('worker stop when the operating system denies ending the worker', () => {
  it('fails with exit code 1 and puts the left-running note on stderr', async () => {
    identity.commandLine = workerCommandLine(daemonEntryScript())
    undo = plantDeniedWorker(dataDir())
    const stdout: string[] = []
    const stderr: string[] = []
    spyOnWrite(process.stdout, stdout)
    spyOnWrite(process.stderr, stderr)
    const code = await runCliExitCode(['worker', 'stop'])
    vi.restoreAllMocks()
    expect(code, 'worker stop exited with a success code though the worker kept running').toBe(1)
    expect(stderr.join(''), 'the left-running note was not on stderr').toContain(workerLeftRunningNote(DENIED_WORKER_PID))
    expect(stdout.join(''), 'the left-running note was printed on stdout').not.toContain('left running')
    expect(fs.existsSync(workerPidPath(dataDir())), 'the pid file of a worker left running was removed').toBe(true)
  })
})
