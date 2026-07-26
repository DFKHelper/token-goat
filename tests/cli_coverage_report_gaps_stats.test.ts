/**
 * Regression: `token-goat coverage-report-gaps` (runCoverageReportGaps in read_commands.ts)
 * never called recordStat -- it reads a full LCOV/Istanbul coverage report from disk and emits
 * only the narrower uncovered-lines slice, the same "read replacement" shape as csv-query (see
 * cli_csv_query_stats.test.ts), but has no stats wiring at all, so the coverage_report_gaps
 * bucket in `token-goat stats --full` stayed permanently zero regardless of real usage (same
 * class of gap fixed for csv_query/map_lookup/changed_lookup, see
 * project_runchanged_missing_stat memory). Drives the real, unmocked `run()` CLI entrypoint
 * against a real scratch LCOV file and asserts a real stats row appears via summarize() against
 * the real (test-isolated) global stats DB -- a synthetic recordStat/DB insert would not catch
 * the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('runCoverageReportGaps stat recording', () => {
  it('`token-goat coverage-report-gaps` records a coverage_report_gaps stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-covgaps-'))
    const cwd = process.cwd()
    try {
      const lcovPath = join(root, 'lcov.info')
      writeFileSync(lcovPath, 'SF:src/clean.ts\nDA:1,1\nend_of_record\nSF:src/partial.ts\nDA:1,1\nDA:2,0\nend_of_record\n')

      const before = summarize(30).by_kind['coverage_report_gaps']
      const beforeEvents = before?.events ?? 0

      process.chdir(root)
      await run(['node', 'token-goat', 'coverage-report-gaps', lcovPath])

      const after = summarize(30).by_kind['coverage_report_gaps']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
