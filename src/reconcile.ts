/** Catch-up reconciliation: detect index drift caused by edits token-goat never saw. Every existing freshness mechanism in this repo is driven by an in-session hook. The Edit hook enqueues what the agent edits (`hooks_edit.ts`); the Bash post-hook enqueues what head-moving git commands rewrite and what in-place shell rewrites touch (`hooks_bash_post.ts`); the per-file `staleWarning`/`healStaleIndex` pair in `read_commands.ts` reparses a file the moment a command names it. Between them, drift caused *during* a session is covered well. None of them can see drift that happened while no hook was running: a `git pull` in another terminal, an edit from an IDE or a second agent session, a codegen or build step invoked outside the harness, or a worker that exited with paths still queued. Nothing reconciles that on the way back in, and the commands most likely to be asked first -- `semantic`, `symbol` by name, `find`, `refs`, `callers`, `arch`, `dead` -- never name a file, so the per-file heal never fires for them. They answer from whatever rows exist, and a stale answer is indistinguishable from a correct one. This module closes that by sweeping the tracked-file set once and enqueueing anything whose on-disk content no longer matches its indexed fingerprint. It is deliberately cause-agnostic: rather than enumerate the ways drift can happen and add a detector per cause, it compares the two things that must agree and repairs the difference, so a cause nobody anticipated is covered by the same code. Cost discipline: `mtime` is checked first and the content hash is computed only for files whose mtime moved, so the steady-state cost is one `stat` per tracked file and zero reads. A file whose mtime moved but whose content did not (the common `git checkout` round-trip) costs one read and is correctly left alone. The whole sweep is bounded by a wall-clock budget and never throws, because its main caller is a session-start hook. */
import * as fs from 'node:fs'

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { enqueueDirtyPathsSafe } from './hooks_index.js'
import { fingerprintFile, statIndexedFile } from './fingerprint.js'
import { getProjectFileEntries } from './index_reader.js'
import { normalizePath, resolveIndexPath, toDisplayPath, displaySafeJson } from './paths.js'
import { indexedPathSpellingIsStale } from './parser.js'
import { parserFingerprintForLanguage } from './parser_stamp.js'
import type { FileIndexEntry } from './parser_types.js'
import { getDisplayRoot } from './project.js'
import { listTrackedFiles } from './repomap.js'
import { projectScopeClause } from './sql_path.js'
import { countNoun, foldPath } from './util.js'

/** Wall-clock budget for a sweep. Chosen so the session-start hook stays imperceptible even on a cold filesystem cache: this repo's own measurement is that hook cost is dominated by process startup rather than logic, and a sweep that pushed past that would turn a correctness improvement into a latency regression on every single session. */
export const DEFAULT_RECONCILE_BUDGET_MS = 1500

/** Files, and then index rows, a sweep examines before its budget may stop it, so every sweep advances both resume points whatever the clock says. */
const MIN_FILES_PER_SWEEP = 1

/** The coarsest timestamp tick the racy-clean gate guards against, in seconds: the FAT 2 s and HFS+ 1 s resolutions the bug report named (filesystem timestamp resolutions not verified against filesystem documentation). */
const TIMESTAMP_TICK_SEC = 2

/** Does an equal mtime prove the file unchanged since its row was written? Only when that mtime is older than the row's indexed_at by at least one timestamp tick (both seconds): a file edited after indexing but inside the tick its recorded mtime was stamped in gets the same stamp while its bytes differ, so equality alone hides that edit forever, and a stamp truncated down to the tick can sit below indexed_at yet still cover the edit. Git's racy-clean rule, https://git-scm.com/docs/racy-git (read at its "racy-git last updated in 2.43.0" revision): an entry whose mtime is the same as or newer than the index timestamp is verified by content. An ambiguous file, a row with no indexed_at included, falls through to the hash compare, so only those files cost a read. */
function mtimeProvesUnchanged(entry: FileIndexEntry, diskMtimeMs: number): boolean {
  return mtimeEqualsRow(entry, diskMtimeMs) && entry.mtime + TIMESTAMP_TICK_SEC <= entry.indexedAt
}

