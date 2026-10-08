// `describe <db> [table]` printed the database path and the table and column names as stored, so a name holding a bidi override or a zero-width joiner reached the model with its control characters intact: both are legal in a file name and in a quoted SQLite identifier.

// HAND-DERIVED: the names are invented to hold U+202E (bidi override) and U+200D (zero-width joiner), both format characters (Unicode category Cf); the expected spellings are displaySafeText's `\uNNNN` escapes, computed from the code points here and not from the implementation's output.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { describeTarget } from '../src/session_store_schema.js'
import Database from '../src/sqlite_driver.js'

const RLO = String.fromCharCode(0x202e)
const ZWJ = String.fromCharCode(0x200d)
const BS = String.fromCharCode(92)
const RLO_ESCAPED = `${BS}u202e`
const ZWJ_ESCAPED = `${BS}u200d`

let root: string
let dbPath: string
let cwdBefore: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), `tg-describe${RLO}names-`))
  dbPath = join(root, `names${RLO}.db`)
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE "tab${RLO}le" ("col${ZWJ}umn" TEXT)`)
  db.close()
  cwdBefore = process.cwd()
  process.chdir(root)
})

afterAll(() => {
  process.chdir(cwdBefore)
  rmSync(root, { recursive: true, force: true })
})

describe('describe on a database escapes the names it prints', () => {
  it('escapes the table, the column and the database path in a table description', async () => {
    const res = await describeTarget(`names${RLO}.db`, `tab${RLO}le`)
    expect(res.exitCode).toBe(0)
    expect(res.text).toContain(`tab${RLO_ESCAPED}le`)
    expect(res.text).toContain(`col${ZWJ_ESCAPED}umn`)
    expect(res.text).toContain(`names${RLO_ESCAPED}.db`)
    expect(res.text).not.toContain(RLO)
    expect(res.text).not.toContain(ZWJ)
  })

  it('escapes the table names a not-found error lists', async () => {
    const res = await describeTarget(`names${RLO}.db`, 'missing')
    expect(res.exitCode).toBe(1)
    expect(res.text).toContain(`tab${RLO_ESCAPED}le`)
    expect(res.text).not.toContain(RLO)
  })
})
