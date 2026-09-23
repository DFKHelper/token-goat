// Known-root registry: the WRITE half of the auto-prune machinery. `sweepKnownRoots` in
// index_prune.ts consumes what this module records, and the two live apart because of their
// dependencies rather than their subject matter: the sweep deletes index rows and so imports
// parser.ts, while recording a root needs nothing but path and project resolution. Keeping the
// writer here is what lets parser.ts call it from indexFileSync -- importing index_prune.ts
// there would close a parser -> index_prune -> parser cycle, which this repo has already shipped
// once as a bundle that typecheck and the suite both passed and the built artifact broke on.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir, globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { shortFingerprint } from './fingerprint.js'
import { findProject } from './project.js'
import { ensureDirSync, normalizePath } from './util.js'

// A drive root (`c:/`) or empty prefix would scope the prune to an entire drive across every project in the shared global DB; refuse it so a malformed root can never mass-delete another project's rows.
export function isTooShallowToPrune(rootPrefix: string): boolean {
  // Normalize FIRST. The scan this guards (foldedBounds) normalizes before it matches rows, so a
  // guard reading the raw spelling is answering about a different string than the one that gets
  // scanned. `C:\` splits into a single segment that looks like an ordinary directory name, passes,
  // and only then normalizes to `c:/` and prefix-matches every row on the drive. Both spellings the
  // guard was written against -- `c:/` and `C:` -- were rejected correctly, which is exactly what
  // kept the gap invisible: it covered the spellings callers happen to pass rather than the hazard.
  const normalized = normalizePath(rootPrefix)
  const segments = normalized.split('/').filter((s) => s.length > 0 && !/^[a-z]:$/i.test(s))
  // A WSL-mounted drive root (/mnt/c) is the same "entire drive" hazard as a bare drive letter -- recognize it too, in case a project root is ever literally the mount root rather than a real path under it.
  if (segments.length === 2 && segments[0]?.toLowerCase() === 'mnt' && /^[a-z]$/i.test(segments[1] ?? '')) return true
  // `//server/share` is the root of a whole network share, the same whole-volume hazard as a drive
  // root. Gated on the path actually being UNC: a plain POSIX `/usr/local` also has two segments and
  // is an ordinary directory that must stay prunable.
  if (normalized.startsWith('//') && segments.length <= 2) return true
  return segments.length === 0
}

/**
 * Record that `filePath`'s project root was just observed alive (an edit was made under it).
 *
 * Feeds {@link sweepKnownRoots}: without a registry of which roots have ever been indexed, the
 * worker's periodic auto-prune sweep would have no safe, bounded set of prefixes to scan --
 * scanning the entire shared `files` table's distinct top-level directories on every cycle, or
 * (worse) pruning against an unscoped drive-root prefix, are exactly what {@link
 * isTooShallowToPrune} exists to prevent. Fail-soft and cheap: called from the edit-hook hot
 * path (throttled by the caller, not here), a no-op when `filePath` isn't under a recognizable
 * project (see {@link findProject}) or resolves to a too-shallow root.
 */
export function recordKnownRoot(filePath: string, dbPath: string = globalDbPath()): void {
  const project = findProject(path.dirname(filePath))
  if (project === null || isTooShallowToPrune(project.root)) return
  const db = getDb(dbPath)
  db.prepare(
    `INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, ?, NULL)
     ON CONFLICT(root) DO UPDATE SET last_seen_ms = excluded.last_seen_ms, first_missing_ms = NULL`,
  ).run(project.root, Date.now())
}

/** Minimum time between {@link recordKnownRootThrottled} writes for the SAME parent directory, so a burst of edit-hook calls (e.g. a multi-file refactor within one folder) doesn't hit the DB on every single one -- roots don't change often enough to need per-edit tracking. */
const KNOWN_ROOT_RECORD_MIN_INTERVAL_MS = 60 * 60 * 1000

// Keyed by a fingerprint of filePath's parent directory, NOT globally: a single shared marker
// (the pre-fix shape of this function) meant the FIRST project edited in any rolling hour window
// consumed the only throttle slot, and every OTHER project touched during that same window never
// got its recordKnownRoot() call at all -- not merely delayed, silently dropped forever, since
// the marker check short-circuits before filePath's project root is even resolved. A dev machine
// routinely has edits land in more than one project inside an hour, so that shape starved every
// project but the first from ever entering known_roots, defeating sweepKnownRoots' auto-prune for
// them permanently (recordKnownRoot is the only writer of that table). Scoping the marker per
// parent directory keeps the same "one findProject()+DB-write per burst" throttle for repeated
// edits to one folder while ensuring a different folder (a different project, or even a different
// subdirectory of the same one) gets its own throttle window instead of silently reusing someone
// else's.
function knownRootRecordMarkerPath(dir: string, filePath: string): string {
  return path.join(dir, `known-root-record-${shortFingerprint(path.dirname(filePath))}.marker`)
}

