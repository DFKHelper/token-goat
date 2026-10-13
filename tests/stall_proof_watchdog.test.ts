/** HAND-DERIVED: the quiet-time arithmetic is computed from the specification (quiet += min(gap, interval), reset on progress, reject past the limit), driven by an injected clock and tick; no wire format is involved. */
import { expect, it } from 'vitest'

import { startWatchdog } from './helpers/stall_proof_watchdog.js'

function fakeTime(): { clock: () => number; tick: (gapMs: number) => void; ticks: () => number; cancelled: () => boolean; schedule: (tick: () => void, intervalMs: number) => () => void } {
  let now = 0
  let onTick: () => void = () => undefined
  let cancelled = false
  let count = 0
  return {
    clock: () => now,
    tick: (gapMs) => { now += gapMs; count += 1; onTick() },
    ticks: () => count,
    cancelled: () => cancelled,
    schedule: (tick) => { onTick = tick; return () => { cancelled = true } },
  }
}

const settled = async (promise: Promise<unknown>): Promise<'pending' | Error> => Promise.race([
  promise.then(() => 'pending' as const, (error: Error) => error),
  new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), 0) }),
])

it('rejects with the label, the last progress reason and the quiet time once the limit is exceeded', async () => {
  const time = fakeTime()
  const wd = startWatchdog({ quietLimitMs: 1000, label: 'row under test', intervalMs: 100, clock: time.clock, schedule: time.schedule })
  wd.progress('child stdout')
  for (let i = 0; i < 10; i += 1) time.tick(100)
  expect(await settled(wd.failed), 'exactly the limit is not yet over it').toBe('pending')
  time.tick(100)
  const error = await settled(wd.failed)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('row under test: no progress for 1100 ms (limit 1000 ms); last progress: child stdout')
  expect(time.cancelled(), 'the tick is cancelled once it has failed').toBe(true)
})

it('never rejects while progress keeps arriving, however long the run', async () => {
  const time = fakeTime()
  const wd = startWatchdog({ quietLimitMs: 1000, label: 'steady', intervalMs: 100, clock: time.clock, schedule: time.schedule })
  for (let i = 0; i < 500; i += 1) {
    time.tick(100)
    if (i % 5 === 0) wd.progress(`chunk ${String(i)}`)
  }
  expect(await settled(wd.failed)).toBe('pending')
  wd.stop()
})

it('counts a tick that arrives 30 s late as one interval, not as 30 s of silence', async () => {
  const time = fakeTime()
  const wd = startWatchdog({ quietLimitMs: 1000, label: 'machine stall', intervalMs: 100, clock: time.clock, schedule: time.schedule })
  for (let i = 0; i < 5; i += 1) time.tick(100)
  time.tick(30_000)
  expect(await settled(wd.failed), 'a 30 s stall added 500 + 100 ms of quiet time, under the 1000 ms limit').toBe('pending')
  for (let i = 0; i < 4; i += 1) time.tick(100)
  expect(await settled(wd.failed), '900 ms of quiet time after the stall is still under the limit').toBe('pending')
  time.tick(100)
  time.tick(100)
  expect(await settled(wd.failed), 'real quiet time past the limit still fails after a stall').toBeInstanceOf(Error)
})

it('stop() prevents a later rejection and cancels the tick', async () => {
  const time = fakeTime()
  const wd = startWatchdog({ quietLimitMs: 300, label: 'stopped', intervalMs: 100, clock: time.clock, schedule: time.schedule })
  time.tick(100)
  wd.stop()
  for (let i = 0; i < 20; i += 1) time.tick(100)
  expect(await settled(wd.failed)).toBe('pending')
  expect(time.cancelled()).toBe(true)
})
