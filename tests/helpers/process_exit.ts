/** Teardown wait for processes a test killed or stopped before it deletes the directories they used. */
import { spawnSync, type ChildProcess } from 'node:child_process'

import { windowsPowerShellPath } from '../../src/windows_powershell.js'

/** Windows sets a killed process's exit status before the kernel has closed its handles and unmapped its image, and `process.kill(pid, 0)` reads only that status, so a liveness probe reports the process gone while its executable, working directory and open files still refuse deletion with EPERM. Measured: a copied PING.EXE killed and then probed until the probe read it gone left its directory undeletable 100 times in 100, while deleting after the child's own exit event, which fires on the signalled process handle, succeeded 100 times in 100. Process.WaitForExit waits on that handle for PIDs this process did not spawn; Wait-Process does not, because it first asks HasExited, which reads the same exit status. `seen` maps each PID to a Date.now() at which it was known to name the process meant: a process under that PID that started later reused the number after the one meant had gone, and is not waited on. POSIX lets a directory in use be deleted, so there this returns at once. */
export function awaitProcessExit(seen: ReadonlyMap<number, number>): void {
  if (process.platform !== 'win32' || seen.size === 0) return
  const table = [...seen].map(([pid, at]) => `${pid}=${Math.ceil(at)}`).join(';')
  const waited = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    `$seen = @{${table}}; foreach ($owned in @(Get-Process -Id ${[...seen.keys()].join(',')} -ErrorAction SilentlyContinue)) { if (([DateTimeOffset]$owned.StartTime).ToUnixTimeMilliseconds() -gt $seen[$owned.Id]) { continue }; if (-not $owned.WaitForExit(10000)) { throw "process $($owned.Id) is still running" } }; exit 0`,
  ], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  if (waited.status !== 0) throw new Error(`processes ${[...seen.keys()].join(',')} did not exit (status ${String(waited.status)}): ${waited.error?.message ?? waited.stderr}${waited.stdout}`)
}

/** Resolves on `child`'s exit event, which fires on its signalled process handle, so unlike a liveness probe it never runs ahead of Windows releasing the child's working directory and image; at once for a child that has already exited, or was never started. */
export function childExit(child: ChildProcess | undefined): Promise<unknown> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}
