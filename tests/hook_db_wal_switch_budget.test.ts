/** The WAL switch of a connection opened by a hook process must be retried for the hook's short budget, not the 15 s indexing one: initConnection hands connectionWaitBudgets().walSwitchMs to enableWalWithRetry, and nothing else pins that argument. HAND-DERIVED: a second connection holding BEGIN IMMEDIATE on a database still in rollback-journal mode makes the conversion answer SQLITE_BUSY without consulting the busy handler (the behaviour enableWalWithRetry documents), so the retry loop runs to its deadline. The clock is virtual: sleepSync advances a faked Date instead of blocking, so the retry time is exact on any machine and nothing here asserts on wall-clock time. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ sleptMs: 0 }))

vi.mock('../src/util.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    sleepSync: (ms: number): void => {
      clock.sleptMs += ms
      vi.setSystemTime(Date.now() + ms)
    },
  }
})

import { DatabaseSync } from 'node:sqlite'

import { closeAllDbs, connectionWaitBudgets, getDb, limitDbWaitsForHook } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'

let dir: string
let holder: DatabaseSync | undefined

beforeEach(() => {
  clearModuleCaches()
  clock.sleptMs = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wal-budget-'))
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  holder?.close()
  holder = undefined
  limitDbWaitsForHook(false)
  closeAllDbs()
  clearModuleCaches()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Hold the write lock of a rollback-journal database from a second connection, and return its path. */
function lockedDatabase(): string {
  const file = path.join(dir, 'locked.db')
  holder = new DatabaseSync(file)
  holder.exec('CREATE TABLE t (x)')
  holder.exec('BEGIN IMMEDIATE')
  return file
}

describe('the WAL switch of a connection opened under a held lock', () => {
  it('is retried for the hook budget in a hook process', () => {
    limitDbWaitsForHook()
    const budget = connectionWaitBudgets().walSwitchMs

    expect(() => getDb(lockedDatabase())).toThrow()

    // The loop sleeps in steps of 25 ms and stops at the first check past the deadline, so it sleeps the budget and at most one step more.
    expect(clock.sleptMs).toBeGreaterThanOrEqual(budget)
    expect(clock.sleptMs).toBeLessThanOrEqual(budget + 25)
  })

  it('is retried for the long budget in any other process', () => {
    const budget = connectionWaitBudgets().walSwitchMs

    expect(() => getDb(lockedDatabase())).toThrow()

    expect(clock.sleptMs).toBeGreaterThanOrEqual(budget)
    expect(clock.sleptMs).toBeLessThanOrEqual(budget + 25)
  })
})
