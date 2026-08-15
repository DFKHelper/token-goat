/**
 * `maxWorkers` is derived from the machine, and the risk of deriving it is that a formula change
 * silently raises it on a CI runner. That is not a hypothetical: 6 workers on the 4-vCPU
 * windows-latest runner pushed ordinary tests past the 30s bound across three consecutive workflow
 * attempts. So the runner shapes are pinned here by value, not left to be re-reasoned about.
 */
import { describe, expect, it } from 'vitest'

import { resolveMaxWorkers, ROOMY_CPUS, ROOMY_MEMORY_GB, WORKER_CEILING } from './setup/max-workers.js'

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
    expect(resolveMaxWorkers('win32', 26, 128)).toBe(WORKER_CEILING)
    // Either half of the bar missing means the base, unchanged.
    expect(resolveMaxWorkers('win32', 26, 16)).toBe(4)
    expect(resolveMaxWorkers('win32', 8, 128)).toBe(4)
  })

  it('holds the base right below the bar and clears it exactly at the bar', () => {
    expect(resolveMaxWorkers('win32', ROOMY_CPUS - 1, ROOMY_MEMORY_GB)).toBe(4)
    expect(resolveMaxWorkers('win32', ROOMY_CPUS, ROOMY_MEMORY_GB - 1)).toBe(4)
    expect(resolveMaxWorkers('win32', ROOMY_CPUS, ROOMY_MEMORY_GB)).toBe(WORKER_CEILING)
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
})
