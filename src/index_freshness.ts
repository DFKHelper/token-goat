/**
 * Whether the index's record of a file still matches what is on disk.
 *
 * Three hook-tier recognizers each open with the same four lines -- fetch the file's index entry,
 * and when that entry carries a SHA, re-fingerprint the file and compare. It is the same
 * comparison staleWarning() makes in read_commands.ts, and it is deliberately NOT reached through
 * that module: read_commands.ts is CLI-command-tier code, and importing it from a hook pulls the
 * whole parser and language-adapter graph into the hook's eager bundle, which
 * tests/guards/dist_chunks_deduped.test.ts caps the size of. This file exists so the check has one
 * home without giving up that separation -- it imports the same two primitives the three callers
 * did and nothing else.
 */

import { fingerprintFile } from './fingerprint.js'
import { getFileEntry } from './index_reader.js'

/**
 * True when `resolved` is indexed and its indexed content still matches the bytes on disk.
 *
 * False for an unindexed file and for one whose index entry has drifted, because every caller treats both the same way: each is about to price, rewrite, or name a region using indexed line spans, and a drifted index would describe yesterday's file. An entry with an empty `sha` is false for the first of those reasons rather than the second, and the comment on that line says why it is not the legacy row it looks like.
 */
export function indexMatchesDisk(resolved: string): boolean {
  const entry = getFileEntry(resolved)
  if (entry === null) return false
  // A row with no sha is not an indexed file. It reads like a pre-fingerprinting legacy row, and was treated as one here until 2026-09-23, but no parse writer has ever left the column empty: every INSERT INTO files back to the first commit sets sha (or content_sha256) alongside indexed_at, and the only UPDATEs touch embed_sha. The one writer that ever produced a sha-less row is the read-retry counter this table used to carry (removed in 2.9.22), which minted a row for a path it had merely failed to READ. Accepting such a row as matching disk is what made that file permanently unhealable: no reparse, no warning, and no symbols to serve. Treat it as absent so the caller's heal path parses it once and replaces the row.
  if (entry.sha === '') return false
  const diskSha = fingerprintFile(resolved)
  return diskSha !== null && diskSha === entry.sha
}
