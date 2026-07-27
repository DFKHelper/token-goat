/**
 * Regression: `token-goat csv-profile` (runCsvProfile in read_commands.ts) never called
 * recordStat -- the csv_profile bucket in `token-goat stats --full` was permanently zero
 * regardless of real `csv-profile` usage, the same class of registry/producer desync
 * previously fixed for csv-query (see cli_csv_query_stats.test.ts) and for
 * map_lookup/changed_lookup (project_runchanged_missing_stat memory). Drives the real,
 * unmocked `run()` CLI entrypoint against a real scratch CSV file and asserts a real stats
 * row appears via summarize() against the real (test-isolated) global stats DB -- a
 * synthetic recordStat/DB insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('runCsvProfile stat recording', () => {
  it('`token-goat csv-profile` records a csv_profile stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-csvprofile-'))
    const cwd = process.cwd()
    try {
      const csvPath = join(root, 'data.csv')
      writeFileSync(csvPath, 'name,age\nalice,30\nbob,40\n')

      const before = summarize(30).by_kind['csv_profile']
      const beforeEvents = before?.events ?? 0

      process.chdir(root)
      await run(['node', 'token-goat', 'csv-profile', csvPath])

      const after = summarize(30).by_kind['csv_profile']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
