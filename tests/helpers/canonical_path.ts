// One place that decides whether two spellings name the same path, so a test compares paths through the OS and not through the temp-dir spelling it happened to be given.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { normalizePath } from '../../src/paths.js'

/** Whether the volume compares names without regard to case, which is true of NTFS and the default APFS but not of ext4. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin'

// Compared in this fold, not keyOf's case-preserved form (src/bridges/created_configs.ts::keyOf).
function product(s: string): string {
  return normalizePath(FOLDS_CASE ? s.toLowerCase() : s)
}

/** `realpath.native` of `p`'s nearest existing ancestor, case-folded on win32 and darwin, then normalizePath. */
export function canonicalPath(p: string): string {
  const absolute = path.resolve(p)
  const tail: string[] = []
  let head = absolute
  for (;;) {
    try {
      const real = fs.realpathSync.native(head)
      return product(tail.length === 0 ? real : path.join(real, ...tail.reverse()))
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return product(absolute)
      tail.push(path.basename(head))
      head = parent
    }
  }
}

/** Whether `a` and `b` name the same path under `canonicalPath`. */
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}

/** The spellings `text` may use for `p`: as given, and as the OS spells it, both folded the way the volume folds. */
export function pathSpellings(p: string): string[] {
  const fold = (s: string): string => (FOLDS_CASE ? s.toLowerCase() : s)
  return [...new Set([fold(p), fold(path.resolve(p)), canonicalPath(p)])]
}

/** Whether `text` names `p` under any spelling `pathSpellings` lists, with the whole text folded the same way. */
export function textNamesPath(text: string, p: string): boolean {
  const folded = FOLDS_CASE ? text.toLowerCase() : text
  return pathSpellings(p).some((s) => folded.includes(s))
}
