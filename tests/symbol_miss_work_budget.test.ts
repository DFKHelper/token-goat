/** A `symbol NAME` miss on a large project used to take minutes: a user measured 341 s on a 968,240-symbol project, and the same miss here took 310 s on the 546,394-symbol aws-cdk index, 187 s of it inside SQLite. The miss path walked the whole project with forEachSymbol, 10,000 full rows (bodies included) per OFFSET page, and every page sorted the entire scope before skipping to its offset -- 1.2 s for the first page, 5.2 s for the last. The answer it needed was a list of distinct names, one exact-name lookup and a list of JSON/YAML files. Nothing caught it because the near-name tests in tests/read_commands.test.ts mock querySymbols and seed a single row, so the walk was one page of one row and cost nothing; wall clock never enters CI. These tests seed a real index past three scan pages and count the work the miss does through the real connection: statements against `symbols`, and rows fetched with a body. Fixture provenance: HAND-DERIVED. The seeded names and the expected lines are computed from the inputs below; the expected suggestion follows from rankSimilarNames's two-edit budget for a 14-character query, independently of the DB path under test. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_symbol.js'
import { instrumentSymbolReads as instrument } from './helpers/symbol_work.js'

/** Past two full 10,000-row scan pages, so a walk of the old kind issues at least three page queries. */
const FILLER_ROWS = 25_000

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-miss-budget-')))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  const db = getDb(globalDbPath())
  const symbol = db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const file = db.prepare('INSERT OR REPLACE INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < FILLER_ROWS; i++) {
      // Ten rows per file keeps the file count realistic; the body makes a full-row walk visibly different from a names-only one.
      const p = `${root}/aaa_filler_${String(Math.floor(i / 10)).padStart(5, '0')}.ts`
      symbol.run(p, `fillerSymbol${i}`, 'function', (i % 10) * 3 + 1, (i % 10) * 3 + 2, `function fillerSymbol${i}() {}`, '')
      if (i % 10 === 0) file.run(p, 'sha', 0, 'typescript', 0)
    }
    symbol.run(`${root}/zzz_target.ts`, 'quokkaLandmark', 'function', 1, 3, 'function quokkaLandmark() {}', '')
    // On disk and stamped with its own SHA-256, so a miss that checks its suggestion against disk finds the file present and fresh: a missing file drops the name, and a mismatched hash reindexes it.
    const target = 'function quokkaLandmark() {\n  return 1\n}\n'
    fs.writeFileSync(`${root}/zzz_target.ts`, target)
    file.run(`${root}/zzz_target.ts`, createHash('sha256').update(target).digest('hex'), 0, 'typescript', 0)
  })()
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('symbol miss on a project spanning several scan pages', () => {
  it('suggests the near name without walking a single full row', () => {
    const { work, restore } = instrument()
    let r: { text: string; code: number }
    try {
      r = runSymbol({ name: 'quokkaLandmarc', projectRoot: root })
    } finally {
      restore()
    }
    expect(r.code).toBe(1)
    expect(r.text).toBe(`No matches for 'quokkaLandmarc'\nDid you mean:\n  - quokkaLandmark`)
    // The lookup itself, the emptiness check, the exact-name check, the names query, the one query for the files behind the top-ranked names and the structured-file query. The old walk alone was three page queries on top of the first two.
    expect(work.statements).toBeLessThanOrEqual(6)
    // No statement on the miss path fetches a body here: the exact-name check finds nothing, and the old walk fetched all 25,001.
    expect(work.bodyRows).toBe(0)
    // The ranking's candidates are the project's 25,001 distinct names, fetched once, plus the emptiness check's one count row and the one file behind the one ranked name.
    expect(work.rows).toBeLessThanOrEqual(FILLER_ROWS + 3)
  })

  it('reports an exact name hidden by --kind from one indexed lookup, not a walk', () => {
    const { work, restore } = instrument()
    let r: { text: string; code: number }
    try {
      r = runSymbol({ name: 'quokkaLandmark', kind: 'class', projectRoot: root })
    } finally {
      restore()
    }
    expect(r.code).toBe(1)
    expect(r.text).toBe(`No matches for 'quokkaLandmark'\n'quokkaLandmark' IS indexed (function at zzz_target.ts:1) -- drop --kind to see it`)
    // One body for the one hidden row it names, where the old walk read all 25,001.
    expect(work.bodyRows).toBe(1)
    // Nothing on this branch needs the vocabulary: the exact hit settles it.
    expect(work.statements).toBeLessThanOrEqual(4)
    expect(work.rows).toBeLessThanOrEqual(2)
  })

  it('counts every exact row the scope hid, past the five it names', () => {
    const db = getDb(globalDbPath())
    const symbol = db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (let i = 0; i < 7; i++) symbol.run(`${root}/zzz_dup_${i}.ts`, 'quokkaTwin', 'function', 1, 1, '', '')
    const r = runSymbol({ name: 'quokkaTwin', kind: 'class', projectRoot: root })
    expect(r.text).toContain('(+2 more)')
    expect(r.text).toContain('function at zzz_dup_0.ts:1; function at zzz_dup_1.ts:1')
  })

  it('offers no suggestion and points at semantic when nothing is near', () => {
    const r = runSymbol({ name: 'zzzzzzzzzz', projectRoot: root })
    expect(r.code).toBe(1)
    expect(r.text).toBe(`No matches for 'zzzzzzzzzz'\nTry: token-goat semantic "zzzzzzzzzz"`)
  })

  it('answers an exact hit unchanged', () => {
    const r = runSymbol({ name: 'quokkaLandmark', projectRoot: root })
    expect(r.code).toBe(0)
    expect(r.text).toContain('# quokkaLandmark (function) — zzz_target.ts:1')
  })

  it('emits the same JSON envelope a hit does, and reads nothing past the lookup', () => {
    const hit = JSON.parse(runSymbol({ name: 'quokkaLandmark', projectRoot: root, json: true }).text) as Record<string, unknown>
    const { work, restore } = instrument()
    let r: { text: string; code: number }
    try {
      r = runSymbol({ name: 'quokkaLandmarc', projectRoot: root, json: true })
    } finally {
      restore()
    }
    expect(r.code).toBe(0)
    const miss = JSON.parse(r.text) as Record<string, unknown>
    expect(miss).toEqual({ items: [], truncated: false, totalCount: 0 })
    expect(Object.keys(miss).sort()).toEqual(Object.keys(hit).sort())
    expect(work.statements).toBe(1)
  })
})
