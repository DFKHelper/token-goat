/** `maxWorkers` is derived from the machine, and the risk of deriving it is that a formula change silently raises it on a CI runner. That is not a hypothetical: 6 workers on the 4-vCPU windows-latest runner pushed ordinary tests past the 30s bound across three consecutive workflow attempts. So the runner shapes are pinned here by value, not left to be re-reasoned about. */
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { idleCpuCount, resolveMaxWorkers, sampleIdleCpus, ROOMY_CPUS, ROOMY_MEMORY_GB, WORKER_CEILING, WORKER_CEILING_WIN32 } from './setup/max-workers.js'

describe('resolveMaxWorkers', () => {
  // The exact shapes CI runs on. Each must resolve to the value the suite was last green on.
  it.each([
    ['windows-latest', 'win32', 4, 16, 4],
    ['ubuntu-latest', 'linux', 4, 16, 6],
    ['macos-latest', 'darwin', 4, 16, 6],
  ])('%s keeps its known-stable worker count', (_label, platform, cpus, gb, expected) => {
    expect(resolveMaxWorkers(platform, cpus, gb)).toBe(expected)
  })

  it('goes above the base only on a machine with both many cores and much memory', () => {
    expect(resolveMaxWorkers('linux', 26, 128)).toBe(WORKER_CEILING)
    // Either half of the bar missing means the base, unchanged.
    expect(resolveMaxWorkers('linux', 26, 16)).toBe(6)
    expect(resolveMaxWorkers('linux', 8, 128)).toBe(6)
  })

  it('holds the base right below the bar and clears it exactly at the bar', () => {
    expect(resolveMaxWorkers('linux', ROOMY_CPUS - 1, ROOMY_MEMORY_GB)).toBe(6)
    expect(resolveMaxWorkers('linux', ROOMY_CPUS, ROOMY_MEMORY_GB - 1)).toBe(6)
    expect(resolveMaxWorkers('linux', ROOMY_CPUS, ROOMY_MEMORY_GB)).toBe(WORKER_CEILING)
  })

  it('always caps win32 at WORKER_CEILING_WIN32 to avoid process and heap explosion', () => {
    expect(resolveMaxWorkers('win32', 26, 128)).toBe(WORKER_CEILING_WIN32)
    expect(resolveMaxWorkers('win32', 4, 16)).toBe(WORKER_CEILING_WIN32)
  })

  it('never returns fewer workers than the platform base', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      for (const cpus of [1, 2, 4, 8, 16, 17, 26, 128]) {
        expect(resolveMaxWorkers(platform, cpus, 128)).toBeGreaterThanOrEqual(platform === 'win32' ? 4 : 6)
      }
    }
  })

  it('caps a very large machine at the ceiling', () => {
    expect(resolveMaxWorkers('linux', 256, 512)).toBe(WORKER_CEILING)
  })

  it('honors TOKEN_GOAT_TEST_MAX_WORKERS env override when set', () => {
    process.env['TOKEN_GOAT_TEST_MAX_WORKERS'] = '2'
    try {
      expect(resolveMaxWorkers('win32', 26, 128)).toBe(2)
      expect(resolveMaxWorkers('linux', 4, 16)).toBe(2)
    } finally {
      delete process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
    }
  })
})

// Provenance: HAND-DERIVED. Every expected width is min(width, max(1, floor(idle cores))) worked out on paper from the row's own numbers; the 26-core row with 8 idle cores is the shape of the rejected pre-push run (log C:/tgwt/push_fail2_7f42686d9.tests.log: 40 forks workers failed to start), where 8 free cores still carry the full 4 workers.
describe('resolveMaxWorkers follows the idle CPU', () => {
  it('keeps the full width on a big busy machine that still has free cores', () => {
    // 26 cores, 8 idle, win32 width 4: min(4, floor(8)) = 4
    expect(resolveMaxWorkers('win32', 26, 128, 8)).toBe(4)
  })

  it('narrows the pool to the free cores when they are fewer than the workers', () => {
    // 26 cores, 2.5 idle, width 4: floor(2.5) = 2
    expect(resolveMaxWorkers('win32', 26, 128, 2.5)).toBe(2)
    // roomy linux, 26 cores, 5.9 idle, width 12: floor(5.9) = 5
    expect(resolveMaxWorkers('linux', 26, 128, 5.9)).toBe(5)
  })

  it('gives one worker when under one core is free', () => {
    // 4 cores, 0.4 idle, width 4: floor(0.4) = 0, floored to 1
    expect(resolveMaxWorkers('win32', 4, 16, 0.4)).toBe(1)
  })

  it('keeps the roomy width of 12 on a fully idle 16-core machine', () => {
    expect(resolveMaxWorkers('linux', 16, 32, 16)).toBe(WORKER_CEILING)
  })

  it('never goes below one worker', () => {
    expect(resolveMaxWorkers('win32', 26, 128, 0)).toBe(1)
    expect(resolveMaxWorkers('linux', 26, 128, -3)).toBe(1)
  })

  it('never goes above the width the machine shape gives', () => {
    expect(resolveMaxWorkers('win32', 26, 128, 500)).toBe(WORKER_CEILING_WIN32)
    expect(resolveMaxWorkers('linux', 26, 128, 500)).toBe(WORKER_CEILING)
  })

  it('leaves the width alone when there is no sample', () => {
    expect(resolveMaxWorkers('win32', 26, 128, undefined)).toBe(WORKER_CEILING_WIN32)
    expect(resolveMaxWorkers('win32', 26, 128, Number.NaN)).toBe(WORKER_CEILING_WIN32)
  })

  it('lets the env override win over the idle narrowing', () => {
    process.env['TOKEN_GOAT_TEST_MAX_WORKERS'] = '5'
    try {
      expect(resolveMaxWorkers('win32', 26, 128, 0)).toBe(5)
    } finally {
      delete process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
    }
  })
})

describe('idleCpuCount', () => {
  const core = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } })

  it('sums each core idle fraction over the ticks that elapsed', () => {
    // core 0: 100 ticks, 25 idle = 0.25; core 1: 200 ticks, 200 idle = 1.0; mean 0.625 over 2 cores = 1.25 cores
    expect(idleCpuCount([core(0, 0), core(0, 0)], [core(75, 25), core(0, 200)])).toBeCloseTo(1.25, 10)
  })

  it('counts a core that did not tick as no information, not as idle', () => {
    // only core 0 ticked (50 of 100 idle = 0.5); mean 0.5 over 2 cores = 1
    expect(idleCpuCount([core(0, 0), core(7, 7)], [core(50, 50), core(7, 7)])).toBeCloseTo(1, 10)
  })

  it('returns undefined when nothing ticked or the snapshots do not pair', () => {
    expect(idleCpuCount([core(1, 1)], [core(1, 1)])).toBeUndefined()
    expect(idleCpuCount([], [])).toBeUndefined()
    expect(idleCpuCount([core(0, 0)], [core(1, 1), core(1, 1)])).toBeUndefined()
  })

  it('samples a real machine into a count between 0 and its core count', () => {
    const idle = sampleIdleCpus(() => os.cpus(), 20)
    expect(idle === undefined || (idle >= 0 && idle <= os.cpus().length)).toBe(true)
  })
})
