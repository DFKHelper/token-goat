/** A work-to-rest throttle for the worker's idle embedding backlog walk. A token bucket in CPU-seconds: every wall second earns `maxCores` of budget, every CPU second the process spends (inference threads included, which a wall-clock duty cycle would miss) is charged, and a new batch may start only while the balance is not negative. A batch that overspends is paid back by a rest, so the average over any long window stays near `maxCores`. */
export interface CpuClock {
  /** Wall-clock milliseconds. */
  wallMs(): number
  /** CPU milliseconds (user plus system) the whole process has used so far. */
  cpuMs(): number
}

export const systemCpuClock: CpuClock = {
  wallMs: () => Date.now(),
  cpuMs: () => {
    const usage = process.cpuUsage()
    return (usage.user + usage.system) / 1000
  },
}

/** Default cap, in cores averaged over time, for the idle backlog; the rest of the ceiling is headroom for foreground drains. */
export const DEFAULT_BACKLOG_MAX_CORES = 0.7

/** How many wall seconds of budget an idle daemon may bank, which bounds the first burst after a long quiet period. */
const BURST_SECONDS = 5

/** Reads the cap from `TG_WORKER_BACKLOG_MAX_CORES`, falling back to the default for an absent, non-numeric or non-positive value. */
export function resolveBacklogMaxCores(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['TG_WORKER_BACKLOG_MAX_CORES'])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKLOG_MAX_CORES
}

export class DutyCycleThrottle {
  private balanceMs: number
  private lastWallMs: number
  private lastCpuMs: number

  constructor(
    private readonly maxCores: number,
    private readonly clock: CpuClock = systemCpuClock,
  ) {
    this.balanceMs = maxCores * BURST_SECONDS * 1000
    this.lastWallMs = clock.wallMs()
    this.lastCpuMs = clock.cpuMs()
  }

  /** Settles the budget earned and the CPU spent since the previous call. Call once per loop cycle, whether or not the backlog ran. */
  sample(): void {
    const wall = this.clock.wallMs()
    const cpu = this.clock.cpuMs()
    this.balanceMs += this.maxCores * Math.max(0, wall - this.lastWallMs) - Math.max(0, cpu - this.lastCpuMs)
    this.balanceMs = Math.min(this.balanceMs, this.maxCores * BURST_SECONDS * 1000)
    this.lastWallMs = wall
    this.lastCpuMs = cpu
  }

  /** Whether the backlog may queue its next batch now. */
  allowed(): boolean {
    return this.balanceMs >= 0
  }
}
