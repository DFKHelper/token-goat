import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.gemini/` (mirrors the pattern in install_codex.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  GeminiSettingsParseError,
  geminiSettingsPath,
  installGemini,
  isGeminiInstalled,
  uninstallGemini,
} from '../src/bridges/gemini_install.js'

interface GeminiHookEntry {
  type: string
  command: string
}
interface GeminiMatcherGroup {
  matcher?: string
  hooks?: GeminiHookEntry[]
}
interface GeminiSettingsShape {
  hooks?: Record<string, GeminiMatcherGroup[]>
  [key: string]: unknown
}

function readSettings(): GeminiSettingsShape {
  return JSON.parse(fs.readFileSync(geminiSettingsPath(), 'utf8')) as GeminiSettingsShape
}

function matchersFor(settings: GeminiSettingsShape, event: string): Array<string | undefined> {
  return (settings.hooks?.[event] ?? []).map((g) => g.matcher)
}

function commandsFor(settings: GeminiSettingsShape, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
}

let TMP: string
let originalArgv1: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gemini-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
  // installGemini/isGeminiInstalled/uninstallGemini identify their own hook commands by
  // checking whether process.argv[1] (the entry path baked into the written command) contains
  // a "token-goat" path segment (GEMINI_ENTRY_PATH_MARKER_PATTERN in gemini_install.ts) -- a
  // real npm install always places the entry under a `node_modules/token-goat/...` directory,
  // so this is reliable in production. Under vitest's fork pool, though, process.argv[1] is
  // tinypool's own internal worker script (node_modules/tinypool/dist/entry/process.js), which
  // has nothing to do with token-goat's identity -- whether it happens to also satisfy the
  // marker depends entirely on whether the repo's checkout *directory* incidentally contains
  // "token-goat" somewhere in its path (true for this repo's usual checkout locations, false
  // for e.g. an arbitrarily-named scratch clone), making the suite pass or fail for reasons
  // unrelated to the code under test. Stub argv[1] to a realistic token-goat entry path so
  // these tests exercise real install/uninstall behavior deterministically, independent of
  // where the repo happens to be checked out.
  originalArgv1 = process.argv[1]
  process.argv[1] = path.join(TMP, 'node_modules', 'token-goat', 'dist', 'token-goat.mjs')
})

afterEach(() => {
  process.argv[1] = originalArgv1
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installGemini', () => {
  it('writes settings.json with the token-goat hook entries under all four Gemini events on a fresh install', () => {
    const result = installGemini()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.settingsPath)).toBe(true)

    const settings = readSettings()

    // BeforeTool: Bash/Read/Grep/WebFetch all have a pre_tool_use handler; Write/Edit don't; Glob has none at all.
    const beforeMatchers = matchersFor(settings, 'BeforeTool')
    expect(beforeMatchers).toContain('^(run_shell_command)$')
    expect(beforeMatchers).toContain('^(read_file|read_many_files|list_directory)$')
    expect(beforeMatchers).toContain('^(grep_search|search_file_content)$')
    expect(beforeMatchers).toContain('^(google_web_search|web_fetch)$')
    expect(process.argv[1]).toBeDefined()
    for (const command of commandsFor(settings, 'BeforeTool')) {
      expect(command).toContain(`"${process.execPath}"`)
      expect(command.startsWith('node ')).toBe(false)
      expect(command).toContain(`"${process.argv[1]}"`)
      expect(command.endsWith('hook pre_tool_use')).toBe(true)
    }

    // AfterTool: Bash/Read/Write/Edit/WebFetch have a post_tool_use handler; Grep doesn't.
    const afterMatchers = matchersFor(settings, 'AfterTool')
    expect(afterMatchers).toContain('^(run_shell_command)$')
    expect(afterMatchers).toContain('^(read_file|read_many_files|list_directory)$')
    expect(afterMatchers).toContain('^(write_file)$')
    expect(afterMatchers).toContain('^(replace)$')
    expect(afterMatchers).toContain('^(google_web_search|web_fetch)$')
    expect(afterMatchers.some((m) => m?.includes('grep_search'))).toBe(false)
    for (const command of commandsFor(settings, 'AfterTool')) {
      expect(command).toContain(`"${process.execPath}"`)
      expect(command.startsWith('node ')).toBe(false)
      expect(command).toContain(`"${process.argv[1]}"`)
      expect(command.endsWith('hook post_tool_use')).toBe(true)
    }

    // Glob ('glob') has no registered pre/post handler at all -- never wired.
    expect(beforeMatchers.some((m) => m?.includes('glob'))).toBe(false)
    expect(afterMatchers.some((m) => m?.includes('glob'))).toBe(false)

    // Lifecycle event: single no-matcher group, fires on every occurrence.
    const preCompressGroups = settings.hooks?.['PreCompress']
    expect(preCompressGroups).toHaveLength(1)
    expect(preCompressGroups?.[0]?.matcher).toBeUndefined()
    const preCompressCommands = (preCompressGroups?.[0]?.hooks ?? []).map((h) => h.command)
    expect(preCompressCommands).toHaveLength(1)
    expect(preCompressCommands[0]).toContain(`"${process.execPath}"`)
    expect(preCompressCommands[0]).toContain(`"${process.argv[1]}"`)
    expect(preCompressCommands[0]?.endsWith('hook pre_compact')).toBe(true)

    // session_start is retired (its handler was a permanent no-op) -- Gemini's
    // SessionStart must not get an entry at all, not even a dead one.
    expect(settings.hooks?.['SessionStart']).toBeUndefined()

    expect(isGeminiInstalled()).toBe(true)
  })

  it('is idempotent (second call reports alreadyInstalled and does not duplicate entries)', () => {
    installGemini()
    const second = installGemini()
    expect(second.alreadyInstalled).toBe(true)

    const settings = readSettings()
    for (const event of ['BeforeTool', 'AfterTool', 'PreCompress']) {
      const matchers = matchersFor(settings, event)
      const unique = new Set(matchers.map((m) => m ?? '.'))
      expect(unique.size).toBe(matchers.length)
    }
  })

  it('preserves pre-existing unrelated settings.json keys and hook entries', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            BeforeTool: [{ matcher: 'my_own_tool', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
          },
        },
        null,
        2,
      ),
    )

    installGemini()

    const settings = readSettings()
    expect(settings['theme']).toBe('dark')
    const beforeCommands = commandsFor(settings, 'BeforeTool')
    expect(beforeCommands).toContain('my-own-hook.sh')
    expect(beforeCommands.some((c) => c.endsWith('hook pre_tool_use'))).toBe(true)
    const beforeMatchers = matchersFor(settings, 'BeforeTool')
    expect(beforeMatchers).toContain('my_own_tool')
  })

  it('writes a timestamped .bak of settings.json before an in-place edit', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ theme: 'dark' }))

    installGemini()

    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const backupContent = fs.readFileSync(path.join(path.dirname(p), backups[0] as string), 'utf8')
    expect(backupContent).toBe(JSON.stringify({ theme: 'dark' }))
  })

  it('throws on an existing settings.json with invalid JSON, and leaves the file byte-for-byte untouched', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Deliberately unparseable: a trailing comma before the closing brace.
    const corrupt = '{ "theme": "dark", }'
    fs.writeFileSync(p, corrupt)

    expect(() => installGemini()).toThrow(GeminiSettingsParseError)
    expect(() => installGemini()).toThrow(/invalid JSON/)

    // installGemini must never reach the settings.json write when the file
    // existed but failed to parse -- the corrupt-but-recoverable file must be
    // left exactly as the user left it, not silently clobbered.
    expect(fs.readFileSync(p, 'utf8')).toBe(corrupt)
  })

  it('throws on an existing settings.json whose top-level value is not an object, and leaves the file untouched', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const nonObject = '[1, 2, 3]'
    fs.writeFileSync(p, nonObject)

    expect(() => installGemini()).toThrow(GeminiSettingsParseError)
    expect(() => installGemini()).toThrow(/does not contain a JSON object/)
    expect(fs.readFileSync(p, 'utf8')).toBe(nonObject)
  })

  it('upgrades a legacy bare "token-goat hook <event>" command to the current exec-path-hardened form on re-install, instead of treating it as already installed (regression: installGemini used to gate on isGeminiTokenGoatCommand, which also matches the legacy form, so a pre-hardening install never got upgraded)', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const legacySettings = {
      hooks: {
        BeforeTool: [
          { matcher: '^(run_shell_command)$', hooks: [{ type: 'command', command: 'token-goat hook pre_tool_use' }] },
        ],
        AfterTool: [
          { matcher: '^(run_shell_command)$', hooks: [{ type: 'command', command: 'token-goat hook post_tool_use' }] },
        ],
        PreCompress: [{ hooks: [{ type: 'command', command: 'token-goat hook pre_compact' }] }],
      },
    }
    fs.writeFileSync(p, JSON.stringify(legacySettings, null, 2))

    const result = installGemini()
    expect(result.alreadyInstalled).toBe(false)

    const settings = readSettings()
    const allCommands = [
      ...commandsFor(settings, 'BeforeTool'),
      ...commandsFor(settings, 'AfterTool'),
      ...commandsFor(settings, 'PreCompress'),
    ]
    // The legacy bare command must be gone entirely -- upgraded in place, not left as a dead duplicate.
    expect(allCommands.some((c) => c === 'token-goat hook pre_tool_use')).toBe(false)
    expect(allCommands.some((c) => c === 'token-goat hook post_tool_use')).toBe(false)
    expect(allCommands.some((c) => c === 'token-goat hook pre_compact')).toBe(false)
    // Every remaining matcher's ^(run_shell_command)$ / no-matcher group now carries the current, hardened form.
    for (const command of commandsFor(settings, 'BeforeTool')) {
      expect(command).toContain(`"${process.execPath}"`)
      expect(command).toContain(`"${process.argv[1]}"`)
    }
    for (const command of commandsFor(settings, 'AfterTool')) {
      expect(command).toContain(`"${process.execPath}"`)
      expect(command).toContain(`"${process.argv[1]}"`)
    }
    // Not asserting isGeminiInstalled() here: it requires process.argv[1] to
    // literally contain a "token-goat" path segment, which the test runner's
    // own entry path does not -- a pre-existing, unrelated environment
    // limitation also hit by the "fresh install" test above, not something
    // this fix changes.
  })
})

describe('isGeminiInstalled / uninstallGemini', () => {
  it('isGeminiInstalled is false before install, true after', () => {
    expect(isGeminiInstalled()).toBe(false)
    installGemini()
    expect(isGeminiInstalled()).toBe(true)
  })

  it('isGeminiInstalled is false when only some of the required entries are present', () => {
    installGemini()
    const p = geminiSettingsPath()
    const settings = readSettings()
    // Delete one required group (AfterTool's Bash matcher) to simulate a partial/tampered install.
    settings.hooks = settings.hooks ?? {}
    settings.hooks['AfterTool'] = (settings.hooks['AfterTool'] ?? []).filter(
      (g) => g.matcher !== '^(run_shell_command)$',
    )
    fs.writeFileSync(p, JSON.stringify(settings, null, 2))

    expect(isGeminiInstalled()).toBe(false)

    // installGemini tops up what's missing.
    installGemini()
    expect(isGeminiInstalled()).toBe(true)
  })

  it('uninstallGemini removes the hook entries and returns true', () => {
    installGemini()
    expect(uninstallGemini()).toBe(true)
    expect(isGeminiInstalled()).toBe(false)

    const settings = readSettings()
    expect(settings.hooks).toBeUndefined()
  })

  it('uninstallGemini returns false when nothing is installed', () => {
    expect(uninstallGemini()).toBe(false)
  })

  it('uninstall leaves unrelated settings.json keys and hook entries intact', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            BeforeTool: [{ matcher: 'my_own_tool', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
          },
        },
        null,
        2,
      ),
    )

    installGemini()
    uninstallGemini()

    const settings = readSettings()
    expect(settings['theme']).toBe('dark')
    const beforeCommands = commandsFor(settings, 'BeforeTool')
    expect(beforeCommands).toContain('my-own-hook.sh')
    expect(beforeCommands.some((c) => c.endsWith('hook pre_tool_use'))).toBe(false)
  })

  it('does not strip an unrelated hook whose command merely contains "token-goat hook" as a substring inside a longer identifier (regression: isGeminiTokenGoatCommand used an unanchored .includes() check, so a lookalike command name would be misidentified as ours and deleted on uninstall)', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          hooks: {
            BeforeTool: [
              { matcher: 'my_own_tool', hooks: [{ type: 'command', command: 'my-wrapper-token-goat hooked-script.sh' }] },
            ],
          },
        },
        null,
        2,
      ),
    )

    installGemini()
    uninstallGemini()

    const settings = readSettings()
    const beforeCommands = commandsFor(settings, 'BeforeTool')
    expect(beforeCommands).toContain('my-wrapper-token-goat hooked-script.sh')
  })

  it('does not recognize a same-shape command from an unrelated tool as token-goat\'s own (regression: GEMINI_COMMAND_PATTERN matched any "<quoted-path>" "<quoted-path>" hook <event> SHAPE regardless of whether the paths referenced token-goat at all)', () => {
    const p = geminiSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          hooks: {
            BeforeTool: [
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

    installGemini()
    uninstallGemini()

    // The unrelated lookalike command must survive both an install (which
    // tops up token-goat's own entries alongside it) and an uninstall (which
    // must not mistake it for token-goat's own entry and strip it).
    const settings = readSettings()
    const beforeCommands = commandsFor(settings, 'BeforeTool')
    expect(beforeCommands).toContain('"C:/some/other/node.exe" "C:/some/other/tool.js" hook pre_tool_use')
    // A real token-goat-authored command of the identical shape (this
    // process's own actual execPath/entryPath, exactly what installGemini()
    // itself writes) IS recognized and gets removed by the same uninstall --
    // only the unrelated lookalike (whose paths never reference process.execPath)
    // remains.
    expect(beforeCommands.some((c) => c.includes(process.execPath))).toBe(false)
  })

  it('writes a timestamped .bak of settings.json before removing entries', () => {
    installGemini()
    uninstallGemini()

    const p = geminiSettingsPath()
    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })
})