/** Is the disk mtime the one the row recorded? A file that passes this but not {@link mtimeProvesUnchanged} is verified by content and, when the bytes match, is not a moved-timestamp file, so it must not be counted as one. */
function mtimeEqualsRow(entry: FileIndexEntry, diskMtimeMs: number): boolean {
  return entry.mtime !== 0 && diskMtimeMs / 1000 === entry.mtime
}

interface VerifiedUnchangedFile {
  /** The `files.path` key of the row, as the index spelled it. */
  readonly indexedPath: string
  /** The sha the hash computed, and the row must still hold for the write to land. */
  readonly sha: string
  /** The `files.mtime` the row holds now, in seconds. */
  readonly rowMtime: number
  /** The file's mtime in seconds, read by a stat taken BEFORE the bytes were hashed, so it is the stamp the hashed bytes carried; a stat after the hash could record the stamp of a later edit against the old bytes. */
  readonly statMtimeSec: number
}

/** Record that the bytes behind each file's `sha` carried its `statMtimeSec`, in one transaction under one clock read (a caller on a mocked or budgeted clock reads it once, not once per file). When that mtime is at least one tick older than `nowSec`, `mtime` and `indexed_at = now` are written together, so the row satisfies the racy-clean rule from the next sweep on. A newer mtime is not stamped with an index time: the file may still be mid-write, so it stays racy and is hashed again until it ages past the tick (only a moved mtime is recorded, as the pre-read probe's equality gate needs). Guarded on the sha, so a row rewritten since keeps its stamp. Best-effort: a database error leaves the rows as they were. */
export function restampVerifiedUnchanged(dbPath: string, files: readonly VerifiedUnchangedFile[], nowSec: number = Date.now() / 1000): void {
  try {
    const db = getDb(dbPath)
    const stampBoth = db.prepare('UPDATE files SET mtime = ?, indexed_at = ? WHERE path = ? AND sha = ?')
    const stampMtime = db.prepare('UPDATE files SET mtime = ? WHERE path = ? AND sha = ?')
    db.transaction(() => {
      for (const file of files) {
        if (file.statMtimeSec + TIMESTAMP_TICK_SEC <= nowSec) stampBoth.run(file.statMtimeSec, nowSec, file.indexedPath, file.sha)
        else if (file.statMtimeSec !== file.rowMtime) stampMtime.run(file.statMtimeSec, file.indexedPath, file.sha)
      }
    })()
  } catch {
    // Best-effort: the next drain or sweep tries again.
  }
}

export interface ReconcileOptions {
  cwd?: string
  /** Wall-clock budget for examining files, counted from once the tracked list and index rows are in hand. Defaults to {@link DEFAULT_RECONCILE_BUDGET_MS}. */
  budgetMs?: number
  /** Compute the drift set without enqueueing it. */
  dryRun?: boolean
  /** Index database to read/write. Defaults to {@link globalDbPath}; overridable for tests so a sweep can be run against an isolated database instead of the process-memoized default. */
  dbPath?: string
  /** Data directory whose dirty queue receives the drifted files. Defaults to the process's data directory; the worker passes the directory it drains. */
  queueDir?: string
}

/** Reads the resume point left by a previous budget-truncated sweep of `root`, or null when there is none (fresh project, a completed lap already cleared it, or the row cannot be read). Never throws: a corrupt or unreadable cursor degrades to "start from the beginning", not a crash. */
function readReconcileCursor(dbPath: string, root: string): string | null {
  try {
    const row = getDb(dbPath).prepare('SELECT last_scanned_path FROM reconcile_cursor WHERE root = ?').get(root) as { last_scanned_path: string } | undefined
    return row?.last_scanned_path ?? null
  } catch {
    return null
  }
}

/** Persists the last file this sweep finished examining before its budget ran out, so the next sweep resumes right after it. Best-effort: a write failure just means the next sweep starts from the beginning again, never a thrown error. */
function writeReconcileCursor(dbPath: string, root: string, lastScannedPath: string): void {
  try {
    getDb(dbPath)
      .prepare(
        'INSERT INTO reconcile_cursor (root, last_scanned_path, updated_at) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET last_scanned_path = excluded.last_scanned_path, updated_at = excluded.updated_at',
      )
      .run(root, lastScannedPath, Date.now())
  } catch {
    // Best-effort persistence: see the doc comment above.
  }
}

