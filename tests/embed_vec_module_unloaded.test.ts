import Database from '../src/sqlite_driver.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { getFileEntry } from '../src/index_reader.js'
import { removeFileFromIndex } from '../src/index_prune.js'
import { indexFileSync } from '../src/parser.js'
import { foldCase } from '../src/util.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vec-unloaded-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// Does this build have a working sqlite-vec so we can create a real chunk_vectors vec0 table? The
// bug-4 scenario is specifically "chunk_vectors was created while sqlite-vec worked, then the
// module is no longer loaded on the connection" -- so it inherently needs vec to have worked once
// to build the fixture. When the prebuilt binary is absent (some CI images) there is nothing to
// reproduce, so the fixture cannot be built and the test is skipped.
function vecWorks(dbPath: string): boolean {
  try {
    const db = getDb(dbPath)
    db.prepare('SELECT rowid FROM chunk_vectors LIMIT 1').get()
    return true
  } catch {
    return false
  }
}

// Bug 4: chunkVectorsTableExists() probed sqlite_master for the `chunk_vectors` NAME only, not
// whether the vec0 module is actually loaded on the connection. After a reinstall without the
// optional sqlite-vec dep (--no-optional, or a native build failure after a Node upgrade), the
// vec0 table row PERSISTS in sqlite_master but the module is gone, so the name probe still
// returned true and the next `chunk_vectors` statement threw "no such module: vec0" at prepare
// time. Inside removeFileFromIndex's transaction that aborted the whole prune, leaking the
// deleted file's symbols/refs/files rows forever (the caller swallows the error). The fix probes
// real usability, so the vector delete is skipped and the rest of the prune completes.
describe('removeFileFromIndex does not leak rows when the vec0 module is unloaded (bug 4)', () => {
  it('prunes symbols/files even though chunk_vectors is present-but-unusable', () => {
    const probePath = path.join(TMP, 'probe.db')
    if (!vecWorks(probePath)) {
      // Cannot build the fixture without a working sqlite-vec; nothing to reproduce here.
      return
    }

    const dbPath = path.join(TMP, 'index.db')
    const file = path.join(TMP, 'leaky.ts')
    fs.writeFileSync(file, 'export function leaky() {\n  return 1\n}\n', 'utf8')

    // Populate symbols + files (and create the real vec0 chunk_vectors table via getDb init).
    indexFileSync(file, dbPath)
    expect(getFileEntry(file, dbPath)).not.toBeNull()

    // Close the vec-loaded connection and reopen the SAME file with a plain connection that never
    // loaded sqlite-vec -- exactly the "reinstalled without the optional dep" state. The vec0
    // chunk_vectors row is still in this file's sqlite_master, but the module is not registered.
    closeAllDbs()
    const raw = new Database(dbPath)
    // db.ts's initConnection registers the Unicode-aware TG_LOWER used by pathEqClause in the
    // prune DELETEs; a plain connection lacks it, so register the identical function here. This
    // is a test-harness detail -- in production the failing connection is a real getDb connection
    // (TG_LOWER present) where only the sqlite-vec load failed, which is what we reproduce.
    raw.function('TG_LOWER', { deterministic: true }, (value: unknown) =>
      value === null ? null : foldCase(String(value)),
    )
    try {
      // Precondition: any reference to chunk_vectors throws because the module is gone. If this
      // build somehow still has vec0 on the plain connection, the scenario is not reproduced.
      let threw = false
      try {
        raw.prepare('SELECT rowid FROM chunk_vectors LIMIT 1').get()
      } catch {
        threw = true
      }
      if (!threw) return

      // Sanity: exactly the one indexed file is present before the prune.
      expect((raw.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(1)
      expect((raw.prepare('SELECT COUNT(*) c FROM symbols').get() as { c: number }).c).toBe(1)

      // The fix makes this complete instead of aborting the transaction. Pre-fix this throws
      // ("no such module: vec0") from the chunk_vectors DELETE inside the transaction.
      expect(() => removeFileFromIndex(raw, file)).not.toThrow()

      // No row leak: only one file was ever indexed, so after pruning it the symbols/files
      // tables are empty. Pre-fix the aborted transaction left both fully populated.
      expect((raw.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c).toBe(0)
      expect((raw.prepare('SELECT COUNT(*) c FROM symbols').get() as { c: number }).c).toBe(0)
    } finally {
      raw.close()
    }
  })
})
