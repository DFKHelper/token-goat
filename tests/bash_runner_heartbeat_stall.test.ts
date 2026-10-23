import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { scheduleHeartbeat } from '../src/bash_runner.js'
import { spawnOwned } from '../src/process_tree.js'

// The heartbeat's quiet clock restarts when output is READ from the child's pipe. A parent whose event loop was stalled (a loaded machine, a long synchronous call) runs its due timer before the loop reads the pipes, so a child that kept writing used to get a beat for a stretch in which it was not quiet. These rows stall the loop on purpose and control, by files the child and the parent hand each other, what is in the pipe when the loop resumes; nothing waits on the clock to decide the outcome.

// HAND-DERIVED: node scripts written for this file. `burst` prints A, then prints B and marks `wrote` once the parent marks `stalling` (so B is in the pipe before the parent's stall ends). `silent` prints A and then writes nothing. Both end when their stdin does.
const BURST = 'const fs = require("fs")\nconst [stalling, wrote] = process.argv.slice(2)\nconsole.log("A")\nconst id = setInterval(() => { if (fs.existsSync(stalling)) { clearInterval(id); console.log("B"); fs.writeFileSync(wrote, "") } }, 10)\nprocess.stdin.on("end", () => process.exit(0))\nprocess.stdin.resume()\n'
const SILENT = 'console.log("A")\nprocess.stdin.on("end", () => process.exit(0))\nprocess.stdin.resume()\n'

const INTERVAL_MS = 300
// The longest the parent may stay stalled waiting for the child's second burst before the row fails; a guard against a dead child, never an allowance the outcome depends on.
const STALL_GIVE_UP_MS = 20_000

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hb-stall-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Block this thread until `ready()` holds and at least `minMs` have passed, so the heartbeat timer is due when the loop resumes. */
function stallUntil(ready: () => boolean, minMs: number): void {
  const start = Date.now()
  const gate = new Int32Array(new SharedArrayBuffer(4))
  while (!ready() || Date.now() - start < minMs) {
    if (Date.now() - start > STALL_GIVE_UP_MS) throw new Error('the child never wrote its second burst while the parent was stalled')
    Atomics.wait(gate, 0, 0, 5)
  }
}

/** Run a child under a heartbeat wired the way `run` wires it (every chunk read calls onOutput), stall the loop once the first chunk has been read, and report the beats written from then until `until` says the run has seen what it was waiting for. */
function drive(name: string, body: string, until: 'second burst' | 'first beat'): Promise<{ beats: number; sawSecondBurst: boolean }> {
  const file = path.join(dir, name + '.js')
  const stalling = path.join(dir, name + '.stalling')
  const wrote = path.join(dir, name + '.wrote')
  fs.writeFileSync(file, body)
  return new Promise((resolve, reject) => {
    const owned = spawnOwned(process.execPath, [file, stalling, wrote], { stdio: ['pipe', 'pipe', 'ignore'] })
    const child = owned.child
    let beatsSinceStall = 0
    let stalled = false
    let finished = false
    let text = ''
    const finish = (sawSecondBurst: boolean): void => {
      if (finished) return
      finished = true
      heartbeat.stop()
      resolve({ beats: beatsSinceStall, sawSecondBurst })
      child.stdin?.end()
    }
    const heartbeat = scheduleHeartbeat(Date.now(), INTERVAL_MS, () => {
      if (!stalled) return
      beatsSinceStall++
      if (until === 'first beat') finish(false)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      heartbeat.onOutput()
      text += chunk.toString('utf8')
      if (text.includes('B')) finish(true)
      if (!stalled && text.includes('A')) {
        setImmediate(() => {
          fs.writeFileSync(stalling, '')
          stallUntil(() => until === 'first beat' || fs.existsSync(wrote), INTERVAL_MS + 20)
          stalled = true
        })
      }
    })
    child.on('error', reject)
    child.on('close', () => {
      heartbeat.stop()
      owned.release()
      finish(false)
    })
  })
}

describe('bash_runner heartbeat schedule (fake clock)', () => {
  // HAND-DERIVED: the doubling schedule from the source's own contract (first beat after the interval, then twice that), restarted by output; the clock is fake, so no wall time decides a row.
  it('beats after the interval, doubles, and restarts at the interval on output', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] })
    const beats: number[] = []
    const heartbeat = scheduleHeartbeat(Date.now(), INTERVAL_MS, (elapsed) => beats.push(elapsed))
    try {
      vi.advanceTimersByTime(INTERVAL_MS - 1)
      heartbeat.onOutput()
      vi.advanceTimersByTime(INTERVAL_MS - 1)
      expect(beats, 'output restarted the first interval').toHaveLength(0)
      // The beat is written from the check phase after the timer fires, which a fake clock runs one millisecond later.
      vi.advanceTimersByTime(2)
      expect(beats, 'first beat one interval after the last output').toHaveLength(1)
      vi.advanceTimersByTime(2 * INTERVAL_MS - 1)
      expect(beats, 'the second wait is doubled').toHaveLength(1)
      vi.advanceTimersByTime(2)
      expect(beats).toHaveLength(2)
      heartbeat.onOutput()
      vi.advanceTimersByTime(INTERVAL_MS - 1)
      expect(beats, 'output after a doubled wait restarts at one interval').toHaveLength(2)
      vi.advanceTimersByTime(2)
      expect(beats).toHaveLength(3)
    } finally {
      heartbeat.stop()
      vi.useRealTimers()
    }
  })
})

describe('bash_runner heartbeat after a stalled event loop', () => {
  it('writes no beat for a child whose output is waiting unread when the loop resumes', async () => {
    const result = await drive('burst', BURST, 'second burst')
    expect(result.sawSecondBurst, 'the second burst reached the parent').toBe(true)
    expect(result.beats, 'beats written before the unread burst was read').toBe(0)
  })

  it('still writes a beat once the loop resumes if the child was quiet', async () => {
    const result = await drive('silent', SILENT, 'first beat')
    expect(result.beats, 'a beat for a stretch with nothing unread').toBeGreaterThanOrEqual(1)
  })
})