/** Filename prefix shared by every {@link knownRootRecordMarkerPath}, so the sweep below can find them without recomputing a fingerprint. */
const KNOWN_ROOT_MARKER_PREFIX = 'known-root-record-'

/**
 * Delete expired {@link recordKnownRootThrottled} markers.
 *
 * The per-directory keying that fixed the starvation bug above also made these markers
 * accumulate without bound: one file per directory ever edited, and nothing ever removed
 * them, so a long-lived data dir collects hundreds of them. Deleting an expired marker is
 * exactly equivalent to leaving it, because {@link recordKnownRootThrottled} already treats
 * any marker older than {@link KNOWN_ROOT_RECORD_MIN_INTERVAL_MS} as absent.
 */
export function sweepExpiredKnownRootMarkers(dir: string = dataDir()): number {
  let removed = 0
  try {
    const cutoff = Date.now() - KNOWN_ROOT_RECORD_MIN_INTERVAL_MS
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(KNOWN_ROOT_MARKER_PREFIX) || !file.endsWith('.marker')) continue
      const full = path.join(dir, file)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full)
          removed += 1
        }
      } catch {
        // best-effort per-file cleanup -- one unremovable marker must not abort the sweep.
      }
    }
  } catch {
    // Missing data dir, or a readdir failure -- nothing to clean.
  }
  return removed
}

/**
 * Rate-limited wrapper around {@link recordKnownRoot}, called from the edit hook and from every
 * seam that walks files for indexing (cmdIndex, the worker's drain, and the read-path stale heal).
 *
 * Indexing has to record here because sweepKnownRoots is the only thing that reclaims index rows
 * for files that have vanished from disk, and it only ever scans roots this table lists. While the
 * edit hook was its sole writer, the sweepable set was "roots you have edited" rather than "roots
 * you have indexed": a project indexed and read but never edited was never registered, so its dead
 * rows were unreachable by any sweep and stayed forever. Measured on a real ledger before this
 * changed, 233 of 235 dead rows (99.1%) sat outside every known root and 24.9% of indexed files
 * belonged to a root that had never been recorded, while `token-goat project prune` reported
 * nothing to do -- the command whose job it was said it had none. The call sits at the
 * orchestration layer rather than inside indexFileSync for two reasons: a file whose content is
 * already fresh never reaches indexFileSync at all, so a project that is fully indexed would stay
 * unregistered indefinitely; and src/parser.ts is hashed whole into PARSER_FINGERPRINT, so a line
 * of bookkeeping there would bill every existing install a full reparse for a change that cannot
 * alter a single extracted symbol.
 *
 * Same marker-file-mtime throttle pattern as ensureWorkerAlive (worker.ts), but keyed per parent
 * directory (see {@link knownRootRecordMarkerPath}) rather than one global marker: a fresh marker
 * for THIS file's directory short-circuits before even resolving `filePath`'s project root, so a
 * burst of edits to one directory touches the DB and does the {@link findProject} directory walk
 * at most once per {@link KNOWN_ROOT_RECORD_MIN_INTERVAL_MS}, without starving a different
 * directory's (or project's) own throttle window.
 */
export function recordKnownRootThrottled(
  filePath: string,
  dir: string = dataDir(),
  dbPath: string = globalDbPath(),
): void {
  const markerPath = knownRootRecordMarkerPath(dir, filePath)
  try {
    const stat = fs.statSync(markerPath)
    if (Date.now() - stat.mtimeMs < KNOWN_ROOT_RECORD_MIN_INTERVAL_MS) return
  } catch {
    // No marker yet: first check ever for this data dir, proceed.
  }
  try {
    ensureDirSync(dir)
    fs.writeFileSync(markerPath, '')
  } catch {
    // If we can't even write the marker, don't let that block the record below -- worst case we
    // just record more often than intended.
  }
  try {
    recordKnownRoot(filePath, dbPath)
  } catch {
    // Bookkeeping must never take down the operation that triggered it. Every caller is an
    // indexing or edit path whose actual job is already done or about to be, and the callers
    // include ones that legitimately hand over a dbPath this cannot write to at all -- an
    // in-memory database, for instance, which has no project root to record in the first place.
    // The failure is not logged, because the only sink available is the database that just
    // refused the write. Missing a record costs one sweep window: the next successful call for
    // this root registers it, and the rows stay exactly where they were until then.
  }
}
