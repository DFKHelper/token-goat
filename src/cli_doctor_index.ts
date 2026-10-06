/** Index and reindex-queue diagnostics for token-goat doctor. Checks the index database's size and what holds its bytes, whether the project's indexed files have symbols, embeddings and current parser stamps, and whether a running worker is still draining the dirty queue. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { countNoun, extractErrorMessage, toKB } from './util.js'
import { findSystemTempFiles, findTopIndexedProjects, type ProjectIndexConsumer } from './index_prune.js'
import { displaySafeText } from './paths.js'
import { isUnderSystemTemp } from './project.js'
import { projectScopeClause } from './sql_path.js'
import { getDirtyPathsFor } from './dirty_queue.js'
import { isWorkerRunning } from './worker_lifecycle.js'
import { emptyIndexMessage, getProjectIndexCounts, getEmbeddingCoverage, getParserFreshness } from './index_health.js'
import { loadConfig } from './config.js'
import { modelFilesPresent } from './embed_model.js'
import { isEmbedFresh, oversizeEmbedSha } from './parser.js'
import { parserFingerprintForLanguage } from './parser_stamp.js'
import { getDb } from './db.js'
import { isZeroLengthDb, quickCheckDb } from './db_integrity.js'
import { indexSizeBytes } from './index_reclaim.js'
import type { DoctorResult } from './doctor_result.js'
import { fencedCommand, quotedArg } from './hint_suggestion_guard.js'

/** Size at which the index DB stops being merely large and starts being a functional problem: write transactions scale with it, and once one outlasts db.ts's 15s `busy_timeout` the failure reaches the user as "database is locked" rather than as anything mentioning size. A healthy index for a large multi-project tree is tens of MB, so exceeding max_db_size_mb (default 1500 MB) is well clear of normal use and still catches the pathology early. */
export const DB_SIZE_WARN_BYTES = 1500 * 1024 * 1024

/** Bytes a VACUUM would return: the page size (offset 16, where 1 means 65536) times the freelist page count (offset 36), both big-endian fields of the database header described at https://www.sqlite.org/fileformat.html#the_database_header. */
export function freelistBytes(header: Buffer): number {
  if (header.length < 40) return 0
  const rawPageSize = header.readUInt16BE(16)
  return (rawPageSize === 1 ? 65536 : rawPageSize) * header.readUInt32BE(36)
}

/** One row category's measured byte share of an oversized global.db, and the command that actually shrinks it. */
export interface CategoryByteShare {
  name: string
  bytes: number
  command: string
}

/** Storage groups an oversized global.db is reported by. Each owns the tables whose names match, with their indexes counted in, and says what actually shrinks it. */
const STORAGE_GROUPS: ReadonlyArray<{ name: string; owns: RegExp; command: string }> = [
  { name: 'refs', owns: /^refs$/, command: 'grows with the files indexed, so it shrinks only when files leave the index' },
  { name: 'symbols and their search index', owns: /^symbols(_fts\w*)?$/, command: 'grows with the files indexed, so it shrinks only when files leave the index' },
  {
    name: 'embeddings',
    owns: /^(chunks|chunk_vectors\w*)$/,
    command: "these back 'semantic'; to drop them, set indexing.embeddings_enabled = false and indexing.auto_reclaim_embeddings = true, then run `token-goat doctor --repair`",
  },
  { name: 'usage stats', owns: /^(stats\w*|hint_\w+|unmapped_tools)$/, command: 'ages out on its own (180-day retention)' },
  { name: 'recall cache', owns: /^cache_recall\w*$/, command: 'ages out on its own' },
]

/** Bytes on disk per table, each table's indexes counted with it, read from SQLite's `dbstat` table. Measured in pages rather than by summing column lengths: the length sum saw 89 MB of refs in a 4.9 GB file whose refs table and four indexes held 2.7 GB of it, and called the rest overhead nothing could measure. */
const OWNER_BYTES_SQL = `SELECT COALESCE(m.tbl_name, s.name) AS owner, SUM(s.pgsize) AS bytes FROM dbstat AS s LEFT JOIN sqlite_master AS m ON m.name = s.name WHERE s.aggregate = 1 GROUP BY owner`

