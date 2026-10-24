/** The Bash-only backslash deny and quote hint do not run on a PowerShell-tool call. PROVENANCE: the halving the deny exists for is CAPTURE (tests/bash_double_backslash_deny.test.ts header); the PowerShell here-string and backtick-escape syntax is FORMAT-DERIVED from https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_quoting_rules (read 2026-10-22); every command string is HAND-DERIVED. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { invalidateConfigCache } from '../src/config.js'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'

// A UNC path opens with two backslashes, which is a plain path to PowerShell and the damaged shape to Git Bash.
const UNC = 'Get-ChildItem \\\\server\\share\\dir'
// A here-string holds quotes that are text, and a backtick escapes a quote: neither is an unclosed quote.
const HERE_STRING = "$t = @'\nit's a \"quoted\" line\n'@\nWrite-Output $t"
const BACKTICK_QUOTE = 'Write-Output "say `"hi`" now"'

function shellEvent(toolName: 'Bash' | 'PowerShell', command: string): HookEvent {
  return makeHookEvent({
    toolName,
    toolInput: { command },
    sessionId: 'ps-bash-only-session',
    raw: { tool_name: toolName, tool_input: { command }, _tg_harness: 'claude' },
  })
}

function isBackslashDeny(result: ReturnType<typeof preBashHandler>): boolean {
  return result.hookType === 'deny' && result.message.includes('two backslashes in a row')
}

describe('preBashHandler -- Bash-only checks skip the PowerShell tool', () => {
  const realPlatform = process.platform
  let configDir = ''

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ps-bashonly-'))
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(curl:*)'] } }))
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
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
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('control: the Bash tool is still denied for a run of two backslashes', () => {
    expect(isBackslashDeny(preBashHandler(shellEvent('Bash', UNC)))).toBe(true)
  })

  it('does not deny a PowerShell-tool UNC path', () => {
    const result = preBashHandler(shellEvent('PowerShell', UNC))
    expect(isBackslashDeny(result), `result for a PowerShell UNC path: ${result.hookType}`).toBe(false)
  })

  it('control: the Bash tool still gets the unclosed-quote hint', () => {
    const result = preBashHandler(shellEvent('Bash', 'echo "unterminated'))
    expect(result.hookType).toBe('context')
  })

  it.each([
    ['a here-string', HERE_STRING],
    ['a backtick-escaped quote', BACKTICK_QUOTE],
  ])('gives %s no unclosed-quote hint on the PowerShell tool', (_name, command) => {
    const result = preBashHandler(shellEvent('PowerShell', command))
    const hint = result.hookType === 'context' ? result.context : ''
    expect(hint, `hint for ${_name}`).not.toContain('unclosed')
  })
})
