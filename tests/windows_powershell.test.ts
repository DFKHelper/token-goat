/** The shared Windows PowerShell launcher (src/windows_powershell.ts) that doctor's process list and the hidden-rule scan's command-line read both start. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { powerShellCommandArgs, windowsPowerShellPath } from '../src/windows_powershell.js'

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
