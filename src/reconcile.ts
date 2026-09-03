/**
 * Catch-up reconciliation: detect index drift caused by edits token-goat never saw.
 *
 * Every existing freshness mechanism in this repo is driven by an in-session hook. The Edit
 * hook enqueues what the agent edits (`hooks_edit.ts`); the Bash post-hook enqueues what
 * head-moving git commands rewrite and what in-place shell rewrites touch (`hooks_bash.ts`);
 * the per-file `staleWarning`/`healStaleIndex` pair in `read_commands.ts` reparses a file the
 * moment a command names it. Between them, drift caused *during* a session is covered well.
 *
 * None of them can see drift that happened while no hook was running: a `git pull` in another
 * terminal, an edit from an IDE or a second agent session, a codegen or build step invoked
 * outside the harness, or a worker that exited with paths still queued. Nothing reconciles that
 * on the way back in, and the commands most likely to be asked first -- `semantic`, `symbol` by
 * name, `find`, `refs`, `callers`, `arch`, `dead` -- never name a file, so the per-file heal
 * never fires for them. They answer from whatever rows exist, and a stale answer is
 * indistinguishable from a correct one.
 *
 * This module closes that by sweeping the tracked-file set once and enqueueing anything whose
 * on-disk content no longer matches its indexed fingerprint. It is deliberately cause-agnostic:
 * rather than enumerate the ways drift can happen and add a detector per cause, it compares the
 * two things that must agree and repairs the difference, so a cause nobody anticipated is
 * covered by the same code.
 *
 * Cost discipline: `mtime` is checked first and the content hash is computed only for files
 * whose mtime moved, so the steady-state cost is one `stat` per tracked file and zero reads.
 * A file whose mtime moved but whose content did not (the common `git checkout` round-trip)
 * costs one read and is correctly left alone. The whole sweep is bounded by a wall-clock budget
 * and never throws, because its main caller is a session-start hook.
 */
import * as fs from 'node:fs'

import { enqueueDirtyPathSafe } from './hooks_index.js'
import { fingerprintFile } from './fingerprint.js'
import { getProjectFileEntries } from './index_reader.js'
import { normalizePath, resolveIndexPath, toDisplayPath } from './paths.js'
import { getDisplayRoot } from './project.js'
import { getTrackedFiles } from './repomap.js'
import { countNoun, foldPath } from './util.js'

/**
 * Wall-clock budget for a sweep. Chosen so the session-start hook stays imperceptible even on a
 * cold filesystem cache: this repo's own measurement is that hook cost is dominated by process
 * startup rather than logic, and a sweep that pushed past that would turn a correctness
 * improvement into a latency regression on every single session.
 */
export const DEFAULT_RECONCILE_BUDGET_MS = 1500

export interface ReconcileOptions {
  cwd?: string
  /** Wall-clock budget. Defaults to {@link DEFAULT_RECONCILE_BUDGET_MS}. */
  budgetMs?: number
  /** Compute the drift set without enqueueing it. */
  dryRun?: boolean
}

export interface ReconcileResult {
  /** Tracked files examined before the budget ran out. */
  scanned: number
  /** Tracked files whose indexed content no longer matches disk. */
  changed: string[]
  /** Tracked files with no row in the index at all. */
  added: string[]
  /** Indexed files that are no longer tracked on disk. */
  removed: string[]
  /** Files whose mtime moved but whose content did not: measured, not estimated. */
  mtimeOnly: number
  /** True when the budget stopped the sweep before every tracked file was examined. */
  budgetExhausted: boolean
  /**
   * True when the tracked-file enumeration came back empty against a non-empty index -- the
   * project is not a git repository, git is missing, or git errored. Distinguished from a
   * genuinely emptied project because the two are identical in the numbers and opposite in what
   * they mean.
   */
  trackedUnavailable: boolean
  /** Tracked files never examined because the budget ran out. */
  unscanned: number
  /** Total paths enqueued for reindexing (0 when `dryRun`). */
  enqueued: number
  elapsedMs: number
}

export interface RunReconcileOptions {
  cwd?: string
  budgetMs?: number
  dryRun?: boolean
  json?: boolean
}

