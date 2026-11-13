import { describe, expect, it } from 'vitest'
import { DutyCycleThrottle, resolveBacklogMaxCores, DEFAULT_BACKLOG_MAX_CORES, type CpuClock } from '../src/duty_cycle.js'

// Provenance: HAND-DERIVED. The expected averages are computed from the token-bucket arithmetic (earn maxCores per wall second, spend CPU seconds), not from the implementation.
function fakeClock(): CpuClock & { advance(wallMs: number, cpuMs: number): void } {
  let wall = 0
  let cpu = 0
  return {
    wallMs: () => wall,
    cpuMs: () => cpu,
    advance(w, c) {
      wall += w
      cpu += c
    },
  }
}

describe('DutyCycleThrottle', () => {
  it('holds the average CPU of a backlog that burns four cores per batch to the cap', () => {
    const clock = fakeClock()
    const throttle = new DutyCycleThrottle(1, clock)
    let batches = 0
    // One simulated hour in 1 s ticks; a batch runs for 1 s of wall at 4 cores whenever allowed.
    for (let tick = 0; tick < 3600; tick++) {
      throttle.sample()
      if (throttle.allowed()) {
        batches++
        clock.advance(1000, 4000)
      } else {
        clock.advance(1000, 0)
      }
    }
    const avgCores = (batches * 4000) / (3600 * 1000)
    expect(avgCores).toBeLessThanOrEqual(1.05)
    expect(avgCores).toBeGreaterThan(0.8)
  })

  it('does not hold back a backlog that stays under the cap', () => {
    const clock = fakeClock()
    const throttle = new DutyCycleThrottle(1, clock)
    for (let tick = 0; tick < 100; tick++) {
      throttle.sample()
      expect(throttle.allowed()).toBe(true)
      clock.advance(1000, 200)
    }
  })

  it('banks at most a few seconds of budget across a long quiet period', () => {
    const clock = fakeClock()
    const throttle = new DutyCycleThrottle(1, clock)
    clock.advance(3_600_000, 0)
    throttle.sample()
    clock.advance(1000, 60_000)
    throttle.sample()
    expect(throttle.allowed()).toBe(false)
  })
})

describe('resolveBacklogMaxCores', () => {
  it('reads a positive number and ignores anything else', () => {
    expect(resolveBacklogMaxCores({ TG_WORKER_BACKLOG_MAX_CORES: '2' })).toBe(2)
    expect(resolveBacklogMaxCores({ TG_WORKER_BACKLOG_MAX_CORES: 'x' })).toBe(DEFAULT_BACKLOG_MAX_CORES)
    expect(resolveBacklogMaxCores({ TG_WORKER_BACKLOG_MAX_CORES: '0' })).toBe(DEFAULT_BACKLOG_MAX_CORES)
    expect(resolveBacklogMaxCores({})).toBe(DEFAULT_BACKLOG_MAX_CORES)
  })
})
