// Provenance: FORMAT-DERIVED. A worker daemon's command line is `node <launcher> --worker-daemon`, the argv startDetachedWorker spawns (src/worker_lifecycle.ts) and the shape src/resident_process.ts::isResidentOfInstall accepts; the claim is checked against the real query in tests/worker_stop_reaps_held_git.test.ts.
/** stopWorker identity options for a test whose stand-in process is not really `node <launcher> --worker-daemon`: the lookup reports that line for every pid, so the code under test sees a confirmed worker of the launcher given. */
import type { CommandLineQuery } from '../../src/resident_process.js'
import type { StopWorkerOptions } from '../../src/worker_lifecycle.js'

export const STAND_IN_LAUNCHER = 'C:/stand-in/token-goat.mjs'

export function workerCommandLine(launcher: string = STAND_IN_LAUNCHER): string {
  return `node ${launcher} --worker-daemon`
}

export function claimsToBeWorker(launcher: string = STAND_IN_LAUNCHER): StopWorkerOptions {
  return { entryScript: launcher, queryCommandLine: (): CommandLineQuery => ({ status: 'found', commandLine: workerCommandLine(launcher) }) }
}
