/**
 * Shared decompression bounds for zip-format archives (.zip/.jar/.whl/.vsix/.nupkg, and the
 * .docx/.pptx/.xlsx OOXML formats, which are all ZIP containers under the hood).
 *
 * fflate's `unzipSync` (with or without a `filter`) allocates a selected member's *entire*
 * decompressed output in one shot with no cap. DEFLATE's worst-case compression ratio is
 * ~1032:1, so even a compressed-input size cap leaves decompression itself unbounded: a
 * compliant, capped archive can still expand toward tens of gigabytes once inflated. Capping the
 * on-disk size alone (as the old `MAX_OOXML_INPUT_BYTES` check did) only halves the problem.
 *
 * A filter callback sees each entry's declared `originalSize` before deciding whether to extract
 * it, which looks like a second, cheap way to reject an oversized entry up front -- but that
 * field lives in the archive's own central directory, is attacker-controlled, and can understate
 * the truth. Gating on it alone is theatre: a crafted entry can declare a small size and still
 * inflate to gigabytes once actually decompressed. `unzipBounded` below still uses the declared
 * size as a fast, cheap first check (skip the CPU of decompressing something already over
 * budget), but the check that actually holds is on the real bytes produced as decompression
 * streams out.
 *
 * To get that real-time check without pulling in a hand-rolled ZIP parser, this drives fflate's
 * low-level streaming API (`Unzip` + `UnzipInflate`) by hand, feeding the archive's bytes in
 * small slices rather than one big push. `Unzip.push()` only decompresses the slice of
 * compressed bytes it was just handed, so the amount any single call can produce is bounded by
 * (slice size * worst-case ratio), not by the archive's declared or actual total -- a running
 * total checked after every slice catches an entry that lied about its declared size, and never
 * holds more than a slice's worth of over-cap output before throwing, let alone the full bomb.
 */

// DEFLATE's worst-case compression ratio is ~1032:1, so capping the compressed input bounds
// eager, unstreamed decompression to a worst case of tens of GB instead of fully unbounded -- a
// sanity cap against a malformed/crafted file, not on its own a hardened defense. See the module
// doc comment above for why MAX_ZIP_OUTPUT_BYTES is the check that actually holds.
export const MAX_ZIP_INPUT_BYTES = 50 * 1024 * 1024

// How much decompressed output a single archive read may produce in total, across every entry
// unzipBounded is asked to extract. Generous for a legitimate document: OOXML content (XML parts)
// compresses well, but the bulk of a real .docx/.pptx/.xlsx's size is usually already-compressed
// embedded media, which expands close to 1:1.
export const MAX_ZIP_OUTPUT_BYTES = 500 * 1024 * 1024

/** How many compressed bytes `unzipBounded` feeds fflate's streaming decompressor per call. Caps
 * how much over-budget output a single slice can produce before the running-total check fires
 * (worst case: this many bytes times DEFLATE's ~1032:1 ratio), independent of the archive's own
 * size. */
// Type-only, so it is erased at build time: this module deliberately takes fflate as a
// parameter rather than importing it, so each caller keeps its own lazy loader and its own
// "fflate is not installed" message. The handler signature has to name fflate's real error
// type rather than `unknown`, because strictFunctionTypes compares parameters
// contravariantly and `unknown` is not assignable to `FlateError | null`.
import type { FlateError, UnzipDecoderConstructor } from 'fflate'

const STREAM_CHUNK_BYTES = 64 * 1024

interface UnzipStreamFile {
  readonly name: string
  readonly compression: number
  readonly originalSize?: number
  ondata: (err: FlateError | null, data: Uint8Array<ArrayBuffer>, final: boolean) => void
  start: () => void
  // fflate's UnzipFile declares terminate as required, so the structural type has to carry it for
  // the module to be assignable here, even though unzipBounded aborts by flag rather than by
  // calling it.
  terminate: () => void
}

interface UnzipStreamHandle {
  onfile: (file: UnzipStreamFile) => void
  push: (chunk: Uint8Array, final: boolean) => void
  register: (decoder: UnzipDecoderConstructor) => void
}

/** The subset of fflate's module surface `unzipBounded` needs, resolved by each caller's own
 * lazy loader (whose "fflate isn't installed" message differs per command). */
