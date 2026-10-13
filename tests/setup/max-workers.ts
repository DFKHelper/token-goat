// How many forked vitest workers this suite may use, derived from the machine rather than fixed.
//
// The suite's wall clock is set by this number, not by how much work the tests do. Total test time is ~453s; over 4 workers that is a ~113s floor against a ~141s actual, so on a large machine the run is idle a fifth of the time with most cores untouched. Measured on a 26-core workstation, full suite green in every arm: 4 workers 141s, 8 workers 92s, 12 workers 79s.
//
// The flat ceiling this replaces was not arbitrary, and the point of deriving is to keep every configuration it protected landing on exactly the same value it landed on before:
//
// - 6 forked workers oversubscribe GitHub's 4-vCPU windows-latest runner by 50%, and Windows process spawn is far more expensive than Linux while this suite spawns the built bundle in many tests. That combination pushed ordinary tests past the 30s bound -- a sqlite cap test took 51s and 55s, and two suites died in hooks -- across all three workflow attempts, while ubuntu and macOS absorbed 6 workers fine. 4 is the value this suite was green on before. - The local Windows suite also creates large V8 heaps and many built-bundle subprocesses. Six workers once consumed 1.34 GB on a developer workstation and timed out browser, snapshot, daemon, and type-reference tests in the same run.
//
// So the base is unchanged and is the floor as well as the default: a machine only goes above it when it is unambiguously larger than the one that failed at six, which means both plenty of cores and plenty of memory, since the documented failure was heap and heap does not scale with core count. Below that bar nothing changes at all -- every CI runner keeps its current value.
import * as fs from 'node:fs'

export const WORKER_CEILING = 12
export const ROOMY_CPUS = 16
export const ROOMY_MEMORY_GB = 32

// The ceiling rather than something like `cpus - 2` because the bar is already above the ceiling: at the smallest machine that clears it, `cpus - 2` is 14, so a per-core term could never bind and would only read as if it did. 12 is the largest arm measured green here, not an extrapolation.
export function resolveMaxWorkers(platform: string, cpus: number, memoryGb: number, swapGb?: number): number {
  const envVal = process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseInt(envVal, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  const base = platform === 'win32' ? 4 : 6
  const chosen = cpus < ROOMY_CPUS || memoryGb < ROOMY_MEMORY_GB ? base : WORKER_CEILING
  if (platform !== 'linux' || swapGb === undefined) return chosen
  return Math.max(1, Math.min(chosen, Math.floor((memoryGb + swapGb - 1) / GB_PER_WORKER)))
}

// The one exception to the base being the floor is a Linux machine whose memory plus swap cannot hold it, which in practice is a WSL VM: .wslconfig gives it a fixed share of the host, often with no swap, and there running out does not fail a test but freezes the whole VM until `wsl --shutdown`. A forked worker peaks past 1 GB (notes.test.ts seeds a million symbols, json_envelope_shape.test.ts passes 1 GB) beside a ~0.5 GB parent, and on a 4 GB VM with no swap both 6 workers and 2 workers froze it mid-run while 1 finished. So Linux gets a worker per GB_PER_WORKER of memory plus swap past the first GB, never fewer than 1; every CI runner clears its base by that measure (ubuntu-latest's 16 GB of memory alone allows 7), and Windows and macOS grow their page file and swap on demand, so a fixed swap total says nothing there and they keep the base.
export const GB_PER_WORKER = 2

/** SwapTotal from /proc/meminfo in GB, or undefined when it is not there to read (any platform but Linux). */
export function linuxSwapGb(meminfo: string): number | undefined {
  const kb = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
  return kb === undefined ? undefined : Number(kb) / 2 ** 20
}

/** This machine's swap as {@link linuxSwapGb} reads it, for vitest.config.ts. */
export function machineSwapGb(platform: string): number | undefined {
  if (platform !== 'linux') return undefined
  try {
    return linuxSwapGb(fs.readFileSync('/proc/meminfo', 'utf8'))
  } catch {
    return undefined
  }
}
