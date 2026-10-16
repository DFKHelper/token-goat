/** saveSessionState runs in every hook, so it must give up on a session-file lock held by another live process after a short budget and skip the save, never fall back to an unlocked write that clobbers the holder's update. The clock is virtual: sleepSync advances a faked Date instead of blocking, so the total backoff is exact and deterministic on any machine, and nothing here asserts on wall-clock time. The second describe holds the lock across a real PreCompact through relayInProcess: HAND-DERIVED from src/hooks_compact.ts, which stamps the epoch in memory and in the `.compacted-at` sidecar, and src/relay.ts, which then saves the session state under the lock. HAND-DERIVED: the lock file is `<pid>:<token>` with this process's own pid, which is alive by construction; a live holder keeps the lock until LOCK_LIVE_HOLDER_MAX_MS, so only the waiter's own budget ends the wait. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ sleptMs: 0 }))

vi.mock('../src/process_util.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    sleepSync: (ms: number): void => {
      clock.sleptMs += ms
      vi.setSystemTime(Date.now() + ms)
    },
  }
})

import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead } from '../src/session.js'
import { loadSessionState, saveSessionState, sessionSidecarPath } from '../src/session_store.js'

let home: string
let priorHome: string | undefined

beforeEach(() => {
  priorHome = process.env['TOKEN_GOAT_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-save-budget-'))
  process.env['TOKEN_GOAT_HOME'] = home
  clearModuleCaches()
  clock.sleptMs = 0
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  if (priorHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = priorHome
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

function sessionFile(id: string): string {
  const p = sessionSidecarPath(id, '.json')
  if (p === null) throw new Error('no session path')
  return p
}

describe('saveSessionState under a session-file lock another live process holds', () => {
  it('skips the save after a short budget instead of writing unlocked', () => {
    const id = 'budget-held'
    loadSessionState(id)
    recordFileRead(path.join(home, 'a.ts'))
    fs.mkdirSync(path.dirname(sessionFile(id)), { recursive: true })
    fs.writeFileSync(`${sessionFile(id)}.lock`, `${process.pid}:1`)

    saveSessionState(id)

    expect(fs.existsSync(sessionFile(id))).toBe(false)
    // The wait ends at the first backoff step past the 500 ms budget; the longest step is 200 ms.
    expect(clock.sleptMs).toBeGreaterThanOrEqual(500)
    expect(clock.sleptMs).toBeLessThanOrEqual(700)
  })

  it('writes the state when the lock is free', () => {
    const id = 'budget-free'
    loadSessionState(id)
    recordFileRead(path.join(home, 'b.ts'))

    saveSessionState(id)

    expect(fs.existsSync(sessionFile(id))).toBe(true)
    expect(clock.sleptMs).toBe(0)
  })
})

describe('a PreCompact whose session save is skipped under a held session lock', () => {
  it('still puts the compaction epoch in force at the next load, so a re-read is not treated as already in context', async () => {
    const saved = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    try {
      // clearModuleCaches in beforeEach empties the hook registry, which only a module's first load fills, so this case runs on a fresh set of modules.
      vi.resetModules()
      const { relayInProcess } = await import('../src/relay.js')
      const { getCompactedAt, recordFileRead, wasFileReadThisSession } = await import('../src/session.js')
      const { loadSessionState, saveSessionState } = await import('../src/session_store.js')
      const { clearModuleCaches } = await import('../src/reset.js')
      const id = 'budget-compact'
      const read = path.join(home, 'c.ts')
      loadSessionState(id)
      recordFileRead(read)
      saveSessionState(id)
      expect(wasFileReadThisSession(read)).toBe(true)

      // The clock is frozen, and a read stamped in the same millisecond as the epoch would still count as after it.
      vi.setSystemTime(Date.now() + 1000)
      const lock = `${sessionFile(id)}.lock`
      fs.writeFileSync(lock, `${process.pid}:1`)
      await relayInProcess('pre_compact', { session_id: id, cwd: home, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' })
      fs.rmSync(lock)

      // The save was skipped, so the state file carries no epoch: the sidecar is the only place it survived.
      expect((JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')) as { compactedAt?: number }).compactedAt).toBeUndefined()
      clearModuleCaches()
      loadSessionState(id)

      expect(getCompactedAt()).toBeGreaterThan(0)
      expect(wasFileReadThisSession(read)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = saved
    }
  })
})
