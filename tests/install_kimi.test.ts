import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parse, stringify } from 'smol-toml'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so the KIMI_CODE_HOME-unset cases below resolve `~` to an isolated
// temp dir instead of touching a real `~/.kimi-code/` (mirrors install_qwen.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  KimiConfigParseError,
  KIMI_HOOK_EVENTS,
  installKimi,
  isKimiInstalled,
  kimiAgentsPath,
  kimiConfigPath,
  kimiHome,
  kimiHookScriptPath,
  kimiSkillPath,
  uninstallKimi,
} from '../src/bridges/kimi_install.js'

interface KimiHookEntry {
  event?: string
  matcher?: string
  command?: string
  timeout?: number
}
interface KimiConfigShape {
  hooks?: KimiHookEntry[]
  [key: string]: unknown
}

function readConfig(): KimiConfigShape {
  return parse(fs.readFileSync(kimiConfigPath(), 'utf8')) as KimiConfigShape
}

/** The internal event arg each wired Kimi event maps onto, restated here rather than imported so a silent flip in the source table fails this test. */
const KIMI_EVENT_ARG: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStop: 'subagent_stop',
  SessionStart: 'session_start',
}

let TMP: string
let originalArgv1: string
let originalKimiHome: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-kimi-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
  originalKimiHome = process.env['KIMI_CODE_HOME']
  delete process.env['KIMI_CODE_HOME']
  // Same rationale as install_qwen.test.ts: the installer identifies its own hook
  // commands by a "token-goat" path segment in the baked command, which tinypool's
  // worker entry path does not satisfy -- stub argv[1] to a realistic entry path.
  originalArgv1 = process.argv[1]
  process.argv[1] = path.join(TMP, 'node_modules', 'token-goat', 'dist', 'token-goat.mjs')
})

