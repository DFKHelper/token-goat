/** `section --list`, `find`, `locate` and the spec resolver never print a file the Read rules deny. */
// Provenance: HAND-DERIVED. Rules use Claude Code's documented Read(...) syntax; index rows are by hand.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { runFind, runListSections, runLocate } from '../src/read_inspect.js'
import { resolveSymbolSpecOrEmitError } from '../src/read_spec.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

let root: string
let cfg: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const saved: Record<string, string | undefined> = {}

function writeRules(deny: string[]): void {
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny } }))
  resetReadDenyCache()
  resetPermissionSourceCache()
}

function addSym(file: string, name: string, lines: [number, number] = [1, 3]): void {
  getDb(globalDbPath())
    .prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(`${normalizePath(root)}/${file}`, name, 'function', lines[0], lines[1], `function ${name}() {}`, '')
}

type Captured<T> = { value: T | undefined; thrown: unknown; out: string; err: string }

function capture<T>(fn: () => T): Captured<T> {
  let out = ''
  let err = ''
  const o = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: unknown) => { out += String(c); return true }) as typeof process.stdout.write
  process.stderr.write = ((c: unknown) => { err += String(c); return true }) as typeof process.stderr.write
  try {
    try {
      return { value: fn(), thrown: undefined, out, err }
    } catch (thrown) {
      return { value: undefined, thrown, out, err }
    }
  } finally {
    process.stdout.write = o
    process.stderr.write = e
  }
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx16-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx16-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  for (const dir of ['vault', 'src', 'lib']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, 'vault', 'util.ts'), 'export function Dup() {}\n')
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function Dup() {}\n')
  fs.writeFileSync(path.join(root, 'lib', 'util.ts'), 'export function Dup() {}\n')
  fs.writeFileSync(path.join(root, 'vault', 'notes.md'), '# SecretHeading\n\ntext\n')
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), '# ShownHeading\n\ntext\n')
  writeRules(['Read(vault/**)'])
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetReadDenyCache()
  resetPermissionSourceCache()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(cfg, { recursive: true, force: true })
})

describe('section --list refuses a denied file', () => {
  it('names no heading of a file a glob rule denies', () => {
    const r = capture(() => runListSections({ file: path.join(root, 'vault', 'notes.md') }))
    expect(r.thrown, 'list on a denied file must refuse').toBeInstanceOf(Error)
    expect(String((r.thrown as Error).message)).toContain('denied')
    expect(r.out + r.err + String((r.thrown as Error).message)).not.toContain('SecretHeading')
  })

  it('names no heading of a file an exact-path rule denies', () => {
    writeRules(['Read(vault/notes.md)'])
    const r = capture(() => runListSections({ file: path.join(root, 'vault', 'notes.md') }))
    expect(r.thrown, 'list on an exact-path denied file must refuse').toBeInstanceOf(Error)
    expect(r.out + r.err).not.toContain('SecretHeading')
  })

  it('still lists an allowed file', () => {
    const r = capture(() => runListSections({ file: path.join(root, 'src', 'notes.md') }))
    expect(r.value).toBe(0)
    expect(r.out.trim()).toBe('ShownHeading')
  })
})

