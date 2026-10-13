/** A progress watchdog for tests that wait on child processes: it fails only after the processes made no progress for `quietLimitMs` of quiet time, and a machine-wide stall that delays its tick adds at most one interval to that quiet time. */

export interface Watchdog {
  /** Records that the watched processes advanced (child output, exit, an awaited file appearing); resets the quiet time. */
  progress(reason: string): void
  /** Ends the watch; no rejection can follow. */
  stop(): void
  /** Rejects with the label, the last progress reason and the quiet time once the quiet time exceeds the limit; race every awaited result against it. */
  failed: Promise<never>
}

export interface WatchdogOptions {
  quietLimitMs: number
  label: string
  /** Tick period in ms; the most one tick can add to the quiet time. */
  intervalMs?: number
  /** Injectable for unit tests only; production reads performance.now(). */
  clock?: () => number
  /** Injectable for unit tests only; production uses an unref'd setInterval. Returns the cancel function. */
  schedule?: (tick: () => void, intervalMs: number) => () => void
}

export const WATCHDOG_TICK_MS = 250

function intervalSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

export function startWatchdog(options: WatchdogOptions): Watchdog {
  const { quietLimitMs, label } = options
  const intervalMs = options.intervalMs ?? WATCHDOG_TICK_MS
  const clock = options.clock ?? (() => performance.now())
  const schedule = options.schedule ?? intervalSchedule
  let quietMs = 0
  let lastTick = clock()
  let lastReason = 'start'
  let stopped = false
  let reject: (error: Error) => void = () => undefined
  const failed = new Promise<never>((_resolve, rejectFailed) => { reject = rejectFailed })
  // The caller races `failed`; a watchdog nobody is racing at the moment it fires must not surface as an unhandled rejection.
  failed.catch(() => undefined)
  const cancel = schedule(() => {
    if (stopped) return
    const now = clock()
    // A tick delayed by a machine stall (a gap far above the interval) counts as one interval, not the stall.
    quietMs += Math.min(Math.max(now - lastTick, 0), intervalMs)
    lastTick = now
    if (quietMs > quietLimitMs) {
      stopped = true
      cancel()
      reject(new Error(`${label}: no progress for ${String(Math.round(quietMs))} ms (limit ${String(quietLimitMs)} ms); last progress: ${lastReason}`))
    }
  }, intervalMs)
  return {
    progress(reason: string): void {
      if (stopped) return
      quietMs = 0
      lastTick = clock()
      lastReason = reason
    },
    stop(): void {
      stopped = true
      cancel()
    },
    failed,
  }
}
