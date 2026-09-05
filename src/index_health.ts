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
import { detectWalkMode } from './walk_mode.js'

/**
 * Raw indexed file/symbol counts for `dbPath`, scoped to `rootDir` when given. Extracted from
 * cli_doctor.ts's checkSymbolCount (which still owns the human-readable message) so index_status
 * (mcp_server.ts) can report the same numbers as structured JSON instead of duplicating the SQL.
 * Throws on a DB error -- callers that want the doctor-style "could not query" fallback must
 * catch it themselves, matching checkSymbolCount's own try/catch.
 */
export function getProjectIndexCounts(dbPath: string, rootDir?: string): { fileCount: number; symbolCount: number } {
  const db = getDb(dbPath)
  const countScoped = (table: string, column: string): number => {
    if (rootDir === undefined) {
      return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c
    }
    const scope = projectScopeClause(column)
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${scope.clause}`).get(...scope.params(rootDir)) as {
      c: number
    }).c
  }
  return { fileCount: countScoped('files', 'path'), symbolCount: countScoped('symbols', 'file_path') }
}

/**
 * How much of the indexed corpus actually has embeddings, scoped exactly like
 * getProjectIndexCounts above.
 *
 * Symbol coverage and embedding coverage fail independently, and only the first was ever
 * reported. A file can be fully parsed -- present in `files`, its symbols in `symbols` -- while
 * contributing no chunks at all, because indexFileEmbeddings (parser.ts) has several deliberate
 * terminal skips that stamp a real embed_sha without embedding anything: a file over
 * `indexing.large_file_symbol_only_kb`, a .profile-meta.xml, oversized Salesforce metadata, a
 * document with no extractable text. Each is correct on its own, and the stamp is what stops the
 * worker re-reading the file every drain. The consequence nobody could see is in aggregate:
 * `semantic` then searches only the files that survived those skips, and a search over 3% of a
 * corpus returns "no matches" in exactly the words it uses for a corpus it searched entirely.
 * Counting distinct chunk paths against indexed files is the one cheap query that tells those
 * apart, so it lives here beside its symbol-side twin rather than being restated at each caller.
 *
 * Throws on a DB error, matching getProjectIndexCounts -- callers own their own fallback.
 */
export function getEmbeddingCoverage(dbPath: string, rootDir?: string): { indexedFiles: number; embeddedFiles: number } {
  const db = getDb(dbPath)
  const countScoped = (sql: string, column: string): number => {
    if (rootDir === undefined) {
      return (db.prepare(sql).get() as { c: number }).c
    }
    const scope = projectScopeClause(column)
    return (db.prepare(`${sql} WHERE ${scope.clause}`).get(...scope.params(rootDir)) as { c: number }).c
  }
  return {
    indexedFiles: countScoped('SELECT COUNT(*) as c FROM files', 'path'),
    // DISTINCT file_path, not COUNT(*): the question is how many files are reachable by vector
    // search at all, and one file contributes anywhere from 1 to 404 chunks (measured), so a raw
    // chunk count would read as healthy coverage whenever a handful of large files chunked well.
    embeddedFiles: countScoped('SELECT COUNT(DISTINCT file_path) as c FROM chunks', 'file_path'),
  }
}

/**
 * How many indexed files were written by the extraction logic this build actually runs, scoped exactly like the two counters above.
 *
 * `files.parser_sha` exists so a parser change invalidates rows whose content never moved, and every freshness gate treats a mismatch as stale: `token-goat index` reparses the file, the worker's drain reparses it, and the read-hook body fold declines on it outright. Each of those is correct in isolation. What nothing reported is the aggregate, and the aggregate is where it matters -- a mismatch only clears when something touches that file, so after an upgrade a project keeps serving symbols from the previous extractor until it is reindexed, with no signal anywhere that it is doing so. Measured on a real multi-project index: 95.1% of one project's 1,155 files, and 71.4% of 17,508 files overall, disagreed with the running build.
 *
 * A NULL or empty `parser_sha` is a row written before the column existed and counts as stale, which is what every gate already does with it.
 *
 * Throws on a DB error, matching the two above -- callers own their own fallback.
 */
export function getParserFreshness(
  dbPath: string,
  parserSha: string,
  rootDir?: string,
): { indexedFiles: number; currentFiles: number } {
  const db = getDb(dbPath)
  const count = (extra: string, params: unknown[]): number => {
    if (rootDir === undefined) {
      return (db.prepare(`SELECT COUNT(*) as c FROM files${extra === '' ? '' : ` WHERE ${extra}`}`).get(...params) as {
        c: number
      }).c
    }
    const scope = projectScopeClause('path')
    const where = extra === '' ? scope.clause : `${scope.clause} AND ${extra}`
    return (db.prepare(`SELECT COUNT(*) as c FROM files WHERE ${where}`).get(...scope.params(rootDir), ...params) as {
      c: number
    }).c
  }
  return { indexedFiles: count('', []), currentFiles: count('parser_sha = ?', [parserSha]) }
}

/**
 * True when `dbPath` (scoped to `rootDir` when given, matching checkSymbolCount's own scoping)
 * has zero indexed files and zero symbols -- the exact condition doctor's Symbols check warns
 * on. Only meant to be called AFTER a query already returned empty: it always pays a DB read, so
 * gating it behind an existing zero-result check keeps it off the hot (nonempty-result) path.
 */
export function isIndexEmptyForProject(dbPath: string, rootDir?: string): boolean {
  if (!fs.existsSync(dbPath)) return true
  try {
    const { fileCount, symbolCount } = getProjectIndexCounts(dbPath, rootDir)
    return fileCount === 0 && symbolCount === 0
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
