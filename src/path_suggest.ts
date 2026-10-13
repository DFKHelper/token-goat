/** Existing paths a missing one was probably meant to be. A path a model or a user types is wrong in a handful of recurring ways (a screenshot name whose AM/PM space is U+202F, a leading `@` from a mention, a `:12` line suffix, a directory dropped, a one-letter typo), and each has a cheap, exact repair. Every candidate returned was checked against the disk, so a suggestion never leads to a second miss. The missing path is whatever the model typed, so the lookup is a probe a hostile prompt could aim anywhere: every candidate, directory read and index row is confined to the project root (the working directory when there is no project), left out when it is a credential file name, a vendored or generated tree, a `skip_dirs` directory or an excluded project root. */

import { existsSync, opendirSync } from 'node:fs'
import * as path from 'node:path'

import { isIgnoredIndexPath } from './baseline.js'
import { loadConfig } from './config.js'
import { fileIsAbsent } from './fingerprint.js'
import { filesNamed, indexedFileList, type IndexedFile } from './indexed_file_names.js'
import { foldPath, isInsideRoot } from './path_containment.js'
import { findProject } from './project.js'
import { isSecretFileName } from './secret_file_names.js'
import { hasSkipSegmentBelowRoot } from './skip_scope.js'
import { isUnderBlockedRoot } from './util.js'
import { levenshteinDistance } from './util_suggest.js'

/** Most candidates returned. */
export const MAX_PATH_SUGGESTIONS = 3

/** Longest path considered; a longer string is not a path anyone typed. */
const MAX_PATH_CHARS = 1024

/** Directory entries read when looking for a near name beside the missing path. */
export const MAX_DIR_ENTRIES = 5000

/** Unicode space characters other than the ASCII space: NBSP, the Ogham space, the U+2000 block, narrow NBSP, the medium mathematical space and the ideographic space. */
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g

/** A trailing position suffix: `:12`, `:12-30`, `#L12`, `#L12-L30`. */
const TRAILING_LOCATION = /(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/

/** Each rewrite maps a spelling toward one a different tool or platform may have written. Applied in sequence over the growing set, so their combinations are all tried. */
const SPELLING_REWRITES: ReadonlyArray<(name: string) => string> = [
  (name) => name.replace(UNICODE_SPACES, ' '),
  (name) => name.replace(/ (AM|PM)\b/g, '\u202F$1'),
  (name) => name.replace(/ (AM|PM)\b/g, '\u00A0$1'),
  (name) => name.normalize('NFC'),
  (name) => name.normalize('NFD'),
  (name) => name.replace(/'/g, '\u2019'),
  (name) => name.replace(/[\u2018\u2019]/g, "'"),
]

/** `missing` with a leading `@` and a trailing position suffix taken off. */
function withoutDecoration(missing: string): string {
  const trimmed = missing.trim()
  const unmentioned = trimmed.startsWith('@') && trimmed.length > 1 ? trimmed.slice(1) : trimmed
  return unmentioned.replace(TRAILING_LOCATION, '')
}

/** {@link withoutDecoration}'s result, then every spelling the rewrites reach from it, the stripped form first. The original spelling is never returned. */
function spellingVariants(missing: string): string[] {
  const seen = new Set<string>([withoutDecoration(missing)])
  for (const rewrite of SPELLING_REWRITES) {
    for (const spelling of [...seen]) seen.add(rewrite(spelling))
  }
  seen.delete(missing)
  return [...seen].filter((spelling) => spelling !== '')
}

/** Where suggestions may come from and what they may be: `root` is the project root, or the working directory when there is no project; `indexed` says the index of `root` may be read. */
interface Scope {
  root: string
  indexed: boolean
  skipDirs: readonly string[]
  blockedRoots: readonly string[]
}

/** The scope of one lookup. The index is read only for a real project: `resolveProjectRoot` falls back to the working directory itself (the home directory, say) when nothing marks a project, and an index keyed on that would answer for every project under it. */
function scopeFor(cwd: string, rootDir: string | null): Scope {
  const cfg = loadConfig()
  const project = rootDir !== null ? findProject(rootDir) : null
  const indexed = rootDir !== null && project !== null && samePath(project.root, rootDir)
  return { root: indexed && rootDir !== null ? rootDir : cwd, indexed, skipDirs: cfg.indexing.skip_dirs, blockedRoots: cfg.worker.blocked_roots }
}

/** Whether `abs` may be offered: inside the scope (links resolved), not a credential file name, not under a vendored or generated tree, a configured `skip_dirs` directory or an excluded project root. */
function permitted(abs: string, scope: Scope): boolean {
  if (isSecretFileName(abs)) return false
  if (isIgnoredIndexPath(abs, scope.root) || hasSkipSegmentBelowRoot(abs, scope.root, (segment) => scope.skipDirs.includes(segment))) return false
  if (isUnderBlockedRoot(abs, scope.blockedRoots)) return false
  return isInsideRoot(abs, scope.root)
}

/** The first {@link MAX_DIR_ENTRIES} names in `dir`, read entry by entry so a huge directory is never listed whole. None for a directory outside the scope, absent or unreadable. */
function entriesOf(dir: string, scope: Scope): string[] {
  if (!isInsideRoot(dir, scope.root)) return []
  const names: string[] = []
  try {
    const handle = opendirSync(dir)
    try {
      while (names.length < MAX_DIR_ENTRIES) {
        const entry = handle.readSync()
        if (entry === null) break
        names.push(entry.name)
      }
    } finally {
      handle.closeSync()
    }
  } catch {
    // A directory that is absent or unreadable has no near names to offer; the rungs that do not need it still run.
  }
  return names
}

/** `abs` as the reader would type it: relative to `cwd` when it sits under it, forward slashes either way. */
function displayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs)
  const shown = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs
  return shown.replace(/\\/g, '/')
}

