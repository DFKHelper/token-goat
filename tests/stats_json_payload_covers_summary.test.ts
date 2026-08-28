/**
 * Every field of a stats summary must reach `stats --json`.
 *
 * The payload is a hand-listed object, which is deliberate (see `statsJsonPayload`) and is also a
 * whitelist: a field added to `StatsSummary` ships dead on the wire until someone remembers to add it
 * here too, and nothing fails in the meantime. That is not hypothetical. `counts` was added to the
 * summary, covered by unit tests, typechecked, and passed the full suite, and `stats --json` still
 * did not contain it: the omission surfaced only by running the built binary and reading the literal
 * output. This test is the mechanical version of that run.
 *
 * Provenance: HAND-DERIVED. The expectation is a set relation between two runtime objects, not a
 * transcribed shape, so there is no producer whose own output could be restated here by accident.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from '../src/sqlite_driver.js'
import { statsJsonPayload } from '../src/cli_stats.js'
import { GLOBAL_SCHEMA_SQL, summarize } from '../src/stats.js'

describe('the stats --json payload', () => {
  let tempDir: string
  let db: Database

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-json-cover-'))
    db = new Database(path.join(tempDir, 'test.db'))
    db.exec(GLOBAL_SCHEMA_SQL)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('carries every field the summary has, so a new one cannot ship dead on the wire', () => {
    // Seeded rather than empty: a summary built from no rows still has every key, but seeding both a
    // saving and a count-only row means the assertion runs against the shape a real user gets.
    const now = Math.floor(Date.now() / 1000)
    const insert = db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)')
    insert.run(now, 'image_shrink', 4000, 1000)
    insert.run(now, 'secret_redacted', 0, 37)

    const summary = summarize(30, db)
    const payload = statsJsonPayload(summary)

    const missing = Object.keys(summary).filter((k) => !(k in payload))
    expect(missing, 'each of these is on StatsSummary and absent from the JSON output: add it to statsJsonPayload in src/cli_stats.ts').toEqual([])

    // The other direction too. A key in the payload with no summary field behind it is a field that
    // was renamed or removed, still being published as undefined.
    const orphaned = Object.keys(payload).filter((k) => !(k in summary))
    expect(orphaned, 'each of these is published by stats --json and no longer exists on StatsSummary').toEqual([])
  })

  it('publishes the redaction count under counts, not inside the token total', () => {
    // The specific field that shipped dead, pinned by name so a future refactor that drops it fails
    // here rather than in a user's parser.
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)').run(now, 'secret_redacted', 0, 37)

    const payload = statsJsonPayload(summarize(30, db))
    expect(payload['counts']).toEqual({ secret_redacted: 37 })
    expect(payload['total_tokens_saved']).toBe(0)
  })
})
