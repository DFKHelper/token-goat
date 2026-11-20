/** `deps --importers` never names a file the Read rules deny. */
// Provenance: HAND-DERIVED. Rules use Claude Code's documented Read(...) syntax; the import edges, index rows and hits are written out by hand below.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runDeps } from '../src/graph_inspection.js'
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

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: root, stdio: 'ignore' })
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx18-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx18-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  // lib.ts is imported by pub.ts (allowed) and vault/priv.ts (denied); solo.ts only by vault/priv.ts.
  put('lib.ts', 'export const lib = 1\n')
  put('solo.ts', 'export const solo = 1\n')
  put('pub.ts', "import { lib } from './lib'\nexport const pub = lib\n")
  put('vault/priv.ts', "import { lib } from '../lib'\nimport { solo } from '../solo'\nexport const priv = lib + solo\n")
  git('init')
  git('add', 'lib.ts', 'solo.ts', 'pub.ts', 'vault/priv.ts')
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

describe('deps --importers drops importers the Read rules deny', () => {
  const importers = (rel: string, extra: { json?: boolean; grep?: string } = {}): Captured<number> =>
    capture(() => runDeps({ file: path.join(root, rel), importers: true, ...extra }))

  it('prints only the allowed importer when an allowed and a denied file import the target', () => {
    const r = importers('lib.ts')
    expect(r.value).toBe(0)
    expect(r.out, 'a denied importer was named').toBe('imported by:\n  pub.ts\n')
    expect(r.err).not.toContain('vault')
  })

  it('keeps json to the allowed importer with a count of one and no hidden-by-grep disclosure', () => {
    const r = importers('lib.ts', { json: true })
    expect(JSON.parse(r.out)).toEqual({ file: 'lib.ts', importedBy: ['pub.ts'] })
    const g = importers('lib.ts', { json: true, grep: '^pub' })
    expect(JSON.parse(g.out)).toEqual({ file: 'lib.ts', importedBy: ['pub.ts'] })
  })

  it('says nothing imports the target when only a denied file does', () => {
    const r = importers('solo.ts')
    expect(r.value).toBe(0)
    expect(r.out).toBe('(no project file imports it)\n')
    expect(r.out + r.err).not.toContain('vault')
  })

  it('honours an exact-path rule the same way', () => {
    writeRules(['Read(vault/priv.ts)'])
    expect(importers('lib.ts').out).toBe('imported by:\n  pub.ts\n')
    expect(importers('solo.ts').out).toBe('(no project file imports it)\n')
  })

  it('refuses a denied target', () => {
    const r = importers('vault/priv.ts')
    expect(r.value).toBe(1)
    expect(r.out).toBe('')
  })

  it('lists every importer, byte for byte, when no rule applies', () => {
    writeRules([])
    expect(importers('lib.ts').out).toBe('imported by:\n  pub.ts\n  vault/priv.ts\n')
    expect(importers('solo.ts').out).toBe('imported by:\n  vault/priv.ts\n')
  })
})
