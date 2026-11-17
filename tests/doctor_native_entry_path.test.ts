import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted: `~` points at a temp dir per test, so no real harness config is read.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import { checkNativeEntryPaths, checkNativeHooks, type NativeWiring } from '../src/cli_doctor_native.js'
import { nativeHookCommandLine, splitHookCommand } from '../src/native_hook.js'

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
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

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

  it('leaves a Node-form entry with no --entry flag unaffected', () => {
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    // HAND-DERIVED: the Node form's argv as nodeHookArgv writes it, with no tg-hook program and no --entry flag.
    expect(checkNativeEntryPaths(wiringOf([process.execPath, SHIM, 'PreToolUse', missing]))).toBeNull()
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

describe('checkNativeHooks runs the entry check for a registered Claude Code hook', () => {
  it('reports a FAIL row when a registered native hook names a missing --entry bundle', () => {
    const missing = path.join(TMP, 'gone', 'token-goat.mjs')
    const settingsDir = path.join(TMP, 'home', '.claude')
    fs.mkdirSync(settingsDir, { recursive: true })
    const line = nativeHookCommandLine('sh', BIN, 'claudecode', SHIM, 'PreToolUse', missing)
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: line }] }] } }))
    const rows = checkNativeHooks(path.join(TMP, 'no-stats.db')).filter((r) => r.name === ROW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('fail')
    expect(rows[0]?.message).toContain(missing)
  })
})
