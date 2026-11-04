/** Shared "this project has zero indexed files" diagnosis, reused by doctor's Symbols check (cli_doctor_index.ts's checkSymbolCount) and by every query command that can dead-end on an empty index (symbol/semantic/refs/types/callers/brief/dead/call-chain). A zero-result query against an unindexed project reads exactly like a genuine "not found" answer -- this module is the one place that tells the two apart and phrases the fix, so the wording never drifts between call sites (see the CLAUDE.md task note this shipped under). */
import * as fs from 'fs'
import { getReadDb } from './db.js'
import { projectScopeClause } from './sql_path.js'
import { foreignStampCurrent } from './stamp_authority.js'
import { detectWalkMode } from './walk_mode.js'
import { echoedValue, fencedCommand } from './hint_suggestion_guard.js'
import { getProjectFileEntries } from './index_reader.js'
import { isParseSkipEligible } from './parser.js'
import { detectLanguageOfFile } from './parser_types.js'
import { isEmbeddableDocument } from './doc_embed_extract.js'
import { loadConfig } from './config.js'
import { foldPath, isUnderBlockedRoot } from './util.js'
import { normalizePath, resolveIndexPath } from './paths.js'
import { listTrackedFiles } from './repomap.js'

/** Raw indexed file/symbol counts for `dbPath`, scoped to `rootDir` when given. Extracted from cli_doctor_index.ts's checkSymbolCount (which still owns the human-readable message) so index_status (mcp_server.ts) can report the same numbers as structured JSON instead of duplicating the SQL. Throws on a DB error -- callers that want the doctor-style "could not query" fallback must catch it themselves, matching checkSymbolCount's own try/catch. */
export function getProjectIndexCounts(dbPath: string, rootDir?: string): { fileCount: number; symbolCount: number } {
  const db = getReadDb(dbPath)
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

/** How much of the indexed corpus actually has embeddings, scoped exactly like getProjectIndexCounts above. Symbol coverage and embedding coverage fail independently, and only the first was ever reported. A file can be fully parsed -- present in `files`, its symbols in `symbols` -- while contributing no chunks at all, because indexFileEmbeddings (parser.ts) has several deliberate terminal skips that stamp a real embed_sha without embedding anything: a file over `indexing.large_file_symbol_only_kb`, a .profile-meta.xml, oversized Salesforce metadata, a document with no extractable text. Each is correct on its own, and the stamp is what stops the worker re-reading the file every drain. The consequence nobody could see is in aggregate: `semantic` then searches only the files that survived those skips, and a search over 3% of a corpus returns "no matches" in exactly the words it uses for a corpus it searched entirely. Counting distinct chunk paths against indexed files is the one cheap query that tells those apart, so it lives here beside its symbol-side twin rather than being restated at each caller. Throws on a DB error, matching getProjectIndexCounts -- callers own their own fallback. */
export function getEmbeddingCoverage(dbPath: string, rootDir?: string): { indexedFiles: number; embeddedFiles: number } {
  const db = getReadDb(dbPath)
  const countScoped = (sql: string, column: string): number => {
    if (rootDir === undefined) {
      return (db.prepare(sql).get() as { c: number }).c
    }
    const scope = projectScopeClause(column)
    return (db.prepare(`${sql} WHERE ${scope.clause}`).get(...scope.params(rootDir)) as { c: number }).c
  }
  return {
    indexedFiles: countScoped('SELECT COUNT(*) as c FROM files', 'path'),
    // DISTINCT file_path, not COUNT(*): the question is how many files are reachable by vector search at all, and one file contributes anywhere from 1 to 404 chunks (measured), so a raw chunk count would read as healthy coverage whenever a handful of large files chunked well.
    embeddedFiles: countScoped('SELECT COUNT(DISTINCT file_path) as c FROM chunks', 'file_path'),
  }
}

/** How many indexed files were written by the extraction logic this build actually runs, scoped exactly like the two counters above. `files.parser_sha` exists so a parser change invalidates rows whose content never moved, and every freshness gate treats a mismatch as stale: `token-goat index` reparses the file, the worker's drain reparses it, and the read-hook body fold declines on it outright. Each of those is correct in isolation. What nothing reported is the aggregate, and the aggregate is where it matters -- a mismatch only clears when something touches that file, so after an upgrade a project keeps serving symbols from the previous extractor until it is reindexed, with no signal anywhere that it is doing so. Measured on a real multi-project index: 95.1% of one project's 1,155 files, and 71.4% of 17,508 files overall, disagreed with the running build. A NULL or empty `parser_sha` is a row written before the column existed and counts as stale, which is what every gate already does with it. `expectedFor` resolves a row's stored language to the stamp a current parse of that language would have written, the same way every per-file gate does -- the digest is per-language, so there is no single value to compare against in SQL. Counting is grouped by (language, parser_sha), which is a handful of rows however large the index is, rather than by reading every row. Throws on a DB error, matching the two above -- callers own their own fallback. */
export function getParserFreshness(
  dbPath: string,
  expectedFor: (language: string) => string,
  rootDir?: string,
): { indexedFiles: number; currentFiles: number } {
  const db = getReadDb(dbPath)
  const scope = rootDir === undefined ? undefined : projectScopeClause('path')
  const rows = db
    .prepare(`SELECT language, parser_sha, COUNT(*) as c FROM files${scope === undefined ? '' : ` WHERE ${scope.clause}`} GROUP BY language, parser_sha`)
    .all(...(scope === undefined || rootDir === undefined ? [] : scope.params(rootDir))) as {
    language: string | null
    parser_sha: string | null
    c: number
  }[]
  let indexedFiles = 0
  let currentFiles = 0
  for (const row of rows) {
    indexedFiles += row.c
    // `?? 'unknown'` matches how getFileEntry reads the same column, so the two resolve a language-less row to the same stamp.
    if (row.parser_sha !== null && (row.parser_sha === expectedFor(row.language ?? 'unknown') || foreignStampCurrent(db, row.parser_sha))) currentFiles += row.c
  }
  return { indexedFiles, currentFiles }
}

/** How many of the files `token-goat index` would take from `rootDir` actually have a row in the index, or null when that cannot be known (git listed nothing or was killed, so there is no eligible set to count against). The eligible set is the one cmdIndex (cli.ts) walks, predicate for predicate: a git-tracked file that exists, is not under a blocked root, has a language or is an embeddable document, and is not excluded by indexing.skip_dirs / skip_files / minified / size. reconcile.ts's `added` is not that set: it counts every tracked file, images and lockfiles included, so it would report a gap the indexer never meant to close. A file missing a row here was never indexed or failed to index; the index records no parse-failure count, so those two are not told apart. Throws on a DB error, matching the counters above -- callers own their own fallback. */
export function getFileIndexCoverage(dbPath: string, rootDir: string): { indexedFiles: number; eligibleFiles: number } | null {
  const listing = listTrackedFiles(rootDir)
  if (listing.timedOut || listing.files.length === 0) return null
  const projectRoot = resolveIndexPath('.', rootDir)
  const indexed = getProjectFileEntries(projectRoot, dbPath)
  const cfg = loadConfig()
  const walkRootKey = resolveIndexPath(rootDir)
  let eligibleFiles = 0
  let indexedFiles = 0
  for (const file of listing.files) {
    const key = resolveIndexPath(file)
    if (isUnderBlockedRoot(key, cfg.worker.blocked_roots)) continue
    if (detectLanguageOfFile(key) === 'unknown' && !isEmbeddableDocument(key)) continue
    if (!fs.existsSync(key) || isParseSkipEligible(key, cfg.indexing, walkRootKey)) continue
    eligibleFiles += 1
    if (indexed.has(foldPath(normalizePath(file)))) indexedFiles += 1
  }
  return { indexedFiles, eligibleFiles }
}

/** The one coverage sentence `semantic`, `search` and `refs` append to an empty result, so a reader can tell "nothing in the project matches" from "most of the project was never indexed" without another turn: `indexed 812 of 840 files in this project` and, when files are missing, `28 not indexed; run token-goat index . to add them`. Printed when coverage is complete too, on purpose: it is what tells the reader the empty answer covers every file. Undefined when the numbers cannot be had (no git listing, DB error) -- a diagnostic never fails the query it annotates. Only meant for the empty-result path: it lists the tracked files and stats each. */
export function indexCoverageLine(dbPath: string, rootDir: string): string | undefined {
  try {
    const coverage = getFileIndexCoverage(dbPath, rootDir)
    if (coverage === null) return undefined
    const { indexedFiles, eligibleFiles } = coverage
    const base = `indexed ${indexedFiles} of ${eligibleFiles} files in this project`
    const missing = eligibleFiles - indexedFiles
    if (missing <= 0) return base
    return `${base}, ${missing} not indexed; an empty result does not cover them. Run ${fencedCommand(suggestedIndexCommand(rootDir))} to add them`
  } catch {
    return undefined
  }
}

/** True when `dbPath` (scoped to `rootDir` when given, matching checkSymbolCount's own scoping) has zero indexed files and zero symbols -- the exact condition doctor's Symbols check warns on. Only meant to be called AFTER a query already returned empty: it always pays a DB read, so gating it behind an existing zero-result check keeps it off the hot (nonempty-result) path. */
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

/** The suggested reindex command for an empty project, git-aware: a non-git scratch folder makes plain `token-goat index .` refuse ("no tracked files found... Pass --walk or --force-walk"), so the empty-index message must not suggest a command that fails in its most common trigger case. detectWalkMode (text_commands.ts) is the existing cheap fs-only git-detection check -- reused here instead of shelling out to git on this failure path. */
export function suggestedIndexCommand(rootDir: string): string {
  return detectWalkMode(rootDir) === 'git' ? 'token-goat index .' : 'token-goat index . --walk'
}

/** The exact doctor wording (checkSymbolCount's warn message) for an empty index, with the git-aware suggested command spliced in. Shared verbatim so every query command's empty-index hint and doctor's own Symbols warning never drift apart. */
export function emptyIndexMessage(rootDir: string, projectRootWasOmitted = false): string {
  const omittedNote = projectRootWasOmitted
    ? ` (projectRoot was omitted and defaulted to server process cwd ${echoedValue(rootDir)}; pass projectRoot: "<workspace-path>" to target your workspace)`
    : ''
  return (
    `no files indexed for this project — every read command will return empty, which looks ` +
    `like a genuine "not found" rather than a missing index; run ${fencedCommand(suggestedIndexCommand(rootDir))} here${omittedNote}`
  )
}