/** Measures where an oversized global.db's bytes are, one row per non-empty storage group, largest first, so the warning can name what holds the file instead of just its size. Returns nothing when this SQLite build has no `dbstat`; the warning then goes without a breakdown rather than with a guessed one. Only runs once the size warning has fired: a full page walk, about 5 s on a 4.9 GB file. */
export function dbCategoryBreakdown(dbPath: string): CategoryByteShare[] {
  let rows: Array<{ owner: string; bytes: number }>
  try {
    rows = getDb(dbPath).prepare(OWNER_BYTES_SQL).all() as Array<{ owner: string; bytes: number }>
  } catch {
    return []
  }
  const shares = STORAGE_GROUPS.map((group) => ({
    name: group.name,
    bytes: rows.filter((r) => group.owns.test(r.owner)).reduce((sum, r) => sum + r.bytes, 0),
    command: group.command,
  }))
  return shares.filter((share) => share.bytes > 0).sort((a, b) => b.bytes - a.bytes)
}

/** The oversized-index warning, naming only what is measurably there to recover: sending someone to VACUUM a file with no free pages has them wait on a rewrite of gigabytes that frees nothing. */
export function oversizeDbMessage(
  dbPath: string,
  sizeBytes: number,
  freeBytes: number,
  tempRows: number,
  categories: CategoryByteShare[] = [],
  topConsumers: ProjectIndexConsumer[] = [],
  thresholdMb: number = 1500,
  autoReclaimEmbeddings: boolean = false,
): string {
  const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))
  const advice: string[] = []
  if (freeBytes >= sizeBytes / 10) advice.push(`\`token-goat reclaim-index\` returns the ${mb(freeBytes)} MB of it that is free pages`)
  if (tempRows > 0) advice.push(`\`token-goat project prune\` removes ${countNoun(tempRows, 'scratch file')} indexed under the OS temp dir`)
  if (autoReclaimEmbeddings) {
    advice.push(`\`token-goat doctor --repair\` will automatically reclaim embedding vectors and compact global.db`)
  }
  const head = `global.db is ${mb(sizeBytes)} MB at ${displaySafeText(dbPath)} (larger than threshold of ${thresholdMb} MB). `
  const listed = categories.slice(0, 3)
  const totalCategoryBytes = listed.reduce((sum, c) => sum + c.bytes, 0)
  // Each share is of the whole file, because "where it went" is a claim about the file the sentence just sized. The groups are measured in pages, indexes included, so together they come to the file less its free pages; whatever the listed groups leave over is named rather than left to be inferred from shares that do not sum to 100.
  const unmeasuredBytes = sizeBytes - totalCategoryBytes
  const breakdown =
    totalCategoryBytes > 0 && sizeBytes > 0
      ? ` Where it went: ${listed
          .map((c) => `${c.name} ${mb(c.bytes)} MB (${Math.round((c.bytes / sizeBytes) * 100)}%) -- ${c.command}`)
          .join('; ')}.${
          unmeasuredBytes >= sizeBytes / 20
            ? ` The other ${mb(unmeasuredBytes)} MB is smaller tables and free pages.`
            : ''
        }`
      : ''
  let base = advice.length > 0 ? `${head}${advice.join('; ')}.${breakdown}` : `${head}Only ${mb(freeBytes)} MB of it is free pages and none of it is temp-dir scratch, so it is live index data that neither 'reclaim-index' nor 'project prune' will shrink.${breakdown}`
  const [top] = topConsumers
  if (top !== undefined) {
    const list = topConsumers.map((c) => `${path.basename(c.root) || c.root} (${countNoun(c.fileCount, 'file')})`).join(', ')
    base += ` Top index consumers: ${list}.`
    // Symbols and refs are most of any large index and grow with the files indexed, so the one command that shrinks them is taking a project out of the index; its rows are deleted at once and the pages come back on the next reclaim.
    base += ` To shrink it, take out a project you do not need surgical reads in: ${fencedCommand('token-goat project exclude ' + quotedArg(displaySafeText(top.root)))} removes its rows, then ${fencedCommand('token-goat reclaim-index')} returns the space.`
  }
  return `${base} If this size is expected, raise indexing.max_db_size_mb above ${Math.ceil(sizeBytes / (1024 * 1024))}.`
}