describe('find and locate drop denied rows', () => {
  it('find prints the allowed file only', () => {
    addSym('src/util.ts', 'Shared')
    addSym('vault/util.ts', 'Shared')
    const r = capture(() => runFind({ pattern: 'Shared' }))
    expect(r.value).toBe(0)
    expect(r.out.trim().split('\n')).toHaveLength(1)
    expect(r.out).toContain('src/util.ts')
    expect(r.out).not.toContain('vault')
  })

  it('find answers a denied-only match as not found', () => {
    addSym('vault/util.ts', 'OnlyHidden')
    const r = capture(() => runFind({ pattern: 'OnlyHidden' }))
    expect(r.value).toBe(1)
    expect(r.out + r.err).not.toContain('vault')
    expect(r.err).toContain('No indexed files match')
  })

  it('find unchanged with no deny rules', () => {
    writeRules([])
    addSym('src/util.ts', 'Shared')
    addSym('vault/util.ts', 'Shared')
    const r = capture(() => runFind({ pattern: 'Shared' }))
    expect(r.out.trim().split('\n')).toEqual(['src/util.ts', 'vault/util.ts'])
  })

  it('locate prints one allowed row and a count of one', () => {
    addSym('src/util.ts', 'Shared', [4, 6])
    addSym('vault/util.ts', 'Shared', [7, 9])
    const r = capture(() => runLocate({ spec: 'Shared', json: true, projectRoot: root }))
    expect(r.value).toBe(0)
    const parsed = JSON.parse(r.out) as { items: { filePath: string }[]; totalCount: number }
    expect(parsed.totalCount).toBe(1)
    expect(parsed.items.map((i) => i.filePath)).toEqual(['src/util.ts'])
    expect(r.out + r.err).not.toContain('vault')
  })

  it('locate answers a denied-only match as not located', () => {
    addSym('vault/util.ts', 'OnlyHidden')
    const r = capture(() => runLocate({ spec: 'OnlyHidden', projectRoot: root }))
    expect(r.value).toBe(1)
    expect(r.out + r.err).not.toContain('vault')
    expect(r.err).toContain('No landmark or symbol located')
  })

  it('locate unchanged with no deny rules', () => {
    writeRules([])
    addSym('src/util.ts', 'Shared', [4, 6])
    addSym('vault/util.ts', 'Shared', [7, 9])
    const r = capture(() => runLocate({ spec: 'Shared', projectRoot: root }))
    expect(r.out.trim().split('\n')).toEqual([
      'src/util.ts:4-6 [function] Shared',
      'vault/util.ts:7-9 [function] Shared',
    ])
  })
})

describe('the symbol-spec resolver filters denied candidates first', () => {
  it('resolves an ambiguity between an allowed and a denied file to the allowed one', () => {
    addSym('src/util.ts', 'Dup', [1, 1])
    addSym('vault/util.ts', 'Dup', [1, 1])
    const r = capture(() => resolveSymbolSpecOrEmitError('diff', 'util.ts::Dup', root))
    expect(r.value?.filePath).toBe(`${normalizePath(root)}/src/util.ts`)
    expect(r.err).not.toContain('vault')
  })

  it('lists only allowed files when an ambiguity among allowed files has a denied one too', () => {
    addSym('src/util.ts', 'Dup', [1, 1])
    addSym('lib/util.ts', 'Dup', [1, 1])
    addSym('vault/util.ts', 'Dup', [1, 1])
    const r = capture(() => resolveSymbolSpecOrEmitError('diff', 'util.ts::Dup', root))
    expect(r.value).toBeNull()
    expect(r.err).toContain('src/util.ts')
    expect(r.err).toContain('lib/util.ts')
    expect(r.err).not.toContain('vault')
  })

  it('refuses a spec that matches only denied files', () => {
    addSym('vault/util.ts', 'Dup', [1, 1])
    addSym('vault/util.ts', 'Dup', [2, 2])
    const r = capture(() => resolveSymbolSpecOrEmitError('diff', 'util.ts::Dup', root))
    expect(r.value).toBeNull()
    expect(r.err).toContain('denied')
  })

  it('never names a denied file in the cross-file lead of a miss', () => {
    addSym('src/util.ts', 'Dup', [1, 1])
    fs.writeFileSync(path.join(root, 'vault', 'other.ts'), 'export function Hidden() {}\n')
    addSym('vault/other.ts', 'Hidden', [2, 2])
    const r = capture(() => resolveSymbolSpecOrEmitError('diff', 'src/util.ts::Hidden', root))
    expect(r.value).toBeNull()
    expect(r.err).toContain('not found')
    expect(r.err).not.toContain('vault')
  })

  it('keeps the cross-file lead for allowed files', () => {
    addSym('src/util.ts', 'Dup', [1, 1])
    fs.writeFileSync(path.join(root, 'lib', 'other.ts'), 'export function Elsewhere() {}\n')
    addSym('lib/other.ts', 'Elsewhere', [2, 2])
    const r = capture(() => resolveSymbolSpecOrEmitError('diff', 'src/util.ts::Elsewhere', root))
    expect(r.value).toBeNull()
    expect(r.err).toContain('lib/other.ts')
  })

  it('resolves an allowed-only spec as before', () => {
    addSym('src/util.ts', 'Dup', [1, 1])
    const r = capture(() => resolveSymbolSpecOrEmitError('diff', 'src/util.ts::Dup', root))
    expect(r.value?.name).toBe('Dup')
  })
})
