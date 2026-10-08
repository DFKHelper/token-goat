/** A detached worker must neither be orphaned by `stopWorker` nor outlive the things that make it findable. Three defects stranded 84 `--worker-daemon` processes on one machine: `stopWorker` removed the pid file of a daemon it had not killed (one still inside its startup grace, which has written no heartbeat yet), the daemon's loop ignored a pid file that was gone for good, and nothing ever retired an idle daemon. The loop half is tested here in-thread with short periods; tests/worker_retire_e2e.test.ts drives the same three through the built bundle's real daemon. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Preflight from '../src/embed_preflight.js'

// While held, a drained file dispatches no embed call (the worker returns before embedFileSerialized), so the only thing that can keep the loop out of its idle exit is the drained batch itself.
const embedHold = vi.hoisted(() => ({ held: false }))
vi.mock('../src/embed_preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Preflight>()
  return { ...actual, modelDownloadHeld: (now?: number) => embedHold.held || actual.modelDownloadHeld(now) }
})

import { appendDirtyQueuePaths } from '../src/dirty_queue.js'
import { closeDb } from '../src/db.js'
import { resolveIdleExitMs, runWorkerLoop } from '../src/worker.js'
import { stopWorker, workerPidPath } from '../src/worker_lifecycle.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
    await sleep(20)
  }
}

const dirs: string[] = []
const children: ChildProcess[] = []

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A long-lived stand-in for a daemon: it has no heartbeat and no knowledge of the pid file, which is what a daemon in its startup window looks like from outside. */
function sleepingProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

