/** The index's file list for a project, looked up by name. One place answers "which indexed files are called this" for `answer`'s subject resolution and for the path-miss suggestions, so the two cannot disagree about what counts as the same file. Vendored, generated and tool-metadata trees are never returned: this repo indexes files under them out of band, and a name that only exists there is not the file the reader meant. */

import { isIgnoredIndexPath } from './baseline.js'
import { getOwnProjectFileEntries } from './index_reader.js'
import { foldPath } from './path_containment.js'

/** Every indexed file of this project outside the ignored trees, as the absolute paths the index stores. */
export function indexedProjectFiles(rootDir: string): string[] {
  const out: string[] = []
  for (const [folded, indexed] of getOwnProjectFileEntries(rootDir)) {
    if (!isIgnoredIndexPath(folded, rootDir)) out.push(indexed.filePath)
  }
  return out
}

/** The indexed files whose basename is `name` ("config.ts"), or whose extensionless stem is `name` ("config"), sorted and deduplicated. The match runs over the `files` table, not the symbols table, so a file with no symbols still resolves. */
export function indexedFilesNamed(name: string, rootDir: string): string[] {
  const want = foldPath(name)
  const matches: string[] = []
  for (const [folded, indexed] of getOwnProjectFileEntries(rootDir)) {
    if (isIgnoredIndexPath(folded, rootDir)) continue
    const base = folded.slice(Math.max(folded.lastIndexOf('/'), folded.lastIndexOf('\\')) + 1)
    const dot = base.lastIndexOf('.')
    if (base === want || (dot > 0 && base.slice(0, dot) === want)) matches.push(indexed.filePath)
  }
  return [...new Set(matches)].sort()
}
