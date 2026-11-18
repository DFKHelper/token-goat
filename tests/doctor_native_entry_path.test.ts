import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { stringify } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted: `~` points at a temp dir per test, so no real harness config is read.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import { codexConfigPath } from '../src/bridges/codex_install.js'
import { copilotCliConfigPath } from '../src/bridges/copilot_cli_install.js'
import { grokConfigPath } from '../src/bridges/grok_install.js'
import { kimiConfigPath } from '../src/bridges/kimi_install.js'
import { dataDir } from '../src/constants.js'
import { hookPointerPath } from '../src/hook_pointer.js'
import { settingsPath } from '../src/install.js'
import { wiringPointsAtMissingFile } from '../src/cli_doctor_hooks.js'
import { checkNativeEntryPaths, checkNativeHooks, nativeWirings, type NativeWiring } from '../src/cli_doctor_native.js'
import { nativeHookCommandLine, splitHookCommand, type HookShell, type NativeHarness } from '../src/native_hook.js'

const ROW = 'Native hook entry (Claude Code (user))'
const BIN = 'tg-hook'
const SHIM = '/home/u/.claude/hooks/token-goat-shim.cjs'
let TMP: string

/** The argv words of a native hook command for `event` pointing at `entry`, split the way the shell would. */
function nativeWords(event: string, entry: string): string[] {
  const line = nativeHookCommandLine('sh', BIN, 'claudecode', SHIM, event, entry)
  if (line === undefined) throw new Error('no native command line')
  return splitHookCommand(line, 'sh')
}

/** A Claude Code (user) wiring whose entries carry the given argv words. */
function wiringOf(...words: string[][]): NativeWiring {
  return { label: 'Claude Code (user)', install: 'token-goat install', harnesses: ['claudecode'], entries: words.map((w) => ({ words: w })) }
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-entry-path-'))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(path.join(TMP, 'home'))
  vi.stubEnv('COPILOT_HOME', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(TMP, 'home', '.claude'))
  vi.stubEnv('TOKEN_GOAT_NATIVE_HOOKS', '0')
  vi.stubEnv('CODEX_HOME', path.join(TMP, 'home', '.codex'))
  vi.stubEnv('KIMI_CODE_HOME', path.join(TMP, 'home', '.kimi-code'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value))
}

/** Points process.cwd() at a temp project root (workers cannot chdir); restored after each test. */
function useProjectRoot(): void {
  const dir = path.join(TMP, 'project')
  fs.mkdirSync(dir, { recursive: true })
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

/** A nested hooks document holding one command, the shape the Claude Code, Grok and Codex readers walk. */
function nestedHooks(command: string): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command }] }] } }
}

/** Copilot CLI's flat per-event hooks document holding one command. */
function copilotHooks(command: string): Record<string, unknown> {
  return { hooks: { preToolUse: [{ type: 'command', command }] } }
}

/** A scope's shell and harness, and a writer that puts a command in that scope's real config file. */
interface ScopeFixture {
  shell: HookShell
  harness: NativeHarness
  write: (command: string) => void
}

const windows = process.platform === 'win32'

/** Every `nativeWirings()` label, written out so the parameterized rows below are statically known. */
const SCOPE_LABELS = ['Claude Code (user)', 'Claude Code (project)', 'Codex', 'Grok CLI', 'Kimi Code', 'Copilot CLI (user)', 'Copilot CLI (project)']

