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
 * False for an unindexed file and for one whose index entry has drifted, because every caller
 * treats both the same way: each is about to price, rewrite, or name a region using indexed line
 * spans, and a drifted index would describe yesterday's file. An entry with an empty `sha` predates
 * fingerprinting and is accepted as-is, which is the behaviour all three call sites already had.
 */
export function indexMatchesDisk(resolved: string): boolean {
  const entry = getFileEntry(resolved)
  if (entry === null) return false
  if (entry.sha === '') return true
  const diskSha = fingerprintFile(resolved)
  return diskSha !== null && diskSha === entry.sha
}
