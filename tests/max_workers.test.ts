/** `maxWorkers` is derived from the machine, and the risk of deriving it is that a formula change silently raises it on a CI runner. That is not a hypothetical: 6 workers on the 4-vCPU windows-latest runner pushed ordinary tests past the 30s bound across three consecutive workflow attempts. So the runner shapes are pinned here by value, not left to be re-reasoned about. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { linuxSwapGb, machineSwapGb, resolveMaxWorkers, ROOMY_CPUS, ROOMY_MEMORY_GB, WORKER_CEILING } from './setup/max-workers.js'

describe('resolveMaxWorkers', () => {
  // TOKEN_GOAT_TEST_MAX_WORKERS is the knob a developer sets to run the suite narrower, and it outranks every other input, so a run with it set failed every case below that is about the machine's shape.
  let savedOverride: string | undefined
  beforeEach(() => {
    savedOverride = process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
    delete process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
  })
  afterEach(() => {
    if (savedOverride === undefined) delete process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
    else process.env['TOKEN_GOAT_TEST_MAX_WORKERS'] = savedOverride
  })

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

  it('honors TOKEN_GOAT_TEST_MAX_WORKERS env override when set', () => {
    process.env['TOKEN_GOAT_TEST_MAX_WORKERS'] = '2'
    try {
      expect(resolveMaxWorkers('win32', 26, 128)).toBe(2)
      expect(resolveMaxWorkers('linux', 4, 16)).toBe(2)
    } finally {
      delete process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
    }
  })

  // Provenance: CAPTURE, the WSL Ubuntu VM the pre-push hook runs the suite in, under `memory=4GB processors=2 swap=0` in .wslconfig: os.totalmem() / 2 ** 30 was 3.827 and /proc/meminfo said `SwapTotal:             0 kB`. 6 workers and then 2 froze the VM mid-run until `wsl --shutdown`.
  it('gives a 4 GB Linux VM with no swap one worker, the count that finished there', () => {
    expect(linuxSwapGb('MemTotal:        4013088 kB\nSwapTotal:             0 kB\n')).toBe(0)
    expect(resolveMaxWorkers('linux', 2, 3.827, 0)).toBe(1)
  })

  it('counts swap toward what a Linux machine can hold, and never goes under 1 or over the base', () => {
    expect(resolveMaxWorkers('linux', 2, 3.827, 4)).toBe(3)
    expect(resolveMaxWorkers('linux', 1, 0.5, 0)).toBe(1)
    expect(resolveMaxWorkers('linux', 4, 15.6, 0)).toBe(6)
    expect(resolveMaxWorkers('linux', 26, 128, 0)).toBe(WORKER_CEILING)
  })

  it('leaves Windows and macOS at their base whatever swap is passed, since both grow it on demand', () => {
    expect(resolveMaxWorkers('win32', 2, 3.827, 0)).toBe(4)
    expect(resolveMaxWorkers('darwin', 3, 7, 0)).toBe(6)
  })

  it("reads this machine's swap on Linux and nothing elsewhere, as vitest.config.ts passes it", () => {
    if (process.platform === 'linux') expect(machineSwapGb('linux')).toBeTypeOf('number')
    else expect(machineSwapGb(process.platform)).toBeUndefined()
  })
})
