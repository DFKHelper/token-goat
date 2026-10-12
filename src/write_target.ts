/** What a Write/Edit pre-hook can learn about the file it targets without touching the session: the diff caps and a bounded read of what is on disk. Kept apart from the guards so the hook entry loads it eagerly while the guards load on demand. */

import { readFileSync, statSync } from 'node:fs'

/** Performance safety valve for the O(n*m) LCS computation below. Independent of the user-configurable `hints.write_rewrite_min_lines` floor (which gates whether the detector fires at all): this caps how large a file the detector will even attempt to diff, so a huge file's Write never turns into a multi-second (or memory-heavy) synchronous hook call. Above this size the detector fails open (passes through, no comparison) rather than block on a diff that's too expensive to be worth it. */
export const MAX_LINES_FOR_DIFF = 4000

/** Byte-size gate applied to the OLD file's `stat.size` before it is ever read into memory. `MAX_LINES_FOR_DIFF` above only rejects an oversized file AFTER `readFileSync` has already loaded the whole thing and `splitLines` has already run -- so a huge single-line file (a minified bundle, a data dump) or a huge multi-GB log sailed straight through that gate and synchronously read its entire content into a JS string on every single Write, exactly the unbounded-`readFileSync` pattern already fixed for the catch-all file-type dispatch in hooks_read.ts (see SLICE_ESTIMATE_SCAN_CAP_BYTES there). Checked against `stat.size`, which is already available post-`statSync`, before any read is attempted. */
export const MAX_OLD_FILE_BYTES_FOR_DIFF = 4 * 1024 * 1024

/** What is on disk at `filePath`: `absent` when it cannot be stat'd (a Write there creates it), `unusable` when it is not a regular file, is over the diff byte cap (never read) or cannot be read, else its text. */
export type OnDisk = { state: 'absent' } | { state: 'unusable' } | { state: 'text'; text: string }

export function inspectFile(filePath: string): OnDisk {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    return { state: 'absent' }
  }
  if (!stat.isFile() || stat.size > MAX_OLD_FILE_BYTES_FOR_DIFF) return { state: 'unusable' }
  try {
    return { state: 'text', text: readFileSync(filePath, 'utf-8') }
  } catch {
    return { state: 'unusable' }
  }
}

/** The current text of `filePath`, or '' when it is missing, not a regular file, over the diff byte cap, or unreadable. */
export function readKnownText(filePath: string): string {
  const onDisk = inspectFile(filePath)
  return onDisk.state === 'text' ? onDisk.text : ''
}
