/** recordStat runs on every hook call, and at SQLite's default `synchronous = FULL` its one-row insert flushed the WAL to disk on each commit. HAND-DERIVED: the pragma sources below are the statements recordStat is expected to issue, recorded from every connection the real driver opens during one call, against a real global.db created by getGlobalDb. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SqliteDriver from '../src/sqlite_driver.js'

const pragmas: string[] = []
vi.mock('../src/sqlite_driver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SqliteDriver>()
  class Recording extends actual.default {
    override pragma(source: string, options?: { simple?: boolean }): unknown {
      pragmas.push(source)
      return super.pragma(source, options)
    }
  }
  return { ...actual, default: Recording }
})

import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import Database from '../src/sqlite_driver.js'
import { getGlobalDb, recordStat } from '../src/stats.js'

let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME']) saved[k] = process.env[k]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-stats-sync-'))
  process.env['TOKEN_GOAT_HOME'] = home
  const dataRoot = dataDirForHome(home)
  const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  closeAllDbs()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('recordStat', () => {
  it('commits its row without a flush to disk once global.db is in WAL mode, and the row lands', () => {
    getGlobalDb()
    pragmas.length = 0
    recordStat('hook:pre_tool_use', 0, 0)
    expect(pragmas).toContain('synchronous = NORMAL')
    const db = new Database(path.join(dataDirForHome(home), 'global.db'), { readonly: true })
    try {
      expect((db.prepare("SELECT COUNT(*) AS c FROM stats WHERE kind = 'hook:pre_tool_use'").get() as { c: number }).c).toBe(1)
    } finally {
      db.close()
    }
  })
})
