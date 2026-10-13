import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkDeferredSessionStarts } from '../src/cli_doctor.js'
import { getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { GLOBAL_SCHEMA_SQL } from '../src/stats.js'

// Provenance: HAND-DERIVED. Rows are inserted directly into the `stats` table with the column list stats.ts writes, and the expected counts are the number of rows inserted here, not a value read back from the check.

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-deferred-'))
})

afterEach(() => {
  // getDb caches an open handle per path; close it before rmSync or Windows refuses to delete the locked files.
  clearModuleCaches()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function seed(dbPath: string, kinds: string[]): void {
  const db = getDb(dbPath)
  db.exec(GLOBAL_SCHEMA_SQL)
  const stmt = db.prepare("INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, 0, 0)")
  for (const kind of kinds) stmt.run(Date.now(), kind)
}

describe('checkDeferredSessionStarts (R8 doctor line)', () => {
  it('reports no database yet', () => {
    const result = checkDeferredSessionStarts(path.join(tempDir, 'global.db'))
    expect(result.status).toBe('ok')
    expect(result.message).toContain('no database yet')
  })

  it('reports none when no deferral was recorded', () => {
    const dbPath = path.join(tempDir, 'global.db')
    seed(dbPath, ['compact_summary'])
    expect(checkDeferredSessionStarts(dbPath).message).toContain('none')
  })

  it('counts only session_start_deferred rows', () => {
    const dbPath = path.join(tempDir, 'global.db')
    seed(dbPath, ['session_start_deferred', 'compact_summary', 'session_start_deferred'])
    const result = checkDeferredSessionStarts(dbPath)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('2 session starts')
  })

  it('uses the singular for one', () => {
    const dbPath = path.join(tempDir, 'global.db')
    seed(dbPath, ['session_start_deferred'])
    expect(checkDeferredSessionStarts(dbPath).message).toContain('1 session start missed')
  })
})
