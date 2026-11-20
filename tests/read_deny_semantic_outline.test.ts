/** `semantic` and `outline --stats` never let a file the Read rules deny shape their output. */
// Provenance: HAND-DERIVED. Rules use Claude Code's documented Read(...) syntax; the import edges, index rows and hits are written out by hand below.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { runOutline } from '../src/read_outline.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

const { runSemantic } = await import('../src/read_semantic.js')

let root: string
let cfg: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const saved: Record<string, string | undefined> = {}

function writeRules(deny: string[]): void {
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny } }))
  resetReadDenyCache()
  resetPermissionSourceCache()
}

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx18-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx18-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'TOKEN_GOAT_EMBEDDINGS_ENABLED']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeRules(['Read(vault/**)'])
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  searchSemanticMock.mockReset()
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

describe('semantic lets no denied hit shape a diagnostic', () => {
  // A hit far beyond any distance floor, so each one is rejected and only the nearest rejected distance is told.
  const hit = (rel: string, distance: number): SearchHit => ({
    filePath: `${normalizePath(root)}/${rel}`, startLine: 1, endLine: 3, kind: 'window', distance, text: 'DENIEDSNIPPET',
  })

  async function ask(hits: SearchHit[]): Promise<{ text: string; warnings: string }> {
    searchSemanticMock.mockResolvedValue(hits)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const r = await runSemantic('anything', {})
      return { text: r.text, warnings: warn.mock.calls.map((c) => String(c[0])).join('\n') }
    } finally {
      warn.mockRestore()
    }
  }

  it('reports the nearest rejected distance of an allowed hit, not the denied one', async () => {
    const r = await ask([hit('vault/a.ts', 5), hit('src/a.ts', 6)])
    expect(r.warnings, 'the denied hit set the distance').toContain('closest was 6.000')
    expect(r.warnings).not.toContain('5.000')
  })

  it('stays silent about a floor that only a denied hit crossed', async () => {
    const r = await ask([hit('vault/a.ts', 5)])
    expect(r.warnings, 'a denied hit was told as a rejected distance').not.toContain('closest was')
    expect(r.text + r.warnings).not.toContain('DENIEDSNIPPET')
  })

  it('tells the distance when no rule applies', async () => {
    writeRules([])
    const r = await ask([hit('vault/a.ts', 5), hit('src/a.ts', 6)])
    expect(r.warnings).toContain('closest was 5.000')
  })
})

describe('outline --stats counts only references from files the Read rules allow', () => {
  function seed(): void {
    const db = getDb(globalDbPath())
    const base = normalizePath(root)
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(`${base}/src/a.ts`, 'Target', 'function', 1, 3, 'function Target() {}', '')
    const ref = db.prepare('INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)')
    ref.run(`${base}/src/b.ts`, 'Target', 1, 0, '')
    ref.run(`${base}/vault/c.ts`, 'Target', 1, 0, '')
    ref.run(`${base}/vault/d.ts`, 'Target', 2, 0, '')
    put('src/a.ts', 'function Target() {}\n')
  }

  const refCount = (): number => {
    const r = runOutline({ file: path.join(root, 'src', 'a.ts'), stats: true, json: true })
    return (JSON.parse(r.text) as { items: Array<{ refCount: number }> }).items[0]!.refCount
  }

  it('does not count a reference a denied file holds', () => {
    seed()
    expect(refCount(), 'denied references were counted').toBe(1)
  })

  it('counts every reference when no rule applies', () => {
    seed()
    writeRules([])
    expect(refCount()).toBe(3)
  })
})
