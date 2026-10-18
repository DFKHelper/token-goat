/** `token-goat index` hashes a file to decide it is unchanged and skips it; the hash that proves it clean is recorded, as the worker's drain does, so a racy row stops being hashed on every later sweep. Fixture provenance: HAND-DERIVED. Every mtime and index time below is computed from the racy rule `mtime + 2 <= indexed_at` (reconcile.ts::mtimeProvesUnchanged); the 'now' side is the real clock compared only against a stamp decades or an hour away from it, so no timing decides a row. No wire format is involved. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs, getDb } from '../src/db.js'

const OLD = 1_000_000_000
// An hour ahead of any clock this runs on: never a tick older than now, however slow the machine, so it stands for a file still being written.
const STILL_BEING_WRITTEN = Math.floor(Date.now() / 1000) + 3600
const SOURCE = 'export function racySymbol(): number {\n  return 1\n}\n'

let tmp: string
let dbPath: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-racy-'))
  dbPath = path.join(tmp, 'index.db')
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function indexedAt(name: string): number {
  return (getDb(dbPath).prepare('SELECT indexed_at FROM files WHERE path LIKE ?').get(`%/${name}`) as { indexed_at: number }).indexed_at
}

/** Writes and indexes `name` at `mtimeSec`, then says it was indexed in the same second as that stamp, which makes the row racy. */
async function indexRacy(name: string, mtimeSec: number): Promise<void> {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, SOURCE)
  fs.utimesSync(file, mtimeSec, mtimeSec)
  await cmdIndex(tmp, { walk: true, dbPath })
  getDb(dbPath).prepare('UPDATE files SET indexed_at = ? WHERE path LIKE ?').run(mtimeSec, `%/${name}`)
}

describe('cmdIndex proves an unchanged file clean and records it', () => {
  it('gives a racy row whose bytes are unchanged an index time a tick past its mtime', async () => {
    await indexRacy('racy.ts', OLD)
    expect(indexedAt('racy.ts'), 'calibration: the row starts racy').toBe(OLD)

    await cmdIndex(tmp, { walk: true, dbPath })

    expect(indexedAt('racy.ts'), 'the run hashed the file, found it unchanged, and left the row racy').toBeGreaterThan(OLD + 2)
  })

  it('leaves a file still being written racy', async () => {
    await indexRacy('writing.ts', STILL_BEING_WRITTEN)

    await cmdIndex(tmp, { walk: true, dbPath })

    expect(indexedAt('writing.ts'), 'a file whose mtime is not a tick old was given an index time that proves its mtime').toBeLessThan(STILL_BEING_WRITTEN + 2)
  })
})

describe('cmdIndex under a clock that stepped back', () => {
  // Fixture provenance: HAND-DERIVED, computed from the racy rule `mtime + 2 <= indexed_at`. The row says it was indexed an hour after the injected clock; the file is stamped one second before that clock and its bytes are unchanged.
  const CLOCK_MS = 1_800_000_000_000

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lowers an index time later than the clock that judged the file', async () => {
    const file = path.join(tmp, 'back.ts')
    await indexRacy('back.ts', OLD)
    getDb(dbPath).prepare('UPDATE files SET indexed_at = ? WHERE path LIKE ?').run(CLOCK_MS / 1000 + 3600, '%/back.ts')
    fs.utimesSync(file, CLOCK_MS / 1000 - 1, CLOCK_MS / 1000 - 1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(CLOCK_MS)

    await cmdIndex(tmp, { walk: true, dbPath })

    expect(indexedAt('back.ts'), 'the run left an index time later than the clock that judged the file').toBe(CLOCK_MS / 1000)
  })
})
