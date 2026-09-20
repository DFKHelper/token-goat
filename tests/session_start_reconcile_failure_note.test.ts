/**
 * Regression for reconcileNote's silent catch: on current main, a thrown reconcileProject sweep
 * inside session_start returns null and records nothing anywhere -- no stat, no log -- so a real
 * failure (SQLite `database is locked` is the observed one; see worker-errors.log) reads exactly
 * like a clean index on every future session start.
 *
 * reconcileProject is mocked to throw here rather than locked at the sqlite level: the fix's own
 * recordStat call writes to the same db reconcileProject reads, so holding an exclusive lock on it
 * would also block the write this test exists to observe, hiding the fix behind the very failure
 * it is supposed to make visible. Everything downstream of the throw -- recordStat, the real
 * sqlite write, sessionStartHandler's return value -- runs unmocked.
 *
 * Provenance: HAND-DERIVED. The thrown message and the expected stat row are asserted against
 * real recordStat/sqlite behavior, not read off hooks_session_start.ts's own source.
 */
import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RECONCILE_ERROR_MESSAGE = 'simulated: database is locked'

// Mirrors tests/hooks_session_start.test.ts's own constants mock, with this file's own temp
// targets so the two files' databases never collide.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    globalDbPath: () => _testDbPath,
    dataDir: () => _testDataDir,
  }
})

// The one seam this file mocks: reconcileProject throwing is the failure under test, and it must
// not touch the real sweep logic to be believable as "the sweep threw", not "the mock threw".
vi.mock('../src/reconcile.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    reconcileProject: () => {
      throw new Error(RECONCILE_ERROR_MESSAGE)
    },
  }
})

const _testConfigPath = tempConfigPath('tg-session-start-reconcile-fail-config.toml')
const _testDataDir = tempConfigPath('tg-session-start-reconcile-fail-data')
// getGlobalDb() (what recordStat writes through) joins dataDir() with 'global.db' itself rather
// than calling globalDbPath() -- the two must resolve to the same file here, or the symbols row
// this test inserts via globalDbPath() and the stats row recordStat writes via dataDir() land in
// two different sqlite files and neither query below ever sees the other's write.
const _testDbPath = path.join(_testDataDir, 'global.db')

import type { HookEvent } from '../src/hook_registry.js'
import { sessionStartHandler } from '../src/hooks_session_start.js'
import { clearModuleCaches } from '../src/reset.js'
import { invalidateConfigCache } from '../src/config.js'
import { getDb } from '../src/db.js'
import { getGlobalDb } from '../src/stats.js'
import { normalizePath } from '../src/paths.js'

function makeEvent(cwd?: string): HookEvent {
  return {
    eventName: 'session_start',
    toolName: undefined,
    toolInput: {},
    sessionId: 'test-session',
    agentId: undefined,
    raw: cwd !== undefined ? { cwd } : {},
  }
}

beforeEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
  for (const p of [_testConfigPath, _testDataDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // absent is fine
    }
  }
})

afterEach(() => {
  for (const p of [_testConfigPath, _testDataDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('sessionStartHandler when reconcileProject throws', () => {
  it('records reconcile_note_failed with the thrown message and still returns the routing reminder', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-start-reconcile-fail-'))
    try {
      const forwardSlashDir = normalizePath(projectDir)
      const db = getDb(_testDbPath)
      // Applies the stats schema up front: getGlobalDb() (what recordStat writes through) creates
      // the `stats` table lazily on its own first call, which otherwise would not happen until
      // the throw inside sessionStartHandler below, leaving the calibration query below with no
      // table to select from.
      getGlobalDb()
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`${forwardSlashDir}/a.ts`, 'foo', 'function', 1, 2, '', '')

      const before = db.prepare("SELECT count(*) AS n FROM stats WHERE kind = 'reconcile_note_failed'").get() as { n: number }
      expect(before.n, 'calibration: a prior write already exists under this kind').toBe(0)

      const result = sessionStartHandler(makeEvent(projectDir))

      expect(result.hookType, 'a thrown reconcile sweep must not fail the session start').toBe('context')
      if (result.hookType === 'context') {
        expect(result.context, 'the routing reminder must survive a thrown sweep').toContain('this project is indexed')
        expect(result.context, 'reconcileNote must degrade to null, not leak a drift note built from a failed sweep').not.toMatch(/reindexing|changed outside this session/)
      }

      const row = db.prepare("SELECT kind, detail FROM stats WHERE kind = 'reconcile_note_failed'").get() as
        | { kind: string; detail: string }
        | undefined
      expect(row, 'reconcile_note_failed was never recorded -- the failure is invisible').toBeDefined()
      expect(row?.detail).toBe(RECONCILE_ERROR_MESSAGE)
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
