import { existsSync, readdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'

/**
 * Remove chunks left by an earlier build: their names carry a content hash, so every build that
 * changes the code emits new names, and unreferenced leftovers would otherwise pile up in dist/ and
 * ship inside the tarball (package.json's `files` is the whole directory).
 *
 * Call this *after* the build it belongs to, passing that build's own emitted output paths. The
 * sweep used to run beforehand, clearing the directory: that left dist/ internally inconsistent for
 * the whole build, because the previous entry file was still on disk and still importing chunks
 * that had just been deleted, so any process starting the CLI in that window died with
 * ERR_MODULE_NOT_FOUND. The test suite starts the built CLI roughly a thousand times, which is
 * enough for a build in another shell to land inside that window and fail unrelated tests. Sweeping
 * afterwards keeps the old chunks readable until the new ones exist.
 *
 * `emitted` is authoritative rather than a heuristic: an unchanged chunk keeps its content hash, so
 * it is re-emitted under the same name and kept. Only the prefix given is considered, so the core
 * and hook builds never delete each other's chunks.
 *
 * @param {string} dir Directory holding the build output.
 * @param {string} prefix Chunk-filename prefix owned by this build.
 * @param {readonly string[]} emitted Output paths this build just wrote, as esbuild's metafile
 *   reports them; only the filename of each is used, so relative and absolute both work.
 * @returns {string[]} The filenames removed.
 */
export function sweepStaleChunks(dir, prefix, emitted) {
  if (!existsSync(dir)) return []
  const keep = new Set(emitted.map((p) => p.replaceAll('\\', '/').split('/').pop()))
  const removed = []
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || keep.has(f)) continue
    rmSync(path.join(dir, f))
    removed.push(f)
  }
  return removed
}