/** How many trailing directory names two paths share, case-folded: the signal that an indexed file with the right basename sits where the missing one was meant to. */
function sharedParents(a: string, b: string): number {
  const left = path.dirname(a).split(/[\\/]/).reverse()
  const right = path.dirname(b).split(/[\\/]/).reverse()
  let shared = 0
  while (shared < left.length && shared < right.length && (left[shared] as string).toLowerCase() === (right[shared] as string).toLowerCase()) shared++
  return shared
}

/** Whether two spellings name one file. The index stores a lowercase drive letter with forward slashes where the disk and `path.resolve` give an uppercase one with backslashes, so spellings must compare through this or one file is offered twice and a candidate equal to the missing path is not recognised as it. */
function samePath(a: string, b: string): boolean {
  return foldPath(path.resolve(a)) === foldPath(path.resolve(b))
}

function resolveIndexed(file: string, rootDir: string): string {
  return path.resolve(rootDir, file)
}

/** Rung 2: indexed files with the same basename, or the same stem under another extension (`config.js` for `config.ts`). When more than the cap share the name (`index.ts`), only those that also share a parent directory name with the missing path are kept: a pick among fifty is no suggestion. */
function sameNameFiles(missingAbs: string, rootDir: string, files: readonly IndexedFile[], scope: Scope): string[] {
  const base = path.basename(missingAbs)
  const dot = base.lastIndexOf('.')
  const names = dot > 0 ? [base, base.slice(0, dot)] : [base]
  const found = [...new Set(names.flatMap((name) => filesNamed(files, name)))]
    .map((file) => resolveIndexed(file, rootDir))
    .filter((abs) => !samePath(abs, missingAbs) && !fileIsAbsent(abs) && permitted(abs, scope))
  const ranked = found.sort((a, b) => sharedParents(b, missingAbs) - sharedParents(a, missingAbs) || a.localeCompare(b))
  return ranked.length <= MAX_PATH_SUGGESTIONS ? ranked : ranked.filter((abs) => sharedParents(abs, missingAbs) > 0)
}

/** The edit distance a basename may be from the missing one: none for a stem under three characters (every short name is one letter from another), one up to seven characters, two beyond. */
function typoBudget(base: string): number {
  const dot = base.lastIndexOf('.')
  if ((dot > 0 ? dot : base.length) < 3) return 0
  return base.length >= 8 ? 2 : 1
}

