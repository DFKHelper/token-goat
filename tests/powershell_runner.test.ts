import { describe, it, expect } from 'vitest'
import { resolvePowerShell, canRunPowerShell } from '../src/shell.js'
import { run } from '../src/bash_runner.js'

describe('PowerShell runner integration and resolution', () => {
  it('resolves PowerShell binary based on platform or environment override', () => {
    const customPs = 'C:\\Custom\\pwsh.exe'
    const resolved = resolvePowerShell({ TOKEN_GOAT_POWERSHELL: customPs }, (p) => p === customPs)
    expect(resolved).toBe(customPs)
  })

  it('canRunPowerShell checks binary accessibility', () => {
    expect(canRunPowerShell()).toBe(true)
  })

  it('runs command under PowerShell preserving backslashes and cmdlets', async () => {
    let captured = ''
    const exitCode = await run('Write-Output "Test-TokenGoat: .\\path\\to\\file.ps1"', {
      filterName: 'powershell',
      shellType: 'pwsh',
      writeStdout: (s) => {
        captured += s
      },
    })

    expect(exitCode).toBe(0)
    expect(captured).toContain('Test-TokenGoat: .\\path\\to\\file.ps1')
  })

  it('propagates non-zero exit codes from PowerShell execution', async () => {
    const exitCode = await run('exit 37', {
      shellType: 'pwsh',
      writeStdout: () => {},
      writeStderr: () => {},
    })

    expect(exitCode).toBe(37)
  })

  it('clears TG_CMD before executing user script to prevent leakage to child processes', async () => {
    let captured = ''
    const exitCode = await run('Write-Output "TG_CMD_VAL:[$env:TG_CMD]"', {
      filterName: 'powershell',
      shellType: 'pwsh',
      writeStdout: (s) => {
        captured += s
      },
    })

    expect(exitCode).toBe(0)
    expect(captured).toContain('TG_CMD_VAL:[]')
  })

  it('executes multi-statement pipeline and native commands via scriptblock invocation', async () => {
    let captured = ''
    const exitCode = await run('Write-Output "Part1"; python -c "print(\'Part2\')"; Write-Output "Part3"', {
      filterName: 'powershell',
      shellType: 'pwsh',
      writeStdout: (s) => {
        captured += s
      },
    })

    expect(exitCode).toBe(0)
    expect(captured).toContain('Part1')
    expect(captured).toContain('Part2')
    expect(captured).toContain('Part3')
  })

  // Provenance: CAPTURE, exit codes of a direct `pwsh -NoProfile -NonInteractive -Command <cmd>` spawned from node, PowerShell 7.6.4 on Windows 11, 2026-10-02. A trailing failed native command exits 1, not its own code, and a top-level `return` keeps the `$?` of the statement before it. `node -e` is the native command because it exists on every CI runner, where `cmd` does not.
  it.each([
    ['Get-Item ./nonexistent-xyz-123', 1],
    ['Write-Output ok', 0],
    ["node -e 'process.exit(3)'", 1],
    ["node -e 'process.exit(3)'; Write-Output ok", 0],
    ["node -e 'process.exit(3)'; node -e 'process.exit(0)'", 0],
    ["node -e 'process.exit(3)'; Get-Item ./nonexistent-xyz-123", 1],
    ['Write-Output hi; return', 0],
    ["node -e 'process.exit(3)'; return", 1],
    ['if ($true) { return }; Write-Output unreached', 0],
    ['throw "boom"', 1],
    ["using namespace System.Text\n[StringBuilder]::new().Append('x').ToString()", 0],
    ["using namespace System.Text\nnode -e 'process.exit(3)'", 1],
    ['Write-Output (', 1],
  ])('wrapped exit code matches direct pwsh for %s', async (cmd, expected) => {
    const exitCode = await run(cmd, { shellType: 'pwsh', writeStdout: () => {}, writeStderr: () => {} })
    expect(exitCode).toBe(expected)
  })

  it('stops at a top-level return and still prints what ran before it', async () => {
    let captured = ''
    const exitCode = await run('Write-Output before; if ($true) { return }; Write-Output after', { filterName: 'powershell', shellType: 'pwsh', writeStdout: (s) => { captured += s }, writeStderr: () => {} })
    expect(exitCode).toBe(0)
    expect(captured).toContain('before')
    expect(captured).not.toContain('after')
  })
})
