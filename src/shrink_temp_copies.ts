/** The shrunk image copies written to the OS temp dir for a host that can only point a Read at another path, and the age sweep that removes them. A leaf module so the worker can sweep without loading the hook bridges; the host-injected twins (MATERIALIZE_SHRUNK_IMAGE_JS in bridges/shrink_block.ts and the pi extension) are source text and repeat the prefix as a literal. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** File-name prefix of every temp copy; the sweep touches nothing without it. */
export const SHRINK_COPY_PREFIX = 'token-goat-shrink-'

/** How long a copy is kept. The copy only has to outlive the one Read it was written for, so anything older is past its delivery window. */
export const SHRINK_COPY_MAX_AGE_MS = 60 * 60 * 1000

/** Delete regular files in `dir` named with {@link SHRINK_COPY_PREFIX} whose mtime is more than {@link SHRINK_COPY_MAX_AGE_MS} before `now`, and return how many went. Never throws: one bad entry or an unreadable dir leaves the rest of the sweep, and the caller, unaffected. */
export function sweepStaleShrinkCopies(now: number = Date.now(), dir: string = os.tmpdir()): number {
  let removed = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(SHRINK_COPY_PREFIX)) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (st.isFile() && now - st.mtimeMs > SHRINK_COPY_MAX_AGE_MS) {
        fs.unlinkSync(full)
        removed++
      }
    } catch {
      // One bad entry must not stop the sweep.
    }
  }
  return removed
}