/** Rung 3: a name beside the missing path, then an indexed file, whose basename is a typo of the missing one. Same-directory names rank first, then the closer edit distance. */
function nearNameFiles(missingAbs: string, rootDir: string, files: readonly IndexedFile[] | null, scope: Scope): string[] {
  const base = path.basename(missingAbs)
  const budget = typoBudget(base)
  if (budget === 0) return []
  const dir = path.dirname(missingAbs)
  const lower = base.toLowerCase()
  const scored: Array<{ abs: string; rank: number; distance: number }> = []
  const consider = (abs: string, sameDir: boolean): void => {
    const name = path.basename(abs)
    if (name === base) return
    const distance = levenshteinDistance(name.toLowerCase(), lower, budget)
    if (distance > budget) return
    scored.push({ abs, rank: sameDir ? 0 : 1, distance })
  }
  for (const name of entriesOf(dir, scope)) consider(path.join(dir, name), true)
  for (const file of files ?? []) consider(resolveIndexed(file.filePath, rootDir), false)
  return scored.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.abs.localeCompare(b.abs)).map((entry) => entry.abs).filter((abs) => !samePath(abs, missingAbs) && !fileIsAbsent(abs) && permitted(abs, scope))
}

/** Rung 4: `abs` with each segment that does not exist swapped for the one directory entry that differs from it only in case, or null when no segment needed it or one had no such entry. On a case-insensitive filesystem every segment already resolves and this is null. */
function caseCorrected(abs: string, scope: Scope): string | null {
  const root = path.parse(abs).root
  let current = root
  let changed = false
  for (const segment of abs.slice(root.length).split(/[\\/]/).filter((s) => s !== '')) {
    const next = path.join(current, segment)
    if (existsSync(next)) {
      current = next
      continue
    }
    const matches = entriesOf(current, scope).filter((entry) => entry.toLowerCase() === segment.toLowerCase())
    if (matches.length !== 1) return null
    current = path.join(current, matches[0] as string)
    changed = true
  }
  return changed && permitted(current, scope) ? current : null
}

/** At most {@link MAX_PATH_SUGGESTIONS} existing paths `missing` may have been meant to name, relative to `cwd` where they sit under it. `rootDir` is the project root the lookup resolved, or null when there is none; every path returned lies inside it, or inside `cwd` when it is not a real project, and the index is read (once) only for a real project. A spelling variant that exists decides the answer alone; otherwise the same-name, near-name and case-only rungs add to it in that order. */
export function suggestPaths(missing: string, cwd: string, rootDir: string | null): string[] {
  if (missing === '' || missing.length > MAX_PATH_CHARS || /[\r\n\0]/.test(missing)) return []
  const scope = scopeFor(cwd, rootDir)
  const missingAbs = path.resolve(cwd, missing)
  const variants = spellingVariants(missing).map((spelling) => path.resolve(cwd, spelling)).filter((abs) => !samePath(abs, missingAbs) && permitted(abs, scope) && existsSync(abs))
  if (variants.length > 0) return [...new Set(variants)].slice(0, MAX_PATH_SUGGESTIONS).map((abs) => displayPath(abs, cwd))

  const stripped = path.resolve(cwd, withoutDecoration(missing))
  const found: string[] = []
  const add = (list: readonly string[]): void => {
    for (const abs of list) if (!samePath(abs, missingAbs) && !found.some((seen) => samePath(seen, abs))) found.push(abs)
  }
  let files: IndexedFile[] | null = null
  if (scope.indexed) {
    try {
      files = indexedFileList(scope.root)
      add(sameNameFiles(stripped, scope.root, files, scope))
    } catch {
      // No readable index (never built, or the read database is unavailable) leaves the disk-only rungs below to answer.
    }
  }
  const corrected = caseCorrected(stripped, scope)
  add(nearNameFiles(stripped, scope.root, files, scope))
  if (corrected !== null) add([corrected])
  return found.slice(0, MAX_PATH_SUGGESTIONS).map((abs) => displayPath(abs, cwd))
}
