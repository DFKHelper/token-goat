/** `outline --stats` follows the Read rules in force on every call and asks for per-name references only under a rule. */
// Provenance: HAND-DERIVED. Rules use Claude Code's documented Read(...) syntax; index rows are written out by hand.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import type * as IndexReaderModule from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { runOutline } from '../src/read_outline.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

const queryRefsSpy = vi.fn()

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return {
    ...actual,
    queryRefs: (...args: Parameters<typeof actual.queryRefs>) => {
      queryRefsSpy(...args)
      return actual.queryRefs(...args)
    },
  }
})

let root: string
let cfg: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const saved: Record<string, string | undefined> = {}

function writeRules(deny: string[]): void {
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny } }))
  resetReadDenyCache()
  resetPermissionSourceCache()
}

function seed(): void {
  const db = getDb(globalDbPath())
  const base = normalizePath(root)
  db.prepare('DELETE FROM symbols').run()
  db.prepare('DELETE FROM refs').run()
  db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`${base}/src/a.ts`, 'Target', 'function', 1, 3, 'function Target() {}', '')
  const ref = db.prepare('INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)')
  ref.run(`${base}/src/b.ts`, 'Target', 1, 0, '')
  ref.run(`${base}/vault/c.ts`, 'Target', 1, 0, '')
  ref.run(`${base}/vault/d.ts`, 'Target', 2, 0, '')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'function Target() {}\n')
}

const refCount = (): number => {
  const r = runOutline({ file: path.join(root, 'src', 'a.ts'), stats: true, json: true })
  return (JSON.parse(r.text) as { items: Array<{ refCount: number }> }).items[0]!.refCount
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx19-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx19-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeRules([])
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  queryRefsSpy.mockReset()
  seed()
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

describe('outline --stats reference counts follow the rules in force', () => {
  it('shows the filtered count after a rule is added and the full count after it is removed', () => {
    expect(refCount(), 'no rule: every reference counts').toBe(3)
    writeRules(['Read(vault/**)'])
    expect(refCount(), 'a count taken before the rule was served after it').toBe(1)
    writeRules([])
    expect(refCount(), 'a count taken under the rule was served after its removal').toBe(3)
  })

  it('makes no per-name reference query when no rule is in force', () => {
    expect(refCount()).toBe(3)
    expect(queryRefsSpy, 'a per-name lookup ran with no rule in force').not.toHaveBeenCalled()
  })

  it('makes no per-name reference query when the project has no settings file', () => {
    fs.rmSync(path.join(root, '.claude', 'settings.json'))
    resetReadDenyCache()
    resetPermissionSourceCache()
    expect(refCount()).toBe(3)
    expect(queryRefsSpy).not.toHaveBeenCalled()
  })

  it('still subtracts denied references under a rule by looking the name up once', () => {
    writeRules(['Read(vault/**)'])
    expect(refCount()).toBe(1)
    expect(queryRefsSpy, 'the denied references were not looked up').toHaveBeenCalledTimes(1)
  })
})
