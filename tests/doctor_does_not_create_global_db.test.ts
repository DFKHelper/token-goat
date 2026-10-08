/** Regression (also the read commands: each reads global.db through readGlobalDb, which answers from an empty in-memory database when the file is absent): the first `doctor` run reported "global.db not found" and then created the file itself (claudeHookActivity opened it through getGlobalDb, which creates), so a second run contradicted the first. A diagnostic must not create what it reports missing. Provenance: CAPTURE of the cause: a stack trace from an instrumented build of the bundle run in an isolated lab showed getGlobalDb <- claudeHookActivity <- runDoctor as the only opener on a fresh data dir. The assertions are HAND-DERIVED (file present or absent, row text equal). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runDoctor } from '../src/cli_doctor.js'
import { _resetDataDirCacheForTesting, globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { getHintSpendTotals, getHintStatsSummary, getHintStatsTotals } from '../src/hint_stats_read.js'
import { logHintEmission } from '../src/hint_stats.js'
import { claudeHookActivity, hookLatencyBreakdown, nativeHookCounts } from '../src/hook_latency.js'
import { runSemanticDistances } from '../src/semantic_distances.js'
import { firstReceiptShownAt, noStatsMessage, readUnmappedTools, summarize } from '../src/stats.js'

let home: string
let root: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-nodb-home-'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-nodb-root-'))
  vi.stubEnv('TOKEN_GOAT_HOME', home)
  vi.stubEnv('LOCALAPPDATA', home)
  vi.stubEnv('XDG_DATA_HOME', home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
  vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
  vi.stubEnv('TOKEN_GOAT_EMBEDDINGS_ENABLED', '0')
  _resetDataDirCacheForTesting()
})

afterEach(() => {
  closeAllDbs()
  vi.unstubAllEnvs()
  _resetDataDirCacheForTesting()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

describe('doctor on a data dir with no global.db', () => {
  it('leaves no global.db behind and reports the same Database row twice', () => {
    const dataDir = path.dirname(globalDbPath())
    const first = runDoctor(dataDir, undefined, root, []).find((r) => r.name === 'Database')
    expect(fs.existsSync(globalDbPath())).toBe(false)
    const second = runDoctor(dataDir, undefined, root, []).find((r) => r.name === 'Database')
    expect(first?.message).toContain('global.db not found')
    expect(second).toEqual(first)
  })

  it.each([
    ['summarize', () => summarize(30)],
    ['noStatsMessage', () => noStatsMessage(30)],
    ['hookLatencyBreakdown', () => hookLatencyBreakdown()],
    ['nativeHookCounts', () => nativeHookCounts()],
    ['claudeHookActivity', () => claudeHookActivity()],
    ['readUnmappedTools', () => readUnmappedTools()],
    ['firstReceiptShownAt', () => firstReceiptShownAt()],
    ['runSemanticDistances', () => runSemanticDistances({})],
    ['getHintStatsSummary', () => getHintStatsSummary()],
    ['getHintStatsSummary (one session)', () => getHintStatsSummary('s1')],
    ['getHintStatsTotals', () => getHintStatsTotals()],
    ['getHintSpendTotals', () => getHintSpendTotals('s1')],
  ])('%s reads a fresh data dir without creating global.db', (_name, read) => {
    read()
    expect(fs.existsSync(globalDbPath())).toBe(false)
  })

  it('summarize on a fresh data dir reports no events', () => {
    expect(summarize(30).total_events).toBe(0)
  })

  it('hint-stats reports an empty ledger on a fresh data dir, and the real figures once one exists', () => {
    expect(getHintStatsSummary().every((r) => r.emitted === 0 && !r.suppressed)).toBe(true)
    expect(getHintStatsTotals()).toEqual({ savedBytes: 0, spentBytes: null, legacyEmissions: 0 })
    expect(fs.existsSync(globalDbPath())).toBe(false)
    logHintEmission('bash_redirect', 's1', null, false, 120)
    expect(fs.existsSync(globalDbPath())).toBe(true)
    expect(getHintSpendTotals('s1').spentBytes).toBe(120)
    expect(getHintStatsSummary('s1').find((r) => r.category === 'bash_redirect')?.bytesEmitted).toBe(120)
  })
})
