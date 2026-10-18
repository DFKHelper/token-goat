/** Where the startup-worker fixtures live decides what ends the detached worker they start when the test run is killed before any afterEach runs. Test hygiene, not product behaviour. */
import { isAbsolute, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { startupWorkerFixtureParent } from '../helpers/copilot_session_start_tree.js'
import { DAEMON_SEARCH_DEPTH } from '../setup/build-bundle.js'

// HAND-DERIVED: the run root's contract comes from tests/setup/build-bundle.ts::createRunRoot (a per-run directory under the repo's .tmp/ that the globalSetup teardown empties and sweepStaleRunRoots reclaims). No wire format is involved.
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

describe('the startup-worker fixture parent', () => {
  it('lies inside the run root the teardown and the next-run sweep cover', () => {
    const runRoot = process.env['TG_TEST_INDEXABLE_ROOT']
    expect(runRoot, 'the run has no indexable root to put fixtures under').toBeDefined()
    expect(isInside(startupWorkerFixtureParent(), runRoot as string)).toBe(true)
  })

  it('keeps the worker heartbeat of a fixture within the depth the sweep searches', () => {
    const runRoot = process.env['TG_TEST_INDEXABLE_ROOT'] as string
    // The data dir the fixture hands the worker: <root>/home/dfk-helper/token-goat (tests/bridges/copilot_session_start_worker.test.ts), whose queue/ holds the heartbeat the sweep reads.
    const dataDir = join(startupWorkerFixtureParent(), 'tg-session-tree-abc123', 'home', 'dfk-helper', 'token-goat')
    expect(relative(runRoot, dataDir).split(sep).length).toBeLessThanOrEqual(DAEMON_SEARCH_DEPTH)
  })

  it('does not lie under the repo artifacts directory, which no sweep reaches', () => {
    expect(isInside(startupWorkerFixtureParent(), join(process.cwd(), 'artifacts'))).toBe(false)
  })
})
