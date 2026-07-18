/**
 * Entry listing + single-member extraction for `token-goat zip-list` / `zip-read`, so a
 * .zip/.jar/.whl/.vsix/.nupkg (all zip-format containers under the hood) never needs its whole
 * archive extracted to disk just to answer "what's in here" or "what does entry X contain".
 * Mirrors openapi_query.ts's split: pure parsing/extraction/formatting here, file IO
 * (readFileBytes, emit/emitErr) in read_commands.ts.
 *
 * Listing uses fflate's `unzipSync` with a filter that always returns `false`: fflate still
 * walks every entry's local header to report its name/size, but a `false` filter result skips
 * decompression, so `zip-list` never inflates member data just to report the table of contents.
 * `zip-read` uses the same `filter` to decompress exactly the one requested entry.
 */

import { unzipSync } from 'fflate'

export interface ZipEntry {
  path: string
  size: number
  compressedSize: number
  isDirectory: boolean
}

/** Lists every entry in a zip-format archive (name, uncompressed/compressed size, directory
 * flag) without decompressing any member's data. Sorted by path so the listing reads the same
 * regardless of the archive's own central-directory order. Throws on a malformed/corrupt zip --
 * the caller (read_commands.ts) is responsible for catching that and emitting a clean error. */
export function listZipEntries(data: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = []
  unzipSync(data, {
    filter: (file) => {
      entries.push({
        path: file.name,
        size: file.originalSize,
        compressedSize: file.size,
        isDirectory: file.name.endsWith('/'),
      })
      return false
    },
  })
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

/** Compact "size  path" listing, one line per entry (directories included, size 0). */
export function formatZipList(entries: readonly ZipEntry[]): string {
  if (entries.length === 0) return '(no entries found)'
  return entries.map((e) => `${String(e.size).padStart(10)}  ${e.path}`).join('\n')
}

/** Decompresses exactly one entry's bytes by its exact in-archive path. Returns `undefined` if
 * no entry matches (the caller emits a "not found" + did-you-mean message). Only the matching
 * entry is ever decompressed -- every other member's filter call returns `false`. Throws on a
 * malformed/corrupt zip, same as {@link listZipEntries}. */
export function extractZipEntry(data: Uint8Array, entryPath: string): Uint8Array | undefined {
  const result = unzipSync(data, { filter: (file) => file.name === entryPath })
  return result[entryPath]
}
