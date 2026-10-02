import { describe, it, expect } from 'vitest'
import { resolvePowerShell, canRunPowerShell } from '../src/shell.js'
import { spawnSync } from 'node:child_process'
import { run, spawnTarget } from '../src/bash_runner.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'

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

  // Provenance: CAPTURE, exit code and trimmed stdout lines of a direct `pwsh -NoProfile -NonInteractive -Command <cmd>` spawned from node, PowerShell 7.6.4 on Windows 11, 2026-10-02. A statement-terminating error (unknown command, .NET exception, divide by zero) does not stop the script, `return X` and a top-level break keep the `$?` of the statement before them, a finally that runs last decides the exit, a break whose label nothing catches still exits 1, and a user variable named like the wrapper's own does not change the result.
  it.each([
    ['nonexistentcmd-xyz; Write-Output after', 0, ['after']],
    ["[int]::Parse('x'); Write-Output after", 0, ['after']],
    ['$x = 1/0; Write-Output after', 0, ['after']],
    ['Write-Output a; nonexistentcmd-xyz', 1, ['a']],
    ['using namespace System.Text\nWrite-Output a; return', 0, ['a']],
    ['using namespace System.Text\nGet-Item ./nope; return', 1, []],
    ['Get-Item ./nope; return 5', 1, ['5']],
    ['Get-Item ./nope; return $false', 1, ['False']],
    ['Write-Output a; return Get-Item ./nope', 1, ['a']],
    ['begin { Write-Output b } end { Get-Item ./nope }', 1, ['b']],
    ['try { Get-Item ./nope; return 5 } finally { Write-Output f }', 0, ['5', 'f']],
    ['try { Write-Output a; return } finally { Get-Item ./nope }', 1, ['a']],
    ['Write-Output a; break; Write-Output b', 0, ['a']],
    ['Get-Item ./nope; break', 1, []],
    ['Get-Item ./nope; break nolabel', 1, []],
    [':l foreach ($i in 1) { Get-Item ./nope; break l }; Write-Output after', 0, ['after']],
    ['function f { Get-Item ./nope; break }; f; Write-Output after', 0, []],
    ['$global:TgOk = $false; Write-Output x', 0, ['x']],
    ['Write-Output "unterminated', 1, []],
  ])('wrapped exit code and output match direct pwsh for %s', async (cmd, expected, lines) => {
    const target = spawnTarget(cmd, undefined, 'pwsh')
    const r = spawnSync(target.file, target.args, { encoding: 'utf8', env: { ...process.env, ...target.cmdEnv } })
    expect(r.status).toBe(expected)
    expect(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(lines)
    expect(await run(cmd, { filterName: 'powershell', shellType: 'pwsh', writeStdout: () => {}, writeStderr: () => {} })).toBe(expected)
  })

  // Provenance: CAPTURE, PowerShell 7.6.4 on Windows 11, 2026-10-02: a direct `pwsh -NoProfile -NonInteractive -Command 'Write-Output "unterminated'` spawned from node exits 1 with empty stdout and stderr, and the previous wrapper printed `MethodInvocationException: Exception calling "Create"`, which names neither the cause nor the line.
  it('reports a parse error as a ParserError quoting the user line', () => {
    const target = spawnTarget('Write-Output "unterminated', undefined, 'pwsh')
    const r = spawnSync(target.file, target.args, { encoding: 'utf8', env: { ...process.env, ...target.cmdEnv } })
    const stderr = stripAnsiEscapes(r.stderr)
    expect(r.status).toBe(1)
    expect(stderr).toContain('ParserError')
    expect(stderr).toContain('Write-Output "unterminated')
    expect(stderr).not.toContain('Exception calling')
  })

  it('stops at a top-level return and still prints what ran before it', async () => {
    let captured = ''
    const exitCode = await run('Write-Output before; if ($true) { return }; Write-Output after', { filterName: 'powershell', shellType: 'pwsh', writeStdout: (s) => { captured += s }, writeStderr: () => {} })
    expect(exitCode).toBe(0)
    expect(captured).toContain('before')
    expect(captured).not.toContain('after')
  })
})
