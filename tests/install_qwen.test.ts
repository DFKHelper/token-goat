import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.qwen/` (mirrors install_gemini.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  QwenSettingsParseError,
  installQwen,
  isQwenInstalled,
  qwenSettingsPath,
  uninstallQwen,
} from '../src/bridges/qwen_install.js'

interface QwenHookEntry {
  type: string
  command: string
}
interface QwenMatcherGroup {
  matcher?: string
  hooks?: QwenHookEntry[]
}
interface QwenSettingsShape {
  hooks?: Record<string, QwenMatcherGroup[]>
  [key: string]: unknown
}

function readSettings(): QwenSettingsShape {
  return JSON.parse(fs.readFileSync(qwenSettingsPath(), 'utf8')) as QwenSettingsShape
}

function commandsFor(settings: QwenSettingsShape, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
}

const QWEN_EVENTS = ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop']
const QWEN_EVENT_ARG: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStop: 'subagent_stop',
}

let TMP: string
let originalArgv1: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-qwen-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
  // Same rationale as install_gemini.test.ts: installQwen/isQwenInstalled/uninstallQwen identify
  // their own hook commands via process.argv[1] containing a "token-goat" path segment
  // (QWEN_ENTRY_PATH_MARKER_PATTERN), which tinypool's worker entry path does not satisfy by
  // default -- stub it to a realistic token-goat entry path for deterministic tests.
  originalArgv1 = process.argv[1]
  process.argv[1] = path.join(TMP, 'node_modules', 'token-goat', 'dist', 'token-goat.mjs')
})

afterEach(() => {
  process.argv[1] = originalArgv1
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installQwen', () => {
  it('writes settings.json with token-goat hook entries under all five Qwen events on a fresh install, each with a catch-all matcher', () => {
    const result = installQwen()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.settingsPath)).toBe(true)

    const settings = readSettings()
    expect(process.argv[1]).toBeDefined()

    for (const event of QWEN_EVENTS) {
      const groups = settings.hooks?.[event]
      expect(groups).toHaveLength(1)
      expect(groups?.[0]?.matcher).toBe('')
      const commands = commandsFor(settings, event)
      expect(commands).toHaveLength(1)
      const command = commands[0] as string
      expect(command).toContain(`"${process.execPath}"`)
      expect(command.startsWith('node ')).toBe(false)
      expect(command).toContain(`"${process.argv[1]}"`)
      expect(command.endsWith(`hook ${QWEN_EVENT_ARG[event]}`)).toBe(true)
    }

    expect(isQwenInstalled()).toBe(true)
  })

  it('is idempotent (second call reports alreadyInstalled and does not duplicate entries)', () => {
    installQwen()
    const second = installQwen()
    expect(second.alreadyInstalled).toBe(true)

    const settings = readSettings()
    for (const event of QWEN_EVENTS) {
      expect(commandsFor(settings, event)).toHaveLength(1)
    }
  })

  it('repairs a stale baked entry path in an existing token-goat hook command instead of leaving it in place', () => {
    installQwen()
    const p = qwenSettingsPath()
    const jsonEscapedEntryPath = process.argv[1]!.replace(/\\/g, '\\\\')
    const entryPathPattern = new RegExp(jsonEscapedEntryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const staleContent = fs.readFileSync(p, 'utf8').replace(entryPathPattern, '/some/stale/old-install-path/token-goat.mjs')
    fs.writeFileSync(p, staleContent)
    expect(readSettings().hooks?.['PreToolUse']).toBeDefined()

    const result = installQwen()

    expect(result.alreadyInstalled).toBe(false)
    const settings = readSettings()
    for (const event of QWEN_EVENTS) {
      for (const command of commandsFor(settings, event)) {
        expect(command).not.toContain('old-install-path')
        expect(command).toContain(`"${process.argv[1]}"`)
      }
    }
  })

  it('preserves pre-existing unrelated settings.json keys and hook entries', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            PreToolUse: [{ matcher: 'my_own_tool', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
          },
        },
        null,
        2,
      ),
    )

    installQwen()

    const settings = readSettings()
    expect(settings['theme']).toBe('dark')
    const beforeCommands = commandsFor(settings, 'PreToolUse')
    expect(beforeCommands).toContain('my-own-hook.sh')
    expect(beforeCommands.some((c) => c.endsWith('hook pre_tool_use'))).toBe(true)
    const groups = settings.hooks?.['PreToolUse'] ?? []
    expect(groups.some((g) => g.matcher === 'my_own_tool')).toBe(true)
  })

  it('throws on an existing settings.json with invalid JSON, and leaves the file byte-for-byte untouched', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const corrupt = '{ "theme": "dark", }'
    fs.writeFileSync(p, corrupt)

    expect(() => installQwen()).toThrow(QwenSettingsParseError)
    expect(() => installQwen()).toThrow(/invalid JSON/)

    expect(fs.readFileSync(p, 'utf8')).toBe(corrupt)
  })

  it('throws on an existing settings.json whose top-level value is not an object, and leaves the file untouched', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const nonObject = '[1, 2, 3]'
    fs.writeFileSync(p, nonObject)

    expect(() => installQwen()).toThrow(QwenSettingsParseError)
    expect(() => installQwen()).toThrow(/does not contain a JSON object/)
    expect(fs.readFileSync(p, 'utf8')).toBe(nonObject)
  })

  it('upgrades a legacy bare "token-goat hook <event>" command to the current exec-path-hardened form on re-install, instead of treating it as already installed', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const legacySettings = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'token-goat hook pre_tool_use' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'token-goat hook post_tool_use' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'token-goat hook pre_compact' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'token-goat hook user_prompt_submit' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'token-goat hook subagent_stop' }] }],
      },
    }
    fs.writeFileSync(p, JSON.stringify(legacySettings, null, 2))

    const result = installQwen()
    expect(result.alreadyInstalled).toBe(false)

    const settings = readSettings()
    const allCommands = QWEN_EVENTS.flatMap((event) => commandsFor(settings, event))
    for (const event of QWEN_EVENTS) {
      expect(allCommands.some((c) => c === `token-goat hook ${QWEN_EVENT_ARG[event]}`)).toBe(false)
    }
    for (const event of QWEN_EVENTS) {
      for (const command of commandsFor(settings, event)) {
        expect(command).toContain(`"${process.execPath}"`)
        expect(command).toContain(`"${process.argv[1]}"`)
      }
    }
  })
})

describe('isQwenInstalled / uninstallQwen', () => {
  it('isQwenInstalled is false before install, true after', () => {
    expect(isQwenInstalled()).toBe(false)
    installQwen()
    expect(isQwenInstalled()).toBe(true)
  })

  it('isQwenInstalled is false when only some of the required entries are present', () => {
    installQwen()
    const p = qwenSettingsPath()
    const settings = readSettings()
    settings.hooks = settings.hooks ?? {}
    delete settings.hooks['SubagentStop']
    fs.writeFileSync(p, JSON.stringify(settings, null, 2))

    expect(isQwenInstalled()).toBe(false)

    installQwen()
    expect(isQwenInstalled()).toBe(true)
  })

  it('uninstallQwen removes the hook entries and returns true', () => {
    installQwen()
    expect(uninstallQwen()).toBe(true)
    expect(isQwenInstalled()).toBe(false)

    const settings = readSettings()
    expect(settings.hooks).toBeUndefined()
  })

  it('uninstallQwen returns false when nothing is installed', () => {
    expect(uninstallQwen()).toBe(false)
  })

  it('uninstall leaves unrelated settings.json keys and hook entries intact', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            PreToolUse: [{ matcher: 'my_own_tool', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
          },
        },
        null,
        2,
      ),
    )

    installQwen()
    uninstallQwen()

    const settings = readSettings()
    expect(settings['theme']).toBe('dark')
    const beforeCommands = commandsFor(settings, 'PreToolUse')
    expect(beforeCommands).toContain('my-own-hook.sh')
    expect(beforeCommands.some((c) => c.endsWith('hook pre_tool_use'))).toBe(false)
  })

  it('does not strip an unrelated hook whose command merely contains "token-goat hook" as a substring inside a longer identifier', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: 'my_own_tool', hooks: [{ type: 'command', command: 'my-wrapper-token-goat hooked-script.sh' }] },
            ],
          },
        },
        null,
        2,
      ),
    )

    installQwen()
    uninstallQwen()

    const settings = readSettings()
    const beforeCommands = commandsFor(settings, 'PreToolUse')
    expect(beforeCommands).toContain('my-wrapper-token-goat hooked-script.sh')
  })

  it('does not recognize a same-shape command from an unrelated tool as token-goat\'s own', () => {
    const p = qwenSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'my_own_tool',
                hooks: [
                  {
                    type: 'command',
                    command: '"C:/some/other/node.exe" "C:/some/other/tool.js" hook pre_tool_use',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    )

    installQwen()
    uninstallQwen()

    const settings = readSettings()
    const beforeCommands = commandsFor(settings, 'PreToolUse')
    expect(beforeCommands).toContain('"C:/some/other/node.exe" "C:/some/other/tool.js" hook pre_tool_use')
    expect(beforeCommands.some((c) => c.includes(process.execPath))).toBe(false)
  })

  it('writes a timestamped .bak of settings.json before removing entries', () => {
    installQwen()
    uninstallQwen()

    const p = qwenSettingsPath()
    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })
})