/** One fixture per `nativeWirings()` label; each writes through the real path function its reader reads. */
const SCOPES: Record<string, ScopeFixture> = {
  'Claude Code (user)': { shell: 'sh', harness: 'claudecode', write: (c) => writeJson(settingsPath('user'), nestedHooks(c)) },
  'Claude Code (project)': {
    shell: 'sh',
    harness: 'claudecode',
    write: (c) => {
      useProjectRoot()
      writeJson(settingsPath('project'), nestedHooks(c))
    },
  },
  Codex: { shell: windows ? 'powershell' : 'sh', harness: 'codex', write: (c) => writeText(codexConfigPath(), stringify(nestedHooks(c))) },
  'Grok CLI': { shell: windows ? 'powershell' : 'sh', harness: 'grok', write: (c) => writeJson(grokConfigPath(), nestedHooks(c)) },
  'Kimi Code': {
    shell: windows ? 'cmd' : 'sh',
    harness: 'kimi',
    write: (c) => writeText(kimiConfigPath(), stringify({ hooks: [{ event: 'PreToolUse', command: c }] })),
  },
  'Copilot CLI (user)': { shell: windows ? 'cmd' : 'sh', harness: 'copilot_cli', write: (c) => writeJson(copilotCliConfigPath(), copilotHooks(c)) },
  'Copilot CLI (project)': {
    shell: windows ? 'cmd' : 'sh',
    harness: 'copilot_cli',
    write: (c) => {
      useProjectRoot()
      writeJson(copilotCliConfigPath({ local: true }), copilotHooks(c))
    },
  },
}

interface PointerExtras {
  readonly shims?: Record<string, string>
  readonly noBin?: boolean
  readonly shim?: string
}

/** HAND-DERIVED from validateHookPointer in src/hook_pointer.ts: schema 1, token-goat.mjs entry, tg-hook. */
function withPointerTo(entry: string, run: () => void, extra: PointerExtras = {}): void {
  const file = hookPointerPath(dataDir())
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  const nativeBin = path.join(TMP, 'tg-hook')
  if (extra.noBin !== true) writeText(nativeBin, '')
  const base = { schema: 1, version: '0', node: null, shim: extra.shim ?? null, writtenAt: 'now' }
  const shims = extra.shims === undefined ? {} : { shims: extra.shims }
  const pointer = { ...base, bundleDir: path.dirname(entry), entry, nativeBin, ...shims }
  try {
    writeText(file, JSON.stringify(pointer))
    run()
  } finally {
    if (before === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, before)
  }
}

describe('checkNativeEntryPaths', () => {
  it('fails naming the host, the hook event and the missing bundle, with the install fix hint', () => {
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    const row = checkNativeEntryPaths(wiringOf(nativeWords('PreToolUse', missing)))
    expect(row?.status).toBe('fail')
    expect(row?.name).toBe(ROW)
    expect(row?.message).toContain('Claude Code (user)')
    expect(row?.message).toContain('PreToolUse')
    expect(row?.message).toContain(missing)
    expect(row?.message).toContain('token-goat install')
  })

  it('returns no row when the named bundle exists', () => {
    const entry = path.join(TMP, 'dist', 'token-goat.mjs')
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, '')
    expect(checkNativeEntryPaths(wiringOf(nativeWords('PreToolUse', entry)))).toBeNull()
  })

  it('fails a Node-form entry with no --entry flag whose bundle is gone, naming its event and bundle', () => {
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    // HAND-DERIVED: nodeHookArgv's Node form, `node <shim> <event> <entry>`, no tg-hook, no --entry.
    const row = checkNativeEntryPaths(wiringOf([process.execPath, SHIM, 'PreToolUse', missing]))
    expect(row?.status).toBe('fail')
    expect(row?.message).toContain('PreToolUse')
    expect(row?.message).toContain(missing)
  })

  it('returns no row for a Node-form entry whose bundle exists', () => {
    const entry = path.join(TMP, 'dist', 'token-goat.mjs')
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, '')
    expect(checkNativeEntryPaths(wiringOf([process.execPath, SHIM, 'PreToolUse', entry]))).toBeNull()
  })

  it('leaves a Node-form entry with no bundle word unaffected', () => {
    // HAND-DERIVED: the shape `node <shim> <event>`, which nodeHookArgv never writes without an entry path.
    expect(checkNativeEntryPaths(wiringOf([process.execPath, SHIM, 'PreToolUse']))).toBeNull()
  })

  it('leaves a four-word entry whose second word is not the shim unaffected', () => {
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    expect(checkNativeEntryPaths(wiringOf(['/usr/bin/other', 'other.cjs', 'PreToolUse', missing]))).toBeNull()
  })

  it('reads a Windows-style backslash path back whole, and fails on it when it is missing', () => {
    // A drive-rooted path that no machine has, so the existence check fails on every platform.
    const winEntry = 'C:\\tg-entry-missing\\dist\\token-goat.mjs'
    const row = checkNativeEntryPaths(wiringOf(nativeWords('PreToolUse', winEntry)))
    expect(row?.status).toBe('fail')
    expect(row?.message).toContain(winEntry)
  })

  it('reads a quoted path with spaces back as one word, and fails only once it is gone', () => {
    const dir = path.join(TMP, 'with space')
    const entry = path.join(dir, 'token-goat.mjs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(entry, '')
    expect(checkNativeEntryPaths(wiringOf(nativeWords('PreToolUse', entry)))).toBeNull()
    fs.rmSync(entry)
    const row = checkNativeEntryPaths(wiringOf(nativeWords('PreToolUse', entry)))
    expect(row?.status).toBe('fail')
    expect(row?.message).toContain(entry)
  })
})

