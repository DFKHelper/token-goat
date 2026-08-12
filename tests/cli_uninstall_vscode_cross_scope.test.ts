/**
 * Regression: `installVscode` guards the project<->user default-scope flip via
 * `otherScopeHasManagedServer` (src/bridges/vscode_install.ts), throwing if the other
 * scope already holds a managed entry. `uninstallVscode` had no equivalent check, so a
 * user with a project-scope registration who ran a bare `token-goat uninstall --vscode`
 * (now defaulting to user scope) got a silent success: the user-scope mcp.json is absent
 * so nothing is removed there, but `stripDelimitedBlock` on the copilot-instructions file
 * still succeeds, so `removed` comes back `true` and the CLI reports success -- while the
 * project-scope server registration, the thing actually launching token-goat, survives
 * untouched.
 *
 * Fix: `cmdUninstall` (src/cli.ts) now checks `otherScopeHasManagedServer` after running
 * the requested-scope uninstall and prints a NOTE pointing at the surviving scope, rather
 * than silently reporting unqualified success.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installVscode } from '../src/bridges/vscode_install.js'
import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let project: string
let appData: string
let originalCwd: string
let savedAppData: string | undefined
let stdout: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeEach(() => {
  originalCwd = process.cwd()
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-project-'))
  appData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-appdata-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = appData
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderrSpy = spyOnWrite(process.stderr, [])
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  process.chdir(originalCwd)
  if (savedAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = savedAppData
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(appData, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<number | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('token-goat uninstall --vscode cross-scope detection', () => {
  it('warns (does not silently succeed) when the OTHER scope still has a managed server after a same-scope-only uninstall', async () => {
    installVscode({ project: true, projectRoot: project })
    const projectMcpPath = path.join(project, '.vscode', 'mcp.json')
    expect(fs.readFileSync(projectMcpPath, 'utf8')).toContain('token-goat')

    process.chdir(project)
    // Bare `uninstall --vscode`, no `--project` -- defaults to user scope, which was
    // never populated, mirroring the reported scenario exactly.
    const code = await runCli(['uninstall', '--vscode'])
    expect(code).toBe(0)

    // The project-scope registration must still be there: uninstall only touched user scope.
    expect(fs.readFileSync(projectMcpPath, 'utf8')).toContain('token-goat')

    const output = stdout.join('')
    expect(output).toMatch(/still registered in VS Code project scope/)
    expect(output).toContain('uninstall --vscode --project')
  })

  it('does not warn when only one scope was ever registered', async () => {
    installVscode({ project: true, projectRoot: project })
    process.chdir(project)
    const code = await runCli(['uninstall', '--vscode', '--project'])
    expect(code).toBe(0)
    expect(stdout.join('')).not.toContain('still registered in VS Code')
  })
})
