/**
 * Non-git walk-index fallback policy (`token-goat index --walk`).
 *
 * The default `index` enumerates files via `git ls-files`, which inherits
 * `.gitignore` exclusions for free. When a folder is not a git repo the user can
 * opt into a bounded directory walk instead — but that walk has none of git's
 * exclusions, so this module re-adds the safety that matters: it refuses roots
 * broad enough to scan the whole machine, caps the file count, and drops files
 * git would usually have ignored (`.env*` secrets, generated `.d.ts`). It
 * deliberately reuses {@link walkProject} (the same bounded walker `map` uses)
 * rather than a second tree-walk implementation.
 *
 * "Usually" is load-bearing, and used not to be. git ignores only what
 * `.gitignore` says to ignore, so a tracked `.env` is not hypothetical:
 * `.env.example` and friends are committed on purpose and a real one gets
 * committed by accident all the time. This module's `.env*` rule was the only
 * protection anywhere, so on the git path -- the default -- those values were
 * indexed and served. Secrecy of dotenv values is now enforced where it belongs,
 * for both paths at once, by redacting the values while keeping the keys: see
 * `dotenv_redact.ts`. The exclusion below stays as the belt to that braces,
 * since a walk has no reason to spend budget on these files either way.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { isDotenvPath } from './dotenv_redact.js'
import { MAX_FILES_SCANNED, walkProject } from './baseline.js'
import { foldPath, normalizePath } from './util.js'

/**
 * Files excluded from a non-git walk even when their extension is a known
 * language. In git mode `.gitignore` keeps these out; the walk has no such list,
 * so exclude the two classes that actually matter: `.env*` (secrets) and `.d.ts`
 * (generated type-declaration noise).
 */
function isWalkExcluded(file: string): boolean {
  // Routed through the shared predicate rather than a second filename test. The two had already
  // drifted: `startsWith('.env.')` matched a file named exactly `.env.`, which `detectLanguage`
  // does not classify as a dotenv file, so that one name was dropped from the walk while every
  // other path treated it as ordinary text.
  if (isDotenvPath(file)) return true
  const base = path.basename(file).toLowerCase()
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
  // realpath, not just resolve: path.resolve is purely lexical, so a symlink or Windows junction
  // pointing at C:\Users (or a drive root) would be evaluated as the harmless-looking alias and
  // waved through. That gap became load-bearing once --force-walk lifted the file-count ceiling,
  // since this guard is then the only thing standing between a typo'd link and a whole-drive scan.
  // Fall back to the lexical path when the target does not exist -- a non-existent root cannot be
  // a dangerous one, and the walk will fail on its own terms.
  let resolved = path.resolve(root)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {
    // Not present / not readable: leave the lexical resolution in place.
  }
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
 * Hard ceiling for a `--force` walk. `--force` is an explicit "yes, this folder really is that
 * big" from the user, so it lifts the default {@link MAX_FILES_SCANNED} refusal -- but it does
 * not remove the bound entirely. An unbounded walk is how one mistyped root becomes a whole-drive
 * scan, and the enumeration itself has to terminate before any of the indexing cost is even paid.
 */
export const MAX_FILES_SCANNED_FORCED = 500_000

/**
 * Collect the files a non-git walk-index should parse under `root`: the bounded
 * source-file walk minus {@link isWalkExcluded} entries. Throws if the root is
 * disallowed (see {@link assertWalkableRoot}) or the tree is too large
 * (>= {@link MAX_FILES_SCANNED} source files -- the "too much stuff" ceiling),
 * unless `force` raises that ceiling to {@link MAX_FILES_SCANNED_FORCED}.
 *
 * `force` deliberately governs **volume only**. {@link assertWalkableRoot} still runs
 * unconditionally, because the two guards protect against different things: the file cap is a
 * cost the user is entitled to accept for a folder they actually meant, while walking a
 * filesystem root or the home directory is never what anyone meant, at any file count.
 */
export function collectWalkIndexFiles(root: string, opts: { force?: boolean } = {}): string[] {
  const resolved = path.resolve(root)
  assertWalkableRoot(resolved)
  const force = opts.force === true
  const ceiling = force ? MAX_FILES_SCANNED_FORCED : MAX_FILES_SCANNED
  const { files } = walkProject(resolved, { includeEmbeddableDocuments: true, maxFiles: ceiling })
  if (files.length >= ceiling) {
    // walkProject stops *at* the ceiling, so this count is a floor, not the true total -- say so
    // rather than implying an exact measurement the walk never made.
    throw new Error(
      `'${resolved}' has too many source files (walk stopped at ${ceiling}; the real total is ` +
        `at least that). ` +
        (force
          ? 'Even --force-walk will not walk a tree this large — point at a narrower path.'
          : 'Index a git repo, point at a narrower path, or pass --force-walk to raise the cap to ' +
            `${MAX_FILES_SCANNED_FORCED}.`),
    )
  }
  return files.filter((f) => !isWalkExcluded(f))
}
