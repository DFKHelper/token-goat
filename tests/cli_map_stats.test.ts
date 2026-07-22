/**
 * Regression: `token-goat map` (cmdMap in cli.ts) never called recordStat, even though
 * src/stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry has carried a live `map_lookup` entry
 * since the Python->TS port -- the `map`/`baseline` dashboard bucket in `token-goat stats --full`
 * was permanently zero regardless of real `map` usage (same class of gap fixed for
 * `changed_lookup`, see project_runchanged_missing_stat memory). Drives the real, unmocked `run()`
 * CLI entrypoint against a real scratch project directory and asserts a real stats row appears via
 * summarize() against the real (test-isolated) global stats DB -- a synthetic recordStat/DB
 * insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('cmdMap stat recording', () => {
  it('`token-goat map` records a map_lookup stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-map-'))
    const cwd = process.cwd()
    try {
      writeFileSync(join(root, 'a.ts'), 'export function statRecMapFn9k2() {\n  return 1\n}\n')

      const before = summarize(30).by_kind['map_lookup']
      const beforeEvents = before?.events ?? 0

      process.chdir(root)
      await run(['node', 'token-goat', 'map', '--compact'])

      const after = summarize(30).by_kind['map_lookup']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
