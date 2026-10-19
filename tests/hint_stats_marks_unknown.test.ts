/** `token-goat hint-stats` must print `unknown` for the manual+/manual- votes when it could not read them, never `0 0`. hint_stats_read.ts::manualMarks answered `{ effective: 0, ineffective: 0 }` from a bare catch, so a global.db whose `hint_manual_marks` table is broken showed the same `0 0` as an install nobody ever voted on, and the reader trusted a false zero. The repro is the real read path: a real global.db with real votes recorded through markCategoryEffective/markCategoryIneffective, then the table dropped, then the shipping runHintStatsCommand; no reader is mocked. Provenance: HAND-DERIVED. The votes and the expected cells are computed from what was recorded, not read off the formatter. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runHintStatsCommand } from '../src/cli_hint_stats.js'
import { globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { markCategoryEffective, markCategoryIneffective, resetHintStats } from '../src/hint_stats.js'
import { clearModuleCaches } from '../src/reset.js'

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    fn()
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

function removeGlobalDb(): void {
  closeAllDbs()
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${globalDbPath()}${suffix}`, { force: true })
}

function rowLine(output: string, category: string): string {
  const line = output.split('\n').find((l) => l.startsWith(category))
  if (line === undefined) throw new Error(`no ${category} row in:\n${output}`)
  return line
}

beforeEach(() => {
  clearModuleCaches()
  removeGlobalDb()
  resetHintStats()
})

afterEach(() => {
  removeGlobalDb()
  clearModuleCaches()
})

function breakMarksTable(): void {
  getDb(globalDbPath()).exec('DROP TABLE hint_manual_marks')
}

describe('hint-stats when hint_manual_marks cannot be read', () => {
  it('prints unknown in the manual+ and manual- cells, and null with a reason in --json', () => {
    markCategoryEffective('read_reread_dedup')
    markCategoryEffective('read_reread_dedup')
    markCategoryIneffective('read_reread_dedup')
    breakMarksTable()

    const text = captureStdout(() => runHintStatsCommand())
    expect(rowLine(text, 'read_reread_dedup')).toMatch(/unknown\s+unknown/)
    expect(text).toMatch(/manual votes: unknown \(.*hint_manual_marks/)

    const rows = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true }))) as Array<{
      category: string
      manualEffective: number | null
      manualIneffective: number | null
      manualMarksUnknownReason: string | null
    }>
    const row = rows.find((r) => r.category === 'read_reread_dedup')
    expect(row?.manualEffective).toBeNull()
    expect(row?.manualIneffective).toBeNull()
    expect(String(row?.manualMarksUnknownReason)).toContain('hint_manual_marks')
  })

  it('control: readable votes print as numbers and carry no reason', () => {
    markCategoryEffective('read_reread_dedup')
    markCategoryEffective('read_reread_dedup')
    markCategoryIneffective('read_reread_dedup')

    const text = captureStdout(() => runHintStatsCommand())
    expect(rowLine(text, 'read_reread_dedup')).toMatch(/\s2\s+1\s/)
    expect(text).not.toContain('unknown')

    const rows = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true }))) as Array<{
      category: string
      manualEffective: number | null
      manualIneffective: number | null
      manualMarksUnknownReason: string | null
    }>
    const row = rows.find((r) => r.category === 'read_reread_dedup')
    expect(row?.manualEffective).toBe(2)
    expect(row?.manualIneffective).toBe(1)
    expect(row?.manualMarksUnknownReason).toBeNull()
  })

  it('control: a readable table with no votes is a genuine zero, not unknown', () => {
    // A vote on one category creates the global.db and the table; a different category stays unvoted.
    markCategoryEffective('read_reread_dedup')

    const rows = JSON.parse(captureStdout(() => runHintStatsCommand({ json: true }))) as Array<{
      category: string
      manualEffective: number | null
      manualIneffective: number | null
      manualMarksUnknownReason: string | null
    }>
    const row = rows.find((r) => r.category === 'edit_reread_suggest')
    expect(row?.manualEffective).toBe(0)
    expect(row?.manualIneffective).toBe(0)
    expect(row?.manualMarksUnknownReason).toBeNull()
  })
})

describe('hint-stats after recordStat writes failed', () => {
  it('says the stats ledger lost writes, with the count and the latest reason', () => {
    markCategoryEffective('read_reread_dedup')
    const logPath = path.join(path.dirname(globalDbPath()), 'stats-write-failed.log')
    // FORMAT-DERIVED from src/stats.ts::recordStatWriteFailure: `<ISO time> recordStat write failed for kind=<kind>: <message>`, one line per logged failure.
    fs.writeFileSync(
      logPath,
      '2026-10-19T01:02:03.000Z recordStat write failed for kind=read_replacement: database is locked\n' +
        '2026-10-19T02:03:04.000Z recordStat write failed for kind=hint_emitted: disk I/O error\n',
    )
    try {
      expect(captureStdout(() => runHintStatsCommand())).toMatch(/Stats writes failed: 2 logged, latest 2026-10-19T02:03:04\.000Z: disk I\/O error/)
    } finally {
      fs.rmSync(logPath, { force: true })
    }
    expect(captureStdout(() => runHintStatsCommand())).not.toContain('Stats writes failed')
  })
})
