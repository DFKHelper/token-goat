/** Which directory segments of an indexed file's path count when the path is tested against a skip-directory set. Only segments inside the project qualify: a project that lives under an ancestor named `build`, `vendor` or `dist` (`C:/work/build/app`, `~/vendor/acme/app`) must not have every file treated as vendored output because of where the user keeps it. Shared by the parser's `indexing.skip_dirs` check and baseline.ts's SKIP_DIRS filter so the two cannot disagree. */
import * as os from 'node:os'
import * as path from 'node:path'

import { foldPath } from './path_containment.js'
import { findProject } from './project.js'

// The root a bulk walk has declared for the files it is feeding to indexFileSync, which takes no root of its own and is spied on with its exact arguments by existing tests. Set only around that synchronous call.
let declaredRoot: string | undefined

/** Run `fn` with `root` declared as the project root for any skip-directory test it makes without an explicit root: the walk root a caller typed is the one root that needs no marker to be known, so a markerless project under an ancestor named `build` still indexes. */
export function withDeclaredSkipScopeRoot<T>(root: string, fn: () => T): T {
  const previous = declaredRoot
  declaredRoot = root
  try {
    return fn()
  } finally {
    declaredRoot = previous
  }
}

function pathSegments(p: string): string[] {
  return p.split(/[/\\]/).filter((s) => s.length > 0)
}

/** The outermost project root enclosing `filePath`, or undefined when no project marker is found. Outermost rather than nearest because a vendored package carries its own marker (`node_modules/pkg/package.json`): the nearest root of such a file is `pkg`, which would leave `node_modules` outside the project and let the file through. The climb stops short of the home directory, so a dotfiles repo at `~` does not turn `~/vendor/acme/app` back into a path under a skip directory. */
function outermostProjectRoot(filePath: string): string | undefined {
  const first = findProject(path.dirname(filePath))
  if (first === null) return undefined
  const home = foldPath(os.homedir()).replace(/\\/g, '/')
  let root = first.root
  for (;;) {
    const parent = path.dirname(root)
    if (parent === root) return root
    const outer = findProject(parent)
    if (outer === null || outer.root === root) return root
    const outerFolded = foldPath(outer.root).replace(/\\/g, '/').replace(/\/+$/, '')
    if (home === outerFolded || home.startsWith(`${outerFolded}/`)) return root
    root = outer.root
  }
}

/** True when a directory segment of `filePath` (the file name excluded) that lies below the project root satisfies `isSkipSegment`. `projectRoot` is the root the caller already knows (a walk root, a resolved project root); when omitted it is derived from project markers, and only once some segment matches at all, so the marker probing is not paid on the common path. A path outside the given root, or with no derivable root, is tested whole: the conservative answer, identical to the old behavior. */
export function hasSkipSegmentBelowRoot(filePath: string, projectRoot: string | undefined, isSkipSegment: (segment: string) => boolean): boolean {
  const dirSegments = pathSegments(filePath).slice(0, -1)
  if (!dirSegments.some(isSkipSegment)) return false
  const root = projectRoot ?? declaredRoot ?? outermostProjectRoot(filePath)
  if (root === undefined) return true
  const rootSegments = pathSegments(root)
  if (rootSegments.length > dirSegments.length) return true
  for (let i = 0; i < rootSegments.length; i++) {
    if (foldPath(rootSegments[i] ?? '') !== foldPath(dirSegments[i] ?? '')) return true
  }
  return dirSegments.slice(rootSegments.length).some(isSkipSegment)
}
