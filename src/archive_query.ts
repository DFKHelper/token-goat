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
 *
 * fflate is an optional dependency, so it is loaded lazily here (the same way ooxml_extract.ts
 * loads it) rather than imported at module scope. A static import put fflate on the CLI's
 * startup path, so an `--omit=optional` install -- the very install SECURITY.md recommends for
 * avoiding the optional native packages' advisories -- could not run any command at all: even
 * `token-goat --version` died with ERR_MODULE_NOT_FOUND. Loading it here keeps the failure where
 * it belongs, on the two zip commands that actually need it.
 */

import { displaySafeText } from './paths.js'

import { createLazyModuleLoader } from './lazy_module.js'
import { MAX_ZIP_OUTPUT_BYTES, unzipBounded, type ZipStreamModule } from './zip_bounds.js'

interface UnzipFileInfo {
  name: string
  size: number
  originalSize: number
}

interface FflateModule extends ZipStreamModule {
  unzipSync: (
    data: Uint8Array,
    opts?: { filter?: (file: UnzipFileInfo) => boolean },
  ) => Record<string, Uint8Array>
}

const loadFflate = createLazyModuleLoader(
  async () => (await import('fflate')) as unknown as FflateModule,
  'archive reading disabled (fflate unavailable)',
)

/** Thrown when fflate cannot be loaded, so the caller can tell "you installed with
 * --omit=optional" apart from "this file is not a zip" and print the right one. Both used to
 * surface as "not a valid zip-format file", which sent the reader looking at their archive. */
export class ArchiveDependencyMissingError extends Error {
  constructor() {
    super('fflate is not installed; run `npm install fflate` to enable zip-list/zip-read')
    this.name = 'ArchiveDependencyMissingError'
  }
}

/** Resolves fflate or throws {@link ArchiveDependencyMissingError}. Kept separate so both entry
 * points report it identically. */
async function requireFflate(): Promise<FflateModule> {
  const fflate = await loadFflate()
  if (!fflate) throw new ArchiveDependencyMissingError()
  return fflate
}

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
export async function listZipEntries(data: Uint8Array): Promise<ZipEntry[]> {
  const fflate = await requireFflate()
  const entries: ZipEntry[] = []
  fflate.unzipSync(data, {
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
  // Ordinal (not locale-aware) sort -- an unlocaled localeCompare() orders differently across
  // Node's small-icu vs full-icu builds and different system default locales, which would make
  // "reads the same regardless of the archive's own central-directory order" (see doc comment
  // above) false across machines/CI runners.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return entries
}

/** Compact "size  path" listing, one line per entry (directories included, size 0). */
export function formatZipList(entries: readonly ZipEntry[]): string {
  if (entries.length === 0) return '(no entries found)'
  // An entry name is whatever whoever built the archive put there, and a zip name may hold a
  // newline: unescaped, one entry could print a second line that reads like another entry.
  return entries.map((e) => `${String(e.size).padStart(10)}  ${displaySafeText(e.path)}`).join('\n')
}

/** Decompresses exactly one entry's bytes by its exact in-archive path. Returns `undefined` if
 * no entry matches (the caller emits a "not found" + did-you-mean message). Only the matching
 * entry is ever decompressed -- every other member is skipped before decompression. Throws
 * {@link ZipOutputTooLargeError} if the entry's real decompressed size exceeds
 * `MAX_ZIP_OUTPUT_BYTES`, or fflate's own error on a malformed/corrupt zip, same as
 * {@link listZipEntries}. */
export async function extractZipEntry(data: Uint8Array, entryPath: string): Promise<Uint8Array | undefined> {
  const fflate = await requireFflate()
  const result = unzipBounded(fflate, data, { limitBytes: MAX_ZIP_OUTPUT_BYTES, shouldExtract: (name) => name === entryPath })
  return result[entryPath]
}
