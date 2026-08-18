import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.codex/` (mirrors the pattern in project_memory.test.ts /
// cli_context_stats.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { parse, stringify } from 'smol-toml'

import {
  CodexConfigParseError,
  codexAgentsPath,
  codexConfigPath,
  codexHookCommandFor,
  computeCodexHookHash,
  installCodex,
  isCodexInstalled,
  uninstallCodex,
} from '../src/bridges/codex_install.js'

interface CodexHookEntry {
  type: string
  command: string
}
interface CodexMatcherGroup {
  matcher?: string
  hooks?: CodexHookEntry[]
}
interface CodexConfigShape {
  hooks?: Record<string, CodexMatcherGroup[]>
  [key: string]: unknown
}

function readConfig(): CodexConfigShape {
  return parse(fs.readFileSync(codexConfigPath(), 'utf8')) as CodexConfigShape
}

function commandsFor(config: CodexConfigShape, event: string): string[] {
  return (config.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
}

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('codexHookCommandFor', () => {
  const realPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('prefixes with "& " on Windows (win32) so PowerShell does not throw a ParserError on adjacent string literals', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const cmd = codexHookCommandFor('C:\\path\\to\\shim.js', 'pre_compact')
    expect(cmd.startsWith('& ')).toBe(true)
    expect(cmd).toContain('pre_compact')
    expect(cmd).toContain('"C:\\path\\to\\shim.js"')
  })

  it('does not prefix with "& " on non-Windows (linux/darwin) so POSIX sh does not treat it as a background operator', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const cmd = codexHookCommandFor('/path/to/shim.js', 'pre_compact')
    expect(cmd.startsWith('& ')).toBe(false)
    expect(cmd.startsWith('"')).toBe(true)
    expect(cmd).toContain('pre_compact')
  })
})

describe('computeCodexHookHash', () => {
  it('computes the canonical sha256 hash matching Codex CLIs [hooks.state] format for matcher-scoped hooks', () => {
    const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\.codex\\hooks\\token-goat-shim.js" pre_tool_use "C:\\Users\\user\\dist\\token-goat.mjs"'
    const hash = computeCodexHookHash('pre_tool_use', cmd, 'view_image|Bash')
    expect(hash.startsWith('sha256:')).toBe(true)
    expect(hash).toHaveLength(71) // 'sha256:' (7) + 64 hex chars
  })

  it('computes the canonical sha256 hash matching Codex CLIs [hooks.state] format for global matcher-less hooks', () => {
    const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\.codex\\hooks\\token-goat-shim.js" pre_compact "C:\\Users\\user\\dist\\token-goat.mjs"'
    const hash = computeCodexHookHash('pre_compact', cmd)
    expect(hash.startsWith('sha256:')).toBe(true)
    expect(hash).toHaveLength(71)
  })
})

describe('installCodex', () => {
  it('writes the config.toml hooks block and the AGENTS.md delimited block on a fresh install', () => {
    const result = installCodex()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(true)
    expect(fs.existsSync(result.agentsPath)).toBe(true)
    expect(fs.existsSync(result.hookScriptPath)).toBe(true)

    const config = readConfig()
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const matchers = (config.hooks?.[event] ?? []).map((g) => g.matcher)
      expect(matchers).toContain('view_image|Bash')
      expect(matchers).toContain('apply_patch')
      expect(matchers).toContain('web_search')
      for (const command of commandsFor(config, event)) {
        expect(command).toContain('token-goat-shim')
      }
    }

    const agents = fs.readFileSync(result.agentsPath, 'utf8')
    expect(agents).toContain('<!-- token-goat-codex-begin -->')
    expect(agents).toContain('<!-- token-goat-codex-end -->')
    expect(agents).toContain('Codex\'s native `shell`, `apply_patch`, and `view_image` tools')
    expect(agents).toContain('shell commands like `cat`/`type` run inside `shell`')
    expect(agents).toContain('Fallback clauses may name')

    // Verifies all token-goat hooks have trusted_hash set in [hooks.state]
    const state = (config.hooks?.['state'] as unknown as Record<string, { trusted_hash?: string }>) ?? {}
    expect(Object.keys(state).length).toBeGreaterThanOrEqual(9) // 3 PreToolUse + 3 PostToolUse + 3 global
    for (const [key, val] of Object.entries(state)) {
      expect(key.startsWith(result.configPath)).toBe(true)
      expect(val.trusted_hash?.startsWith('sha256:')).toBe(true)
    }

    expect(isCodexInstalled()).toBe(true)
  })

  // Regression coverage for the parity-matrix gap found via feature-queue #307's
  // static capability audit: codex_install.ts wired PreToolUse/PostToolUse only,
  // even though Codex's real hooks API (developers.openai.com/codex/hooks) also
  // supports PreCompact/UserPromptSubmit/SubagentStop -- the same three events
  // Claude Code (install.ts's HOOK_EVENT_MAP) and Grok (grok_install.ts) already
  // wire to token-goat's real registered handlers.
  it('writes matcher-less PreCompact/UserPromptSubmit/SubagentStop hook entries on a fresh install', () => {
    installCodex()
    const config = readConfig()
    for (const event of ['PreCompact', 'UserPromptSubmit', 'SubagentStop']) {
      const groups = config.hooks?.[event] ?? []
      // Fresh install: stripStaleGroupHooks finds nothing to strip, so installCodex pushes
      // exactly one matcher-less group per global event.
      expect(groups.length).toBe(1)
      const commands = commandsFor(config, event)
      expect(commands.some((c) => c.includes('token-goat-shim'))).toBe(true)
      // No matcher: these are turn-scoped, not tool-scoped, events.
      for (const g of groups) {
        expect(g.matcher).toBeUndefined()
      }
    }
    // Correct internal event arg is baked into each command.
    expect(commandsFor(config, 'PreCompact').some((c) => c.includes(' pre_compact '))).toBe(true)
    expect(commandsFor(config, 'UserPromptSubmit').some((c) => c.includes(' user_prompt_submit '))).toBe(true)
    expect(commandsFor(config, 'SubagentStop').some((c) => c.includes(' subagent_stop '))).toBe(true)
  })

  it('is idempotent (second call reports alreadyInstalled and does not duplicate entries)', () => {
    installCodex()
    const second = installCodex()
    expect(second.alreadyInstalled).toBe(true)

    const config = readConfig()
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const matchers = (config.hooks?.[event] ?? []).map((g) => g.matcher)
      expect(matchers.filter((m) => m === 'apply_patch')).toHaveLength(1)
      expect(matchers.filter((m) => m === 'web_search')).toHaveLength(1)
      expect(matchers.filter((m) => m === 'view_image|Bash')).toHaveLength(1)
    }
    for (const event of ['PreCompact', 'UserPromptSubmit', 'SubagentStop']) {
      expect(commandsFor(config, event)).toHaveLength(1)
    }

    const agents = fs.readFileSync(codexAgentsPath(), 'utf8')
    expect(agents.split('<!-- token-goat-codex-begin -->')).toHaveLength(2)
  })

  it('preserves pre-existing unrelated config.toml hooks and top-level keys', () => {
    const p = codexConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      [
        'model = "gpt-5"',
        '',
        '[[hooks.PreToolUse]]',
        'matcher = "my-own-tool"',
        '',
        '[[hooks.PreToolUse.hooks]]',
        'type = "command"',
        'command = "my-own-hook.sh"',
        '',
      ].join('\n'),
    )

    installCodex()

    const config = readConfig()
    expect(config['model']).toBe('gpt-5')
    const preCommands = commandsFor(config, 'PreToolUse')
    expect(preCommands).toContain('my-own-hook.sh')
    expect(preCommands.some((c) => c.includes('token-goat-shim'))).toBe(true)
    const preMatchers = (config.hooks?.['PreToolUse'] ?? []).map((g) => g.matcher)
    expect(preMatchers).toContain('my-own-tool')
  })

  it('preserves pre-existing non-token-goat AGENTS.md content outside the delimiters', () => {
    const p = codexAgentsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# My project agents notes\n\nAlways run `npm test` before committing.\n')

    installCodex()

    const agents = fs.readFileSync(p, 'utf8')
    expect(agents).toContain('# My project agents notes')
    expect(agents).toContain('Always run `npm test` before committing.')
    expect(agents).toContain('<!-- token-goat-codex-begin -->')
  })

  it('throws on an existing config.toml with invalid TOML, and leaves the file byte-for-byte untouched', () => {
    const p = codexConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Deliberately unparseable: an unterminated array.
    const corrupt = 'model = "gpt-5"\nhooks = [\n'
    fs.writeFileSync(p, corrupt)

    expect(() => installCodex()).toThrow(CodexConfigParseError)
    expect(() => installCodex()).toThrow(/invalid TOML/)

    // installCodex must never reach the config.toml write when the file existed
    // but failed to parse -- the corrupt-but-recoverable file must be left
    // exactly as the user left it, not silently clobbered.
    expect(fs.readFileSync(p, 'utf8')).toBe(corrupt)
  })

  it('uses the absolute Node binary path (process.execPath) and bakes the running token-goat entry as a trailing arg, not a bare `node`, in every generated hook command', () => {
    installCodex()
    const config = readConfig()
    expect(process.argv[1]).toBeDefined()
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const command of commandsFor(config, event)) {
        if (!command.includes('token-goat-shim')) continue
        expect(command).toContain(`"${process.execPath}"`)
        expect(command.startsWith('node ')).toBe(false)
        expect(command).toContain(`"${process.argv[1]}"`)
      }
    }
  })

  it('writes a timestamped .bak of config.toml before an in-place edit', () => {
    const p = codexConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'model = "gpt-5"\n')

    installCodex()

    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('config.toml.bak.'))
    // backupFile no-ops when the target doesn't exist yet, so exactly one call above actually
    // produces a backup file.
    expect(backups.length).toBe(1)
    const backupContent = fs.readFileSync(path.join(path.dirname(p), backups[0] as string), 'utf8')
    expect(backupContent).toBe('model = "gpt-5"\n')
  })

  it('refreshes a stale baked entry path on re-install instead of skipping as already installed (regression: the idempotency check only tested for the token-goat-shim marker being present, never compared the actual command text against what hookCommandFor would currently produce, so a deleted-dev-checkout or node-version-switch entry path never got corrected)', () => {
    const p = codexConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // A marker-shaped entry (contains "token-goat-shim") whose baked node/entry
    // paths point at a checkout that no longer exists -- exactly what a real
    // install call would never write today, but exactly what an old install
    // left behind.
    const staleConfig = [
      '[[hooks.PreToolUse]]',
      'matcher = "view_image|Bash"',
      '',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "\\"C:/deleted-node/node.exe\\" \\"C:/deleted-checkout/hooks/token-goat-shim.js\\" pre_tool_use \\"C:/deleted-checkout/dist/token-goat.mjs\\""',
      '',
      '[[hooks.PreToolUse]]',
      'matcher = "apply_patch"',
      '',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "\\"C:/deleted-node/node.exe\\" \\"C:/deleted-checkout/hooks/token-goat-shim.js\\" pre_tool_use \\"C:/deleted-checkout/dist/token-goat.mjs\\""',
      '',
      '[[hooks.PreToolUse]]',
      'matcher = "web_search"',
      '',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "\\"C:/deleted-node/node.exe\\" \\"C:/deleted-checkout/hooks/token-goat-shim.js\\" pre_tool_use \\"C:/deleted-checkout/dist/token-goat.mjs\\""',
      '',
    ].join('\n')
    fs.writeFileSync(p, staleConfig)

    const result = installCodex()
    expect(result.alreadyInstalled).toBe(false)

    const config = readConfig()
    const preCommands = commandsFor(config, 'PreToolUse')
    // The stale entry must be gone entirely -- refreshed in place, not left as a dead duplicate.
    expect(preCommands.some((c) => c.includes('C:/deleted-checkout'))).toBe(false)
    for (const command of preCommands) {
      expect(command).toContain(`"${process.execPath}"`)
      expect(command).toContain(result.hookScriptPath)
    }
  })
})

describe('isCodexInstalled / uninstallCodex', () => {
  it('isCodexInstalled is false before install, true after', () => {
    expect(isCodexInstalled()).toBe(false)
    installCodex()
    expect(isCodexInstalled()).toBe(true)
  })

  it('isCodexInstalled is false when the global (matcher-less) events are missing even if the matcher-scoped ones are present', () => {
    installCodex()
    expect(isCodexInstalled()).toBe(true)

    const p = codexConfigPath()
    const config = readConfig()
    delete config.hooks?.['PreCompact']
    fs.writeFileSync(p, stringify(config as Record<string, unknown>))

    expect(isCodexInstalled()).toBe(false)
  })

  it('uninstallCodex removes the hooks, the AGENTS.md block, and the shim script; returns true', () => {
    const result = installCodex()
    expect(uninstallCodex()).toBe(true)
    expect(isCodexInstalled()).toBe(false)
    expect(fs.existsSync(result.hookScriptPath)).toBe(false)

    const config = readConfig()
    expect(config.hooks).toBeUndefined()

    const agents = fs.readFileSync(result.agentsPath, 'utf8')
    expect(agents).not.toContain('<!-- token-goat-codex-begin -->')
    for (const event of ['PreCompact', 'UserPromptSubmit', 'SubagentStop']) {
      expect(commandsFor(config, event)).toHaveLength(0)
    }
  })

  it('uninstallCodex returns false when nothing is installed', () => {
    expect(uninstallCodex()).toBe(false)
  })

  it('uninstall leaves unrelated config.toml hooks and AGENTS.md content intact', () => {
    const configP = codexConfigPath()
    const agentsP = codexAgentsPath()
    fs.mkdirSync(path.dirname(configP), { recursive: true })
    fs.writeFileSync(
      configP,
      ['[[hooks.PreToolUse]]', 'matcher = "my-own-tool"', '', '[[hooks.PreToolUse.hooks]]', 'type = "command"', 'command = "my-own-hook.sh"', ''].join(
        '\n',
      ),
    )
    fs.writeFileSync(agentsP, '# Keep me\n')

    installCodex()
    uninstallCodex()

    const config = readConfig()
    const preCommands = commandsFor(config, 'PreToolUse')
    expect(preCommands).toContain('my-own-hook.sh')
    expect(preCommands.some((c) => c.includes('token-goat-shim'))).toBe(false)

    const agents = fs.readFileSync(agentsP, 'utf8')
    expect(agents).toContain('# Keep me')
    expect(agents).not.toContain('token-goat-codex-begin')
  })

  it('does not strip an unrelated hook whose command merely contains "token-goat-shim" as a substring inside a longer identifier (regression: isCodexTokenGoatCommand used an unanchored .includes() check, so a lookalike command name would be misidentified as ours and deleted on uninstall)', () => {
    const configP = codexConfigPath()
    fs.mkdirSync(path.dirname(configP), { recursive: true })
    fs.writeFileSync(
      configP,
      [
        '[[hooks.PreToolUse]]',
        'matcher = "my-own-tool"',
        '',
        '[[hooks.PreToolUse.hooks]]',
        'type = "command"',
        'command = "bash /opt/scripts/definitely-not-token-goat-shim-related.sh"',
        '',
      ].join('\n'),
    )

    installCodex()
    uninstallCodex()

    const config = readConfig()
    const preCommands = commandsFor(config, 'PreToolUse')
    expect(preCommands).toContain('bash /opt/scripts/definitely-not-token-goat-shim-related.sh')
  })
})
