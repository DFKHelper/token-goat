/**
 * Guard: every injectable seam on the indexer/worker critical path has a recorded decision.
 *
 * CLAUDE.md calls out one failure mode for this area by name -- "a test always supplies the
 * dependency the shipping path omits" -- and records the release it shipped: `drainOnce`'s default
 * index callback was a stub that never wrote to the `symbols` table, and the suite stayed green
 * because every worker test injected its own callback. A seam whose production default nothing
 * drives is unobserved code, whatever the suite says.
 *
 * This guard does not try to prove coverage by itself. It makes the population explicit and forces
 * a decision per member: a seam is either COVERED (a named test file drives its production default,
 * proven by a marker string that must exist in that file) or EXEMPT (a stated reason, plus a marker
 * in the file the reason cites, so a reason that stops being true fails rather than reading as a
 * settled decision). A seam the scanner finds but the table does not name fails the guard, which is
 * what makes adding a new one a decision rather than an omission.
 *
 * The scanner (tests/guards/critical_path_seam_coverage.ts) matches on syntax, not on any call
 * name, so a rename cannot silently empty its population -- and the count floor below catches the
 * case where it does empty for some other reason.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SEAM_FILES, collectSeams } from './critical_path_seam_coverage.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Decision {
  /** A test file that drives this seam's production default, plus a string that must appear in it. */
  readonly coveredBy?: { readonly test: string; readonly marker: string }
  /** Why no test drives the default, plus a file and a marker in it that must still hold for the reason to be true. */
  readonly exempt?: { readonly reason: string; readonly file: string; readonly marker: string }
}

/**
 * Every seam, with its decision. The three `processDirtyBatch` callbacks are exempt together: its
 * only production caller passes all three explicitly, so their defaults exist for direct-call tests
 * and are not a shipping path at all -- but `drainOnce`'s own defaults ARE, and they are covered.
 */
const DECISIONS: Record<string, Decision> = {
  'src/worker.ts::processDirtyBatch::index': {
    exempt: {
      reason: 'the only production caller is drainOnce, which passes its own index/remove/dir/requeue explicitly; these defaults are reached by direct-call tests only, and drainOnce\'s defaults (covered below) are what ships',
      file: 'src/worker.ts',
      marker: 'processDirtyBatch(parseDirtyQueueLines(claimedContent), indexFn, removeFn, dir, requeueFn)',
    },
  },
  'src/worker.ts::processDirtyBatch::remove': {
    exempt: {
      reason: 'same as processDirtyBatch::index -- drainOnce supplies it on every production call',
      file: 'src/worker.ts',
      marker: 'processDirtyBatch(parseDirtyQueueLines(claimedContent), indexFn, removeFn, dir, requeueFn)',
    },
  },
  'src/worker.ts::processDirtyBatch::requeue': {
    exempt: {
      reason: 'same as processDirtyBatch::index -- drainOnce supplies its own requeueFn so the deferred-requeue ordering holds',
      file: 'src/worker.ts',
      marker: 'processDirtyBatch(parseDirtyQueueLines(claimedContent), indexFn, removeFn, dir, requeueFn)',
    },
  },
  'src/worker.ts::drainOnce::index': {
    coveredBy: {
      test: 'tests/worker.test.ts',
      marker: 'default path indexes drained files into global.db (no injected callback)',
    },
  },
  'src/worker.ts::drainOnce::remove': {
    coveredBy: { test: 'tests/worker.test.ts', marker: 'rows on re-drain (no injected callback)' },
  },
  'src/worker.ts::runWorkerLoop::shouldStop': {
    exempt: {
      reason: 'the default is the daemon\'s own never-stop predicate, so a test that took it would not return; the production caller runDetachedWorkerDaemon is the one that omits it, and the loop body it drives (drainOnce) is covered at its own defaults',
      file: 'src/worker.ts',
      marker: 'void runWorkerLoop(dir, safeInterval)',
    },
  },
  'src/parser.ts::indexFileEmbeddings::onError': {
    coveredBy: { test: 'tests/embed_sha_gate.test.ts', marker: 'indexFileEmbeddings(file, dbPath, sha ?? undefined)' },
  },
  'src/parser.ts::setTreeSitterCoreForTesting': {
    coveredBy: {
      test: 'tests/worker.test.ts',
      marker: 'default path indexes drained files into global.db (no injected callback)',
    },
  },
  'src/embeddings.ts::setPipelineFnForTesting': {
    coveredBy: { test: 'tests/embeddings_index_wiring.test.ts', marker: 'canExerciseRealUpsert' },
  },
  'src/embeddings.ts::setPipelineRetryDelayForTesting': {
    exempt: {
      reason: 'the override replaces a sleep duration, not behavior: the production default is only how long buildExtractorWithRetry waits between attempts, and the retry logic itself is exercised with the override installed',
      file: 'src/embeddings.ts',
      marker: 'DEFAULT_PIPELINE_RETRY_DELAY_MS',
    },
  },
}

/**
 * Floor on the scanned population. A syntax scanner that silently matches nothing -- after a
 * refactor, a formatter change, or a bad edit to the scanner itself -- would otherwise report a
 * clean sweep over an empty set.
 */
const MIN_SEAMS = 10

describe('critical-path injectable seams', () => {
  const seams = collectSeams(REPO_ROOT)

  it('finds a non-empty seam population across every critical-path file', () => {
    expect(seams.length).toBeGreaterThanOrEqual(MIN_SEAMS)
    for (const file of SEAM_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true)
    }
  })

  it('records a decision for every seam, and names no seam that no longer exists', () => {
    const found = seams.map((s) => s.id).sort()
    const declared = Object.keys(DECISIONS).sort()
    const undeclared = found.filter((id) => !declared.includes(id))
    expect(
      undeclared,
      `new injectable seam(s) on the indexer/worker critical path with no recorded decision. Add each to DECISIONS in ${path.basename(fileURLToPath(import.meta.url))} with either a coveredBy test that drives its production default, or an exempt reason naming a file and a marker that keeps the reason honest.`,
    ).toEqual([])
    const stale = declared.filter((id) => !found.includes(id))
    expect(stale, 'DECISIONS names seam(s) the scanner no longer finds -- renamed, removed, or the scanner stopped matching them').toEqual([])
  })

  it('backs every decision with a marker that is still present in the file it cites', () => {
    for (const [id, decision] of Object.entries(DECISIONS)) {
      const cited = decision.coveredBy?.test ?? decision.exempt?.file
      const marker = decision.coveredBy?.marker ?? decision.exempt?.marker
      expect(cited, `${id} has neither coveredBy nor exempt`).toBeDefined()
      expect(marker, `${id} has no marker`).toBeDefined()
      const full = path.join(REPO_ROOT, cited ?? '')
      expect(fs.existsSync(full), `${id} cites ${cited ?? ''}, which does not exist`).toBe(true)
      expect(
        fs.readFileSync(full, 'utf8').includes(marker ?? ''),
        `${id} cites a marker that is no longer in ${cited ?? ''}: ${marker ?? ''}`,
      ).toBe(true)
    }
  })
})