export interface ZipStreamModule {
  Unzip: new (cb: (file: UnzipStreamFile) => void) => UnzipStreamHandle
  UnzipInflate: UnzipDecoderConstructor
  // Used only to validate the archive is well-formed before streaming it (see the well-formedness
  // check in unzipBounded below) -- never to decompress; the filter always returns false.
  unzipSync: (data: Uint8Array, opts?: { filter?: (file: { name: string }) => boolean }) => Record<string, Uint8Array>
}

/** Thrown when an entry's real decompressed byte count -- not just its declared size -- exceeds
 * `limitBytes`. `decompressedSoFarBytes` is a lower bound on the entry's true size: extraction
 * stops the moment the running total crosses the limit, so the final size is never actually
 * known. */
export class ZipOutputTooLargeError extends Error {
  constructor(entryName: string, limitBytes: number, decompressedSoFarBytes: number) {
    super(
      `zip entry '${entryName}' is over the ${Math.round(limitBytes / (1024 * 1024))}MB decompressed-size limit ` +
        `(over ${Math.round(decompressedSoFarBytes / (1024 * 1024))}MB decompressed so far)`,
    )
    this.name = 'ZipOutputTooLargeError'
  }
}

/** Thrown when a zip-format archive's on-disk (compressed) size exceeds `MAX_ZIP_INPUT_BYTES`,
 * before any of it is read into memory. Mirrors {@link ZipOutputTooLargeError}'s message style. */
export class ZipInputTooLargeError extends Error {
  constructor(filePath: string, sizeBytes: number, limitBytes: number) {
    super(`${filePath} is ${Math.round(sizeBytes / (1024 * 1024))}MB, over the ${Math.round(limitBytes / (1024 * 1024))}MB limit for zip-format archives`)
    this.name = 'ZipInputTooLargeError'
  }
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Decompresses the entries `shouldExtract` selects out of a zip-format archive, enforcing
 * `limitBytes` against the *actual* cumulative decompressed byte count across every extracted
 * entry as it streams out, not just each entry's declared size. Entries `shouldExtract` rejects
 * are never decompressed at all (fflate's streaming class simply skips a file whose `start()` is
 * never called), the same trick `listZipEntries`'s always-false `filter` uses for `unzipSync`.
 *
 * Throws {@link ZipOutputTooLargeError} on an over-budget entry, or fflate's own error for a
 * malformed archive / unsupported compression method (mirroring `unzipSync`'s throw behavior).
 */
export function unzipBounded(
  mod: ZipStreamModule,
  data: Uint8Array,
  opts: { limitBytes: number; shouldExtract: (name: string) => boolean },
): Record<string, Uint8Array> {
  // fflate's low-level `Unzip` streaming class parses forward from local file headers and never
  // validates the end-of-central-directory record the way `unzipSync` does, so garbage input
  // that contains no recognizable local file header silently yields zero entries instead of
  // throwing. Reuse `unzipSync`'s own well-formedness check (its `filter` never returns true, so
  // it never decompresses anything) to keep "malformed archive" behavior identical to before.
  mod.unzipSync(data, { filter: () => false })

  const results: Record<string, Uint8Array> = {}
  let firstError: Error | undefined
  let totalDecompressed = 0

  const unzip = new mod.Unzip((file) => {
    if (firstError !== undefined || !opts.shouldExtract(file.name)) return
    if (typeof file.originalSize === 'number' && totalDecompressed + file.originalSize > opts.limitBytes) {
      firstError = new ZipOutputTooLargeError(file.name, opts.limitBytes, totalDecompressed + file.originalSize)
      return
    }
    const chunks: Uint8Array[] = []
    let entryTotal = 0
    file.ondata = (err, chunk, final) => {
      if (firstError !== undefined) return
      if (err) {
        firstError = err instanceof Error ? err : new Error(String(err))
        return
      }
      entryTotal += chunk.length
      totalDecompressed += chunk.length
      if (totalDecompressed > opts.limitBytes) {
        firstError = new ZipOutputTooLargeError(file.name, opts.limitBytes, totalDecompressed)
        return
      }
      chunks.push(chunk)
      if (final) results[file.name] = concatChunks(chunks, entryTotal)
    }
    file.start()
  })
  unzip.register(mod.UnzipInflate)

  let offset = 0
  for (;;) {
    const end = Math.min(offset + STREAM_CHUNK_BYTES, data.length)
    const isFinal = end >= data.length
    unzip.push(data.subarray(offset, end), isFinal)
    offset = end
    if (firstError !== undefined || isFinal) break
  }

  if (firstError !== undefined) throw firstError
  return results
}