/**
 * CLI entrypoint for `token-goat reconcile`. Returns the process exit code.
 *
 * Exit code is 0 whether or not drift was found: finding drift is this command succeeding, not
 * failing, and a nonzero code would break `token-goat reconcile && <next step>` on exactly the runs
 * where the reconciliation did its job.
 */
export function runReconcile(opts: RunReconcileOptions = {}): number {
  const raw = reconcileProject(opts)

  // Absolute paths are what the queue needs and what `reconcileProject` therefore works in; they
  // are not what a person reading a drift report needs. Converted here, at the presentation seam,
  // so the mechanism keeps the only form the worker can match.
  const root = getDisplayRoot(opts.cwd ?? process.cwd())
  const display = (paths: string[]): string[] => paths.map((p) => toDisplayPath(root, p)).sort()
  const result = {
    ...raw,
    changed: display(raw.changed),
    added: display(raw.added),
    removed: display(raw.removed),
  }

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  const lines: string[] = []
  if (isReconcileClean(result)) {
    // Not claimed when the enumeration failed: an empty drift set there means nothing was
    // compared, and "Index matches disk" over zero comparisons is the confident wrong answer this
    // whole command exists to avoid. The disclosure below carries that case instead.
    if (!result.trackedUnavailable) {
      lines.push(`Index matches disk: ${countNoun(result.scanned, 'file')} checked in ${result.elapsedMs}ms.`)
    }
  } else {
    const verb = opts.dryRun === true ? 'would reindex' : 'queued for reindexing'
    // Deletions get their own verb. The shared one is accurate for the other two kinds and wrong
    // here -- "indexed but gone from disk (queued for reindexing)" describes reparsing a file that
    // no longer exists, which is the opposite of what the queue does with it.
    const dropVerb = opts.dryRun === true ? 'would drop from the index' : 'queued for removal'
    if (result.changed.length > 0) lines.push(`${countNoun(result.changed.length, 'file')} changed since indexing (${verb}):`)
    for (const f of result.changed) lines.push(`  ~ ${f}`)
    if (result.added.length > 0) lines.push(`${countNoun(result.added.length, 'file')} not in the index (${verb}):`)
    for (const f of result.added) lines.push(`  + ${f}`)
    if (result.removed.length > 0) lines.push(`${countNoun(result.removed.length, 'file')} indexed but gone from disk (${dropVerb}):`)
    for (const f of result.removed) lines.push(`  - ${f}`)
    lines.push(`Checked ${countNoun(result.scanned, 'file')} in ${result.elapsedMs}ms.`)
  }
  // Both disclosures print in every mode, clean or not. A sweep that ran out of time found the
  // drift it had time to find, and "Index matches disk" over a partial scan is the exact shape of
  // confident-wrong-answer this codebase treats as a defect rather than a rough edge.
  if (result.mtimeOnly > 0) {
    lines.push(`${countNoun(result.mtimeOnly, 'file')} had a newer timestamp but identical content, so ${result.mtimeOnly === 1 ? 'it was' : 'they were'} left alone.`)
  }
  if (result.trackedUnavailable) {
    lines.push('This project has an index but git listed no files in it, so nothing could be compared and no deletions were computed. Run token-goat inside the repository, or reindex with --walk if this directory is deliberately not under git.')
  }
  if (result.budgetExhausted) {
    lines.push(`Stopped at the ${result.elapsedMs}ms budget with ${countNoun(result.unscanned, 'file')} unchecked, so there may be more drift; deletions were not computed at all, because an unchecked file is indistinguishable from a deleted one. Raise --budget-ms for a complete sweep.`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/** True when this result found nothing to repair -- the whole point of the common case. */
export function isReconcileClean(r: ReconcileResult): boolean {
  return r.changed.length === 0 && r.added.length === 0 && r.removed.length === 0
}

/**
 * Sweep `cwd`'s tracked files against the index and enqueue whatever drifted.
 *
 * Deletions are enqueued rather than handled separately: the worker's drain reconciles a
 * deletion when the removed path is the one enqueued, so one queue and one drainer cover all
 * three drift kinds instead of a second removal path that could disagree with the first.
 */
export function reconcileProject(opts: ReconcileOptions = {}): ReconcileResult {
  const cwd = opts.cwd ?? process.cwd()
  const budgetMs = opts.budgetMs ?? DEFAULT_RECONCILE_BUDGET_MS
  const startedAt = Date.now()

  const tracked = getTrackedFiles(cwd)
  // Absolutized before scoping: the index stores absolute paths, and `projectScopeClause` builds
  // a prefix-range bound straight from the root it is handed. A relative `cwd` -- what
  // `token-goat reconcile` from inside the project passes -- would produce a relative prefix that
  // matches no stored row, so every tracked file would look unindexed and the sweep would enqueue
  // the entire project as "added" on every run.
  const projectRoot = resolveIndexPath('.', cwd)
  const indexed = getProjectFileEntries(projectRoot)

  const changed: string[] = []
  const added: string[] = []
  const seenOnDisk = new Set<string>()
  let mtimeOnly = 0
  let scanned = 0
  let budgetExhausted = false

  for (const file of tracked) {
    // Checked before the work rather than after, so the budget bounds what this function does
    // rather than merely reporting that it overran. The check itself is a clock read, and
    // hoisting it out of the loop would be the optimization that removes the bound.
    if (Date.now() - startedAt > budgetMs) {
      budgetExhausted = true
      break
    }
    scanned++
    const folded = foldPath(normalizePath(file))
    seenOnDisk.add(folded)
    const entry = indexed.get(folded)

    if (entry === undefined) {
      added.push(file)
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      // Vanished between `getTrackedFiles` and now, or unreadable. Treat as drift rather than
      // silently skipping: enqueueing it lets the worker's own read decide, and a genuinely
      // missing file is reconciled as a deletion there.
      changed.push(file)
      continue
    }

    // The cheap gate. An unchanged mtime means an unchanged file for every writer that does not
    // deliberately forge timestamps, so the overwhelming majority of files cost one stat and
    // nothing else. A moved mtime is only a *suspicion* of change -- confirmed by content below,
    // never assumed -- because `git checkout` rewrites mtimes wholesale and treating that as
    // drift would enqueue the entire repository on every branch switch.
    if (entry.mtime !== 0 && mtimeMs === entry.mtime) continue

    const diskSha = fingerprintFile(file)
    if (diskSha === null) {
      changed.push(file)
      continue
    }
    if (diskSha === entry.sha) {
      mtimeOnly++
      continue
    }
    changed.push(file)
  }

  // A deletion is inferred from absence, so it is only sound when the tracked-file enumeration
  // actually produced the population it is being compared against. Two ways it does not:
  //
  //   - A budget-truncated pass never visited some tracked files, and every unvisited one looks
  //     "indexed but not on disk" here.
  //   - `getTrackedFiles` returns an empty list for a directory git cannot enumerate -- not a
  //     repository, git not installed, git errored -- which is indistinguishable in the numbers
  //     from a project whose every file was deleted. Measured against a real non-git project with
  //     two live files and a populated index: every one of them was reported gone and queued for
  //     removal.
  //
  // In both cases an incomplete sweep reports no deletions at all rather than a guess, because
  // enqueueing a live file for removal is the one mistake here that destroys working index rows.
  const trackedUnavailable = tracked.length === 0 && indexed.size > 0
  const removed: string[] = []
  if (!budgetExhausted && !trackedUnavailable) {
    for (const [folded, entry] of indexed) {
      if (!seenOnDisk.has(folded)) removed.push(entry.filePath)
    }
  }

  let enqueued = 0
  if (opts.dryRun !== true) {
    for (const p of [...changed, ...added, ...removed]) {
      // Resolved here rather than passed raw: `getTrackedFiles` returns paths joined onto the
      // root it was given, so a relative `cwd` (the natural `token-goat reconcile` from inside the
      // project) yields relative paths, and the worker's sha gate keys on the canonical absolute
      // form. An unresolved relative path enqueues a key no reader can match -- the queue would
      // fill and nothing would ever reindex. Paths from the index are already canonical, so
      // resolving them is a no-op.
      enqueueDirtyPathSafe(resolveIndexPath(p, cwd), { alreadyResolved: true })
      enqueued++
    }
  }

  return {
    scanned,
    changed,
    added,
    removed,
    mtimeOnly,
    budgetExhausted,
    trackedUnavailable,
    unscanned: Math.max(0, tracked.length - scanned),
    enqueued,
    elapsedMs: Date.now() - startedAt,
  }
}