/** Check if the data directory and database files exist. */
export function checkDbExists(dataDir: string, maxDbSizeMb?: number): DoctorResult {
  const dbPath = path.join(dataDir, 'global.db')
  if (!fs.existsSync(dbPath)) {
    return {
      name: 'Database',
      status: 'warn',
      message: `global.db not found at ${dbPath}`,
    }
  }
  const sizeBytes = indexSizeBytes(dbPath)
  if (isZeroLengthDb(dbPath)) {
    return {
      name: 'Database',
      status: 'warn',
      message: `global.db at ${dbPath} is empty (0 bytes); token-goat creates a fresh database in it on next use, so run token-goat index to rebuild this project's index`,
    }
  }
  const SQLITE_HEADER = 'SQLite format 3\0'
  let header = ''
  let headerBytes = Buffer.alloc(0)
  try {
    const fd = fs.openSync(dbPath, 'r')
    try {
      const buf = Buffer.alloc(100)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      headerBytes = buf.subarray(0, bytesRead)
      header = buf.toString('latin1', 0, Math.min(bytesRead, SQLITE_HEADER.length))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // treat an unreadable file as invalid below
  }
  if (header !== SQLITE_HEADER) {
    return {
      name: 'Database',
      status: 'fail',
      message: `global.db at ${dbPath} is not a valid SQLite file (${sizeBytes} bytes) — likely truncated or corrupt; run token-goat doctor --repair to move it aside and rebuild the index`,
    }
  }
  // A valid header says nothing about the pages behind it: quick_check is what turns a malformed index into a failed row instead of a healthy one whose every other check warns.
  const integrity = quickCheckDb(dbPath)
  if (!integrity.ok) {
    return {
      name: 'Database',
      status: 'fail',
      message: `global.db at ${dbPath} is malformed (${integrity.detail}); run token-goat doctor --repair to move it aside and rebuild the index`,
    }
  }
  // An index that has grown into the gigabytes is not merely a disk-space matter: every reindex transaction scales with it, and once a write outlasts db.ts's 15s busy_timeout the failure presents to the user as an unexplained "database is locked" plus long stalls during `token-goat index`. Surface the size directly, because the symptom points nowhere near the cause. A healthy index is tens of MB; exceeding max_db_size_mb (default 1500 MB) means something is storing far more per symbol than it should.
  const cfg = loadConfig()
  const thresholdMb = maxDbSizeMb ?? cfg.indexing.max_db_size_mb ?? 1500
  const warnBytes = thresholdMb * 1024 * 1024
  if (sizeBytes > warnBytes) {
    let tempRows = 0
    try {
      tempRows = findSystemTempFiles(dbPath).length
    } catch {
      // an unreadable files table only loses this half of the advice
    }
    let categories: CategoryByteShare[] = []
    try {
      categories = dbCategoryBreakdown(dbPath)
    } catch {
      // measuring the breakdown only loses that half of the message, not the warning itself
    }
    // findTopIndexedProjects catches internally and returns [] on an unreadable index, so no wrapper is needed here.
    const topConsumers = findTopIndexedProjects(dbPath, 3)
    return {
      name: 'Database',
      status: 'warn',
      message: oversizeDbMessage(
        dbPath,
        sizeBytes,
        freelistBytes(headerBytes),
        tempRows,
        categories,
        topConsumers,
        thresholdMb,
        cfg.indexing.auto_reclaim_embeddings,
      ),
    }
  }
  // Name the resolved path even when healthy. The warn branch above already does, and the asymmetry actively misleads: TOKEN_GOAT_HOME and the data dir resolve independently, so exporting both to point at a scratch directory does NOT guarantee a command reads the isolated index. Without the path here, a dogfood run against the real global index is indistinguishable from an isolated one, and "which index am I actually on" is the first question worth answering when a command returns surprising output.
  return {
    name: 'Database',
    status: 'ok',
    message: `global.db exists (${toKB(sizeBytes)} KB) at ${dbPath}`,
  }
}

/** Check that the index actually contains symbols when it has indexed files. Guards against the worker-draining-to-a-stub-callback failure mode (see CLAUDE.md's "Critical path" section): a release once shipped with the queue drain wired to a default stub, so files were marked indexed in the `files` table while the parser never ran and `symbols` stayed permanently empty — every surgical-read command (`symbol`, `read`, `skeleton`, `outline`, `semantic`) silently returned nothing, and the test suite stayed green because every worker test injected its own callback. Caller passes the same `dbPath` `checkDbExists` validated; if the database doesn't exist yet (or isn't openable), this check quietly no-ops rather than duplicating that failure. `rootDir`, when given, scopes both counts to files under that project root via `getProjectIndexCounts` (index_health.ts), which uses sql_path.ts's `projectScopeClause` -- the same helper map/semantic/find/dead already use (see commit 6a5ac228). Without it, `global.db`'s machine-wide sharing across every project ever indexed means an unrelated project's symbols can mask this exact project's own parser being broken: fileCount/symbolCount would count every project's rows, so a project with 0 of its own symbols still reads as healthy as long as some other indexed project has symbols. Omitting `rootDir` falls back to the prior unscoped (whole-database) behavior for callers that genuinely want a global figure. */
export function checkSymbolCount(dbPath: string, rootDir?: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Symbols', status: 'ok', message: 'no database yet' }
  }
  try {
    const { fileCount, symbolCount } = getProjectIndexCounts(dbPath, rootDir)
    if (fileCount > 0 && symbolCount === 0) {
      return {
        name: 'Symbols',
        status: 'warn',
        message: `${fileCount} file(s) indexed but 0 symbols extracted — the parser may not be running (check the worker log); try \`token-goat index --force\``,
      }
    }
    // An existing-but-empty index is not healthy, it is unindexed: every surgical-read command (symbol, read, skeleton, semantic) returns nothing, which reads as a real "not found" answer rather than as missing data. This is the failure mode a scratch/isolated TOKEN_GOAT_HOME hits, so say so instead of reporting 0 of everything as ok.
    if (fileCount === 0 && symbolCount === 0) {
      return {
        name: 'Symbols',
        status: 'warn',
        message: emptyIndexMessage(rootDir ?? process.cwd()),
      }
    }
    return {
      name: 'Symbols',
      status: 'ok',
      message: `${symbolCount} symbol(s) across ${fileCount} indexed file(s)`,
    }
  } catch (err) {
    return {
      name: 'Symbols',
      status: 'warn',
      message: `could not query symbol count: ${extractErrorMessage(err)}`,
    }
  }
}

