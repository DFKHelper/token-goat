/** Git linked worktrees that sit inside a project's own directory, and the SQL that keeps their rows out of that project's queries. Claude Code creates agent worktrees under `<project>/.claude/worktrees/<name>`, so each one is a full second copy of the project nested under the project root. The index records both copies, and a prefix-range scope over the root takes in the nested copy with it: `symbol drainOnce` from the project answered with one definition per worktree plus the real one, and search and semantic ranked stale copies against the live file. A worktree is its own checkout, reached as its own project when the agent works inside it, so it is excluded from the parent's scope rather than merged into it. Submodules and monorepo packages are not worktrees and stay in scope: they are part of the parent's tree, where a worktree is a duplicate of it. */

import fs from 'node:fs'
import path from 'node:path'

import { normalizePath } from './paths.js'
import { projectScopeClause } from './sql_path.js'
import { foldPath } from './util.js'

interface CacheEntry {
  readonly listMtimeMs: number
  readonly roots: readonly string[]
}

/** Keyed by the project root as given. The MCP server and the worker live for hours, so a list read once would miss a worktree added after startup; the entry is checked against the `worktrees` directory's mtime, which git changes whenever it adds or prunes one. */
const cache = new Map<string, CacheEntry>()

/** The repository's common git directory for a checkout rooted at `root`, or null when `root` is not the top of a checkout. A `.git` directory is the common dir itself; a `.git` file (the root is a linked worktree) points at `.git/worktrees/<name>`, whose `commondir` names the shared directory, relative to it. */
function commonGitDir(root: string): string | null {
  const dotGit = path.join(root, '.git')
  let st: fs.Stats
  try {
    st = fs.statSync(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) return dotGit
  if (!st.isFile()) return null
  try {
    const m = /^gitdir:(.*)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
    const target = m?.[1]?.trim()
    if (target === undefined || target === '') return null
    const gitDir = path.resolve(root, target)
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    return path.resolve(gitDir, common)
  } catch {
    return null
  }
}

/** Whether `child` is strictly inside `parent`, both already normalized and folded the way the index folds them. */
function strictlyInside(child: string, parent: string): boolean {
  const base = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(base) && child.length > base.length
}

/** Roots of the git linked worktrees strictly inside `root`, in the index's path spelling. Empty when `root` is not a checkout, has no linked worktrees, or they all live elsewhere, which is the common case and costs two stats. Each `<common>/worktrees/<name>/gitdir` holds the path of that worktree's `.git` file, absolute by default and relative to its own directory under `worktree.useRelativePaths`; its parent is the worktree root. An entry that cannot be read is skipped rather than guessed at: the cost of missing one is the duplicate rows this exists to remove, not a wrong answer. */
export function nestedWorktreeRoots(root: string): readonly string[] {
  const common = commonGitDir(root)
  if (common === null) return []
  const listDir = path.join(common, 'worktrees')
  let listMtimeMs: number
  try {
    listMtimeMs = fs.statSync(listDir).mtimeMs
  } catch {
    return []
  }
  const hit = cache.get(root)
  if (hit?.listMtimeMs === listMtimeMs) return hit.roots

  const rootPath = normalizePath(root)
  const rootKey = foldPath(rootPath)
  // Git records a worktree by its resolved path, which need not be the spelling the index uses for the root: macOS's /var is a link to /private/var, and a Windows temp directory can be reached by its 8.3 short name. A worktree under the resolved root is re-spelled under the root as given, since that is the spelling the rows were stored under.
  let realPath: string | null
  try {
    realPath = normalizePath(fs.realpathSync.native(root))
  } catch {
    realPath = null
  }
  const roots: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(listDir)
  } catch {
    names = []
  }
  for (const name of names) {
    const entryDir = path.join(listDir, name)
    let target: string
    try {
      target = fs.readFileSync(path.join(entryDir, 'gitdir'), 'utf8').trim()
    } catch {
      continue
    }
    if (target === '') continue
    const wtRoot = normalizePath(path.dirname(path.resolve(entryDir, target)))
    if (strictlyInside(foldPath(wtRoot), rootKey)) roots.push(wtRoot)
    else if (realPath !== null && strictlyInside(foldPath(wtRoot), foldPath(realPath))) roots.push(rootPath.replace(/\/+$/, '') + wtRoot.slice(realPath.replace(/\/+$/, '').length))
  }
  roots.sort()
  cache.set(root, { listMtimeMs, roots })
  return roots
}

/** {@link projectScopeClause} for `root`, minus every git linked worktree nested inside it. The clause text depends on the root, because each nested worktree adds one `NOT (range)` term, so this takes the root up front where `projectScopeClause` defers it; with no nested worktree the clause and params are exactly `projectScopeClause`'s. Built from `projectScopeClause` itself so the excluded ranges fold case exactly as the scope does. Maintenance queries (reconcile, doctor's counts, the worker) keep using the plain range: rows under a nested worktree are still real rows that have to be kept fresh or pruned, and hiding them there would leave them to rot. */
export function ownProjectScope(column: string, root: string): { clause: string; params: string[] } {
  const scope = projectScopeClause(column)
  const excluded = nestedWorktreeExclusions(column, root)
  if (excluded.clauses.length === 0) return { clause: scope.clause, params: scope.params(root) }
  return { clause: `(${[scope.clause, ...excluded.clauses].join(' AND ')})`, params: [...scope.params(root), ...excluded.params] }
}

/** Only the `NOT (range)` terms of {@link ownProjectScope}, one per nested worktree, for a caller that binds the project's own range itself: `forEachSymbol` pages by keyset and has to own the lower bound, since a second `>=` beside the resumed key made SQLite seek from the start of the range on every page. */
export function nestedWorktreeExclusions(column: string, root: string): { clauses: string[]; params: string[] } {
  const scope = projectScopeClause(column)
  const clauses: string[] = []
  const params: string[] = []
  for (const wt of nestedWorktreeRoots(root)) {
    clauses.push(`NOT ${scope.clause}`)
    params.push(...scope.params(wt))
  }
  return { clauses, params }
}
