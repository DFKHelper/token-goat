/**
 * Non-git walk-index fallback policy (`token-goat index --walk`).
 *
 * The default `index` enumerates files via `git ls-files`, which inherits
 * `.gitignore` exclusions for free. When a folder is not a git repo the user can
 * opt into a bounded directory walk instead — but that walk has none of git's
 * exclusions, so this module re-adds the safety that matters: it refuses roots
 * broad enough to scan the whole machine, caps the file count, and drops files
 * git would have ignored (`.env*` secrets, generated `.d.ts`). It deliberately
 * reuses {@link walkProject} (the same bounded walker `map` uses) rather than a
 * second tree-walk implementation.
 */

import * as os from 'node:os'
import * as path from 'node:path'

import { MAX_FILES_SCANNED, walkProject } from './baseline.js'
import { foldPath, normalizePath } from './util.js'

/**
 * Files excluded from a non-git walk even when their extension is a known
 * language. In git mode `.gitignore` keeps these out; the walk has no such list,
 * so exclude the two classes that actually matter: `.env*` (secrets) and `.d.ts`
 * (generated type-declaration noise).
 */
function isWalkExcluded(file: string): boolean {
  const base = path.basename(file).toLowerCase()
  if (base === '.env' || base.startsWith('.env.')) return true
  if (base.endsWith('.d.ts')) return true
  return false
}

/**
 * Throw if `root` is too broad or sensitive to walk-index: a filesystem root,
 * the home directory itself, or any ancestor of it (e.g. `C:\Users`). Indexing
 * any of these would scan effectively the whole machine. Comparison routes both
 * sides through {@link normalizePath} so a drive-letter or separator difference
 * cannot defeat the guard on Windows.
 */
export function assertWalkableRoot(root: string): void {
  const resolved = path.resolve(root)
  // On case-insensitive filesystems (Windows, macOS) C:\Users and C:\USERS are the same directory, but normalizePath only lowercases the drive letter — fold the whole path for these comparisons or a case variant slips the guard.
  const norm = foldPath(normalizePath(resolved))
  const fsRoot = foldPath(normalizePath(path.parse(resolved).root))
  if (norm === fsRoot) {
    throw new Error(`refusing to walk-index a filesystem root: ${resolved}`)
  }
  const home = os.homedir()
  if (home) {
    const normHome = foldPath(normalizePath(path.resolve(home)))
    if (norm === normHome) {
      throw new Error(`refusing to walk-index the home directory: ${resolved}`)
    }
    // `root` is an ancestor of home (home lives inside it) -> still too broad.
    const boundary = norm.endsWith('/') ? norm : `${norm}/`
    if (normHome.startsWith(boundary)) {
      throw new Error(`refusing to walk-index '${resolved}' — it contains the home directory`)
    }
  }
}

/**
 * Collect the files a non-git walk-index should parse under `root`: the bounded
 * source-file walk minus {@link isWalkExcluded} entries. Throws if the root is
 * disallowed (see {@link assertWalkableRoot}) or the tree is too large
 * (>= {@link MAX_FILES_SCANNED} source files — the "too much stuff" ceiling).
 */
export function collectWalkIndexFiles(root: string): string[] {
  const resolved = path.resolve(root)
  assertWalkableRoot(resolved)
  const { files } = walkProject(resolved)
  if (files.length >= MAX_FILES_SCANNED) {
    throw new Error(
      `'${resolved}' has too many source files (>= ${MAX_FILES_SCANNED}); refusing to ` +
        `walk-index — index a git repo or point at a narrower path`,
    )
  }
  return files.filter((f) => !isWalkExcluded(f))
}
