/** The index's file list for a project, looked up by name. One place answers "which indexed files are called this" for `answer`'s subject resolution and for the path-miss suggestions, so the two cannot disagree about what counts as the same file. Vendored, generated and tool-metadata trees are never returned: this repo indexes files under them out of band, and a name that only exists there is not the file the reader meant. */

import { isIgnoredIndexPath } from './baseline.js'
import { getOwnProjectFileEntries } from './index_reader.js'
import { foldPath } from './path_containment.js'

/** One indexed file: its absolute path as the index stores it, and the case-folded base name the name lookups compare. */
export interface IndexedFile {
  filePath: string
  base: string
}

/** Every indexed file of this project outside the ignored trees, read from the index once. A caller that makes several lookups (the path-miss rungs) loads this and passes it to {@link filesNamed}, so one miss reads the `files` table one time. */
export function indexedFileList(rootDir: string): IndexedFile[] {
  const out: IndexedFile[] = []
  for (const [folded, indexed] of getOwnProjectFileEntries(rootDir)) {
    if (isIgnoredIndexPath(folded, rootDir)) continue
    out.push({ filePath: indexed.filePath, base: folded.slice(Math.max(folded.lastIndexOf('/'), folded.lastIndexOf('\\')) + 1) })
  }
  return out
}

/** Every indexed file of this project outside the ignored trees, as the absolute paths the index stores. */
export function indexedProjectFiles(rootDir: string): string[] {
  return indexedFileList(rootDir).map((file) => file.filePath)
}

/** The files of `list` whose basename is `name` ("config.ts"), or whose extensionless stem is `name` ("config"), sorted and deduplicated. */
export function filesNamed(list: readonly IndexedFile[], name: string): string[] {
  const want = foldPath(name)
  const matches: string[] = []
  for (const { filePath, base } of list) {
    const dot = base.lastIndexOf('.')
    if (base === want || (dot > 0 && base.slice(0, dot) === want)) matches.push(filePath)
  }
  return [...new Set(matches)].sort()
}

/** The indexed files whose basename is `name` ("config.ts"), or whose extensionless stem is `name` ("config"), sorted and deduplicated. The match runs over the `files` table, not the symbols table, so a file with no symbols still resolves. */
export function indexedFilesNamed(name: string, rootDir: string): string[] {
  return filesNamed(indexedFileList(rootDir), name)
}
