// Provenance: the halving itself is CAPTURE -- a probe spawning Git Bash (`C:/Program Files/Git/usr/bin/bash.exe -c <cmd>`) through Node's child_process on Windows 11 with runs of one to five backslashes before letters, quotes, spaces and the end of the argument: every run of two or more arrived shortened, a lone one arrived intact. Upstream report: anthropics/claude-code#85856. The gating cases below are HAND-DERIVED from that finding: the deny must fire only where the halving happens (Windows, Claude Code's Bash tool) and only for a run of two or more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, loadConfig, saveConfig } from '../src/config.js'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'

// Two backslashes in a row, the shape the deny exists for: a Windows path with escaped separators, as a model writes it inside a quoted string.
const DOUBLE = 'printf "%s" "C:\\\\Users\\\\me"'
// One backslash: never halved, so it must never be denied.
const SINGLE = 'printf "a\\tb"'

function bashEvent(command: string, harness = 'claude'): HookEvent {
  return makeHookEvent({
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'dbl-backslash-session',
    raw: { tool_name: 'Bash', tool_input: { command }, _tg_harness: harness },
  })
}

function isBackslashDeny(result: ReturnType<typeof preBashHandler>): boolean {
  return result.hookType === 'deny' && result.message.includes('two backslashes in a row')
}

describe('preBashHandler -- denies a run of two backslashes in Claude Code on Windows', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', '')
    vi.stubEnv('HERMES_SESSION_ID', '')
    vi.stubEnv('HERMES_HOME', '')
    vi.stubEnv('CLAUDE_CODE_VERSION', '2.1.0')
    vi.stubEnv('TOKEN_GOAT_DENY_BASH_DOUBLE_BACKSLASH', '')
    clearModuleCaches()
    invalidateConfigCache()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.unstubAllEnvs()
    clearModuleCaches()
    invalidateConfigCache()
  })

  it('the fixtures hold what their names say', () => {
    expect(DOUBLE).toContain('\\\\')
    expect(SINGLE).toContain('\\')
    expect(SINGLE).not.toContain('\\\\')
  })

  it('denies, and the message names the Write tool, the PowerShell tool and the off switch', () => {
    const result = preBashHandler(bashEvent(DOUBLE))
    expect(isBackslashDeny(result)).toBe(true)
    if (result.hookType !== 'deny') throw new Error('unreachable')
    expect(result.message.startsWith('[tg] ')).toBe(true)
    expect(result.message).toContain('Write tool')
    expect(result.message).toContain('PowerShell tool')
    expect(result.message).toContain('anthropics/claude-code#85856')
    expect(result.message).toContain('hints.deny_bash_double_backslash = false')
    expect(result.message).toContain('TOKEN_GOAT_DENY_BASH_DOUBLE_BACKSLASH=0')
  })

  it('denies a run longer than two as well', () => {
    expect(isBackslashDeny(preBashHandler(bashEvent('echo a\\\\\\b')))).toBe(true)
  })

  it('lets a single backslash through', () => {
    expect(isBackslashDeny(preBashHandler(bashEvent(SINGLE)))).toBe(false)
  })

  it('lets it through off Windows, where nothing halves the command', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(isBackslashDeny(preBashHandler(bashEvent(DOUBLE)))).toBe(false)
  })

  it('lets it through for a bridged harness that normalizes to something other than claude', () => {
    expect(isBackslashDeny(preBashHandler(bashEvent(DOUBLE, 'codex')))).toBe(false)
  })

  it('lets it through when the caller is not Claude Code, even though its payload normalizes to claude', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'opencode')
    expect(isBackslashDeny(preBashHandler(bashEvent(DOUBLE)))).toBe(false)
  })

  it('lets it through when the setting is off in the config file', () => {
    // Through saveConfig and back, so a serializer that dropped the key would load the default and fail here.
    const cfg = defaultConfig()
    cfg.hints.deny_bash_double_backslash = false
    saveConfig(cfg)
    invalidateConfigCache()
    try {
      expect(loadConfig().hints.deny_bash_double_backslash).toBe(false)
      expect(isBackslashDeny(preBashHandler(bashEvent(DOUBLE)))).toBe(false)
    } finally {
      saveConfig(defaultConfig())
      invalidateConfigCache()
    }
  })

  it('lets it through when the environment switch is 0', () => {
    vi.stubEnv('TOKEN_GOAT_DENY_BASH_DOUBLE_BACKSLASH', '0')
    invalidateConfigCache()
    expect(isBackslashDeny(preBashHandler(bashEvent(DOUBLE)))).toBe(false)
  })

  it('is on by default', () => {
    expect(loadConfig().hints.deny_bash_double_backslash).toBe(true)
  })
})
