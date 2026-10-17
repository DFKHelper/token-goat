// Provenance: HAND-DERIVED. The expectation is a count identity (the process listeners and the abort listeners after a batch settles equal the counts before it), not a wire format; the events are the ones spawnOwned hooks in src/process_tree.ts (exit plus OWNER_SIGNALS) and the abort listener runGitAsync adds in src/git_async.ts. Batch sizes: the 200 failed spawns start no process, so they are cheap; the real batches are a few dozen runs of `git --version`, because a leak of even one listener per call shows as an exact count difference after the first call, so hundreds of runs add wall time and no evidence.
import { getEventListeners } from 'node:events'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runGitAsync } from '../src/git_async.js'

const EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const
const counts = (): number[] => EVENTS.map((e) => process.listenerCount(e))
const abortListeners = (signal: AbortSignal): number => getEventListeners(signal, 'abort').length
// A directory that does not exist, so the spawn itself fails (ENOENT) and no process starts.
const MISSING_CWD = path.join(os.tmpdir(), 'tg-listeners-test-no-such-directory', 'nested')

describe('runGitAsync leaves the process and abort listeners where it found them', () => {
  it('holds them while a call is in flight, so the counts below are not trivially unchanged', async () => {
    const before = counts()
    const ac = new AbortController()
    const pending = runGitAsync(['--version'], { signal: ac.signal })
    expect(counts(), 'spawnOwned adds one listener per event while a child is live').toEqual(before.map((n) => n + 1))
    expect(abortListeners(ac.signal), 'runGitAsync listens for abort while the child is live').toBe(1)
    await pending
    expect(counts(), 'the hooks come off when the call settles').toEqual(before)
    expect(abortListeners(ac.signal), 'the abort listener comes off when the call settles').toBe(0)
  })

  it('a failed spawn, a finished run, concurrent runs, aborts, timeouts and a pre-aborted signal each return to the baseline', async () => {
    const before = counts()
    const ac = new AbortController()

    const failed = []
    for (let i = 0; i < 200; i++) failed.push(await runGitAsync(['--version'], { cwd: MISSING_CWD, signal: ac.signal }))
    expect(failed.every((r) => r.exitCode === -1), 'every spawn in a missing directory fails').toBe(true)
    expect(counts(), 'after 200 failed spawns').toEqual(before)
    expect(abortListeners(ac.signal), 'after 200 failed spawns').toBe(0)

    let ok = 0
    for (let i = 0; i < 30; i++) if ((await runGitAsync(['--version'], { signal: ac.signal })).exitCode === 0) ok++
    expect(ok, 'every sequential run exits 0').toBe(30)
    expect(counts(), 'after 30 sequential runs').toEqual(before)
    expect(abortListeners(ac.signal), 'after 30 sequential runs').toBe(0)

    const concurrent = await Promise.all(Array.from({ length: 12 }, () => runGitAsync(['--version'], { signal: ac.signal })))
    expect(concurrent.every((r) => r.exitCode === 0), 'every concurrent run exits 0').toBe(true)
    expect(counts(), 'after 12 concurrent runs').toEqual(before)
    expect(abortListeners(ac.signal), 'after 12 concurrent runs').toBe(0)

    const aborted = []
    for (let i = 0; i < 12; i++) {
      const c = new AbortController()
      const pending = runGitAsync(['--version'], { signal: c.signal })
      c.abort()
      aborted.push(await pending)
      expect(abortListeners(c.signal), `abort listener after aborted run ${String(i)}`).toBe(0)
    }
    expect(aborted.every((r) => r.exitCode === -1), 'an abort straight after the call always wins over a git that has not yet exited').toBe(true)
    expect(counts(), 'after 12 aborted runs').toEqual(before)

    const timedOut = []
    for (let i = 0; i < 12; i++) timedOut.push(await runGitAsync(['--version'], { timeoutMs: 1, signal: ac.signal }))
    expect(timedOut.length, 'every timed-out run settled').toBe(12)
    expect(counts(), 'after 12 timed-out runs').toEqual(before)
    expect(abortListeners(ac.signal), 'after 12 timed-out runs').toBe(0)

    const pre = new AbortController()
    pre.abort()
    for (let i = 0; i < 12; i++) expect((await runGitAsync(['--version'], { signal: pre.signal })).exitCode, 'a pre-aborted call never starts').toBe(-1)
    expect(counts(), 'after 12 pre-aborted calls').toEqual(before)
    expect(abortListeners(pre.signal), 'after 12 pre-aborted calls').toBe(0)
  }, 120_000)
})
