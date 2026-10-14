import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllReadRangeEvasion, coerceReadRangeEvasion, evaluateRangeEvasion, exportReadRangeEvasion, getReadRangeDenials, importReadRangeEvasion, lockReadRange,
  getRecentReadRanges, recordRecentReadRange,
  type ReadRange,
} from '../src/read_range_evasion.js'
import { exportSessionState, importSessionState, markCompacted, resetFileLineRanges, recordFileLineRange, MAX_RANGES_PER_FILE } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { clearModuleCaches } from '../src/reset.js'
import { normalizePath } from '../src/paths.js'
import { foldPath } from '../src/util.js'

beforeEach(() => clearModuleCaches())

describe('recent explicit-range evasion decisions', () => {
  it('denies L1:2 after L1:1', () => {
    expect(evaluateRangeEvasion({ span: [1, 2], served: [[1, 1]] })).toBe('same_anchor')
  })

  it('allows three substantial same-anchor expansions, but denies the fourth', () => {
    const served: ReadRange[] = []
    for (const end of [40, 70, 100]) {
      expect(evaluateRangeEvasion({ span: [1, end], served })).toBeNull()
      served.push([1, end])
    }
    expect(evaluateRangeEvasion({ span: [1, 130], served })).toBe('same_anchor')
  })

  it('denies a backward overlap hunt on the second window', () => {
    expect(evaluateRangeEvasion({ span: [410, 425], served: [[415, 445]] })).toBe('overlap')
  })

  it('does not treat disjoint windows as churn', () => {
    expect(evaluateRangeEvasion({ span: [166, 180], served: [[140, 165]] })).toBeNull()
  })

  it('compares micro-shifts with a pre-hook denied span without a served ledger', () => {
    lockReadRange('file', [20, 30])
    expect(evaluateRangeEvasion({ span: [21, 29], served: [], denied: getReadRangeDenials('file') })).toBe('micro_shift')
  })

  it('does not compare a nearby read with stale history outside the recent window', () => {
    const served: ReadRange[] = [[20, 30], [200, 210], [400, 410], [600, 610]]
    expect(evaluateRangeEvasion({ span: [21, 29], served })).toBeNull()
  })

  it('limits micro-shifts to the last two served windows', () => {
    // Third-most-recent span overlaps <50%, so only an incorrectly broad micro-shift scan denies.
    expect(evaluateRangeEvasion({ span: [8, 17], served: [[1, 10], [200, 210], [400, 410]] })).toBeNull()
  })

  it('honors an existing lock even for a distant jump', () => {
    expect(evaluateRangeEvasion({ span: [600, 610], served: [], locked: true })).toBe('locked')
  })
})

describe('range-denial lifecycle', () => {
  it('counts pre/post recording of the same served window only once', () => {
    for (const end of [40, 70, 100]) {
      recordRecentReadRange('file', [1, end])
      recordRecentReadRange('file', [1, end])
    }
    expect(getRecentReadRanges('file')).toEqual([[1, 40], [1, 70], [1, 100]])
  })

  it('round-trips the lock through session hydration and clears it on a range reset', () => {
    const key = foldPath(normalizePath('file'))
    lockReadRange(key, [20, 30])
    const snapshot = exportSessionState()
    clearAllReadRangeEvasion()
    importSessionState(snapshot)
    expect(getReadRangeDenials(key)).toEqual([[20, 30]])
    resetFileLineRanges('file')
    expect(getReadRangeDenials(key)).toEqual([])
  })

  // HAND-DERIVED: lines 10..30 read, the file changes on disk, 15..25 is read (it finds the change), then 10..30 again. Windows are computed by hand; 10..30 holds an edit the model was never shown, so it must not count as a high-overlap retry of 15..25.
  it('does not judge a read around the window that re-synced the file after a change as evasion', () => {
    const key = foldPath(normalizePath('file'))
    recordRecentReadRange(key, [10, 30])
    resetFileLineRanges('file')
    recordRecentReadRange(key, [15, 25])
    recordRecentReadRange(key, [15, 25])
    expect(getRecentReadRanges(key)).toEqual([])
    expect(evaluateRangeEvasion({ span: [10, 30], served: getRecentReadRanges(key) })).toBeNull()
    // The pass is for that one window: once the re-read of 10..30 is booked, a hunt around it is still caught.
    recordRecentReadRange(key, [10, 30])
    expect(evaluateRangeEvasion({ span: [5, 50], served: getRecentReadRanges(key) })).toBe('overlap')
  })

  it('keeps the re-sync mark across the JSON boundary between hook processes', () => {
    const key = foldPath(normalizePath('file'))
    resetFileLineRanges('file')
    recordRecentReadRange(key, [15, 25])
    importReadRangeEvasion(coerceReadRangeEvasion(JSON.parse(JSON.stringify(exportReadRangeEvasion()))))
    expect(getRecentReadRanges(key)).toEqual([])
  })

  it('clears the denied spans and lock at compaction', () => {
    lockReadRange('file', [20, 30])
    expect(getReadRangeDenials('file')).toEqual([[20, 30]])
    markCompacted(Date.now() + 1)
    expect(getReadRangeDenials('file')).toEqual([])
  })
})

describe('range evasion across hook-process snapshots', () => {
  let home: string
  let previousHome: string | undefined
  beforeEach(() => {
    previousHome = process.env['TOKEN_GOAT_HOME']
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-range-state-'))
    process.env['TOKEN_GOAT_HOME'] = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('keeps recent windows after the containment ledger reaches its persisted cap', () => {
    const key = foldPath(normalizePath(path.join(home, 'file.ts')))
    loadSessionState('cap')
    for (let i = 0; i < MAX_RANGES_PER_FILE; i++) {
      recordFileLineRange(key, 100 * i + 1, 100 * i + 10)
      recordRecentReadRange(key, [100 * i + 1, 100 * i + 10])
    }
    saveSessionState('cap')
    loadSessionState('cap')
    recordFileLineRange(key, 100001, 100010)
    recordRecentReadRange(key, [100001, 100010])
    saveSessionState('cap')
    loadSessionState('cap')
    expect(getRecentReadRanges(key).at(-1)).toEqual([100001, 100010])
    expect(evaluateRangeEvasion({ span: [100002, 100011], served: getRecentReadRanges(key) })).not.toBeNull()
  })

  it('does not resurrect a reset lock when an overlapping hook saves a stale snapshot', () => {
    const key = foldPath(normalizePath(path.join(home, 'file.ts')))
    loadSessionState('reset')
    lockReadRange(key, [2, 3])
    saveSessionState('reset')
    loadSessionState('reset')
    expect(getReadRangeDenials(key)).toEqual([[2, 3]])
    const stale = exportSessionState()
    resetFileLineRanges(key)
    saveSessionState('reset')
    importSessionState(stale)
    saveSessionState('reset')
    loadSessionState('reset')
    expect(getReadRangeDenials(key)).toEqual([])
    expect(getRecentReadRanges(key)).toEqual([])
  })

  it('does not resurrect a pre-compaction lock from a stale snapshot', () => {
    loadSessionState('compact')
    lockReadRange('file', [2, 3])
    saveSessionState('compact')
    loadSessionState('compact')
    expect(getReadRangeDenials('file')).toEqual([[2, 3]])
    const stale = exportSessionState()
    markCompacted(Date.now() + 1)
    saveSessionState('compact')
    importSessionState(stale)
    saveSessionState('compact')
    loadSessionState('compact')
    expect(getReadRangeDenials('file')).toEqual([])
  })
})
