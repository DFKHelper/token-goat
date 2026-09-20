import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerHook } from '../src/hook_registry.js'
import { clearModuleCaches } from '../src/reset.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { relayInProcess } from '../src/relay.js'
import { getDb, closeAllDbs } from '../src/db.js'
import * as statsModule from '../src/stats.js'

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

describe('relayInProcess records total wall-clock since process start, not just dispatch (Batch U)', () => {
  it('passes performance.now() -- elapsed time since process start, per Node\'s perf_hooks contract -- to recordStat, not a delta between two timestamps taken inside this function', async () => {
    registerHook('notification', () => ({ hookType: 'pass' }))
    // FORMAT-DERIVED: performance.now()'s contract (ms elapsed since performance.timeOrigin, i.e. process start) is documented in Node's perf_hooks API docs; a large stubbed value simulates a process that took a while to start, which the pre-fix hrtime-delta implementation could never reflect since it only timed the inside of this function.
    const fakeElapsedSinceProcessStart = 12345.6
    const originalNow = performance.now.bind(performance)
    const recordStatSpy = vi.spyOn(statsModule, 'recordStat')
    performance.now = () => fakeElapsedSinceProcessStart
    try {
      await relayInProcess('notification', { session_id: 's1' })
    } finally {
      performance.now = originalNow
    }

    expect(recordStatSpy).toHaveBeenCalledWith(
      'hook:notification',
      0,
      0,
      undefined,
      undefined,
      undefined,
      fakeElapsedSinceProcessStart,
    )
    const row = latestHookRow()
    expect(row?.duration_ms).toBe(Math.round(fakeElapsedSinceProcessStart))
  })
})

describe('relayInProcess records what the harness actually waited on, not always its own lifetime (Batch V)', () => {
  it('records the caller-supplied harnessWaitMs as duration_ms, ignoring this call\'s own elapsed time', async () => {
    registerHook('subagent_stop', () => ({ hookType: 'pass' }))
    // FORMAT-DERIVED: harnessWaitMs models the Claude Code shim's own performance.now() reading at the instant it printed the `{"async":true}` marker (src/bridges/claudecode.ts's CLAUDECODE_HOOK_SCRIPT), taken from the batch brief's measured fastest-of-8 figure for a detached post_tool_use Write (26.4ms); relayInProcess itself never reads the shim's clock, only the number it is handed.
    const harnessWaitMs = 26.4
    const recordStatSpy = vi.spyOn(statsModule, 'recordStat')
    const originalNow = performance.now.bind(performance)
    // A value far from harnessWaitMs and easy to tell apart in the assertion below: if this call's own elapsed time leaked through instead of the argument, the row would read 9999, not 26.
    performance.now = () => 9999
    try {
      await relayInProcess('subagent_stop', { session_id: 's1' }, harnessWaitMs)
    } finally {
      performance.now = originalNow
    }

    expect(recordStatSpy).toHaveBeenCalledWith('hook:subagent_stop', 0, 0, undefined, undefined, undefined, harnessWaitMs)
    const row = latestHookRow()
    expect(row?.duration_ms).toBe(Math.round(harnessWaitMs))
  })

  it('still records its own full elapsed time when no harnessWaitMs is given -- the synchronous population this fix must leave alone', async () => {
    registerHook('notification', () => ({ hookType: 'pass' }))
    const fakeElapsed = 555.2
    const recordStatSpy = vi.spyOn(statsModule, 'recordStat')
    const originalNow = performance.now.bind(performance)
    performance.now = () => fakeElapsed
    try {
      await relayInProcess('notification', { session_id: 's1' })
    } finally {
      performance.now = originalNow
    }

    expect(recordStatSpy).toHaveBeenCalledWith('hook:notification', 0, 0, undefined, undefined, undefined, fakeElapsed)
    const row = latestHookRow()
    expect(row?.duration_ms).toBe(Math.round(fakeElapsed))
  })
})
