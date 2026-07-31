/**
 * Regression: `token-goat compact-doc` (cmdCompactDoc in config_commands.ts) never called
 * recordStat at all, and stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `compact-doc`
 * entry either -- so the compact-doc bucket in `token-goat stats --full` was permanently zero
 * regardless of real `compact-doc` usage (same class of registry/producer desync fixed for
 * map_lookup/changed_lookup/csv_query/brief_view, see project_runchanged_missing_stat memory).
 * Drives the real, unmocked `run()` CLI entrypoint against a real scratch file and asserts a
 * real stats row appears via summarize() against the real (test-isolated) global stats DB -- a
 * synthetic recordStat/DB insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('cmdCompactDoc stat recording', () => {
  it('`token-goat compact-doc --heading` records a compact_doc stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-compactdoc-'))
    const cwd = process.cwd()
    try {
      const filePath = join(root, 'DOC.md')
      writeFileSync(
        filePath,
        '# Title\n\n## Install\n\nSome install instructions go here for the compact heading test.\n',
      )

      const before = summarize(30).by_kind['compact_doc']
      const beforeEvents = before?.events ?? 0

      process.chdir(root)
      await run(['node', 'token-goat', 'compact-doc', filePath, '--heading', 'Install'])

      const after = summarize(30).by_kind['compact_doc']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
