// Whether a pid still names a process that can run. A killed child that nobody has reaped yet is a zombie: signal 0 still succeeds for it, but it is dead, so on Linux the state in /proc/<pid>/stat decides. Provenance: FORMAT-DERIVED from proc(5): the stat file is `pid (comm) state ...`, comm may contain spaces and parentheses so the state is the first field after the LAST closing parenthesis, and `Z` is zombie and `X` is dead.
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'

/** The two probes processAlive makes, injectable so every Linux branch can be driven on any host; the default reads the real process table. */
export interface AliveSeam {
  readonly platform: NodeJS.Platform
  /** Sends signal 0 to pid; throws the node error a failed kill raises. */
  signal0(pid: number): void
  /** The text of /proc/<pid>/stat; throws the node error a failed read raises. */
  readStat(pid: number): string
  /** The stat= column ps prints for pid, empty when ps lists nothing; throws when ps cannot run. */
  ps(pid: number): string
}

const REAL_SEAM: AliveSeam = {
  get platform(): NodeJS.Platform {
    return process.platform
  },
  signal0: (pid) => {
    process.kill(pid, 0)
  },
  readStat: (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
  ps: (pid) => {
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1_000, windowsHide: true })
    if (result.error !== undefined) throw result.error
    return result.stdout
  },
}

export function processAlive(pid: number): boolean {
  return processAliveWith(pid, REAL_SEAM)
}

/** processAlive with its probes injected; a separate export so callers passing processAlive to filter keep their two-argument type. */
export function processAliveWith(pid: number, seam: AliveSeam): boolean {
  try {
    seam.signal0(pid)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (seam.platform !== 'linux') {
    if (seam.platform === 'win32') return true
    let state: string
    try {
      state = seam.ps(pid).trim()
    } catch {
      return true
    }
    return state !== '' && !state.startsWith('Z')
  }
  try {
    const stat = seam.readStat(pid)
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z' && state !== 'X'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true
    // On ENOENT the signal decides: a pid that procfs cannot show is alive while kill(pid, 0) still succeeds.
    try {
      seam.signal0(pid)
      return true
    } catch (again) {
      return (again as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

/** Resolves true once `alive(pid)` reads false, polling every 10 ms; false past a 30 s cap that only backstops a broken run. */
export async function waitGone(pid: number, alive: (pid: number) => boolean = processAlive): Promise<boolean> {
  const cap = Date.now() + 30_000
  while (alive(pid)) {
    if (Date.now() > cap) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}
