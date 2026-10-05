/** The drain heartbeat must never be observed half-written. `writeDrainHeartbeat` used to rewrite `queue/drain-heartbeat` in place with `fs.writeFileSync`, which truncates the file to zero bytes before writing the pid. A reader in another process that opened it inside that window read an empty string, `hasFreshWorkerHeartbeat` compared '' against the pid and answered false, and `isWorkerRunning` reported a live, draining worker as dead: that is the one-off "Worker is not running" flake `worker_daemon_e2e` produced once the worker started waking on every queue append and so rewrote the heartbeat far more often. The race needs two processes, so the reader is a plain child `node` loop reading the real file as fast as it can while this process calls the real `writeDrainHeartbeat` in a tight loop. Measured against the in-place write: thousands of empty reads per run (6134 of 25819 in the report that found it). Against the temp-file-and-rename write: none. Provenance: CAPTURE. Both the torn reads and their absence are what a real second process sees on the real filesystem; nothing is asserted on the implementation's own source. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { drainHeartbeatPathFor, writeDrainHeartbeat } from '../src/worker_lifecycle.js'

const READER = `
const fs = require('node:fs')
const [file, expected, stopFile, outFile] = process.argv.slice(1)
let reads = 0, torn = 0, errors = 0
while (!fs.existsSync(stopFile)) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    reads++
    if (text !== expected) torn++
  } catch (e) {
    if (e.code !== 'ENOENT') errors++
  }
}
fs.writeFileSync(outFile, JSON.stringify({ reads, torn, errors }))
`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('writeDrainHeartbeat', () => {
  it('is never read half-written by another process while it is being rewritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-heartbeat-'))
    dirs.push(dir)
    writeDrainHeartbeat(dir, true)
    const file = drainHeartbeatPathFor(dir)
    const stopFile = path.join(dir, 'stop')
    const outFile = path.join(dir, 'result.json')

    const child = spawn(process.execPath, ['-e', READER, file, `${process.pid}\n`, stopFile, outFile], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    // Let the reader get going before the writes start, so the window is actually contested.
    await new Promise((resolve) => setTimeout(resolve, 300))

    // 1.5 s, and past that until 20 writes have landed: under a loaded full-suite run on Windows the retried renames were once slow enough that 1.5 s held only 7, failing the floor below with nothing wrong. The 10 s cap keeps a truly stuck writer from hanging the test.
    const deadline = Date.now() + 1500
    const hardDeadline = Date.now() + 10_000
    let writes = 0
    while (Date.now() < deadline || (writes < 20 && Date.now() < hardDeadline)) {
      writeDrainHeartbeat(dir, true)
      writes++
    }
    fs.writeFileSync(stopFile, '')
    await exited

    const result = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { reads: number; torn: number; errors: number }
    // A rename contested by a reader this aggressive retries on Windows (withRetryOnLock), so the write count here is in the tens, not thousands; each one is still a contested window.
    expect(writes).toBeGreaterThan(10)
    expect(result.reads).toBeGreaterThan(100)
    expect(result).toMatchObject({ torn: 0, errors: 0 })
  }, 20000)
})
