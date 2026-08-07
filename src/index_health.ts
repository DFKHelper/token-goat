/**
 * Shared "this project has zero indexed files" diagnosis, reused by doctor's Symbols check
 * (cli_doctor.ts's checkSymbolCount) and by every query command that can dead-end on an empty
 * index (symbol/semantic/refs/types/callers/brief/dead/call-chain). A zero-result query against
 * an unindexed project reads exactly like a genuine "not found" answer -- this module is the one
 * place that tells the two apart and phrases the fix, so the wording never drifts between call
 * sites (see the CLAUDE.md task note this shipped under).
 */
import * as fs from 'fs'
import { getDb } from './db.js'
import { projectScopeClause } from './sql_path.js'
import { detectWalkMode } from './text_commands.js'

/**
 * True when `dbPath` (scoped to `rootDir` when given, matching checkSymbolCount's own scoping)
 * has zero indexed files and zero symbols -- the exact condition doctor's Symbols check warns
 * on. Only meant to be called AFTER a query already returned empty: it always pays a DB read, so
 * gating it behind an existing zero-result check keeps it off the hot (nonempty-result) path.
 */
export function isIndexEmptyForProject(dbPath: string, rootDir?: string): boolean {
  if (!fs.existsSync(dbPath)) return true
  try {
    const db = getDb(dbPath)
    const countScoped = (table: string, column: string): number => {
      if (rootDir === undefined) {
        return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c
      }
      const scope = projectScopeClause(column)
      return (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${scope.clause}`).get(scope.param(rootDir)) as {
        c: number
      }).c
    }
    return countScoped('files', 'path') === 0 && countScoped('symbols', 'file_path') === 0
  } catch {
    // Can't tell -- don't claim the index is empty on a query failure the caller didn't ask about.
    return false
  }
}

/**
 * The suggested reindex command for an empty project, git-aware: a non-git scratch folder makes
 * plain `token-goat index .` refuse ("no tracked files found... Pass --walk or --force-walk"),
 * so the empty-index message must not suggest a command that fails in its most common trigger
 * case. detectWalkMode (text_commands.ts) is the existing cheap fs-only git-detection check --
 * reused here instead of shelling out to git on this failure path.
 */
export function suggestedIndexCommand(rootDir: string): string {
  return detectWalkMode(rootDir) === 'git' ? 'token-goat index .' : 'token-goat index . --walk'
}

/**
 * The exact doctor wording (checkSymbolCount's warn message) for an empty index, with the
 * git-aware suggested command spliced in. Shared verbatim so every query command's empty-index
 * hint and doctor's own Symbols warning never drift apart.
 */
export function emptyIndexMessage(rootDir: string): string {
  return (
    `no files indexed for this project — every read command will return empty, which looks ` +
    `like a genuine "not found" rather than a missing index; run '${suggestedIndexCommand(rootDir)}' here`
  )
}
