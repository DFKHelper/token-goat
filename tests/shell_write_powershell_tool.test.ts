/** Claude Code's PowerShell tool runs the same shell hooks as its Bash tool, through the real registry. PROVENANCE: the tool_input {command, description} is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks.md (PowerShell section: "The fields match the Bash tool, with the command string in `command`"); the tool_response shape is UNVERIFIED (that page does not document it) and only reuses the Bash one; every command value is HAND-DERIVED. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gitRepoWithCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { tempConfigPath } from './helpers/temp-config.js'

// dataDir() points at a per-file temp dir so the queue the hook writes never touches a real one.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, dataDir: () => _testDataDir }
})

// Whether a PowerShell or a bash is installed is the machine's, not the hook's: the wrapper rows below must hold on a host with neither.
vi.mock('../src/shell.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, canRunPowerShell: () => true, canRunWrappedShell: () => true }
})

const _testConfigPath = tempConfigPath('tg-shell-ps-tool-config-test.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-shell-ps-tool-data-'))

// Side-effect import: registers every hook handler, as the shipping relay does.
import '../src/relay.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'
import { handlersFor, runHook, type HookEvent } from '../src/hook_registry.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { resolveIndexPath } from '../src/paths.js'
import { foldPath } from '../src/util.js'

function powerShellCall(command: string, cwd: string): HookEvent {
  const toolInput = { command, description: 'run' }
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'PowerShell', toolInput, sessionId: 'shell-ps-tool-session', raw: { tool_name: 'PowerShell', tool_input: toolInput, tool_response: { stdout: 'done', stderr: '', exit_code: 0 }, cwd } })
}

const dirs: string[] = []
beforeEach(() => clearDirtyQueue())
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Claude Code's PowerShell tool reaches the same shell hooks as Bash", () => {
  it('queues the file a Set-Content wrote', async () => {
    const dir = gitRepoWithCommit()
    dirs.push(dir)
    await runHook(powerShellCall("Set-Content -Path a.txt -Value 'x'", dir))
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('queues nothing for a Get-Content read', async () => {
    const dir = gitRepoWithCommit()
    dirs.push(dir)
    await runHook(powerShellCall('Get-Content a.txt', dir))
    expect(getDirtyPaths()).toEqual([])
  })

  it('registers the pre handlers Bash has and the post handler Bash uses', () => {
    expect(handlersFor('pre_tool_use', 'PowerShell'), 'pre_tool_use handlers for PowerShell').toHaveLength(handlersFor('pre_tool_use', 'Bash').length)
    expect(handlersFor('post_tool_use', 'PowerShell'), 'post_tool_use handlers for PowerShell').toContain(postBashHandler)
  })
})

// PROVENANCE: the PowerShell tool's `PowerShell(...)` rule name and the `tool_name` "PowerShell" are FORMAT-DERIVED from https://code.claude.com/docs/en/permissions.md (PowerShell section) and https://code.claude.com/docs/en/hooks.md (PowerShell section), fetched 2026-10-22; the settings file shape is the documented `permissions.deny` array; every command value is HAND-DERIVED. The platform is spoofed, so these rows hold on any host.
describe("a pre-tool rewrite of the PowerShell tool's command", () => {
  const realPlatform = process.platform
  const savedConfigDir = process.env['CLAUDE_CONFIG_DIR']
  let configDir: string
  let projectDir: string

  function preCall(toolName: 'PowerShell' | 'Bash', command: string): HookEvent {
    const toolInput = { command, description: 'run' }
    return makeHookEvent({ eventName: 'pre_tool_use', toolName, toolInput, sessionId: 'shell-ps-pre-session', raw: { tool_name: toolName, tool_input: toolInput, cwd: projectDir, permission_mode: 'default' } })
  }

  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'tg-shell-ps-pre-'))
    dirs.push(root)
    configDir = join(root, 'config')
    projectDir = join(root, 'proj')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    process.env['CLAUDE_CONFIG_DIR'] = configDir
    resetPermissionSourceCache()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
    resetPermissionSourceCache()
  })

  const denyRule = (rule: string): void => writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ permissions: { deny: [rule] } }))

  it('wraps for pwsh on Windows when no rule is present', () => {
    setPlatform('win32')
    const out = preBashHandler(preCall('PowerShell', 'go vet ./...'))
    expect(out.hookType).toBe('rewriteInput')
    if (out.hookType === 'rewriteInput') expect(out.updatedInput['command']).toContain('--shell pwsh --cmd-b64')
  })

  it('is not made while a PowerShell deny rule is in force', () => {
    setPlatform('win32')
    denyRule('PowerShell(Remove-Item *)')
    expect(preBashHandler(preCall('PowerShell', 'go vet ./...')).hookType).toBe('pass')
  })

  it('is not made while the settings file holds a rule that does not parse', () => {
    setPlatform('win32')
    denyRule('PowerShell(')
    expect(preBashHandler(preCall('PowerShell', 'go vet ./...')).hookType).toBe('pass')
  })

  it('is not made while the settings file cannot be read as JSON', () => {
    setPlatform('win32')
    writeFileSync(join(configDir, 'settings.json'), '{ "permissions": ')
    expect(preBashHandler(preCall('PowerShell', 'go vet ./...')).hookType).toBe('pass')
  })

  it('is still made for the Bash tool under the same PowerShell deny rule', () => {
    setPlatform('win32')
    denyRule('PowerShell(Remove-Item *)')
    expect(preBashHandler(preCall('Bash', 'go vet ./...')).hookType).toBe('rewriteInput')
  })

  it('is not made off Windows, where the only wrapper built is the bash one', () => {
    setPlatform('linux')
    expect(preBashHandler(preCall('PowerShell', 'go vet ./...')).hookType).toBe('pass')
  })

  it('leaves the bash wrapper of a Bash call off Windows as it was', () => {
    setPlatform('linux')
    const out = preBashHandler(preCall('Bash', 'go vet ./...'))
    expect(out.hookType).toBe('rewriteInput')
    if (out.hookType === 'rewriteInput') {
      expect(out.updatedInput['command']).toContain(" -c 'go vet ./...'")
      expect(out.updatedInput['command']).not.toContain('--shell pwsh')
    }
  })
})
