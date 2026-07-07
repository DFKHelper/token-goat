import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.copilot/` (mirrors the pattern in install_codex.test.ts /
// install_pi.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  copilotCliConfigPath,
  copilotCliProjectHooksDir,
  copilotCliScriptPath,
  copilotCliUserHooksDir,
  installCopilotCli,
  isCopilotCliInstalled,
  uninstallCopilotCli,
} from '../src/bridges/copilot_cli_install.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { HOOK_EVENTS } from '../src/types.js'

let TMP: string
let origCwd: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-cli-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(path.join(TMP, 'home'))

  origCwd = process.cwd()
  // Project-scope install resolves against process.cwd() (mirrors install_pi.test.ts's
  // handling of --local); chdir into an isolated project dir so `{ local: true }`
  // writes under {TMP}/project/.github/hooks, never this repo's own .github/.
  fs.mkdirSync(path.join(TMP, 'project'), { recursive: true })
  process.chdir(path.join(TMP, 'project'))
})

afterEach(() => {
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installCopilotCli (user scope)', () => {
  it('writes the shim script and a hooks config registering all five implemented events on a fresh install', () => {
    const result = installCopilotCli()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.configPath).toBe(copilotCliConfigPath())
    expect(result.scriptPath).toBe(copilotCliScriptPath())
    expect(fs.existsSync(result.configPath)).toBe(true)
    expect(fs.existsSync(result.scriptPath)).toBe(true)
    expect(fs.readFileSync(result.scriptPath, 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)

    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      version: number
      hooks: Record<string, Array<{ type: string; command: string }>>
    }
    expect(config.version).toBe(1)
    for (const event of ['preToolUse', 'postToolUse', 'preCompact', 'agentStop', 'subagentStop']) {
      expect(config.hooks[event]).toBeDefined()
      expect(config.hooks[event]?.[0]?.type).toBe('command')
      expect(config.hooks[event]?.[0]?.command).toContain(result.scriptPath)
    }

    expect(isCopilotCliInstalled()).toBe(true)
  })

  it('is idempotent: a second install reports alreadyInstalled and does not duplicate or alter entries', () => {
    installCopilotCli()
    const second = installCopilotCli()
    expect(second.alreadyInstalled).toBe(true)

    const config = JSON.parse(fs.readFileSync(second.configPath, 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    for (const event of ['preToolUse', 'postToolUse', 'preCompact', 'agentStop', 'subagentStop']) {
      expect(config.hooks[event]).toHaveLength(1)
    }
  })

  it('overwrites a hand-modified shim script wholesale instead of merging or warning', () => {
    const result = installCopilotCli()
    fs.writeFileSync(result.scriptPath, '#!/usr/bin/env node\n// hand-edited\n')

    const second = installCopilotCli()
    expect(second.alreadyInstalled).toBe(false)
    expect(fs.readFileSync(result.scriptPath, 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)
  })

  it('does not touch unrelated files already present in the hooks directory', () => {
    const dir = copilotCliUserHooksDir()
    fs.mkdirSync(dir, { recursive: true })
    const unrelatedPath = path.join(dir, 'some-other-tool.json')
    fs.writeFileSync(unrelatedPath, '{"version":1,"hooks":{}}\n')

    installCopilotCli()

    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('{"version":1,"hooks":{}}\n')
  })
})

describe('installCopilotCli ({ local: true })', () => {
  it('writes to the project-scoped path instead of the user-scoped one', () => {
    const result = installCopilotCli({ local: true })
    expect(result.configPath).toBe(copilotCliConfigPath({ local: true }))
    expect(result.configPath).toBe(path.join(process.cwd(), '.github', 'hooks', 'token-goat.json'))
    expect(fs.existsSync(copilotCliUserHooksDir())).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(true)
  })

  it('is idempotent for the project scope too', () => {
    installCopilotCli({ local: true })
    const second = installCopilotCli({ local: true })
    expect(second.alreadyInstalled).toBe(true)
  })

  it('does not collide with a user-scope install in the same run', () => {
    const userResult = installCopilotCli()
    const localResult = installCopilotCli({ local: true })
    expect(userResult.configPath).not.toBe(localResult.configPath)
    expect(fs.existsSync(userResult.configPath)).toBe(true)
    expect(fs.existsSync(localResult.configPath)).toBe(true)
  })

  it('resolves copilotCliProjectHooksDir() to <cwd>/.github/hooks', () => {
    expect(copilotCliProjectHooksDir()).toBe(path.join(process.cwd(), '.github', 'hooks'))
  })
})

describe('isCopilotCliInstalled / uninstallCopilotCli', () => {
  it('isCopilotCliInstalled is false before install, true after (user scope)', () => {
    expect(isCopilotCliInstalled()).toBe(false)
    installCopilotCli()
    expect(isCopilotCliInstalled()).toBe(true)
  })

  it('isCopilotCliInstalled is false before install, true after (project scope)', () => {
    expect(isCopilotCliInstalled({ local: true })).toBe(false)
    installCopilotCli({ local: true })
    expect(isCopilotCliInstalled({ local: true })).toBe(true)
  })

  it('uninstallCopilotCli removes the config and the shim script, and returns true', () => {
    const result = installCopilotCli()
    expect(uninstallCopilotCli()).toBe(true)
    expect(isCopilotCliInstalled()).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(false)
    expect(fs.existsSync(result.scriptPath)).toBe(false)
  })

  it('uninstallCopilotCli returns false when nothing is installed', () => {
    expect(uninstallCopilotCli()).toBe(false)
  })

  it('uninstallCopilotCli removes exactly token-goat\'s entries, leaving an unrelated sibling file in the hooks dir intact', () => {
    const dir = copilotCliUserHooksDir()
    fs.mkdirSync(dir, { recursive: true })
    const unrelatedPath = path.join(dir, 'some-other-tool.json')
    fs.writeFileSync(unrelatedPath, '{"version":1,"hooks":{}}\n')

    installCopilotCli()
    uninstallCopilotCli()

    expect(fs.existsSync(unrelatedPath)).toBe(true)
    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('{"version":1,"hooks":{}}\n')
  })

  it('uninstalling the user scope leaves a project-scope install untouched', () => {
    const localResult = installCopilotCli({ local: true })
    installCopilotCli()
    uninstallCopilotCli()
    expect(fs.existsSync(localResult.configPath)).toBe(true)
  })
})

// --- shim script (COPILOT_CLI_HOOK_SCRIPT) behavior ---
// Mirrors tests/bridges/shims.test.ts's approach: run the embedded script as a
// standalone Node process exactly as Copilot CLI would (argv[2] = event name,
// stdin = the hook payload JSON), and inspect what it writes to stdout.

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function mkIsolated(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'tg-copilot-shim-test-'))
  tempDirs.push(dir)
  return dir
}

function runShim(eventName: string, stdin: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: env ?? process.env,
  })
  return res.stdout ?? ''
}

/**
 * Writes a fake `token-goat` executable into `cwd` and returns a PATH-prepended env pointing
 * at it, so the shim's internal `spawnSync('token-goat', ['hook', event], { shell: true })`
 * resolves to `jsonStdout` instead of the real installed binary (mirrors
 * tests/bridges/shims.test.ts's withFakeTokenGoat).
 */
function withFakeTokenGoat(cwd: string, jsonStdout: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(cwd, 'token-goat.cmd'), `@echo off\r\necho ${jsonStdout}\r\n`, 'utf8')
  } else {
    const scriptPath = path.join(cwd, 'token-goat')
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${jsonStdout}'\n`, 'utf8')
    fs.chmodSync(scriptPath, 0o755)
  }
  return { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
}

