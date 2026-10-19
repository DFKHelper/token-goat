/** The shared Windows PowerShell launcher (src/windows_powershell.ts) that doctor's process list and the hidden-rule scan's command-line read both start. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { powerShellCommandArgs } from '../src/shell.js'
import { powerShellTextQueryArgs, windowsPowerShellPath } from '../src/windows_powershell.js'

const saved = { SystemRoot: process.env['SystemRoot'], windir: process.env['windir'] }

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('powerShellCommandArgs', () => {
  // FORMAT-DERIVED: the flags both former copies passed, read off src/cli_doctor_process.ts and src/claude_hidden_rules.ts at 44fdbaa9.
  it('runs the command without a profile and without waiting on input', () => {
    expect(powerShellCommandArgs('Get-Date')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Get-Date'])
  })
})

describe('powerShellTextQueryArgs', () => {
  // FORMAT-DERIVED: the prefix is the line src/windows_powershell.ts::powerShellTextQueryArgs builds at f5040bd46 (`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;`); Console.OutputEncoding is "the encoding the console uses to write output" (https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding, read 2026-10-18), and the 5.1 failure it prevents is captured in tests/resident_process.test.ts. Runs on every platform because the args are built, not executed.
  it('puts a UTF-8 (no byte order mark) output encoding before the script, after the bare flags', () => {
    expect(powerShellTextQueryArgs('Get-Date')).toEqual(['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Get-Date'])
  })
})

describe('windowsPowerShellPath', () => {
  // HAND-DERIVED: a throwaway system root that does or does not hold System32/WindowsPowerShell/v1.0/powershell.exe.
  it('names the System32 executable under the system root when it exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ps-path-'))
    try {
      const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      fs.mkdirSync(path.dirname(exe), { recursive: true })
      fs.writeFileSync(exe, '')
      process.env['SystemRoot'] = root
      expect(windowsPowerShellPath()).toBe(exe)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads windir when SystemRoot is unset, and never names a bare executable when the file is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ps-path-'))
    try {
      delete process.env['SystemRoot']
      process.env['windir'] = root
      expect(path.win32.isAbsolute(windowsPowerShellPath()), 'a bare name would resolve against PATH or the working directory').toBe(true)
      expect(windowsPowerShellPath()).not.toBe('powershell.exe')
      const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      fs.mkdirSync(path.dirname(exe), { recursive: true })
      fs.writeFileSync(exe, '')
      expect(windowsPowerShellPath()).toBe(exe)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
