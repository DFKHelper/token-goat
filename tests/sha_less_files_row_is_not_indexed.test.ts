/**
 * A `files` row with no `sha` means the file was never indexed, not that it is a legacy row.
 *
 * `indexMatchesDisk` and `healStaleIndex` both used to accept such a row as-is, on the reading
 * that it predated content fingerprinting. No such row has ever existed: every `INSERT INTO files`
 * in this repo's history sets `sha` (or `content_sha256` under the pre-port schema) alongside
 * `indexed_at`, and every `UPDATE files` touches only `embed_sha`. The one writer that ever left
 * the column empty was the read-retry counter `files` used to carry, removed in 2.9.22, which
 * minted a row for a path it had merely failed to READ. A database written before that upgrade can
 * still hold those rows, and accepting one made the file permanently unhealable: no reparse, no
 * stale warning, and no symbols to serve.
 *
 * CAPTURE. The stub row below is written with the exact statement the shipping code used to
 * produce it, `INSERT INTO files (path, retry_count) VALUES (?, 1)`, copied verbatim from
 * `c7558c84^:src/worker.ts:144` (`git show c7558c84^:src/worker.ts`). It is not derived from the
 * matcher it exercises, and the first assertion pins the premise -- that such a row really does
 * reach the readers as an entry whose `sha` is empty -- so the test fails loudly rather than
 * silently passing if that shape ever stops being reachable.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { indexMatchesDisk } from '../src/index_freshness.js'
import { getFileEntry } from '../src/index_reader.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'

/** Write the stub row the pre-2.9.22 retry counter left behind for a path it could not read. */
function seedRetryStubRow(resolved: string): void {
  getDb(globalDbPath()).prepare('INSERT INTO files (path, retry_count) VALUES (?, 1)').run(resolved)
}

describe('a files row with no sha is not an indexed file', () => {
  it('reports the file as not matching disk, so the caller heals it instead of trusting the stub', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-shaless-match-'))
    try {
      const file = join(root, 'stub.ts')
      writeFileSync(file, 'export function shaLessStubFn4q(): number {\n  return 1\n}\n')
      const resolved = normalizePath(file)
      seedRetryStubRow(resolved)

      // Premise: the stub really is reachable as an entry with an empty sha. Without this the
      // assertion below could pass for the unrelated reason that no row was found at all.
      const stub = getFileEntry(resolved)
      expect(stub, 'the seeded stub row must be queryable').not.toBeNull()
      expect(stub?.sha, 'the seeded stub row must carry no sha').toBe('')

      expect(indexMatchesDisk(resolved)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serves a symbol from a file whose only row is a retry stub, and replaces the stub', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-shaless-heal-'))
    try {
      const file = join(root, 'stub.ts')
      writeFileSync(file, 'export function shaLessHealFn4q(): number {\n  return 2\n}\n')
      const resolved = normalizePath(file)
      seedRetryStubRow(resolved)
      expect(getFileEntry(resolved)?.sha, 'premise: stub row with no sha').toBe('')

      const { text, code } = runSymbol({ name: 'shaLessHealFn4q', file })
      expect(code).toBe(0)
      expect(text).toContain('shaLessHealFn4q')

      // The stub must be gone, not merely papered over in the command's output: writeParseResult
      // deletes the file's rows before inserting, so a real parse replaces it rather than
      // colliding with its primary key.
      expect(getFileEntry(resolved)?.sha).toBe(fingerprintFile(resolved))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