describe('wiringPointsAtMissingFile on a native wiring', () => {
  it('reports a rewrite when the --entry bundle is gone, even with the client binary present', () => {
    const bin = path.join(TMP, 'tg-hook')
    fs.writeFileSync(bin, '')
    // The shim exists, so only the missing --entry bundle can make the wiring count as broken.
    const shim = path.join(TMP, 'token-goat-shim.cjs')
    fs.writeFileSync(shim, '')
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    const line = nativeHookCommandLine('sh', bin, 'claudecode', shim, 'PreToolUse', missing)
    if (line === undefined) throw new Error('no native command line')
    expect(wiringPointsAtMissingFile([{ words: splitHookCommand(line, 'sh') }])).toBe(true)
  })

  it('reports nothing when the client binary and the --entry bundle both exist', () => {
    const bin = path.join(TMP, 'tg-hook')
    fs.writeFileSync(bin, '')
    const entry = path.join(TMP, 'dist', 'token-goat.mjs')
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, '')
    // The shim word is checked too, so the shim must exist for this wiring to count as complete.
    const shim = path.join(TMP, 'token-goat-shim.cjs')
    fs.writeFileSync(shim, '')
    const line = nativeHookCommandLine('sh', bin, 'claudecode', shim, 'PreToolUse', entry)
    if (line === undefined) throw new Error('no native command line')
    expect(wiringPointsAtMissingFile([{ words: splitHookCommand(line, 'sh') }])).toBe(false)
  })
})

describe('checkNativeEntryPaths on a guarded entry', () => {
  const guardedWiring = (entry: string): NativeWiring => ({
    ...wiringOf(nativeWords('PreToolUse', entry)),
    entries: [{ words: nativeWords('PreToolUse', entry), guarded: true }],
  })

  it('passes a guarded entry whose --entry is gone while the hook pointer names a live bundle', () => {
    const live = path.join(TMP, 'live', 'token-goat.mjs')
    writeText(live, '')
    withPointerTo(live, () => {
      expect(checkNativeEntryPaths(guardedWiring(path.join(TMP, 'gone', 'token-goat.mjs')))).toBeNull()
    })
  })

  it('still fails a guarded entry when the pointer names a bundle that is missing', () => {
    const gone = path.join(TMP, 'gone', 'token-goat.mjs')
    withPointerTo(path.join(TMP, 'dead', 'token-goat.mjs'), () => {
      const row = checkNativeEntryPaths(guardedWiring(gone))
      expect(row?.status).toBe('fail')
      expect(row?.message).toContain(gone)
    })
  })

  it('still fails an unguarded entry even when the pointer names a live bundle', () => {
    const live = path.join(TMP, 'live', 'token-goat.mjs')
    const gone = path.join(TMP, 'gone', 'token-goat.mjs')
    writeText(live, '')
    withPointerTo(live, () => {
      expect(checkNativeEntryPaths(wiringOf(nativeWords('PreToolUse', gone)))?.status).toBe('fail')
    })
  })
})