afterEach(() => {
  embedHold.held = false
  for (const c of children.splice(0)) {
    if (c.pid !== undefined && alive(c.pid)) {
      try {
        process.kill(c.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  for (const d of dirs.splice(0)) {
    closeDb(path.join(d, 'global.db'))
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // best-effort
    }
  }
})

describe('stopWorker never strands a daemon', () => {
  it('kills a live daemon that is inside its startup grace and has written no heartbeat, and clears its pid file', async () => {
    const dir = scratch('tg-retire-stop-grace-')
    const child = sleepingProcess()
    const pid = child.pid as number
    await waitFor('the stand-in to be alive', 5000, () => alive(pid))
    // The shape startDetachedWorker leaves right after a spawn: the pid file just written, no queue/drain-heartbeat yet.
    fs.writeFileSync(workerPidPath(dir), `${pid}\n`)

    expect(stopWorker(dir)).toBe(true)

    await waitFor('the daemon inside its grace to be killed', 10000, () => !alive(pid))
    expect(fs.existsSync(workerPidPath(dir))).toBe(false)
  })

  it('leaves a live pid that proves no lease, and the pid file naming it, alone', async () => {
    const dir = scratch('tg-retire-stop-nolease-')
    const child = sleepingProcess()
    const pid = child.pid as number
    await waitFor('the stand-in to be alive', 5000, () => alive(pid))
    fs.writeFileSync(workerPidPath(dir), `${pid}\n`)
    // Older than the grace, and no heartbeat: this pid may by now be an unrelated process that reused the number, so it is neither signalled nor unnamed.
    const old = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(workerPidPath(dir), old, old)

    expect(stopWorker(dir)).toBe(false)

    expect(alive(pid)).toBe(true)
    expect(fs.readFileSync(workerPidPath(dir), 'utf8').trim()).toBe(String(pid))
  })

  it('still clears a pid file that names a dead process', async () => {
    const dir = scratch('tg-retire-stop-dead-')
    const child = sleepingProcess()
    const pid = child.pid as number
    await waitFor('the stand-in to be alive', 5000, () => alive(pid))
    process.kill(pid, 'SIGKILL')
    await waitFor('the stand-in to die', 5000, () => !alive(pid))
    fs.writeFileSync(workerPidPath(dir), `${pid}\n`)

    expect(stopWorker(dir)).toBe(false)

    expect(fs.existsSync(workerPidPath(dir))).toBe(false)
  })
})

/** Run the loop until it returns or `ms` passes; 'stopped' when it returned on its own. */
async function outcomeWithin(loop: Promise<void>, ms: number): Promise<'stopped' | 'running'> {
  return Promise.race([loop.then(() => 'stopped' as const), sleep(ms).then(() => 'running' as const)])
}

describe('the daemon loop retires on its own', () => {
  it('exits once its pid file has been gone for the grace period', async () => {
    const dir = scratch('tg-retire-absent-')
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)
    const loop = runWorkerLoop(dir, 5, () => false, { pidFileGraceMs: 300, idleExitMs: 60_000 })
    expect(await outcomeWithin(loop, 100)).toBe('running')

    fs.rmSync(workerPidPath(dir))

    expect(await outcomeWithin(loop, 3000)).toBe('stopped')
  })

  it('keeps running when the pid file is replaced inside the grace period', async () => {
    const dir = scratch('tg-retire-replaced-')
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)
    let stop = false
    const loop = runWorkerLoop(dir, 5, () => stop, { pidFileGraceMs: 600, idleExitMs: 60_000 })
    await sleep(60)
    // A successor claiming the slot removes and recreates the file; the gap is not a retirement.
    fs.rmSync(workerPidPath(dir))
    await sleep(150)
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)

    // Longer than the grace measured from the removal: only a clock that is not reset by the file coming back would have left by now.
    expect(await outcomeWithin(loop, 900)).toBe('running')

    stop = true
    await loop
  })

  it('exits when the pid file names another process after a whole grace in which it never named this one', async () => {
    const dir = scratch('tg-retire-never-owned-')
    const other = process.pid === 424242 ? 424243 : 424242
    fs.writeFileSync(workerPidPath(dir), `${other}\n`)
    const loop = runWorkerLoop(dir, 5, () => false, { pidFileGraceMs: 400, idleExitMs: 60_000 })

    expect(await outcomeWithin(loop, 150)).toBe('running')
    expect(await outcomeWithin(loop, 3000)).toBe('stopped')
  })

  it('does not leave on an empty pid file, which is a read in the middle of a replacement and not an absence', async () => {
    const dir = scratch('tg-retire-empty-')
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)
    let stop = false
    const loop = runWorkerLoop(dir, 5, () => stop, { pidFileGraceMs: 150, idleExitMs: 60_000 })
    await sleep(40)
    fs.writeFileSync(workerPidPath(dir), '')

    expect(await outcomeWithin(loop, 600)).toBe('running')

    stop = true
    await loop
  })

  it('exits after the idle period with an empty queue', async () => {
    const dir = scratch('tg-retire-idle-')
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)
    const loop = runWorkerLoop(dir, 5, () => false, { pidFileGraceMs: 60_000, idleExitMs: 400 })

    expect(await outcomeWithin(loop, 100)).toBe('running')
    expect(await outcomeWithin(loop, 4000)).toBe('stopped')
  })

  it('does not count a cycle that drained work as idle', async () => {
    const dir = scratch('tg-retire-busy-')
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)
    embedHold.held = true
    const source = path.join(dir, 'busy_sample.ts')
    fs.writeFileSync(source, 'export const busySample = 1\n')
    let stop = false
    const loop = runWorkerLoop(dir, 5, () => stop, { pidFileGraceMs: 60_000, idleExitMs: 400 })
    // Fresh work every 80 ms for well over the idle period: each drained batch resets it. Changing the file keeps the sha gate from skipping it as unchanged. An embed in flight is a second, independent reason the loop counts as busy, so this guards the behaviour (work keeps the daemon alive), not the drained-batch line alone.
    const started = Date.now()
    let n = 0
    let outcome: 'stopped' | 'running' = 'running'
    while (Date.now() - started < 1500 && outcome === 'running') {
      fs.writeFileSync(source, `export const busySample = ${++n}\n`)
      appendDirtyQueuePaths(dir, [source])
      outcome = await outcomeWithin(loop, 80)
    }
    expect(outcome, 'a daemon that kept draining work left as if it were idle').toBe('running')

    stop = true
    await loop
  })
})

describe('resolveIdleExitMs', () => {
  const saved = process.env['TG_WORKER_IDLE_EXIT_MS']
  afterEach(() => {
    if (saved === undefined) delete process.env['TG_WORKER_IDLE_EXIT_MS']
    else process.env['TG_WORKER_IDLE_EXIT_MS'] = saved
  })

  it('defaults to six hours and accepts a positive integer from the environment', () => {
    delete process.env['TG_WORKER_IDLE_EXIT_MS']
    expect(resolveIdleExitMs()).toBe(6 * 60 * 60 * 1000)
    process.env['TG_WORKER_IDLE_EXIT_MS'] = '1500'
    expect(resolveIdleExitMs()).toBe(1500)
  })

  it.each(['', 'soon', '0', '-5'])('ignores %j', (value) => {
    process.env['TG_WORKER_IDLE_EXIT_MS'] = value
    expect(resolveIdleExitMs()).toBe(6 * 60 * 60 * 1000)
  })
})
