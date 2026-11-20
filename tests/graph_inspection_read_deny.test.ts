/** `types`, `scope` and `dead` honour the host Read deny rules for files indexed before the rule existed. */
// Provenance: HAND-DERIVED. Rules use Claude Code's documented Read(...) syntax; rows are inserted by hand.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runDead, runScope, runTypes } from '../src/graph_inspection.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

let root: string
let cfg: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const saved: Record<string, string | undefined> = {}

function addSym(file: string, name: string, kind: string, body: string): void {
  getDb(globalDbPath())
    .prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(`${normalizePath(root)}/${file}`, name, kind, 1, 3, body, '')
}

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  const o = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: unknown) => { out += String(c); return true }) as typeof process.stdout.write
  process.stderr.write = ((c: unknown) => { err += String(c); return true }) as typeof process.stderr.write
  try {
    return { code: fn(), out, err }
  } finally {
    process.stdout.write = o
    process.stderr.write = e
  }
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ginsp-deny-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ginsp-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  const rules = { permissions: { deny: ['Read(vault/**)'] } }
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(rules))
  fs.mkdirSync(path.join(root, 'vault'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vault', 'secret.ts'), 'interface Hidden {}\n')
  fs.writeFileSync(path.join(root, 'src', 'ok.ts'), 'interface Shown {}\n')
  resetReadDenyCache()
  resetPermissionSourceCache()
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

describe('scope refuses a denied file', () => {
  it('prints the denial and no stored body with --json', () => {
    addSym('vault/secret.ts', 'Hidden', 'interface', 'interface Hidden { TOPSECRETBODY: string }')
    const r = capture(() => runScope({ spec: 'vault/secret.ts:2', json: true, projectRoot: root }))
    expect(r.code, 'scope on a denied file must refuse').toBe(1)
    expect(r.out + r.err).not.toContain('TOPSECRETBODY')
    expect(r.err).toContain('denied')
  })

  it('still answers for an allowed file', () => {
    addSym('src/ok.ts', 'Shown', 'interface', 'interface Shown { fine: string }')
    const r = capture(() => runScope({ spec: 'src/ok.ts:2', json: true, projectRoot: root }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('Shown')
  })
})

describe('types drops denied files', () => {
  beforeEach(() => {
    addSym('src/ok.ts', 'Shown', 'interface', 'interface Shown { fine: string }')
    addSym('vault/secret.ts', 'Hidden', 'interface', 'interface Hidden { TOPSECRETBODY: string }')
  })

  it('lists the allowed symbol and nothing of the denied one with --json', () => {
    const r = capture(() => runTypes({ json: true }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('Shown')
    expect(r.out).not.toContain('Hidden')
    expect(r.out).not.toContain('TOPSECRETBODY')
  })

  it('agrees in text mode', () => {
    const r = capture(() => runTypes({}))
    expect(r.out).toContain('Shown')
    expect(r.out).not.toContain('Hidden')
    expect(r.out).not.toContain('secret.ts')
  })

  it('refuses an explicit denied file option', () => {
    const r = capture(() => runTypes({ file: 'vault/secret.ts', json: true }))
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('TOPSECRETBODY')
    expect(r.out).not.toContain('Hidden')
    expect(r.err).toContain('denied')
  })
})

describe('dead drops denied files, as symbol and search do', () => {
  beforeEach(() => {
    addSym('src/ok.ts', 'unusedShown', 'function', 'function unusedShown() {}')
    addSym('vault/secret.ts', 'unusedHidden', 'function', 'function unusedHidden() {}')
  })

  it('lists no denied name or path with --json', () => {
    const r = capture(() => runDead({ json: true }))
    expect(r.out).toContain('unusedShown')
    expect(r.out).not.toContain('unusedHidden')
    expect(r.out).not.toContain('secret.ts')
  })

  it('agrees in text mode', () => {
    const r = capture(() => runDead({}))
    expect(r.out).toContain('unusedShown')
    expect(r.out).not.toContain('unusedHidden')
    expect(r.out).not.toContain('secret.ts')
  })
})

describe('types drops denied class rows that read as a type', () => {
  beforeEach(() => {
    addSym('src/ok.ts', 'ShownModel', 'class', 'class ShownModel(BaseModel): fine: str')
    addSym('vault/secret.ts', 'HiddenModel', 'class', 'class HiddenModel(BaseModel): TOPSECRETCLASS: str')
  })

  it('lists the allowed class and nothing of the denied one with --json', () => {
    const r = capture(() => runTypes({ json: true }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('ShownModel')
    expect(r.out).not.toContain('HiddenModel')
    expect(r.out).not.toContain('TOPSECRETCLASS')
    expect(r.out).not.toContain('secret.ts')
  })

  it('agrees in text mode', () => {
    const r = capture(() => runTypes({}))
    expect(r.out).toContain('ShownModel')
    expect(r.out).not.toContain('HiddenModel')
    expect(r.out).not.toContain('secret.ts')
  })
})
