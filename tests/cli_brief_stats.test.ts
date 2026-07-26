/**
 * Regression: `token-goat brief` (runBrief in read_commands.ts) never called recordStat at
 * all, and stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `brief` entry either -- so
 * the brief bucket in `token-goat stats --full` was permanently zero regardless of real
 * `brief` usage (same class of registry/producer desync fixed for map_lookup/changed_lookup/
 * csv_query, see project_runchanged_missing_stat memory). Drives the real, unmocked `run()`
 * CLI entrypoint against a real scratch file and asserts a real stats row appears via
 * summarize() against the real (test-isolated) global stats DB -- a synthetic recordStat/DB
 * insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('runBrief stat recording', () => {
  it('`token-goat brief` records a brief_view stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-brief-'))
    const cwd = process.cwd()
    try {
      const filePath = join(root, 'mod.ts')
      writeFileSync(filePath, 'export function myFunc() {\n  return 1\n}\n')

      const before = summarize(30).by_kind['brief_view']
      const beforeEvents = before?.events ?? 0

      process.chdir(root)
      await run(['node', 'token-goat', 'index'])
      await run(['node', 'token-goat', 'brief', `${filePath}::myFunc`])

      const after = summarize(30).by_kind['brief_view']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
