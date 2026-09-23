/**
 * One-time-per-release sweep that deletes chunk rows an already-indexed file would no longer be
 * allowed to contribute.
 *
 * Why this exists at all. The embed-freshness gate compares a file's stored `files.embed_sha`
 * against its content, and every one of the rows this sweep targets was written by a build whose
 * gates admitted it, so every one of them carries a valid sha. From the gate's point of view they
 * are current, and a new gate shipped on its own changes nothing whatsoever for an index that
 * already exists -- on one real machine-wide index, 141,750 of 243,603 chunk rows (58%) were text
 * decoded out of JPEGs, fonts and generated data snapshots, and shipping the gates alone would have
 * left every one of them in place and searchable forever.
 *
 * Why not move EMBED_FINGERPRINT instead. That is the blunt version of this and it does work: it
 * marks every embedded file on the machine stale and re-embeds it. It was rejected on measurement.
 * Re-embedding that index costs roughly 45 minutes of model inference and purges every project's
 * vectors in the meantime, to reach the few hundred files whose verdict actually changed. This pass
 * reads no file content, runs no inference, and touches exactly the files whose verdict changed.
 *
 * Why keyed on version rather than on a content digest. A digest keyed on the gate sources is
 * EMBED_FINGERPRINT again, with the same cost. The version moves on every release, which is exactly
 * the granularity at which a gate can change, and it makes the pass self-maintaining: a later
 * release that adds an extension to NON_TEXT_ASSET_EXTENSIONS or lowers the chunk ceiling is
 * backfilled by this same pass with no new migration to write. Within a release the pass is
 * idempotent anyway -- the second run's SELECT matches nothing -- so the key is a cost guard, not a
 * correctness one.
 */
import { isNonTextAsset } from './asset_extensions.js'
import { pathEqClause } from './sql_path.js'
import type { SqliteDatabase } from './sqlite_driver.js'
import { foldPath } from './util.js'
import { VERSION } from './version.js'

/** Bookkeeping key holding the token-goat version whose sweep last completed. */
export const BACKFILL_META_KEY = 'unembeddable_chunks_pruned_version'

/**
 * Created here on demand rather than added to db.ts's SCHEMA_SQL, because the databases this pass
 * most needs to stamp are the ones written by older builds, and a ledger row is not worth a schema
 * version. `CREATE TABLE IF NOT EXISTS` is idempotent and costs one statement on the first sweep
 * only; every later call finds the table and short-circuits on the row inside it. Deliberately not
 * the `meta` table a very old build left behind in some databases: that table is not part of the
 * current schema and is absent from every database created since, so a stamp written there would
 * silently fail and the sweep would rescan a quarter-million-row table on every worker drain.
 */