/** Fraction of indexed files that must be reachable by vector search before embedding coverage is reported as healthy. Set low deliberately: some files never embed by design (over `indexing.large_file_symbol_only_kb`, .profile-meta.xml, oversized Salesforce metadata, documents with no extractable text), so a perfectly healthy index is not at 100% and a strict threshold would warn forever on a correct install. A quarter is far enough below any normal install to mean something is systematically excluding files rather than a few skips landing. */
const EMBED_COVERAGE_WARN_FRACTION = 0.25

/** Why indexed files have no embeddings, counted with the indexer's own freshness gate under the current configuration. `owed` is the files whose stamp that gate rejects, which the worker puts back on its queue while idle (see requeueStaleEmbeddings in worker.ts): a NULL stamp left by a worker stopped with embeds still queued, or a stamp the configuration has since overtaken. `overSizeCap` is the files over indexing.large_file_symbol_only_kb, indexed for symbols only on purpose. Temp-dir files are counted in neither, because nothing ever embeds them. On the live index these differed by two orders of magnitude, 25,840 owed against 202 over the cap in one project, which is why the warning names each separately instead of calling the cap the usual reason. */
export function unembeddedReasons(dbPath: string, rootDir: string | undefined, symbolOnlyKb: number, maxChunks: number): { owed: number; overSizeCap: number } {
  const db = getDb(dbPath)
  const scope = rootDir === undefined ? null : projectScopeClause('path')
  const rows = db
    .prepare(`SELECT path, sha, embed_sha FROM files${scope === null ? '' : ` WHERE ${scope.clause}`}`)
    .all(...(scope === null || rootDir === undefined ? [] : scope.params(rootDir))) as Array<{ path: string; sha: string; embed_sha: string | null }>
  let owed = 0
  let overSizeCap = 0
  for (const row of rows) {
    if (isUnderSystemTemp(row.path)) continue
    if (row.embed_sha === oversizeEmbedSha(row.sha, symbolOnlyKb)) overSizeCap += 1
    else if (!isEmbedFresh(row.embed_sha ?? undefined, row.sha, true, true, symbolOnlyKb, maxChunks)) owed += 1
  }
  return { owed, overSizeCap }
}