describe('checkNativeEntryPaths needs the pointer route to be whole, not only the pointer file', () => {
  const codexWiring = (entry: string): NativeWiring => ({
    label: 'Codex',
    install: 'token-goat install --codex',
    harnesses: ['codex'],
    entries: [{ words: nativeWords('PreToolUse', entry), guarded: true }],
  })
  const live = (): string => {
    const file = path.join(TMP, 'live', 'token-goat.mjs')
    writeText(file, '')
    return file
  }
  const gone = (): string => path.join(TMP, 'gone', 'token-goat.mjs')
  /** HAND-DERIVED from validateHookPointer in src/hook_pointer.ts: a shim must be named token-goat-shim.cjs. */
  const shimFile = (): string => {
    const file = path.join(TMP, 'shims', 'token-goat-shim.cjs')
    writeText(file, '')
    return file
  }

  it('fails a Codex entry when the pointer names no shim for codex', () => {
    withPointerTo(live(), () => {
      const row = checkNativeEntryPaths(codexWiring(gone()))
      expect(row?.status).toBe('fail')
    }, {})
  })

  it('fails a Codex entry when the pointer names a shim that is missing from disk', () => {
    withPointerTo(live(), () => {
      expect(checkNativeEntryPaths(codexWiring(gone()))?.status).toBe('fail')
    }, { shims: { codex: path.join(TMP, 'shims', 'token-goat-shim.cjs') } })
  })

  it('fails when the pointer names a native client that is missing', () => {
    withPointerTo(live(), () => {
      expect(checkNativeEntryPaths(codexWiring(gone()))?.status).toBe('fail')
    }, { shims: { codex: shimFile() }, noBin: true })
  })

  it('passes a Codex entry when the pointer names its shim, the native client and a live bundle', () => {
    withPointerTo(live(), () => {
      expect(checkNativeEntryPaths(codexWiring(gone()))).toBeNull()
    }, { shims: { codex: shimFile() } })
  })

  it('fails a Codex entry when a shims map lacks codex, though the single shim is valid', () => {
    // FORMAT-DERIVED: Pointer::shim_for (native/tg-hook/src/pointer.rs) never falls back to `shim`.
    withPointerTo(live(), () => {
      expect(checkNativeEntryPaths(codexWiring(gone()))?.status).toBe('fail')
    }, { shims: { grok: shimFile() }, shim: shimFile() })
  })

  it('passes a Codex entry with no shims map and a valid single shim', () => {
    // FORMAT-DERIVED: Pointer::shim_for (native/tg-hook/src/pointer.rs) answers `shim` when `shims` is absent.
    withPointerTo(live(), () => {
      expect(checkNativeEntryPaths(codexWiring(gone()))).toBeNull()
    }, { shim: shimFile() })
  })

  it('fails a Claude Code entry when the native client is missing', () => {
    withPointerTo(live(), () => {
      const entries = [{ words: nativeWords('PreToolUse', gone()), guarded: true }]
      expect(checkNativeEntryPaths({ ...wiringOf(), entries })?.status).toBe('fail')
    }, { noBin: true })
  })
})

describe('checkNativeHooks runs the entry check for every harness scope', () => {
  it('has a fixture for every scope nativeWirings() returns', () => {
    expect(nativeWirings().map((w) => w.label).sort()).toEqual([...SCOPE_LABELS].sort())
    expect(Object.keys(SCOPES).sort()).toEqual([...SCOPE_LABELS].sort())
  })

  it.each(SCOPE_LABELS)('%s: reports a FAIL row when a registered native hook names a missing --entry bundle', (label) => {
    const scope = SCOPES[label]
    if (scope === undefined) throw new Error(`no fixture for ${label}`)
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    const command = nativeHookCommandLine(scope.shell, BIN, scope.harness, SHIM, 'PreToolUse', missing)
    if (command === undefined) throw new Error('no native command line')
    scope.write(command)
    const rows = checkNativeHooks(path.join(TMP, 'no-stats.db')).filter((r) => r.name === `Native hook entry (${label})`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('fail')
    expect(rows[0]?.message).toContain(missing)
  })
})