/** Clears the resume point once a sweep completes a full lap without running out of budget, so the next sweep naturally starts from the beginning of a fresh lap rather than an offset that no longer means anything. */
function clearReconcileCursor(dbPath: string, root: string): void {
  try {
    getDb(dbPath).prepare('DELETE FROM reconcile_cursor WHERE root = ?').run(root)
  } catch {
    // Best-effort persistence: see readReconcileCursor's doc comment.
  }
}

export interface ReconcileResult {
  /** Tracked files examined before the budget ran out. */
  scanned: number
  /** Indexed files whose content no longer matches disk: tracked files from the scan, plus untracked rows the deletion pass found still on disk but changed. */
  changed: string[]
  /** Tracked files with no row in the index at all. */
  added: string[]
  /** Indexed files that are no longer tracked on disk. */
  removed: string[]
  /** Files whose mtime moved but whose content did not: measured, not estimated. */
  mtimeOnly: number
  /** Tracked files (a subset of {@link changed}) enqueued purely because their rows carry a `parser_sha` other than the one a current parse of their own language would write (see {@link parserFingerprintForLanguage}) -- content on disk never moved, but the extractor that produced their symbol/ref rows did. Reported separately from the rest of `changed` because it is the one bucket a content-only diff (`diskSha !== entry.sha`) could never have found on its own. */
  parserStale: number
  /** Tracked files (a subset of {@link changed}) enqueued because they still hold embedding chunks but no `embed_sha`: ensureEmbeddingProvenance clears it after a chunker change while keeping the old vectors serving, so content and parse are both current and only this enqueue gets a file nobody edits re-embedded. */
  embedStale: number
  /** True when the budget stopped the sweep before every tracked file was examined, or before every indexed row git does not list was checked against disk. */
  budgetExhausted: boolean
  /** True when the budget stopped the deletion pass before every untracked indexed row was checked; the next sweep resumes after the last row it examined. */
  deletionsIncomplete: boolean
  /** True when the tracked-file enumeration came back empty against a non-empty index -- the project is not a git repository, git is missing, or git errored. Distinguished from a genuinely emptied project because the two are identical in the numbers and opposite in what they mean. */
  trackedUnavailable: boolean
  /** True when `git ls-files` was killed for running too long, so what the project tracks is unknown rather than empty. The sweep then checks only what the index already holds; a caller that must not act on a listing it never got (install marking the root indexed) reads this. */
  gitTimedOut: boolean
  /** Tracked files never examined because the budget ran out. */
  unscanned: number
  /** Paths that reached the dirty queue (0 when `dryRun`). Fewer than changed + added + removed when the queue refused some: it takes nothing under the OS temp dir, and nothing at all when it cannot be written. */
  enqueued: number
  /** The wall-clock budget this sweep ran under, in milliseconds: the one passed in, or the default. */
  budgetMs: number
  /** Time from the call to its return, including the git listing that comes before the budget starts counting. */
  elapsedMs: number
}

export interface RunReconcileOptions {
  cwd?: string
  budgetMs?: number
  dryRun?: boolean
  json?: boolean
}

