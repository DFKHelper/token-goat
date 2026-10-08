/** The real Windows process-list gather in src/cli_doctor_process.ts, which starts PowerShell through the shared launcher in src/windows_powershell.ts. */
import { describe, expect, it } from 'vitest'

import { readWindowsProcesses } from '../src/cli_doctor_process.js'

describe('readWindowsProcesses on the real PowerShell launcher', () => {
  // CAPTURE: on a Windows machine this very test process is in the table Get-CimInstance prints; a loaded machine may instead time out, which the result marks transient. Any other failure (powershell.exe not found, a bad argument list) is the launcher broken.
  it.runIf(process.platform === 'win32')('lists this process, or fails only by timing out', () => {
    const processes = readWindowsProcesses()
    if (Array.isArray(processes)) expect(processes.some((p) => p.processId === process.pid)).toBe(true)
    else expect(processes, 'the process list failed for a reason other than a timeout').toMatchObject({ transient: true })
  }, 60_000)
})