function unembeddedReasonText(reasons: { owed: number; overSizeCap: number }, sizeKb: number): string {
  let text = ''
  if (reasons.owed > 0) {
    text += ` ${countNoun(reasons.owed, 'file')} ${reasons.owed === 1 ? 'is' : 'are'} still owed an embed: the worker embeds them while it is idle, or run \`token-goat index\` in the project to embed them now.`
  }
  if (reasons.overSizeCap > 0) {
    text +=
      ` ${countNoun(reasons.overSizeCap, 'file')} ${reasons.overSizeCap === 1 ? 'is' : 'are'} over indexing.large_file_symbol_only_kb (currently ${sizeKb} KB) and indexed for symbols only; ` +
      `raise it with \`token-goat config set indexing.large_file_symbol_only_kb <KB>\` and the next \`token-goat index\` embeds them.`
  }
  return text
}

/** Check that `semantic` can actually see the corpus, not just that the corpus was parsed. The symbol side has had `checkSymbolCount` for exactly this reason; the embedding side had nothing, and the two fail independently. Every terminal skip in indexFileEmbeddings (parser.ts) stamps a real embed_sha so the worker stops re-reading the file -- correct individually, and it also means a skipped file is indistinguishable from an embedded one at the freshness gate and will never be retried. Nothing summed those skips, so an index where almost nothing embedded looked identical to a healthy one, and `semantic` answered from the remainder using the same "no matches" wording it uses after searching everything. That is the failure this reports. A low number here is not automatically a defect -- it is usually a threshold doing its job -- so the message names `indexing.large_file_symbol_only_kb` and its current value rather than asserting a cause, because that setting is the dominant reason files land in the skip branches and is the one the reader can act on. */
export function checkEmbeddingCoverage(dbPath: string, rootDir?: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Embedding coverage', status: 'ok', message: 'no database yet' }
  }
  const cfg = loadConfig()
  if (!cfg.indexing.embeddings_enabled) {
    // Off on purpose is not a health problem, and warning about it would be a warning that can never clear while the setting stands.
    return { name: 'Embedding coverage', status: 'ok', message: 'disabled (indexing.embeddings_enabled = false)' }
  }
  try {
    const { indexedFiles, embeddedFiles } = getEmbeddingCoverage(dbPath, rootDir)
    if (indexedFiles === 0) {
      // An empty index is already reported by the Symbols check; saying it twice adds nothing.
      return { name: 'Embedding coverage', status: 'ok', message: 'no indexed files yet' }
    }
    const pct = Math.round((embeddedFiles / indexedFiles) * 100)
    const sizeKb = cfg.indexing.large_file_symbol_only_kb
    if (embeddedFiles / indexedFiles < EMBED_COVERAGE_WARN_FRACTION) {
      // Without the model nothing can be embedded, and the Embedding model check already warns about exactly that; a second warning here would count one fault twice.
      if (!modelFilesPresent()) {
        return { name: 'Embedding coverage', status: 'ok', message: `${embeddedFiles} of ${indexedFiles} indexed file(s) (${pct}%) have embeddings; model not installed, see Embedding model` }
      }
      return {
        name: 'Embedding coverage',
        status: 'warn',
        message:
          `only ${embeddedFiles} of ${indexedFiles} indexed file(s) (${pct}%) have embeddings, so 'semantic' searches ` +
          `those files only, and reports finding nothing in the same words it uses after searching everything.` +
          unembeddedReasonText(unembeddedReasons(dbPath, rootDir, sizeKb, cfg.indexing.max_chunks_per_file), sizeKb) +
          ` Exact symbol lookups are unaffected`,
      }
    }
    return {
      name: 'Embedding coverage',
      status: 'ok',
      message: `${embeddedFiles} of ${indexedFiles} indexed file(s) (${pct}%) have embeddings`,
    }
  } catch (err) {
    return {
      name: 'Embedding coverage',
      status: 'warn',
      message: `could not query embedding coverage: ${extractErrorMessage(err)}`,
    }
  }
}

