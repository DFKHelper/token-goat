/** The worker's side of a reconcile request: a hook that knew files changed but could not learn which (a branch switch whose changed-file list git failed to produce in time) leaves the project in `queue/reconcile.txt`, and the drain sweeps it here, off the hook's time budget. Kept apart from worker.ts, which only calls {@link drainReconcileRequests}. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { appendReconcileRequest, parseReconcileRequests, reconcileRequestPathFor } from './dirty_queue.js'
import { isIndexedRoot } from './indexed_roots.js'
import { reconcileProject } from './reconcile.js'
import { foldPath, runGit } from './util.js'
import { appendWorkerErrorLog } from './worker_lifecycle.js'

/** What became of one requested project, for the worker's error log. */
function logOutcome(dir: string, projectDir: string, outcome: string): void {
  appendWorkerErrorLog(dir, `${new Date().toISOString()} reconcile request for ${projectDir}: ${outcome}\n`)
}

/** Claim the reconcile-request file for `dir` by rename, as the drain claims the dirty queue, and return the claimed path; null when there is nothing to do. A claim left behind by a drain that died mid-sweep is returned first, so its requests are not lost. */
function claimReconcileRequests(dir: string): string | null {
  const live = reconcileRequestPathFor(dir)
  const claimed = `${live}.draining`
  if (fs.existsSync(claimed)) return claimed
  if (!fs.existsSync(live)) return null
  try {
    fs.renameSync(live, claimed)
    return claimed
  } catch {
    // A writer holding the file open (Windows) keeps the claim from succeeding; the next cycle tries again.
    return null
  }
}

/** Sweep every project named in the reconcile-request file under `dir` against the index in `dir`'s global.db, enqueueing the files that drifted for the next drain cycle. Only a project indexed on purpose is swept (see indexed_roots.ts), the rule session start applies; a request whose directory git cannot place in a repository any more, or whose project was not indexed on purpose, is dropped with a line in the worker error log. A sweep that ran out of its budget puts its project back so the next cycle resumes at the saved cursor. Returns how many projects were swept. Never throws. */
export function drainReconcileRequests(dir: string): number {
  let claimed: string | null
  try {
    claimed = claimReconcileRequests(dir)
  } catch {
    return 0
  }
  if (claimed === null) return 0
  let raw: string
  try {
    raw = fs.readFileSync(claimed, 'utf8')
  } catch {
    // Left in place: the next cycle claims it again.
    return 0
  }
  const dbPath = path.join(dir, 'global.db')
  const requeue: string[] = []
  const seenRoots = new Set<string>()
  let swept = 0
  for (const projectDir of parseReconcileRequests(raw)) {
    try {
      const top = runGit(['rev-parse', '--show-toplevel'], { cwd: projectDir, timeoutMs: 5000 })
      // A git that ran past its 5 s budget has not said this is no repository; dropping the request there lost the branch switch the hook had handed over, so the project goes back for the next cycle.
      if (top.timedOut === true) {
        requeue.push(projectDir)
        logOutcome(dir, projectDir, 'git did not answer in time, continuing next cycle')
        continue
      }
      const root = top.exitCode === 0 ? top.stdout.trim() : ''
      if (root === '') {
        logOutcome(dir, projectDir, 'dropped, git names no repository there')
        continue
      }
      // Several requested directories can sit in one repository (a subdirectory and its top-level); one sweep covers them all.
      const rootKey = foldPath(path.resolve(root))
      if (seenRoots.has(rootKey)) continue
      seenRoots.add(rootKey)
      if (!isIndexedRoot(root, dbPath)) {
        logOutcome(dir, projectDir, `dropped, ${root} was not indexed on purpose`)
        continue
      }
      const result = reconcileProject({ cwd: root, dbPath, queueDir: dir })
      swept++
      // A sweep whose file listing git did not finish found no new files, so the request goes back for the next cycle instead of being spent.
      if (result.budgetExhausted || result.gitTimedOut) requeue.push(root)
      logOutcome(dir, projectDir, `swept ${root}: ${result.scanned} scanned, ${result.enqueued} queued${result.gitTimedOut ? ', git did not answer in time listing the files, continuing next cycle' : result.budgetExhausted ? ', budget spent, continuing next cycle' : ''}`)
    } catch (e) {
      logOutcome(dir, projectDir, `failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Removed only after every sweep has run, so a kill mid-sweep leaves the claim for the next cycle (a sweep is idempotent) rather than losing the requests it named.
  try {
    fs.rmSync(claimed, { force: true })
  } catch {
    try {
      fs.renameSync(claimed, `${claimed}.corrupt-${Date.now()}`)
    } catch {
      // Both failed: the next cycle sweeps the same projects again, which is wasted work but not lost work.
    }
  }
  for (const root of requeue) {
    try {
      appendReconcileRequest(dir, root)
    } catch {
      // The cursor the sweep saved still resumes at the next reconcile of this project.
    }
  }
  return swept
}
