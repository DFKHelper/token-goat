// Whether a pid still names a process that can run. A killed child that nobody has reaped yet is a zombie: signal 0 still succeeds for it, but it is dead, so on Linux the state in /proc/<pid>/stat decides. Provenance: FORMAT-DERIVED from proc(5): the stat file is `pid (comm) state ...`, comm may contain spaces and parentheses so the state is the first field after the LAST closing parenthesis, and `Z` is zombie and `X` is dead.
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (process.platform !== 'linux') {
    if (process.platform === 'win32') return true
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      windowsHide: true,
    })
    if (result.error !== undefined) return true
    const state = result.stdout.trim()
    return state !== '' && !state.startsWith('Z')
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}
