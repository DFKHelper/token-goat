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
})
