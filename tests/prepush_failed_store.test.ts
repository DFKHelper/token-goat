/** scripts/prepush-failed.mjs keeps the failing test files of a red pre-push leg between pushes. Every read that cannot be trusted must come back empty, because an empty read makes the next push run the full leg. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearFailure, loadStore, readFailure, recordFailure } from '../scripts/prepush-failed.mjs'

const SCRIPT = path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'prepush-failed.mjs')

describe('prepush failure record', () => {
  let dir = ''
  let store = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-failed-'))
    store = path.join(dir, 'nested', 'last-failed.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps one record per leg and creates the directory', () => {
    recordFailure(store, 'win', 'abc123', ['tests/a.test.ts'])
    recordFailure(store, 'wsl', 'def456', ['tests/b.test.ts', 'tests/c.test.ts'])
    expect(readFailure(store, 'win')).toEqual({ sha: 'abc123', files: ['tests/a.test.ts'] })
    expect(readFailure(store, 'wsl')?.files).toHaveLength(2)
  })

  it('replaces a leg record and clears one without touching the other leg', () => {
    recordFailure(store, 'win', 'abc123', ['tests/a.test.ts'])
    recordFailure(store, 'wsl', 'def456', ['tests/b.test.ts'])
    recordFailure(store, 'win', 'fff000', ['tests/z.test.ts'])
    expect(readFailure(store, 'win')).toEqual({ sha: 'fff000', files: ['tests/z.test.ts'] })
    clearFailure(store, 'win')
    expect(readFailure(store, 'win')).toBeNull()
    expect(readFailure(store, 'wsl')).not.toBeNull()
  })

  it('records nothing for an empty failing list, so a red leg with no parsable failure is re-run in full', () => {
    recordFailure(store, 'win', 'abc123', ['tests/a.test.ts'])
    recordFailure(store, 'win', 'fff000', [])
    expect(readFailure(store, 'win')).toBeNull()
  })

  it('treats a missing, corrupt or malformed store as no record', () => {
    expect(readFailure(store, 'win')).toBeNull()
    recordFailure(store, 'win', 'abc123', ['tests/a.test.ts'])
    writeFileSync(store, '{not json')
    expect(loadStore(store)).toEqual({})
    expect(readFailure(store, 'win')).toBeNull()
    writeFileSync(store, JSON.stringify({ win: { sha: 'abc', files: 'tests/a.test.ts' }, wsl: { sha: '', files: ['x'] } }))
    expect(readFailure(store, 'win')).toBeNull()
    expect(readFailure(store, 'wsl')).toBeNull()
  })

  it('records from a log on the command line and prints the sha then the files on read', () => {
    const log = path.join(dir, 'tests.log')
    writeFileSync(log, ' FAIL  tests/hooks_stop.test.ts > the built hook entry, per host > codex: a test run\n Test Files  1 failed | 1352 passed | 5 skipped (1365)\n')
    execFileSync(process.execPath, [SCRIPT, 'record', store, 'win', 'abc123', log])
    expect(execFileSync(process.execPath, [SCRIPT, 'read', store, 'win'], { encoding: 'utf8' })).toBe('abc123\ntests/hooks_stop.test.ts\n')
    expect(() => execFileSync(process.execPath, [SCRIPT, 'read', store, 'wsl'], { stdio: 'pipe' })).toThrow()
  })
})