afterEach(() => {
  process.argv[1] = originalArgv1
  if (originalKimiHome === undefined) {
    delete process.env['KIMI_CODE_HOME']
  } else {
    process.env['KIMI_CODE_HOME'] = originalKimiHome
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('kimiHome', () => {
  it('defaults to ~/.kimi-code, the data root Kimi Code documents', () => {
    expect(kimiHome()).toBe(path.join(TMP, '.kimi-code'))
  })

  it('follows KIMI_CODE_HOME when set, so an isolated Kimi data root gets its own install', () => {
    const alt = path.join(TMP, 'alt-root')
    process.env['KIMI_CODE_HOME'] = alt
    expect(kimiHome()).toBe(path.resolve(alt))
    expect(kimiConfigPath()).toBe(path.join(path.resolve(alt), 'config.toml'))
  })

  it('ignores a blank KIMI_CODE_HOME rather than installing into the process working directory', () => {
    process.env['KIMI_CODE_HOME'] = '   '
    expect(kimiHome()).toBe(path.join(TMP, '.kimi-code'))
  })
})

describe('installKimi', () => {
  it('writes one [[hooks]] entry per wired event, each naming the absolute node binary, the shim and the internal event arg', () => {
    const result = installKimi()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(true)

    const config = readConfig()
    const hooks = config.hooks ?? []
    expect(hooks).toHaveLength(KIMI_HOOK_EVENTS.length)
    expect(KIMI_HOOK_EVENTS).toEqual(['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop', 'SessionStart'])

    for (const event of KIMI_HOOK_EVENTS) {
      const entry = hooks.find((h) => h.event === event)
      expect(entry, `no [[hooks]] entry for ${event}`).toBeDefined()
      const command = entry?.command ?? ''
      expect(command).toContain(`"${process.execPath}"`)
      expect(command.startsWith('node ')).toBe(false)
      expect(command).toContain(`"${kimiHookScriptPath()}"`)
      expect(command).toContain(` ${KIMI_EVENT_ARG[event] ?? 'MISSING'}`)
    }
  })

  it("writes only keys Kimi's strict [[hooks]] schema accepts, since an unknown key makes the whole config file fail to load", () => {
    installKimi()
    for (const entry of readConfig().hooks ?? []) {
      expect(Object.keys(entry).sort()).toEqual(['command', 'event'])
    }
  })

  it('writes the shim script, the AGENTS.md guidance block and the SKILL.md the Kimi skill loader requires', () => {
    const result = installKimi()

    const shim = fs.readFileSync(result.hookScriptPath, 'utf8')
    expect(shim).toContain("process.env.TOKEN_GOAT_HARNESS_OVERRIDE = 'kimi'")
    expect(shim).toContain('permissionDecision')

    const agents = fs.readFileSync(result.agentsPath, 'utf8')
    expect(agents).toContain('<!-- token-goat-kimi-begin -->')
    expect(agents).toContain('<!-- token-goat-kimi-end -->')
    expect(agents).toContain('## token-goat')

    const skill = fs.readFileSync(result.skillPath, 'utf8')
    expect(skill.startsWith('---\nname: token-goat\ndescription: ')).toBe(true)
    // Kimi's SKILL.md frontmatter schema has no allowed-tools field; writing one would be
    // invented surface. Scoped to the frontmatter block, since the shared gate body legitimately
    // mentions the phrase in prose.
    const frontmatter = skill.slice(0, skill.indexOf('\n---', 3) + 4)
    expect(frontmatter).not.toContain('allowed-tools')
    expect(frontmatter.split('\n').filter((l) => l !== '---')).toHaveLength(2)
    expect(skill).toContain('## token-goat')
    expect(result.skillPath).toBe(path.join(kimiHome(), 'skills', 'token-goat', 'SKILL.md'))
  })

  it('preserves unrelated config keys and foreign hook entries instead of clobbering them', () => {
    fs.mkdirSync(kimiHome(), { recursive: true })
    fs.writeFileSync(
      kimiConfigPath(),
      ['default_model = "kimi-k2"', '', '[[hooks]]', 'event = "Notification"', 'command = "notify-send hi"', ''].join('\n'),
    )

    installKimi()

    const config = readConfig()
    expect(config['default_model']).toBe('kimi-k2')
    const foreign = (config.hooks ?? []).filter((h) => h.command === 'notify-send hi')
    expect(foreign).toHaveLength(1)
    expect(foreign[0]?.event).toBe('Notification')
    expect(config.hooks ?? []).toHaveLength(KIMI_HOOK_EVENTS.length + 1)
  })

  it('is idempotent: a second install reports alreadyInstalled and adds no duplicate entry', () => {
    installKimi()
    const second = installKimi()
    expect(second.alreadyInstalled).toBe(true)
    expect(readConfig().hooks ?? []).toHaveLength(KIMI_HOOK_EVENTS.length)
  })

  it('upgrades a stale baked entry path in place rather than leaving a dead duplicate beside the current one', () => {
    installKimi()
    const stale = readConfig()
    const hooks = stale.hooks ?? []
    expect(hooks[0]).toBeDefined()
    hooks[0] = { event: 'PreToolUse', command: '"/old/node" "/old/token-goat/dist/token-goat.mjs" pre_tool_use' }
    fs.writeFileSync(kimiConfigPath(), stringify(stale as Record<string, unknown>))

    const result = installKimi()

    expect(result.alreadyInstalled).toBe(false)
    const after = readConfig().hooks ?? []
    expect(after).toHaveLength(KIMI_HOOK_EVENTS.length)
    expect(after.some((h) => h.command?.includes('/old/token-goat/'))).toBe(false)
  })

  it('refuses to touch a config.toml that exists but is not parseable, so a recoverable file is never clobbered', () => {
    fs.mkdirSync(kimiHome(), { recursive: true })
    fs.writeFileSync(kimiConfigPath(), 'this is [not valid = toml')
    expect(() => installKimi()).toThrow(KimiConfigParseError)
    expect(fs.readFileSync(kimiConfigPath(), 'utf8')).toBe('this is [not valid = toml')
  })
})

describe('isKimiInstalled', () => {
  it('is false before install, true after, and false again once the hook entries are gone', () => {
    expect(isKimiInstalled()).toBe(false)
    installKimi()
    expect(isKimiInstalled()).toBe(true)
    uninstallKimi()
    expect(isKimiInstalled()).toBe(false)
  })

  it('is false when only some events are wired, so a partial install is not reported as complete', () => {
    installKimi()
    const config = readConfig()
    config.hooks = (config.hooks ?? []).filter((h) => h.event !== 'SessionStart')
    fs.writeFileSync(kimiConfigPath(), stringify(config as Record<string, unknown>))
    expect(isKimiInstalled()).toBe(false)
  })
})

describe('uninstallKimi', () => {
  it('removes token-goat hook entries, the shim, the skill and the AGENTS.md block, keeping foreign content', () => {
    fs.mkdirSync(kimiHome(), { recursive: true })
    fs.writeFileSync(kimiAgentsPath(), 'my own notes\n')
    fs.writeFileSync(
      kimiConfigPath(),
      ['default_model = "kimi-k2"', '', '[[hooks]]', 'event = "Notification"', 'command = "notify-send hi"', ''].join('\n'),
    )
    installKimi()
    expect(fs.existsSync(kimiSkillPath())).toBe(true)

    expect(uninstallKimi()).toBe(true)

    const config = readConfig()
    expect(config['default_model']).toBe('kimi-k2')
    expect(config.hooks ?? []).toEqual([{ event: 'Notification', command: 'notify-send hi' }])
    expect(fs.existsSync(kimiHookScriptPath())).toBe(false)
    expect(fs.existsSync(kimiSkillPath())).toBe(false)
    const agents = fs.readFileSync(kimiAgentsPath(), 'utf8')
    expect(agents).toContain('my own notes')
    expect(agents).not.toContain('token-goat-kimi-begin')
  })

  it('drops the hooks key entirely when token-goat wrote every entry, leaving no empty array behind', () => {
    installKimi()
    uninstallKimi()
    expect(readConfig().hooks).toBeUndefined()
  })

  it('returns false when there is nothing to remove', () => {
    expect(uninstallKimi()).toBe(false)
  })
})
