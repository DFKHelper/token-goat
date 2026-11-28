import { spawnSync } from 'node:child_process'

/** Block the calling thread for `ms` milliseconds without spawning a process. Uses `Atomics.wait` on a throwaway SharedArrayBuffer: the wait never resolves (no other thread writes to it), so it always times out after `ms`. This is a true synchronous sleep, unlike a busy-loop, and burns no CPU. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// taskkill and ps are local utilities that answer in milliseconds; the bound only keeps a wedged one from holding the caller.
export const HELPER_TIMEOUT_MS = 10_000

// Checks a killed member gets to be seen gone before the tree end names it as still running.
const GONE_CHECKS = 20
const GONE_PAUSE_MS = 25

/** Injected probes for the tree end: `isGone` reads one pid, `pause` waits between checks; both default to the real ones. */
export interface TreeEndSeam {
  isGone?: (pid: number) => boolean
  pause?: () => void
}

/** Whether a signalled member has ended: signal 0 finds no process, or it is a zombie (killed, not yet reaped). */
function memberGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  const listed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: HELPER_TIMEOUT_MS, windowsHide: true })
  return listed.status === 0 && typeof listed.stdout === 'string' && listed.stdout.trim().startsWith('Z')
}

/** The pids still running after the bounded checks; a pause follows each round that still sees one alive. */
export function stillRunning(pids: readonly number[], seam: TreeEndSeam = {}): number[] {
  const isGone = seam.isGone ?? memberGone
  const pause = seam.pause ?? (() => sleepSync(GONE_PAUSE_MS))
  let alive = pids.filter((pid) => !isGone(pid))
  for (let check = 0; alive.length > 0 && check < GONE_CHECKS; check++) {
    pause()
    alive = alive.filter((pid) => !isGone(pid))
  }
  return alive
}
