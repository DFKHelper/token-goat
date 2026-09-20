/**
 * The oversized-index warning names what is actually recoverable instead of always recommending a VACUUM.
 *
 * Provenance: the freelist cases are CAPTURE, a database SQLite itself just wrote, checked against SQLite's own `freelist_count` and `page_size` pragmas. The message cases are HAND-DERIVED from a real `token-goat doctor` run on a 2,250 MB index whose VACUUM freed 1.3 MB and which held 3,186 scratch files indexed under the OS temp dir.
 */
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { freelistBytes, oversizeDbMessage } from '../src/cli_doctor.js'
import { tempDir } from './helpers/temp-config.js'

const MB = 1024 * 1024

describe('freelistBytes', () => {
  it.each([4096, 65536])('matches SQLite\'s own freelist accounting at page size %i', (pageSize) => {
    const dbPath = path.join(tempDir(), 'free.db')
    const db = new Database(dbPath)
    db.pragma(`page_size = ${pageSize}`)
    db.exec('CREATE TABLE t (b BLOB)')
    const insert = db.prepare('INSERT INTO t VALUES (?)')
    for (let i = 0; i < 50; i++) insert.run(Buffer.alloc(pageSize * 2))
    db.exec('DELETE FROM t')
    const expected = (db.pragma('freelist_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number)
    db.close()

    expect(expected, 'the fixture left no free pages, so a zero reading would pass').toBeGreaterThan(0)
    expect(freelistBytes(fs.readFileSync(dbPath).subarray(0, 100))).toBe(expected)
  })
})

describe('oversizeDbMessage', () => {
  it('says the file is live data instead of recommending a reclaim that frees nothing', () => {
    const msg = oversizeDbMessage('/data/global.db', 2250 * MB, 1.3 * MB, 0)
    expect(msg).toContain('live index data')
    expect(msg).not.toContain("'token-goat reclaim-index' returns")
  })

  it('sends temp-dir scratch rows to project prune', () => {
    const msg = oversizeDbMessage('/data/global.db', 2250 * MB, 1.3 * MB, 3186)
    expect(msg).toContain("'token-goat project prune' removes 3186 scratch files")
    expect(msg).not.toContain('live index data')
  })

  it('sends a file that is largely free pages to reclaim-index', () => {
    expect(oversizeDbMessage('/data/global.db', 2000 * MB, 900 * MB, 0)).toContain("'token-goat reclaim-index' returns the 900 MB")
  })

  // HAND-DERIVED: category byte counts are constructed by this test, not read off the message's own formatter.
  it('names the dominant category and its shrink command before the smaller ones', () => {
    const msg = oversizeDbMessage('/data/global.db', 2250 * MB, 1.3 * MB, 0, [
      { name: 'embedding vectors', bytes: 320 * MB, command: "'token-goat reclaim-index --rebuild' drops them" },
      { name: 'symbol bodies', bytes: 160 * MB, command: "'token-goat reclaim-index --rebuild' drops and re-derives them" },
      { name: 'stats detail', bytes: 10 * MB, command: 'ages out on its own (180-day retention)' },
    ])
    expect(msg).toContain('embedding vectors 320 MB')
    expect(msg.indexOf('embedding vectors')).toBeLessThan(msg.indexOf('symbol bodies'))
    expect(msg).toContain("reclaim-index --rebuild")
  })

  // HAND-DERIVED: project roots and file counts are constructed by this test, not read off the message's own formatter.
  it('names top project consumers when present', () => {
    const msg = oversizeDbMessage('/data/global.db', 2250 * MB, 1.3 * MB, 0, [], [
      { root: '/repos/large-frontend', fileCount: 8400 },
      { root: '/repos/backend-service', fileCount: 3120 },
    ])
    expect(msg).toContain('Top index consumers:')
    expect(msg).toContain('large-frontend (8400 files)')
    expect(msg).toContain('backend-service (3120 files)')
  })

  // Both halves answer different questions -- which table holds the bytes, and which project put them there -- so the merged message must carry both rather than one displacing the other.
  it('carries the category breakdown and the top consumers in the same message', () => {
    const msg = oversizeDbMessage('/data/global.db', 2250 * MB, 1.3 * MB, 0, [{ name: 'symbol bodies', bytes: 160 * MB, command: "'token-goat reclaim-index --rebuild' drops and re-derives them" }], [{ root: '/repos/large-frontend', fileCount: 8400 }])
    expect(msg).toContain('symbol bodies 160 MB')
    expect(msg).toContain('large-frontend (8400 files)')
  })
})