describe('COPILOT_CLI_HOOK_SCRIPT', () => {
  it('every Copilot event name it maps to a token-goat event resolves to a real HOOK_EVENTS member', () => {
    const mapMatch = /COPILOT_TO_TG_EVENT = \{([\s\S]*?)\}/.exec(COPILOT_CLI_HOOK_SCRIPT)
    expect(mapMatch).not.toBeNull()
    const mapped = [...(mapMatch?.[1] ?? '').matchAll(/:\s*'([^']+)'/g)].map((m) => m[1])
    expect(mapped.length).toBeGreaterThan(0)
    for (const eventName of mapped) {
      expect(HOOK_EVENTS as readonly string[]).toContain(eventName)
    }
  })

  it('no-ops on sessionStart without invoking token-goat at all', () => {
    const cwd = mkIsolated()
    // No fake token-goat on PATH -- if the shim tried to spawn it, spawnSync
    // would fail and the shim's own catch-all would still print '{}', so this
    // alone wouldn't prove non-invocation. The real proof is the immediate,
    // synchronous early-return in the source (checked below) plus this
    // behavioral smoke test.
    const stdout = runShim('sessionStart', '{}', cwd)
    expect(stdout.trim()).toBe('{}')
    expect(COPILOT_CLI_HOOK_SCRIPT).toMatch(/copilotEvent === 'sessionStart'/)
  })

  it('no-ops on an event name it does not implement', () => {
    const cwd = mkIsolated()
    const stdout = runShim('sessionEnd', '{}', cwd)
    expect(stdout.trim()).toBe('{}')
  })

  it('fails open ({}) on malformed JSON on stdin', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, '{}')
    const stdout = runShim('preToolUse', 'not json', cwd, env)
    expect(stdout.trim()).toBe('{}')
  })

  it('fails open ({}) when the token-goat child process exits non-zero', () => {
    const cwd = mkIsolated()
    const scriptPath =
      process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    if (process.platform === 'win32') {
      fs.writeFileSync(scriptPath, '@echo off\r\nexit /b 1\r\n', 'utf8')
    } else {
      fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 1\n', 'utf8')
      fs.chmodSync(scriptPath, 0o755)
    }
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
    const stdout = runShim('preToolUse', '{}', cwd, env)
    expect(stdout.trim()).toBe('{}')
  })

  it('sets TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli when invoking token-goat, since Copilot has no ambient env-var signal of its own', () => {
    expect(COPILOT_CLI_HOOK_SCRIPT).toMatch(/TOKEN_GOAT_HARNESS_OVERRIDE:\s*'copilot_cli'/)
  })

  it('translates a preToolUse deny (decision:"block") into permissionDecision:"deny"', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({ decision: 'block', reason: 'already read this session' }))
    const stdout = runShim(
      'preToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'read', toolArgs: { path: '/f.txt' } }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.permissionDecision).toBe('deny')
    expect(parsed.permissionDecisionReason).toBe('already read this session')
  })

  it('translates a preToolUse rewriteInput (hookSpecificOutput.updatedInput) into modifiedArgs', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'compressed-command' } } }),
    )
    const stdout = runShim(
      'preToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'shell', toolArgs: { command: 'original' } }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.modifiedArgs).toEqual({ command: 'compressed-command' })
  })

  it('translates a postToolUse context response (hookSpecificOutput.additionalContext) into additionalContext', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({ hookSpecificOutput: { additionalContext: 'you already read this file' } }),
    )
    const stdout = runShim(
      'postToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'read', toolArgs: {}, toolResult: {} }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.additionalContext).toBe('you already read this file')
  })

  it('translates a pre_compact systemMessage response into additionalContext for preCompact', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({ systemMessage: 'session manifest here' }))
    const stdout = runShim('preCompact', JSON.stringify({ sessionId: 's1' }), cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed.additionalContext).toBe('session manifest here')
  })

  it('maps shell/read/write/url tool names to Bash/Read/Write/WebFetch before calling token-goat', () => {
    for (const [copilotTool, tgTool] of [
      ['shell', 'Bash'],
      ['read', 'Read'],
      ['write', 'Write'],
      ['url', 'WebFetch'],
    ] as const) {
      const cwd = mkIsolated()
      const capturePath = path.join(cwd, 'captured.json')
      const script =
        process.platform === 'win32'
          ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
          : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
      const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
      fs.writeFileSync(binPath, script, 'utf8')
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
      const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

      runShim('preToolUse', JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: copilotTool, toolArgs: {} }), cwd, env)

      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { tool_name: string }
      expect(captured.tool_name).toBe(tgTool)
    }
  })
})
