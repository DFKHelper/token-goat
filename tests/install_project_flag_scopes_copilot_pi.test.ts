// `-p/--project` is the documented project-scope flag for every client, but `install --copilot --project` and `install --pi --project` ignored it (only --local was read) and silently wrote the user-scope config. -p/--project now selects the same project-local target as --local, on install and on uninstall. PROVENANCE: FORMAT-DERIVED. The target paths are the ones the --local help text and docs/install.md name (<project>/.github/hooks/token-goat.json, <project>/.pi/extensions/token-goat.ts, ~/.copilot/hooks/token-goat.json, ~/.pi/agent/extensions/token-goat.ts); the reproduction is the observed one (`install --copilot --project` wrote ~/.copilot/hooks/token-goat.json and nothing under the project).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME'] as const

let base: string
let project: string
let home: string
let origCwd: string
let saved: Record<string, string | undefined>
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-project-flag-')))
  project = path.join(base, 'proj')
  home = path.join(base, 'home')
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['LOCALAPPDATA'] = path.join(base, 'local')
  process.env['XDG_DATA_HOME'] = path.join(base, 'local')
  process.env['APPDATA'] = path.join(base, 'roaming')
  process.env['TOKEN_GOAT_HOME'] = path.join(base, 'tghome')
  process.env['CLAUDE_CONFIG_DIR'] = path.join(base, 'claude')
  delete process.env['COPILOT_HOME']
  _resetDataDirCacheForTesting()
  origCwd = process.cwd()
  process.chdir(project)
  stdoutSpy = spyOnWrite(process.stdout, [])
  stderrSpy = spyOnWrite(process.stderr, [])
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  process.chdir(origCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(base, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<void> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    expect(process.exitCode).toBe(0)
  } finally {
    process.exitCode = prev
  }
}

describe('-p/--project selects the project-local target for --copilot and --pi', () => {
  const copilotProject = (): string => path.join(project, '.github', 'hooks', 'token-goat.json')
  const copilotUser = (): string => path.join(home, '.copilot', 'hooks', 'token-goat.json')
  const piProject = (): string => path.join(project, '.pi', 'extensions', 'token-goat.ts')
  const piUser = (): string => path.join(home, '.pi', 'agent', 'extensions', 'token-goat.ts')

  it('install --copilot --project writes the project hooks file and not the user one', async () => {
    await runCli(['install', '--copilot', '--project', '--no-index'])
    expect(fs.existsSync(copilotProject())).toBe(true)
    expect(fs.existsSync(copilotUser())).toBe(false)
  })

  it('uninstall --copilot --project removes the project hooks file', async () => {
    await runCli(['install', '--copilot', '--local', '--no-index'])
    expect(fs.existsSync(copilotProject())).toBe(true)
    await runCli(['uninstall', '--copilot', '--project'])
    expect(fs.existsSync(copilotProject())).toBe(false)
  })

  it('uninstall --copilot --project leaves a coexisting user-scope install alone', async () => {
    await runCli(['install', '--copilot', '--no-index'])
    await runCli(['install', '--copilot', '--local', '--no-index'])
    expect(fs.existsSync(copilotUser())).toBe(true)
    await runCli(['uninstall', '--copilot', '--project'])
    expect(fs.existsSync(copilotProject())).toBe(false)
    expect(fs.existsSync(copilotUser())).toBe(true)
  })

  it('install --pi --project writes the project extension and not the global one', async () => {
    await runCli(['install', '--pi', '--project', '--no-index'])
    expect(fs.existsSync(piProject())).toBe(true)
    expect(fs.existsSync(piUser())).toBe(false)
  })

  it('uninstall --pi --project removes the project extension and leaves the global one', async () => {
    await runCli(['install', '--pi', '--no-index'])
    await runCli(['install', '--pi', '--local', '--no-index'])
    expect(fs.existsSync(piUser())).toBe(true)
    await runCli(['uninstall', '--pi', '--project'])
    expect(fs.existsSync(piProject())).toBe(false)
    expect(fs.existsSync(piUser())).toBe(true)
  })
})
