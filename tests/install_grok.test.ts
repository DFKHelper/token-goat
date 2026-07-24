import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.grok/` (mirrors the pattern in install_copilot_cli.test.ts /
// install_codex.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { GROK_HOOK_SCRIPT } from '../src/bridges/grok.js'
import {
  grokConfigPath,
  grokHooksDir,
  grokHookScriptPath,
  installGrok,
  isGrokInstalled,
  uninstallGrok,
} from '../src/bridges/grok_install.js'
import { HOOK_EVENTS } from '../src/types.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-grok-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(path.join(TMP, 'home'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installGrok', () => {
  it('writes the shim script and a hooks config registering all five wired events on a fresh install', () => {
    const result = installGrok()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.configPath).toBe(grokConfigPath())
    expect(result.hookScriptPath).toBe(grokHookScriptPath())
    expect(fs.existsSync(result.configPath)).toBe(true)
    expect(fs.existsSync(result.hookScriptPath)).toBe(true)
    expect(fs.readFileSync(result.hookScriptPath, 'utf8')).toBe(GROK_HOOK_SCRIPT)

    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>
    }
    for (const event of ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop']) {
      expect(config.hooks[event]).toBeDefined()
      expect(config.hooks[event]?.[0]?.matcher).toBe('')
      expect(config.hooks[event]?.[0]?.hooks?.[0]?.type).toBe('command')
      expect(config.hooks[event]?.[0]?.hooks?.[0]?.command).toContain(result.hookScriptPath)
    }

    expect(isGrokInstalled()).toBe(true)
  })

  it('uses the absolute Node binary path (process.execPath), not bare node, in the generated hook command', () => {
    const result = installGrok()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const command = config.hooks['PreToolUse']?.[0]?.hooks?.[0]?.command
    expect(command).toBeDefined()
    expect(command).toContain(process.execPath)
    expect(command?.startsWith('node ')).toBe(false)
  })

  it("bakes the running token-goat entry's absolute path (process.argv[1]) as a trailing arg, so the shim's own inner call can bypass PATH resolution too", () => {
    const result = installGrok()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const command = config.hooks['PreToolUse']?.[0]?.hooks?.[0]?.command
    expect(process.argv[1]).toBeDefined()
    expect(command).toBe(`"${process.execPath}" "${result.hookScriptPath}" pre_tool_use "${process.argv[1]}"`)
  })

  it('is idempotent: a second install reports alreadyInstalled and does not duplicate or alter entries', () => {
    installGrok()
    const second = installGrok()
    expect(second.alreadyInstalled).toBe(true)

    const config = JSON.parse(fs.readFileSync(second.configPath, 'utf8')) as { hooks: Record<string, unknown[]> }
    for (const event of ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop']) {
      expect(config.hooks[event]).toHaveLength(1)
    }
  })

  it('overwrites a hand-modified shim script wholesale instead of merging or warning', () => {
    const result = installGrok()
    fs.writeFileSync(result.hookScriptPath, '#!/usr/bin/env node\n// hand-edited\n')

    const second = installGrok()
    expect(second.alreadyInstalled).toBe(false)
    expect(fs.readFileSync(result.hookScriptPath, 'utf8')).toBe(GROK_HOOK_SCRIPT)
  })

  it('does not touch unrelated files already present in ~/.grok/hooks/', () => {
    const dir = grokHooksDir()
    fs.mkdirSync(dir, { recursive: true })
    const unrelatedPath = path.join(dir, 'some-other-tool.json')
    fs.writeFileSync(unrelatedPath, '{"hooks":{}}\n')

    installGrok()

    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('{"hooks":{}}\n')
  })

  it('backs up a hand-edited hooks config (with the OLD content) before overwriting it on reinstall', () => {
    const result = installGrok()
    const handEdited = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'custom' }] }] } })
    fs.writeFileSync(result.configPath, handEdited)

    installGrok()

    const dir = path.dirname(result.configPath)
    const bakFiles = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(result.configPath) + '.bak.'))
    expect(bakFiles.length).toBe(1)
    expect(fs.readFileSync(path.join(dir, bakFiles[0] as string), 'utf8')).toBe(handEdited)
    expect(fs.readFileSync(result.configPath, 'utf8')).not.toBe(handEdited)
  })

  it('does not create a spurious .bak file when reinstalling with no actual config change', () => {
    const result = installGrok()
    installGrok()

    const dir = path.dirname(result.configPath)
    const bakFiles = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(result.configPath) + '.bak.'))
    expect(bakFiles.length).toBe(0)
  })
})

describe('isGrokInstalled / uninstallGrok', () => {
  it('isGrokInstalled is false before install, true after', () => {
    expect(isGrokInstalled()).toBe(false)
    installGrok()
    expect(isGrokInstalled()).toBe(true)
  })

  it('uninstallGrok removes the config and the shim script, and returns true', () => {
    const result = installGrok()
    expect(uninstallGrok()).toBe(true)
    expect(isGrokInstalled()).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(false)
    expect(fs.existsSync(result.hookScriptPath)).toBe(false)
  })

  it('uninstallGrok returns false when nothing is installed', () => {
    expect(uninstallGrok()).toBe(false)
  })

  it("uninstallGrok removes exactly token-goat's entries, leaving an unrelated sibling file in the hooks dir intact", () => {
    const dir = grokHooksDir()
    fs.mkdirSync(dir, { recursive: true })
    const unrelatedPath = path.join(dir, 'some-other-tool.json')
    fs.writeFileSync(unrelatedPath, '{"hooks":{}}\n')

    installGrok()
    uninstallGrok()

    expect(fs.existsSync(unrelatedPath)).toBe(true)
    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('{"hooks":{}}\n')
  })
})

// --- shim script (GROK_HOOK_SCRIPT) behavior ---
// Mirrors tests/install_copilot_cli.test.ts's approach: run the embedded script as a
// standalone Node process exactly as Grok would (argv[2] = internal event arg, stdin
// = the raw hook payload JSON), and inspect what it writes to stdout / its exit code.

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function mkIsolated(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'tg-grok-shim-test-'))
  tempDirs.push(dir)
  return dir
}

function runShim(eventArg: string, stdin: string, cwd: string, env?: NodeJS.ProcessEnv): { stdout: string; status: number | null } {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, GROK_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventArg], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: env ?? process.env,
  })
  return { stdout: res.stdout ?? '', status: res.status }
}

/**
 * Writes a fake `token-goat` executable into `cwd` and returns a PATH-prepended env
 * pointing at it, so the shim's internal `spawnSync('token-goat hook <event>', {shell: true})`
 * fallback resolves to `jsonStdout` instead of the real installed binary.
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

/**
 * Writes a fake token-goat "entry" -- a plain Node script, not a PATH-resolvable binary --
 * that records the argv it was invoked with and exits 0 with a caller-supplied JSON body.
 */
function writeFakeEntry(cwd: string, jsonStdout = '{}'): { entryPath: string; capturePath: string } {
  const entryPath = path.join(cwd, 'fake-entry.js')
  const capturePath = path.join(cwd, 'captured-argv.json')
  const captureLiteral = JSON.stringify(capturePath)
  const bodyLiteral = JSON.stringify(jsonStdout)
  fs.writeFileSync(
    entryPath,
    `require('fs').writeFileSync(${captureLiteral}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write(${bodyLiteral})\n`,
    'utf8',
  )
  return { entryPath, capturePath }
}

describe('GROK_HOOK_SCRIPT', () => {
  it('invokes the baked entry path (argv[3]) directly via process.execPath, bypassing PATH resolution entirely, when the shim receives one', () => {
    const cwd = mkIsolated()
    const { entryPath, capturePath } = writeFakeEntry(cwd)
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, GROK_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
      cwd,
      input: JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'run_terminal_command', toolInput: { command: 'npm test' } }),
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    expect(res.status).toBe(0)
    expect(fs.existsSync(capturePath)).toBe(true)
    const capturedArgv = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as string[]
    expect(capturedArgv).toEqual(['hook', 'pre_tool_use'])
  })

  it('no-ops (allow) on an event name it does not recognize', () => {
    const cwd = mkIsolated()
    const { stdout } = runShim('not_a_real_event', '{}', cwd)
    expect(stdout.trim()).toBe('{}')
  })

  it('fails open ({"decision":"allow"}) on malformed JSON on stdin for pre_tool_use', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, '{}')
    const { stdout, status } = runShim('pre_tool_use', 'not json', cwd, env)
    expect(stdout.trim()).toBe('{"decision":"allow"}')
    expect(status).toBe(0)
  })

  it('fails open ({"decision":"allow"}) when the token-goat child process exits non-zero', () => {
    const cwd = mkIsolated()
    const scriptPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    if (process.platform === 'win32') {
      fs.writeFileSync(scriptPath, '@echo off\r\nexit /b 1\r\n', 'utf8')
    } else {
      fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 1\n', 'utf8')
      fs.chmodSync(scriptPath, 0o755)
    }
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
    const { stdout, status } = runShim('pre_tool_use', '{}', cwd, env)
    expect(stdout.trim()).toBe('{"decision":"allow"}')
    expect(status).toBe(0)
  })

  it('translates a pre_tool_use deny (decision:"block") into {"decision":"deny",reason} AND sets exit code 2', () => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd, JSON.stringify({ decision: 'block', reason: 'already read this session' }))
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, GROK_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
      cwd,
      input: JSON.stringify({ sessionId: 's1', toolName: 'read_file' }),
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    const parsed = JSON.parse(res.stdout ?? '{}') as { decision: string; reason: string }
    expect(parsed.decision).toBe('deny')
    expect(parsed.reason).toBe('already read this session')
    expect(res.status).toBe(2)
  })

  it('translates a non-blocking pre_tool_use response into {"decision":"allow"} with exit code 0', () => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd, JSON.stringify({}))
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, GROK_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
      cwd,
      input: JSON.stringify({ sessionId: 's1', toolName: 'read_file' }),
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    expect(JSON.parse(res.stdout ?? '{}')).toEqual({ decision: 'allow' })
    expect(res.status).toBe(0)
  })

  it('forwards a post_tool_use response verbatim (Grok ignores stdout for passive events, per the hooks doc)', () => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd, JSON.stringify({ hookSpecificOutput: { additionalContext: 'you already read this file' } }))
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, GROK_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'post_tool_use', entryPath], {
      cwd,
      input: JSON.stringify({ sessionId: 's1', toolName: 'read_file' }),
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    const parsed = JSON.parse(res.stdout ?? '{}') as { hookSpecificOutput?: { additionalContext?: string } }
    expect(parsed.hookSpecificOutput?.additionalContext).toBe('you already read this file')
    expect(res.status).toBe(0)
  })

  it('never propagates an uncaught exception or an unexpected exit code, even for adversarial/malformed payloads', () => {
    const cwd = mkIsolated()
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, GROK_HOOK_SCRIPT, 'utf8')
    const env = withFakeTokenGoat(cwd, JSON.stringify({ decision: 'block' }))

    const adversarialStdins = ['[1,2,3]', '"just a string"', '42', 'null', JSON.stringify({ toolName: { nested: 'weird' } })]

    for (const stdin of adversarialStdins) {
      const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use'], {
        cwd,
        input: stdin,
        encoding: 'utf8',
        timeout: 15000,
        env,
      })
      expect([0, 2]).toContain(res.status)
      expect(() => JSON.parse(res.stdout ?? '')).not.toThrow()
    }
  })

  it('every internal event name it lists is a real HOOK_EVENTS member', () => {
    const mapMatch = /VALID_HOOK_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(GROK_HOOK_SCRIPT)
    expect(mapMatch).not.toBeNull()
    const events = [...(mapMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    // 7 entries: pre_tool_use, post_tool_use, notification, stop, pre_compact,
    // user_prompt_submit, subagent_stop.
    expect(events.length).toBe(7)
    for (const eventName of events) {
      expect(HOOK_EVENTS as readonly string[]).toContain(eventName)
    }
  })
})
