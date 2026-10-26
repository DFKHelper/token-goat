// How many forked vitest workers this suite may use, derived from the machine rather than fixed.
//
// The suite's wall clock is set by this number, not by how much work the tests do. Total test time is ~453s; over 4 workers that is a ~113s floor against a ~141s actual, so on a large machine the run is idle a fifth of the time with most cores untouched. Measured on a 26-core workstation, full suite green in every arm: 4 workers 141s, 8 workers 92s, 12 workers 79s.
//
// The flat ceiling this replaces was not arbitrary, and the point of deriving is to keep every configuration it protected landing on exactly the same value it landed on before:
//
// - 6 forked workers oversubscribe GitHub's 4-vCPU windows-latest runner by 50%, and Windows process spawn is far more expensive than Linux while this suite spawns the built bundle in many tests. That combination pushed ordinary tests past the 30s bound -- a sqlite cap test took 51s and 55s, and two suites died in hooks -- across all three workflow attempts, while ubuntu and macOS absorbed 6 workers fine. 4 is the value this suite was green on before. - The local Windows suite also creates large V8 heaps and many built-bundle subprocesses. Six workers once consumed 1.34 GB on a developer workstation and timed out browser, snapshot, daemon, and type-reference tests in the same run.
//
// So the base is unchanged and is the floor as well as the default: a machine only goes above it when it is unambiguously larger than the one that failed at six, which means both plenty of cores and plenty of memory, since the documented failure was heap and heap does not scale with core count. Below that bar nothing changes at all -- every CI runner keeps its current value.
export const WORKER_CEILING = 12
export const WORKER_CEILING_WIN32 = 4
export const ROOMY_CPUS = 16
export const ROOMY_MEMORY_GB = 32

// The ceiling rather than something like `cpus - 2` because the bar is already above the ceiling: at the smallest machine that clears it, `cpus - 2` is 14, so a per-core term could never bind and would only read as if it did. 12 is the largest arm measured green here, not an extrapolation. On Windows, process spawning carries high OS overhead and each worker spawns subprocesses, creating process storms and V8 heap exhaustion if scaled to 12. Capped at WORKER_CEILING_WIN32 (4).
export function resolveMaxWorkers(platform: string, cpus: number, memoryGb: number, idleCpus?: number): number {
  const envVal = process.env['TOKEN_GOAT_TEST_MAX_WORKERS']
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseInt(envVal, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  const width = platform === 'win32' ? WORKER_CEILING_WIN32 : cpus < ROOMY_CPUS || memoryGb < ROOMY_MEMORY_GB ? 6 : WORKER_CEILING
  return narrowToIdle(width, idleCpus)
}

// The width above is what an otherwise idle machine of that shape can carry. What starves the pool is fewer free cores than workers, not a low idle percentage: a full Windows run on a 26-core machine held at about 68% CPU by other sessions (about 8 cores free) logged 40 "Failed to start forks worker ... Timeout waiting for worker to respond" and a 60s setup-hook timeout, yet 8 free cores carry 4 workers. So the pool is capped at the whole free cores, one worker per free core with no headroom term and no new tunable; the floor is one worker and the result is never above `width`. No sample (undefined) leaves the width alone. A quiet machine with fewer cores than the width (a 4-vCPU Linux runner, width 6) now gets its core count.
export function narrowToIdle(width: number, idleCpus: number | undefined): number {
  if (idleCpus === undefined || !Number.isFinite(idleCpus)) return width
  return Math.max(1, Math.min(width, Math.floor(idleCpus)))
}

export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

// The cores' worth of idle time between two os.cpus() snapshots: per core, idle ticks over all ticks that elapsed, summed. os.loadavg() is always 0 on Windows, so the tick counters are the signal that exists on all three platforms. Undefined when the snapshots do not pair up or no core ticked, which is no information rather than "idle".
export function idleCpuCount(before: readonly { times: CpuTimes }[], after: readonly { times: CpuTimes }[]): number | undefined {
  if (before.length === 0 || before.length !== after.length) return undefined
  let idle = 0
  let ticked = 0
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i]!.times
    const b = after[i]!.times
    const total = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq)
    if (!(total > 0)) continue
    idle += Math.min(1, Math.max(0, (b.idle - a.idle) / total))
    ticked += 1
  }
  return ticked === 0 ? undefined : (idle / ticked) * before.length
}

// Samples os.cpus() across a short window with a synchronous wait, because vitest reads maxWorkers while it loads its config. The window is a measurement interval, not a deadline anything waits on.
export function sampleIdleCpus(read: () => { times: CpuTimes }[], windowMs: number): number | undefined {
  const before = read()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, windowMs)
  return idleCpuCount(before, read())
}
