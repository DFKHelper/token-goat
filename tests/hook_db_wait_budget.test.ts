/** Pins the database wait budgets of a process that called limitDbWaitsForHook, the call the one-shot `hook` command makes before it relays, and that every other process keeps the long ones. Both budgets are read from the seam initConnection itself uses, and the busy_timeout is also read back from a real open connection, so a hard-coded value in either place fails here. Nothing waits on a lock and nothing asserts on elapsed time. tests/hook_path_waits_bounded.test.ts drives the same limit through the built bundle with a lock held by another OS process. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, connectionWaitBudgets, getDb, limitDbWaitsForHook } from '../src/db.js'
import { clearModuleCaches, clearPerRequestCaches } from '../src/reset.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'
import { busyTrace } from './helpers/sqlite_busy_trace.js'

let dir: string

beforeEach(() => {
  clearModuleCaches()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hook-db-budget-'))
})

afterEach(() => {
  limitDbWaitsForHook(false)
  closeAllDbs()
  clearModuleCaches()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('limitDbWaitsForHook', () => {
  it('keeps the long indexing budgets until a process asks for the hook ones', () => {
    const budgets = connectionWaitBudgets()
    expect(budgets.busyMs).toBeGreaterThanOrEqual(10_000)
    expect(budgets.walSwitchMs).toBeGreaterThanOrEqual(10_000)
    const conn = getDb(path.join(dir, 'long.db'))
    expect(Number(conn.pragma('busy_timeout', { simple: true }))).toBe(budgets.busyMs)
  })

  it('is switched on by the in-process hook library the shims import, on its first event', async () => {
    const { relayInProcess } = await import('../src/hook_lib.js')
    expect(connectionWaitBudgets().busyMs).toBeGreaterThanOrEqual(10_000)
    await relayInProcess('not_a_hook_event', {})
    expect(connectionWaitBudgets().busyMs).toBeLessThan(1000)
  })

  it('is handed back to the long budgets between the requests of a resident process', () => {
    limitDbWaitsForHook()
    expect(connectionWaitBudgets().busyMs).toBeLessThan(1000)
    clearPerRequestCaches()
    expect(connectionWaitBudgets().busyMs).toBeGreaterThanOrEqual(10_000)
  })

  it('is switched on by the one-shot hook command (built bundle), and by no other command', () => {
    // HAND-DERIVED: the recorder (tests/helpers/sqlite_busy_trace.ts) lists every busy_timeout the spawned process sets; the Read payload is the shape the hook tests in tests/hook_path_waits_bounded.test.ts send.
    const run = (args: string[], input: string): { status: number | null; seen: number[] } => {
      const trace = busyTrace(dir)
      const res = spawnSync(process.execPath, [BUNDLE, ...args], {
        cwd: dir,
        input,
        encoding: 'utf8',
        env: tgIsolatedEnv(dir, { TOKEN_GOAT_HOME: path.join(dir, 'tg'), ...trace.env }),
      })
      return { status: res.status, seen: trace.seen() }
    }
    const hook = run(['hook', 'pre_tool_use'], JSON.stringify({ session_id: 'budget', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'a.txt') }, cwd: dir }))
    expect(hook.status).toBe(0)
    expect(hook.seen.length).toBeGreaterThan(0)
    expect(Math.max(...hook.seen)).toBeLessThan(1000)

    const other = run(['stats'], '')
    expect(other.seen.length).toBeGreaterThan(0)
    expect(Math.max(...other.seen)).toBeGreaterThanOrEqual(10_000)
  })

  it('gives every connection opened afterwards a short busy_timeout and WAL-switch deadline', () => {
    limitDbWaitsForHook()
    const budgets = connectionWaitBudgets()
    expect(budgets.busyMs).toBeGreaterThan(0)
    expect(budgets.busyMs).toBeLessThan(1000)
    expect(budgets.walSwitchMs).toBeGreaterThan(0)
    expect(budgets.walSwitchMs).toBeLessThan(1000)
    const conn = getDb(path.join(dir, 'short.db'))
    expect(Number(conn.pragma('busy_timeout', { simple: true }))).toBe(budgets.busyMs)
  })
})
