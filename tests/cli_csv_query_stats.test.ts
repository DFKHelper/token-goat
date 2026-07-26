/**
 * Regression: `token-goat csv-query` (runCsvQuery in read_commands.ts) never called
 * recordStat, even after src/stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry gained a live
 * `csv_query` entry -- the csv-query bucket in `token-goat stats --full` was permanently zero
 * regardless of real `csv-query` usage (same class of gap fixed for map_lookup/changed_lookup,
 * see project_runchanged_missing_stat memory). Drives the real, unmocked `run()` CLI entrypoint
 * against a real scratch CSV file and asserts a real stats row appears via summarize() against
 * the real (test-isolated) global stats DB -- a synthetic recordStat/DB insert would not catch
 * the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('runCsvQuery stat recording', () => {
  it('`token-goat csv-query` records a csv_query stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-csv-'))
    const cwd = process.cwd()
    try {
      const csvPath = join(root, 'data.csv')
      writeFileSync(csvPath, 'name,age\nalice,30\nbob,40\n')

      const before = summarize(30).by_kind['csv_query']
      const beforeEvents = before?.events ?? 0

      process.chdir(root)
      await run(['node', 'token-goat', 'csv-query', csvPath])

      const after = summarize(30).by_kind['csv_query']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
