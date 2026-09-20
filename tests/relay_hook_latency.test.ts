import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerHook } from '../src/hook_registry.js'
import { clearModuleCaches } from '../src/reset.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { relayInProcess } from '../src/relay.js'
import { getDb, closeAllDbs } from '../src/db.js'

/**
 * Same LOCALAPPDATA/XDG_DATA_HOME isolation as `content_store.test.ts`: `relayInProcess` records
 * through `recordStat()` -> `getGlobalDb()` -> `dataDir()`, which caches its resolved directory
 * for the process lifetime, so a test-only override must both set the env var the real hook path
 * reads and force that cache to re-resolve.
 */
let home: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-relay-latency-'))
  process.env['TOKEN_GOAT_HOME'] = home
  const dataRoot = dataDirForHome(home)
  const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n')
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  closeAllDbs()
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

function latestHookRow(): { kind: string; duration_ms: number | null } | undefined {
  const db = getDb(path.join(dataDirForHome(home), 'global.db'))
  return db
    .prepare("SELECT kind, duration_ms FROM stats WHERE kind LIKE 'hook:%' ORDER BY rowid DESC LIMIT 1")
    .get() as { kind: string; duration_ms: number | null } | undefined
}

function hookRowCount(): number {
  try {
    const db = getDb(path.join(dataDirForHome(home), 'global.db'))
    return (db.prepare("SELECT COUNT(*) as c FROM stats WHERE kind LIKE 'hook:%'").get() as { c: number }).c
  } catch {
    return 0
  }
}

describe('relayInProcess records its own wall-clock duration (Batch S)', () => {
  it('records a hook:<event> row with a non-negative duration for a real hook invocation', async () => {
    registerHook('notification', () => ({ hookType: 'pass' }))

    await relayInProcess('notification', { session_id: 's1' })

    const row = latestHookRow()
    expect(row?.kind).toBe('hook:notification')
    expect(row?.duration_ms).not.toBeNull()
    expect(row!.duration_ms!).toBeGreaterThanOrEqual(0)
  })

  it('still records a duration when a registered handler throws (the outer catch path)', async () => {
    registerHook('stop', () => {
      throw new Error('boom')
    })

    await relayInProcess('stop', { session_id: 's1' })

    const row = latestHookRow()
    expect(row?.kind).toBe('hook:stop')
    expect(row?.duration_ms).not.toBeNull()
  })

  it('records nothing for an unrecognized event name -- there is no hook invocation to time', async () => {
    // Establish the table first so "no new row" is a real assertion rather than "no table exists yet".
    await relayInProcess('notification', { session_id: 's1' })
    const before = hookRowCount()

    await relayInProcess('not_a_real_hook_event', { session_id: 's1' })

    expect(hookRowCount()).toBe(before)
  })
})