function ensureLedger(db: SqliteDatabase): void {
  db.exec('CREATE TABLE IF NOT EXISTS index_migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

export interface BackfillResult {
  /** Files whose chunk rows were deleted. */
  files: number
  /** Chunk rows deleted. */
  chunks: number
  /** True when the sweep ran; false when this version had already swept this database. */
  ran: boolean
}

/**
 * Every distinct `file_path` in `chunks` the current gates would reject, with its chunk count.
 *
 * Exported so a caller can count without deleting, and so the test suite can assert the selection
 * directly rather than inferring it from what survived. Both predicates are applied here, in one
 * pass over a grouped scan, rather than as two SQL filters: the asset test is an extension lookup
 * that SQL cannot express against a set, and the chunk-count test is on the group's own size.
 */
export function selectUnembeddableChunkFiles(db: SqliteDatabase, maxChunksPerFile: number): Array<{ filePath: string; chunks: number }> {
  const rows = db.prepare('SELECT file_path AS filePath, COUNT(*) AS chunks FROM chunks GROUP BY file_path').all() as Array<{ filePath: string; chunks: number }>
  return rows.filter((r) => isNonTextAsset(r.filePath) || (maxChunksPerFile > 0 && r.chunks > maxChunksPerFile))
}

/**
 * The two `files.embed_sha` markers `indexFileEmbeddings` stamps for the verdicts this sweep
 * re-applies, injected for the same leaf reason `deleteForFile` is: both live in parser.ts, and an
 * import edge from here to there would drag the whole parser into this module's closure and risk a
 * cycle that only shows up in the built bundle. Callers pass `assetEmbedSha` and `maxChunksEmbedSha`.
 */
export interface EmbedSkipMarkers {
  asset: (sha: string) => string
  maxChunks: (sha: string, maxChunks: number) => string
}

/**
 * Delete the chunk rows (and their vectors) of every file the current gates would reject, once per
 * token-goat version per database, and restamp each one with the marker the live gate would have
 * given it.
 *
 * `deleteForFile` is the per-file delete primitive, injected rather than imported so this module
 * stays a leaf: importing embeddings.ts here would put this file in the embedding fingerprint's
 * import closure, which is the exact cost the whole design avoids. Callers pass
 * `deleteFileEmbeddings`.
 *
 * The restamp is the point of the pass as much as the delete is. Leaving the file's original bare
 * `embed_sha` in place -- which is what this did first -- makes `isEmbedFresh` return true on its
 * terminal `storedEmbedSha === sha` clause forever, which is precisely the
 * permanent-verdict-from-a-changed-condition failure ASSET_EMBED_SHA_PREFIX and
 * MAX_CHUNKS_EMBED_SHA_PREFIX exist to prevent: raising `indexing.max_chunks_per_file`, or dropping
 * an extension from NON_TEXT_ASSET_EXTENSIONS, re-opens the decision for every file the live gate
 * stamped and for none of the files this sweep pruned. Clearing the stamp to NULL would fix that
 * too but costs a re-read of every pruned file's bytes on the next drain to reach the same verdict;
 * stamping the threshold-bearing marker keeps the file settled AND re-examines it the moment the
 * condition it was refused under moves. Mirrors `indexFileEmbeddings`' own gate order, where the
 * asset test runs before anything counts chunks.
 *
 * The stamp carries `AND sha = ?` for the reason `stampEmbedSha` does: if the file's content moved
 * between the SELECT and the UPDATE, the row already belongs to a fresher writer and this one must
 * be a no-op rather than bury the new content under a verdict taken on the old.
 */
export function pruneUnembeddableChunks(
  db: SqliteDatabase,
  maxChunksPerFile: number,
  deleteForFile: (db: SqliteDatabase, filePath: string) => void,
  markers: EmbedSkipMarkers,
): BackfillResult {
  ensureLedger(db)
  const row = db.prepare('SELECT value FROM index_migrations WHERE key = ?').get(BACKFILL_META_KEY) as { value: string } | undefined
  if (row?.value === VERSION) return { files: 0, chunks: 0, ran: false }

  const targets = selectUnembeddableChunkFiles(db, maxChunksPerFile)
  const readSha = db.prepare(`SELECT sha FROM files WHERE ${pathEqClause('path')}`).pluck()
  const restamp = db.prepare(`UPDATE files SET embed_sha = ? WHERE ${pathEqClause('path')} AND sha = ?`)
  let chunks = 0
  for (const target of targets) {
    deleteForFile(db, target.filePath)
    chunks += target.chunks
    const folded = foldPath(target.filePath)
    // A chunk row whose file row is gone (or never carried a sha) has nothing to stamp against, and no gate will ever read it either. Deleting its chunks was the whole job.
    const sha = readSha.get(folded) as string | null | undefined
    if (typeof sha !== 'string' || sha === '') continue
    restamp.run(isNonTextAsset(target.filePath) ? markers.asset(sha) : markers.maxChunks(sha, maxChunksPerFile), folded, sha)
  }
  db.prepare('INSERT INTO index_migrations (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(BACKFILL_META_KEY, VERSION)
  return { files: targets.length, chunks, ran: true }
}