/** Fraction of a project's indexed files that may predate the running parser before it is worth saying so. Not zero: a mismatch is self-healing (the next `index` or worker drain reparses the file), so a handful of rows behind after a fresh upgrade is the mechanism working, not a fault. Set at a quarter, matching the embedding-coverage fraction beside it, because both answer the same question -- has enough of this project silently dropped out of an index-backed feature that the feature's answers no longer describe the project. */
const PARSER_FRESHNESS_WARN_FRACTION = 0.25

/** How much of this project's index was written by the parser this build runs. The other two index checks ask whether rows exist and whether they are embedded. Neither can see a row that is present, embedded, and produced by a previous version of the extraction logic. Those rows are stale by every gate's own definition -- `token-goat index` reparses them, the worker reparses them, the read-hook body fold refuses to fold them -- and until something touches the file, the project keeps answering from the older extractor with nothing to say so. Measured on a real index before this check existed: 95.1% of one project's files. */
export function checkParserFreshness(dbPath: string, rootDir?: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Parser freshness', status: 'ok', message: 'no database yet' }
  }
  try {
    const { indexedFiles, currentFiles } = getParserFreshness(dbPath, parserFingerprintForLanguage, rootDir)
    if (indexedFiles === 0) {
      // Already reported by the Symbols check; saying it twice adds nothing.
      return { name: 'Parser freshness', status: 'ok', message: 'no indexed files yet' }
    }
    const stale = indexedFiles - currentFiles
    const pct = Math.round((stale / indexedFiles) * 100)
    if (currentFiles / indexedFiles < 1 - PARSER_FRESHNESS_WARN_FRACTION) {
      return {
        name: 'Parser freshness',
        status: 'warn',
        message:
          `${stale} of ${indexedFiles} indexed file(s) (${pct}%) were parsed by a different build of the ` +
          `extraction logic, so their symbols are whatever that build extracted — 'symbol', 'read', 'outline' and ` +
          `'skeleton' answer from those rows, and the read-hook body fold declines on them. Run \`token-goat index\` ` +
          `in this project to reparse them; --force is not needed, a parser mismatch reindexes on its own`,
      }
    }
    return {
      name: 'Parser freshness',
      status: 'ok',
      message: `${currentFiles} of ${indexedFiles} indexed file(s) match the running parser`,
    }
  } catch (err) {
    return {
      name: 'Parser freshness',
      status: 'warn',
      message: `could not query parser freshness: ${extractErrorMessage(err)}`,
    }
  }
}

/** Backlog size above which a nonzero dirty-queue is worth flagging even when the worker is running -- large enough that normal churn (a big rebase, a branch switch) never trips it, small enough to catch a genuinely stalled drain before every surgical-read command in the project is serving stale data. */
const DIRTY_QUEUE_BACKLOG_WARN_THRESHOLD = 500

/** Check the health of the dirty-reindex queue: how many files are pending, counted the way the worker drains them (deduplicated), and whether the backlog is large enough to suggest a stalled drain. Whether the worker is alive and still draining is isWorkerRunning's heartbeat lease, which the 'Worker' check reports too: a loop that stops completing drain cycles lets its lease lapse, so it reads as not running here rather than as a separate stuck state. */
export function checkDirtyQueueHealth(dataDir: string): DoctorResult {
  const pendingCount = getDirtyPathsFor(dataDir).length

  if (pendingCount > DIRTY_QUEUE_BACKLOG_WARN_THRESHOLD) {
    return {
      name: 'Dirty queue',
      status: 'warn',
      message: `${pendingCount} file(s) pending reindex -- the worker may be falling behind or stalled; check \`token-goat worker status\``,
    }
  }

  if (!isWorkerRunning(dataDir)) {
    return { name: 'Dirty queue', status: 'ok', message: `${pendingCount} file(s) pending (worker not running)` }
  }
  return { name: 'Dirty queue', status: 'ok', message: `${pendingCount} file(s) pending, worker actively draining` }
}
