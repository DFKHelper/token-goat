/** Codex config.toml safety across install and uninstall: the user's comments and own hook trust entries must come back exactly as they were. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return { ...original, homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)) }
})

import * as os from 'node:os'

import { parse, stringify } from 'smol-toml'

import { codexConfigPath, installCodex, uninstallCodex } from '../src/bridges/codex_install.js'

type Cfg = { hooks?: Record<string, unknown> }

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-roundtrip-'))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(TMP)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function put(text: string): string {
  const p = codexConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}

const backupsOf = (p: string): string[] => fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(`${path.basename(p)}.bak.`))

// HAND-DERIVED: the file is typed out here, comments (full-line, inline, trailing), blank lines, odd spacing and a table order smol-toml would not reproduce; the expected result of install then uninstall is that these exact bytes come back, which needs no knowledge of our code.
const COMMENTED = `# my codex settings
model = "o3"  # inline note

# sandbox choice
[sandbox]
mode   =   "workspace-write"
# trailing comment
`

describe('install then uninstall of a commented config.toml', () => {
  it('gives back the exact bytes that were there before install', () => {
    const p = put(COMMENTED)
    installCodex()
    expect(fs.readFileSync(p, 'utf8')).not.toBe(COMMENTED)
    expect(fs.readFileSync(p, 'utf8').startsWith(COMMENTED)).toBe(true)
    uninstallCodex()
    expect(fs.readFileSync(p, 'utf8')).toBe(COMMENTED)
    expect(backupsOf(p)).toEqual([])
  })

  it('does the same for a file with no final newline and for CRLF line endings', () => {
    for (const original of [COMMENTED.trimEnd(), COMMENTED.replace(/\n/g, '\r\n')]) {
      const p = put(original)
      installCodex()
      uninstallCodex()
      expect(fs.readFileSync(p, 'utf8')).toBe(original)
    }
  })

  it('keeps a line the user adds between install and uninstall', () => {
    const p = put(COMMENTED)
    installCodex()
    fs.writeFileSync(p, `# added later\napproval_policy = "never"\n${fs.readFileSync(p, 'utf8')}`)
    uninstallCodex()
    expect(fs.readFileSync(p, 'utf8')).toBe(`# added later\napproval_policy = "never"\n${COMMENTED}`)
  })

  it('a second install changes nothing, and an empty file round-trips to an empty file', () => {
    const p = put(COMMENTED)
    installCodex()
    const once = fs.readFileSync(p, 'utf8')
    installCodex()
    expect(fs.readFileSync(p, 'utf8')).toBe(once)
    fs.writeFileSync(p, '')
    uninstallCodex()
    installCodex()
    uninstallCodex()
    expect(fs.readFileSync(p, 'utf8')).toBe('')
  })

  it('keeps the pre-install backup when the file has to be rewritten without its comments', () => {
    const p = put(COMMENTED)
    installCodex()
    // Damage the managed block's end marker so uninstall cannot cut the block out as text.
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('# <<< token-goat codex hooks <<<\n', ''))
    uninstallCodex()
    expect(parse(fs.readFileSync(p, 'utf8')).hooks).toBeUndefined()
    const kept = backupsOf(p)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.some((f) => fs.readFileSync(path.join(path.dirname(p), f), 'utf8').includes('# my codex settings'))).toBe(true)
  })
})

describe('uninstall and the user\'s own [hooks.state] trust entries', () => {
  // FORMAT-DERIVED: Codex keys a hook's trust `<config path>:<event snake_case>:<group index>:<handler index>` (openai/codex codex-rs/hooks/src/lib.rs hook_key; position keying is the subject of https://github.com/openai/codex/issues/49399).
  const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }

  it('removes only token-goat\'s entries and leaves the user\'s', () => {
    const p = codexConfigPath()
    const key = `${p}:pre_tool_use:0:0`
    put(stringify({ hooks: { PreToolUse: [userGroup], state: { [key]: { trusted_hash: 'sha256:user-own' } } } }))
    installCodex()
    uninstallCodex()
    const hooks = (parse(fs.readFileSync(p, 'utf8')) as Cfg).hooks as Record<string, unknown>
    expect(hooks['PreToolUse']).toEqual([userGroup])
    expect(hooks['state']).toEqual({ [key]: { trusted_hash: 'sha256:user-own' } })
  })

  it('renames a user entry whose group moves up when a token-goat group before it is removed', () => {
    const p = codexConfigPath()
    installCodex()
    const cfg = parse(fs.readFileSync(p, 'utf8')) as { hooks: Record<string, unknown[]> & { state: Record<string, unknown> } }
    const own = cfg.hooks['PreToolUse']!.length
    expect(own).toBeGreaterThan(0)
    // The user's group sits after token-goat's, at index `own`, with its trust recorded there.
    cfg.hooks['PreToolUse']!.push(userGroup)
    cfg.hooks.state[`${p}:pre_tool_use:${own}:0`] = { trusted_hash: 'sha256:user-own' }
    fs.writeFileSync(p, stringify(cfg))
    uninstallCodex()
    const after = (parse(fs.readFileSync(p, 'utf8')) as Cfg).hooks as Record<string, unknown>
    expect(after['PreToolUse']).toEqual([userGroup])
    expect(after['state']).toEqual({ [`${p}:pre_tool_use:0:0`]: { trusted_hash: 'sha256:user-own' } })
  })

  it('removes token-goat\'s own entries and the hooks table once nothing else is left', () => {
    const p = put(COMMENTED)
    installCodex()
    uninstallCodex()
    expect((parse(fs.readFileSync(p, 'utf8')) as Cfg).hooks).toBeUndefined()
  })
})
