// Provenance: HAND-DERIVED. kill(2) documents EPERM as the error for a signal the caller may not send to a process that exists, and signal 0 as the existence probe; the pid file and heartbeat paths are the ones src/worker_lifecycle.ts::workerPidPath and drainHeartbeatPathFor name.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { vi } from 'vitest'

import { drainHeartbeatPathFor, workerPidPath } from '../../src/worker_lifecycle.js'

/** A pid no process holds: with process.kill mocked it reads as alive, and it is neither this process nor its parent, which no stop path may signal. */
export const DENIED_WORKER_PID = 313131

/** Plants a worker the operating system will not let this process end: a pid file and a fresh heartbeat naming DENIED_WORKER_PID in `dir`, and a process.kill that answers the existence probe and refuses every other signal with EPERM. The caller reports a confirmed worker for that pid through its own resident_process mock. Returns the undo, for `finally` or `afterEach`. */
export function plantDeniedWorker(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(workerPidPath(dir), `${DENIED_WORKER_PID}\n`)
  const heartbeat = drainHeartbeatPathFor(dir)
  fs.mkdirSync(path.dirname(heartbeat), { recursive: true })
  fs.writeFileSync(heartbeat, `${DENIED_WORKER_PID}\n`)
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
    if (signal === 0) return true
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  })
  return () => {
    killSpy.mockRestore()
    fs.rmSync(workerPidPath(dir), { force: true })
    fs.rmSync(heartbeat, { force: true })
  }
}
