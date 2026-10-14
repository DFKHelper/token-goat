/** claimSessionFlag holds a once-per-session notice in global.db, where the worker's 24-hour sweep of idle session state cannot reach it, and pruneSessionFlags keeps those rows from accumulating one per session for good. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from '../src/sqlite_driver.js'
import { FIRST_RECEIPT_FLAG, GLOBAL_SCHEMA_SQL, STATS_RETENTION_DAYS, claimSessionFlag, pruneSessionFlags } from '../src/stats.js'

let tempDir: string
let db: Database

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-flags-'))
  db = new Database(path.join(tempDir, 'global.db'))
  db.exec(GLOBAL_SCHEMA_SQL)
})

afterEach(() => {
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function flagNames(): string[] {
  return (db.prepare('SELECT name FROM stats_flags ORDER BY name').all() as { name: string }[]).map((r) => r.name)
}

describe('claimSessionFlag', () => {
  it('wins once per flag and session, and a different session claims its own', () => {
    expect(claimSessionFlag('notice', 'sess-a', db)).toBe(true)
    expect(claimSessionFlag('notice', 'sess-a', db)).toBe(false)
    expect(claimSessionFlag('notice', 'sess-b', db)).toBe(true)
    expect(claimSessionFlag('other-notice', 'sess-a', db)).toBe(true)
  })
})

describe('pruneSessionFlags', () => {
  it('ages out session claims past the stats retention and leaves recent claims and the receipt flag alone', () => {
    const day = 86_400_000
    const now = Date.now()
    claimSessionFlag('notice', 'old-session', db, now - (STATS_RETENTION_DAYS + 1) * day)
    claimSessionFlag('notice', 'recent-session', db, now - day)
    db.prepare('INSERT INTO stats_flags (name, set_ts) VALUES (?, ?)').run(FIRST_RECEIPT_FLAG, Math.floor((now - (STATS_RETENTION_DAYS + 30) * day) / 1000))
    expect(flagNames()).toHaveLength(3)

    pruneSessionFlags(db)

    expect(flagNames()).toEqual([FIRST_RECEIPT_FLAG, 'session:notice:recent-session'].sort())
    expect(claimSessionFlag('notice', 'old-session', db), 'a pruned claim can be taken again').toBe(true)
  })
})
