/** Wakes the worker's between-cycle sleep as soon as a producer appends to the dirty queue, instead of leaving the edit to wait out the poll interval. Kept apart from worker.ts so the watcher's lifecycle can be reasoned about on its own. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dirtyQueuePathFor } from './dirty_queue.js'

/** The sleep a worker cycle ends with: `sleep` resolves after `ms`, or earlier once a producer appends to the queue; `close` releases the watcher when the loop exits. */
export interface QueueWaker {
  sleep: (ms: number) => Promise<void>
  close: () => void
}

/** Identity and size of the queue file, or '' when there is none. Compared rather than any watch event trusted, because the worker's own appends (a transient-failure requeue, a backlog batch) land between cycles too and must keep their pacing; only a queue that changed after the sleep began wakes it. */
function queueSignature(queuePath: string): string {
  try {
    const st = fs.statSync(queuePath, { bigint: true })
    return st.size === 0n ? '' : `${st.ino}:${st.size}:${st.mtimeNs}`
  } catch {
    return ''
  }
}

/** The queue as the worker's own last append left it, per queue file. Written by {@link noteOwnQueueWrite}. */
const ownWrites = new Map<string, string>()

/** Record that the worker itself just appended to the queue in `dir` (a transient-failure requeue, a deferred path, a backlog batch), so that append neither wakes a sleep nor cuts the next one short: those are paced by the poll interval on purpose. An embed that fails while the worker sleeps requeues from its own callback, which is why a sleep checks this as well as the queue it started from. */
export function noteOwnQueueWrite(dir: string): void {
  const queuePath = dirtyQueuePathFor(dir)
  ownWrites.set(queuePath, queueSignature(queuePath))
}

/** Build the waker for data directory `dir`. It watches `dir/queue/` with fs.watch, which reports a change within milliseconds on Windows, macOS and Linux; the timed sleep stays as the fallback, so a platform or filesystem where the watch cannot start or fails later (a network share, an exhausted inotify limit) behaves exactly as before. The queue directory is created here when the data directory exists (never the data directory itself: a missing one is how the loop learns to exit), so the first edit after a start is watched too. An append that lands while a cycle is running rather than sleeping skips the next sleep instead, since no event can reach a sleep that has not started: the queue is compared with the one the cycle began from, so a queue the drain could not claim (a sharing violation) is retried at the poll interval as before rather than in a spin. */
export function createQueueWaker(dir: string): QueueWaker {
  const queuePath = dirtyQueuePathFor(dir)
  const queueDir = path.dirname(queuePath)
  const queueName = path.basename(queuePath)
  let watcher: fs.FSWatcher | null = null
  let closed = false
  let wake: (() => void) | null = null
  let baseline = ''
  // The queue as the running cycle found it: an append from anyone else since then is work the sleep must not wait out.
  let cycleStart = queueSignature(queuePath)
  const isFresh = (now: string): boolean => now !== '' && now !== baseline && now !== ownWrites.get(queuePath)

  const stopWatching = (): void => {
    const w = watcher
    watcher = null
    try {
      w?.close()
    } catch {
      // Already closed by the platform.
    }
  }

  const onEvent = (_event: string, name: string | Buffer | null): void => {
    const file = name === null ? null : path.basename(name.toString())
    if (file !== null && file !== queueName) {
      // Windows reports a deleted watched directory as an endless run of events naming the directory itself, which spins a core; stop watching once the directory is gone, and the next sleep will start again if it comes back.
      if (!fs.existsSync(queueDir)) stopWatching()
      return
    }
    if (wake !== null && isFresh(queueSignature(queuePath))) wake()
  }

  const startWatching = (): void => {
    if (closed || watcher !== null) return
    try {
      if (!fs.existsSync(queueDir)) {
        if (!fs.existsSync(dir)) return
        fs.mkdirSync(queueDir)
      }
      const w = fs.watch(queueDir, { persistent: false }, onEvent)
      w.on('error', () => {
        if (watcher === w) stopWatching()
      })
      watcher = w
    } catch {
      // No watch this sleep: it falls back to the timer, and the next sleep tries again.
      stopWatching()
    }
  }

  return {
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        startWatching()
        baseline = cycleStart
        const now = queueSignature(queuePath)
        if (isFresh(now)) {
          cycleStart = now
          resolve()
          return
        }
        baseline = now
        const done = (): void => {
          if (wake !== done) return
          wake = null
          clearTimeout(timer)
          cycleStart = queueSignature(queuePath)
          resolve()
        }
        const timer = setTimeout(done, ms)
        wake = done
      }),
    close: () => {
      closed = true
      wake?.()
      stopWatching()
    },
  }
}
