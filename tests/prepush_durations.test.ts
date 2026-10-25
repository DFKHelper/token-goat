/** The duration table next to the failure record: the pre-push selection costs each test file from it, so a table that is lost, mixed up between legs or written torn would silently change what gets deferred to CI. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { durationsPath, medianMs, readDurations, recordDurations } from '../scripts/test-durations.mjs'

// Fixture provenance: the log lines are FORMAT-DERIVED from vitest's default reporter (` ✓ tests/x.test.ts (3 tests) 1234ms`), the same shape scripts/test-durations.mjs already parses; the table contents are HAND-DERIVED.
const SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'scripts', 'test-durations.mjs')
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tg-durations-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('duration table', () => {
  it('sits next to the failure record, so one override relocates both', () => {
    expect(durationsPath(path.join('x', 'store', 'last-failed.json'))).toBe(path.join('x', 'store', 'durations.json'))
  })

  it('keeps each leg apart and a new run replaces only the files it timed', () => {
    const t = path.join(dir, 'durations.json')
    recordDurations(t, 'win', [{ file: 'tests/a.test.ts', ms: 100 }, { file: 'tests/b.test.ts', ms: 200 }])
    recordDurations(t, 'wsl', [{ file: 'tests/a.test.ts', ms: 900 }])
    recordDurations(t, 'win', [{ file: 'tests/a.test.ts', ms: 150 }])
    expect(readDurations(t, 'win')).toEqual({ 'tests/a.test.ts': 150, 'tests/b.test.ts': 200 })
    expect(readDurations(t, 'wsl')).toEqual({ 'tests/a.test.ts': 900 })
  })

  it.each([
    ['absent', null],
    ['not json', '{oops'],
    ['an array', '[1,2]'],
    ['a leg that is not a table', '{"win": 5}'],
  ])('reads %s as empty', (_name, body) => {
    const t = path.join(dir, 'durations.json')
    if (body !== null) writeFileSync(t, body)
    expect(readDurations(t, 'win')).toEqual({})
  })

  it('drops entries that are not non-negative numbers', () => {
    const t = path.join(dir, 'durations.json')
    writeFileSync(t, JSON.stringify({ win: { 'tests/a.test.ts': 5, 'tests/b.test.ts': -1, 'tests/c.test.ts': 'x', 'tests/d.test.ts': null } }))
    expect(readDurations(t, 'win')).toEqual({ 'tests/a.test.ts': 5 })
  })

  it('a malformed table is rewritten from the new run', () => {
    const t = path.join(dir, 'durations.json')
    writeFileSync(t, '{oops')
    recordDurations(t, 'win', [{ file: 'tests/a.test.ts', ms: 7 }])
    expect(readDurations(t, 'win')).toEqual({ 'tests/a.test.ts': 7 })
  })

  it('a run with no timings leaves the table alone', () => {
    const t = path.join(dir, 'durations.json')
    recordDurations(t, 'win', [])
    expect(() => readFileSync(t)).toThrow()
  })

  it.each([
    [[], null],
    [[5], 5],
    [[1, 100, 3], 3],
    [[10, 20, 30, 40], 25],
  ])('median of %j is %s', (values, want) => {
    expect(medianMs(values)).toBe(want)
  })

  it('--record folds a log into the table beside the store', () => {
    const log = path.join(dir, 'tests.log')
    writeFileSync(log, ' ✓ tests/a.test.ts (3 tests) 1234ms\n ❯ tests/b.test.ts (2 tests | 1 failed) 40ms\n     ✓ a sub-test 5ms\n')
    const store = path.join(dir, 'sub', 'last-failed.json')
    const out = execFileSync(process.execPath, [SCRIPT, log, '--record', store, 'win'], { encoding: 'utf8' })
    expect(out).toBe('recorded 2 test file timing(s) for win\n')
    expect(readDurations(path.join(dir, 'sub', 'durations.json'), 'win')).toEqual({ 'tests/a.test.ts': 1234, 'tests/b.test.ts': 40 })
  })
})