/** CLI entrypoint for `token-goat reconcile`. Returns the process exit code. Exit code is 0 whether or not drift was found: finding drift is this command succeeding, not failing, and a nonzero code would break `token-goat reconcile && <next step>` on exactly the runs where the reconciliation did its job. */
export function runReconcile(opts: RunReconcileOptions = {}): number {
  const raw = reconcileProject(opts)

  // Absolute paths are what the queue needs and what `reconcileProject` therefore works in; they are not what a person reading a drift report needs. Converted here, at the presentation seam, so the mechanism keeps the only form the worker can match.
  const root = getDisplayRoot(opts.cwd ?? process.cwd())
  const display = (paths: string[]): string[] => paths.map((p) => toDisplayPath(root, p)).sort()
  const result = {
    ...raw,
    changed: display(raw.changed),
    added: display(raw.added),
    removed: display(raw.removed),
  }

  if (opts.json === true) {
    process.stdout.write(`${displaySafeJson(result)}\n`)
    return 0
  }

  // Worded from what the queue took, not from what the sweep found: the queue refuses every path under the OS temp dir, and a report that called those files queued promised a reindex no worker would run.
  const unqueued = opts.dryRun === true ? 0 : result.changed.length + result.added.length + result.removed.length - result.enqueued
  const noneQueued = unqueued > 0 && result.enqueued === 0
  const lines: string[] = []
  if (isReconcileClean(result)) {
    // Not claimed when the enumeration failed: an empty drift set there means nothing was compared, and "Index matches disk" over zero comparisons is the confident wrong answer this whole command exists to avoid. The disclosure below carries that case instead.
    if (!result.trackedUnavailable && !result.gitTimedOut) {
      lines.push(`Index matches disk: ${countNoun(result.scanned, 'file')} checked in ${result.elapsedMs}ms.`)
    }
  } else {
    const verb = opts.dryRun === true ? 'would reindex' : noneQueued ? 'not queued' : 'queued for reindexing'
    // Deletions get their own verb. The shared one is accurate for the other two kinds and wrong here -- "indexed but gone from disk (queued for reindexing)" describes reparsing a file that no longer exists, which is the opposite of what the queue does with it.
    const dropVerb = opts.dryRun === true ? 'would drop from the index' : noneQueued ? 'not queued' : 'queued for removal'
    if (result.changed.length > 0) lines.push(`${countNoun(result.changed.length, 'file')} changed since indexing (${verb}):`)
    for (const f of result.changed) lines.push(`  ~ ${f}`)
    if (result.added.length > 0) lines.push(`${countNoun(result.added.length, 'file')} not in the index (${verb}):`)
    for (const f of result.added) lines.push(`  + ${f}`)
    if (result.removed.length > 0) lines.push(`${countNoun(result.removed.length, 'file')} indexed but gone from disk (${dropVerb}):`)
    for (const f of result.removed) lines.push(`  - ${f}`)
    lines.push(`Checked ${countNoun(result.scanned, 'file')} in ${result.elapsedMs}ms.`)
  }
  // Both disclosures print in every mode, clean or not. A sweep that ran out of time found the drift it had time to find, and "Index matches disk" over a partial scan is the exact shape of confident-wrong-answer this codebase treats as a defect rather than a rough edge.
  if (result.mtimeOnly > 0) {
    lines.push(`${countNoun(result.mtimeOnly, 'file')} had a newer timestamp but identical content, so ${result.mtimeOnly === 1 ? 'it was' : 'they were'} left alone.`)
  }
  if (result.parserStale > 0) {
    const reparseVerb = opts.dryRun === true ? 'would reparse' : noneQueued ? 'not queued' : 'queued for reparse'
    lines.push(`${countNoun(result.parserStale, 'file')} of the above ${result.parserStale === 1 ? 'was' : 'were'} unchanged on disk but indexed by an older parser (${reparseVerb}).`)
  }
  if (result.embedStale > 0) {
    const reembedVerb = opts.dryRun === true ? 'would re-embed' : noneQueued ? 'not queued' : 'queued for re-embedding'
    lines.push(`${countNoun(result.embedStale, 'file')} of the above ${result.embedStale === 1 ? 'was' : 'were'} unchanged on disk but held out-of-date embeddings (${reembedVerb}).`)
  }
  if (unqueued > 0) {
    lines.push(`${countNoun(unqueued, 'file')} of the above could not be queued for reindexing: the queue takes nothing under the OS temp dir, and nothing at all when it cannot be written. Run token-goat index here to bring the index up to date.`)
  }
  if (result.gitTimedOut) {
    lines.push('git did not answer in time while listing the tracked files, so new files could not be found. Indexed files that changed or are gone from disk were still detected. Run token-goat reconcile again once git responds.')
  } else if (result.trackedUnavailable) {
    lines.push('This project has an index but git listed no files in it, so new files could not be found. Indexed files that changed or are gone from disk were still detected. Run token-goat inside the repository, or reindex with --walk if this directory is deliberately not under git.')
  }
  if (result.budgetExhausted) {
    lines.push(`Stopped at the ${result.budgetMs}ms budget (${result.elapsedMs}ms elapsed) with ${uncheckedClauses(result).join(' and ')}, so there may be more drift; what it found is listed above and the next sweep continues where this one stopped. Raise --budget-ms for a complete sweep.`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/** What a budget-stopped sweep left unchecked, worded once for `reconcile` and the session-start note: a sweep that finished its file scan but ran out of time in the deletion pass has 0 files unscanned, and "0 files unchecked" would contradict the deletion half it still owes. */
export function uncheckedClauses(result: ReconcileResult): string[] {
  return [
    ...(result.unscanned > 0 ? [`${countNoun(result.unscanned, 'file')} unchecked`] : []),
    ...(result.deletionsIncomplete ? ['some indexed files not yet checked for deletion'] : []),
  ]
}

/** True when this result found nothing to repair -- the whole point of the common case. */
export function isReconcileClean(r: ReconcileResult): boolean {
  return r.changed.length === 0 && r.added.length === 0 && r.removed.length === 0
}

/** Sweep `cwd`'s tracked files against the index and enqueue whatever drifted. Deletions are enqueued rather than handled separately: the worker's drain reconciles a deletion when the removed path is the one enqueued, so one queue and one drainer cover all three drift kinds instead of a second removal path that could disagree with the first. */
export function reconcileProject(opts: ReconcileOptions = {}): ReconcileResult {
  const cwd = opts.cwd ?? process.cwd()
  const budgetMs = opts.budgetMs ?? DEFAULT_RECONCILE_BUDGET_MS
  const calledAt = Date.now()
  const dbPath = opts.dbPath ?? globalDbPath()

  const listing = listTrackedFiles(cwd)
  const tracked = listing.files
  // Absolutized before scoping: the index stores absolute paths, and `projectScopeClause` builds a prefix-range bound straight from the root it is handed. A relative `cwd` -- what `token-goat reconcile` from inside the project passes -- would produce a relative prefix that matches no stored row, so every tracked file would look unindexed and the sweep would enqueue the entire project as "added" on every run.
  const projectRoot = resolveIndexPath('.', cwd)
  const indexed = getProjectFileEntries(projectRoot, dbPath)
  const chunkScope = projectScopeClause('file_path')
  const chunked = new Set(
    (getDb(dbPath).prepare(`SELECT DISTINCT file_path FROM chunks WHERE ${chunkScope.clause}`).pluck().all(...chunkScope.params(projectRoot)) as string[]).map((p) => foldPath(normalizePath(p))),
  )
  // The budget starts here, after `git ls-files` and the index reads, because it bounds the examining and nothing earlier: the setup runs whatever the budget says, so charging it only shrinks the scan. When setup alone outran the budget, the sweep examined nothing and saved no resume point, so the next session repeated the same empty sweep and the project was never checked at all.
  const startedAt = Date.now()

  // Resume where the previous budget-truncated sweep of this project left off, instead of rescanning the same deterministic `git ls-files` prefix every session forever and never reaching whatever comes after it. Matched by folded/normalized path rather than by array index, because the tracked-file list can change shape between sessions (a file added, removed, or renamed shifts every index after it); a cursor that no longer matches anything just is not found, and the sweep falls back to starting from the beginning -- never an out-of-bounds read, never a crash. `scanOrder` is always a full permutation of `tracked` (same elements, same count, only reordered), so a lap that completes without exhausting the budget still visits every tracked file exactly once, which is what the deletion logic below depends on.
  let scanOrder = tracked
  const cursorPath = tracked.length > 0 ? readReconcileCursor(dbPath, projectRoot) : null
  if (cursorPath !== null) {
    const cursorFolded = foldPath(normalizePath(cursorPath))
    const cursorIdx = tracked.findIndex((f) => foldPath(normalizePath(f)) === cursorFolded)
    if (cursorIdx !== -1) {
      scanOrder = [...tracked.slice(cursorIdx + 1), ...tracked.slice(0, cursorIdx + 1)]
    }
  }

  const changed: string[] = []
  const added: string[] = []
  // Every tracked path, not only the scanned ones: a sweep the budget cut short has still not seen the rest of the listing, and a row for one of them is tracked, not a deletion candidate.
  const seenOnDisk = new Set<string>(tracked.map((file) => foldPath(normalizePath(file))))
  // Files whose hash matched their row, with the mtime stat taken before that hash; recorded after both passes so the clock is read once, outside the budget checks.
  const verifiedClean: VerifiedUnchangedFile[] = []
  let mtimeOnly = 0
  let parserStale = 0
  let embedStale = 0
  let scanned = 0
  let scanExhausted = false
  let deletionsIncomplete = false
  let lastScanned: string | null = null

  for (const file of scanOrder) {
    // Checked before the work rather than after, so the budget bounds what this function does rather than merely reporting that it overran, and the check is a clock read that hoisting out of the loop would remove. Not before the first file: a sweep that may stop having examined nothing saves no resume point, so a machine slow enough to spend the budget before the first stat (or a budget of 0) repeated the same empty sweep every session and never checked the project. One file is the floor, so the cursor advances every sweep and the laps complete; it is a count, not a time, and the budget still bounds everything after it.
    const overBudget = Date.now() - startedAt >= budgetMs
    if (overBudget && scanned >= MIN_FILES_PER_SWEEP) {
      scanExhausted = true
      break
    }
    scanned++
    lastScanned = file
    const normalized = normalizePath(file)
    const folded = foldPath(normalized)
    const entry = indexed.get(folded)

    if (entry === undefined) {
      added.push(file)
      continue
    }

    // Checked before the mtime shortcut below, and unconditionally: a parser upgrade changes what gets extracted from content that never moved, so the mtime/content diff below -- which only ever compares this file's bytes against themselves -- can never notice it. Without this, a file nobody edits after a parser bump keeps the old parser's rows forever (this is the same failure shape files.parser_sha exists to close on the per-file gates in worker.ts/cli.ts; reconcileProject is the sweep that is supposed to find drift nothing edited, so it is the one place a content-only key silently misses this bucket entirely). An empty parserSha is a row written before the column existed and is correctly stale, same as the per-file gates. The expected stamp is the one for the language the row itself records, so a fix to one adapter sweeps that language's files back into the queue and leaves every other language's rows alone.
    if (entry.parserSha !== parserFingerprintForLanguage(entry.language)) {
      changed.push(file)
      parserStale++
      continue
    }

    // Same shape one freshness key over: chunks with no embed_sha are vectors ensureEmbeddingProvenance kept serving after a chunker change (or that a reparse left behind older content), and the content checks below compare bytes that never moved, so without this a file nobody edits keeps its old chunks forever.
    if (entry.embedSha === '' && chunked.has(folded)) {
      changed.push(file)
      embedStale++
      continue
    }

    // A case-only rename leaves the bytes as they were, and `git mv` leaves the mtime too, so the checks below pass and the row keeps a spelling the file no longer has, which nothing else revisits: the drain and `token-goat index` correct it only for a file that reaches them. git spelling the path differently from the row is the cheap signal, compared below the project root so that a working directory typed in another case than the one the index was built from does not send the whole project back through the drain. The filesystem decides, as it does for those two (see indexedPathSpellingIsStale), because git keeps the old name until a rename is staged.
    if (normalizePath(entry.filePath).slice(projectRoot.length) !== normalized.slice(projectRoot.length) && indexedPathSpellingIsStale(entry.filePath, file)) {
      changed.push(file)
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      // Vanished between `listTrackedFiles` and now, or unreadable. Treat as drift rather than silently skipping: enqueueing it lets the worker's own read decide, and a genuinely missing file is reconciled as a deletion there.
      changed.push(file)
      continue
    }

    // The cheap gate. An unchanged mtime means an unchanged file for every writer that does not deliberately forge timestamps, so the overwhelming majority of files cost one stat and nothing else. A moved mtime is only a *suspicion* of change -- confirmed by content below, never assumed -- because `git checkout` rewrites mtimes wholesale and treating that as drift would enqueue the entire repository on every branch switch. `entry.mtime` is stored in seconds (see `safeMtime` in parser.ts) while `mtimeMs` is milliseconds, so the comparison converts here rather than at the write side, which would require migrating every already-indexed row.
    if (mtimeProvesUnchanged(entry, mtimeMs)) continue

    const diskSha = fingerprintFile(file)
    if (diskSha === null) {
      changed.push(file)
      continue
    }
    if (diskSha === entry.sha) {
      if (!mtimeEqualsRow(entry, mtimeMs)) mtimeOnly++
      // The hash proved the bytes unchanged, so it is recorded once the sweep ends: without that a file indexed inside the tick of its own edit, or one whose mtime moved over identical bytes, is hashed again on every sweep. The stat above is the one taken before the hash.
      verifiedClean.push({ indexedPath: entry.filePath, sha: entry.sha, rowMtime: entry.mtime, statMtimeSec: mtimeMs / 1000 })
      continue
    }
    changed.push(file)
  }

  // Reported, not gated on: `listTrackedFiles` returns an empty `files` list for a directory git cannot enumerate -- not a repository, git not installed, git errored -- so `changed`/`added` are computed over nothing and the caller must be told. It used to suppress the deletion pass below as well, from when that pass inferred a deletion from absence from `seenOnDisk` and would therefore have called every live file in a non-git project deleted. The pass now stats each row instead, so absence from a failed enumeration cannot reach `removed` at all, and suppressing it only left deleted files sitting in the index of every non-git root forever.
  const trackedUnavailable = tracked.length === 0 && indexed.size > 0
  const removed: string[] = []
  // Sorted so a resume point means the same thing on every sweep: the index map's order is whatever the query returned.
  const deletionCandidates = [...indexed].filter(([folded]) => !seenOnDisk.has(folded)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const deletionKey = `${projectRoot}\u0000deletions`
  const deletionCursor = deletionCandidates.length > 0 ? readReconcileCursor(dbPath, deletionKey) : null
  let lastExamined: string | null = null
  if (deletionCandidates.length > 0) {
    // Resume after the row the last budget-truncated pass finished, wrapping, so repeated truncated sweeps reach every row instead of re-statting the same first few.
    const resumeAt = deletionCursor === null ? -1 : deletionCandidates.findIndex(([folded]) => folded > deletionCursor)
    const order = resumeAt > 0 ? [...deletionCandidates.slice(resumeAt), ...deletionCandidates.slice(0, resumeAt)] : deletionCandidates
    let examined = 0
    for (const [folded, entry] of order) {
      // The scan loop costs one map lookup per row; this one costs a disk stat, so it needs the same clock. Read before the stat so a row that is still on disk, which exits early, cannot let the contents of the index decide whether the bound is consulted. Not before the first row: a pass that may stop having examined nothing saves no resume point, so a machine that spent the budget in the scan (or a budget of 0) never reached a deletion. Deletions already found stay reported, since each was confirmed by its own stat.
      const overBudget = Date.now() - startedAt >= budgetMs
      if (overBudget && examined >= MIN_FILES_PER_SWEEP) {
        deletionsIncomplete = true
        break
      }
      examined++
      lastExamined = folded
      // The stat is the whole check. `seenOnDisk` is filled from `git ls-files`, so on its own it says "not tracked", which is a different question from "not on disk" for every row the incremental path wrote: `token-goat index` lists tracked files only, but a file reaches the index whenever the agent reads or edits it, gitignored or merely not `git add`ed yet. Measured on this repository's own index, 228 of its 1,628 rows were untracked and all 228 were live on disk -- 201 under `scratch/`, 12 under `.claude/`, 5 under `node_modules/`, the rest loose files nobody had staged. Without this stat each sweep reported all of them as deletions and queued them for removal, the next read put them straight back, and the next sweep removed them again -- churn that never settles, and precisely the live-file removal the paragraph above calls the one mistake that destroys working index rows. Only a missing path (ENOENT/ENOTDIR) or one that is no longer a regular file, such as a directory now standing where the file was, counts as a deletion (indexedFileIsGone, the rule the prune sweeps use); every other failure means "cannot tell", and a row nobody can stat is left exactly as it is. The stat above answers the deletion question for every row in the index now that nothing else bounds this pass -- in a root git cannot enumerate that is 100% of rows, where it used to be only the untracked ones inside a repo (228 of 1,628 here). So a permission-denied path, or an unreachable network or removable drive, would otherwise hand the whole root's index to the removal queue on a single sweep, which is the one outcome this pass must never produce.
      const st = statIndexedFile(entry.filePath)
      if (st === 'gone') {
        removed.push(entry.filePath)
        continue
      }
      // A live row git does not list is still compared against its content, as the scan above compares a tracked one: nothing else revisits an untracked file rewritten outside an edit, such as one a formatter or `git stash pop` changed past the post-bash sweep's cap.
      if (st === null || mtimeProvesUnchanged(entry, st.mtimeMs)) continue
      const diskSha = fingerprintFile(entry.filePath)
      if (diskSha === entry.sha) {
        if (!mtimeEqualsRow(entry, st.mtimeMs)) mtimeOnly++
        // Same proof, same record as the scan above; `st` was read before the hash.
        verifiedClean.push({ indexedPath: entry.filePath, sha: entry.sha, rowMtime: entry.mtime, statMtimeSec: st.mtimeMs / 1000 })
      } else if (diskSha !== null) changed.push(entry.filePath)
    }
  }

  const budgetExhausted = scanExhausted || deletionsIncomplete

  // A dry run writes nothing, as it writes no resume point.
  if (opts.dryRun !== true && verifiedClean.length > 0) restampVerifiedUnchanged(dbPath, verifiedClean)

  let enqueued = 0
  if (opts.dryRun !== true) {
    // Resolved here rather than passed raw: `listTrackedFiles` returns paths joined onto the root it was given, so a relative `cwd` (the natural `token-goat reconcile` from inside the project) yields relative paths, and the worker's sha gate keys on the canonical absolute form. An unresolved relative path enqueues a key no reader can match -- the queue would fill and nothing would ever reindex. Paths from the index are already canonical, so resolving them is a no-op.
    const toEnqueue = [...changed, ...added, ...removed].map((p) => resolveIndexPath(p, cwd))
    // Batched rather than enqueued one at a time: a sweep routinely fans out four figures of paths at session start, and the single-path form appends each one separately. The count is what the queue took, not what it was offered: it refuses every path under the OS temp dir, and a project there reported files enqueued that no worker would ever see.
    enqueued = enqueueDirtyPathsSafe(toEnqueue, { alreadyResolved: true, ...(opts.queueDir !== undefined ? { dir: opts.queueDir } : {}) })
    // Cursor upkeep, gated the same as enqueueing above: `--dry-run` reports drift without any side effect, and persisting a resume point is a side effect. A truncated sweep that scanned at least one file saves where it stopped, so the next sweep resumes there; a sweep with nothing scanned (an empty tracked list, since the budget cannot stop a sweep before its first file) leaves whatever cursor already exists untouched rather than clobbering it with nothing. A sweep that completed a full lap clears the cursor, since the next sweep should start a fresh lap from the beginning rather than carry forward an offset a completed lap has made meaningless.
    if (scanExhausted) {
      if (lastScanned !== null) writeReconcileCursor(dbPath, projectRoot, lastScanned)
    } else if (tracked.length > 0) {
      clearReconcileCursor(dbPath, projectRoot)
    }
    // The deletion pass keeps its own resume point under a second key in the same table (a NUL cannot appear in a path, so it cannot collide with a root): the table shape is unchanged and a build that never reads the key ignores the row.
    if (deletionsIncomplete) {
      if (lastExamined !== null) writeReconcileCursor(dbPath, deletionKey, lastExamined)
    } else if (deletionCursor !== null) {
      clearReconcileCursor(dbPath, deletionKey)
    }
  }

  return {
    scanned,
    changed,
    added,
    removed,
    mtimeOnly,
    parserStale,
    embedStale,
    budgetExhausted,
    deletionsIncomplete,
    trackedUnavailable,
    gitTimedOut: listing.timedOut,
    unscanned: Math.max(0, tracked.length - scanned),
    enqueued,
    budgetMs,
    elapsedMs: Date.now() - calledAt,
  }
}
