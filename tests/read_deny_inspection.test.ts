/** `dead` and `types` list only files the Read rules allow, and neither names a denied path on stderr. */
// Provenance: HAND-DERIVED. Rules use Claude Code's documented Read(...) syntax; index rows are written out by hand.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { runDead, runTypes } from '../src/graph_inspection.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
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

function addSym(file: string, name: string, kind = 'function'): void {
  getDb(globalDbPath())
    .prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(`${normalizePath(root)}/${file}`, name, kind, 1, 1, `${kind} ${name}() {}`, '')
}

function addRef(file: string, name: string): void {
  getDb(globalDbPath())
    .prepare('INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)')
    .run(`${normalizePath(root)}/${file}`, name, 3, 1, `${name}()`)
}

type Captured = { value: number | undefined; thrown: unknown; out: string; err: string }

function capture(fn: () => number): Captured {
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
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx19-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx19-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeRules(['Read(vault/**)'])
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  getDb(globalDbPath()).prepare('DELETE FROM symbols').run()
  getDb(globalDbPath()).prepare('DELETE FROM refs').run()
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

describe('dead', () => {
  function seed(): void {
    addSym('lib/helper.ts', 'plainDead')
    addSym('lib/helper.ts', 'onlyDeniedCaller')
    addSym('lib/helper.ts', 'usedByAllowed')
    addSym('vault/secret.ts', 'secretDead')
    addRef('vault/secret.ts', 'onlyDeniedCaller')
    addRef('src/main.ts', 'usedByAllowed')
  }

  it('lists only allowed dead symbols, judges reachability by allowed files, and names no denied path', () => {
    seed()
    const r = capture(() => runDead({}))
    expect(r.value).toBe(0)
    expect(r.out, 'a denied file symbol was listed').not.toContain('secretDead')
    expect(r.out, 'a symbol only a denied file uses was kept alive by it').toContain('onlyDeniedCaller')
    expect(r.out, 'an allowed symbol that an allowed file uses was listed').not.toContain('usedByAllowed')
    expect(r.out, 'an allowed dead symbol was dropped').toContain('plainDead')
    expect(r.out + r.err, 'a denied path was named').not.toContain('vault')
  })

  it('prints the ordinary empty text and no denied path when only a denied file has a dead symbol', () => {
    addSym('vault/secret.ts', 'secretDead')
    const r = capture(() => runDead({}))
    expect(r.value).toBe(0)
    expect(r.out).toContain('No dead symbols found.')
    expect(r.out + r.err, 'a denied name or path was printed').not.toMatch(/vault|secretDead/)
  })

  it('with no rules lists every dead symbol and lets a denied-path reference keep a symbol alive', () => {
    seed()
    writeRules([])
    const r = capture(() => runDead({}))
    expect(r.out.split('\n').filter((l) => l.length > 0).sort()).toEqual([
      'plainDead\tlib/helper.ts:1',
      'secretDead\tvault/secret.ts:1',
    ])
    expect(r.err).toBe('')
  })
})

describe('types', () => {
  function seed(): void {
    addSym('lib/t.ts', 'PublicShape', 'interface')
    addSym('vault/t.ts', 'SecretShape', 'interface')
  }

  it('lists only allowed type declarations and names no denied path on stderr', () => {
    seed()
    const r = capture(() => runTypes({}))
    expect(r.value).toBe(0)
    expect(r.out).toContain('PublicShape')
    expect(r.out + r.err, 'a denied name or path was printed').not.toMatch(/vault|SecretShape/)
  })

  it('prints the ordinary none-found text and no denied path when only a denied file declares a type', () => {
    addSym('vault/t.ts', 'SecretShape', 'interface')
    const r = capture(() => runTypes({}))
    expect(r.value).toBe(1)
    expect(r.err).toContain('No type declarations found')
    expect(r.out + r.err, 'a denied name or path was printed').not.toMatch(/vault|SecretShape/)
  })

  it('with no rules lists both and writes nothing to stderr', () => {
    seed()
    writeRules([])
    const r = capture(() => runTypes({}))
    expect(r.out.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t')[0]).sort())
      .toEqual(['PublicShape', 'SecretShape'])
    expect(r.err).toBe('')
  })
})
