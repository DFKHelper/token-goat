/** retireDisplacedWorker runs in a daemon and returns nothing, so a holder whose command line Windows hides (an elevated process) cannot be reported through a return value or an exit code: it is never signalled, and its pid is appended to worker-errors.log, the file a daemon's notes go to (worker.ts, reconcile_requests.ts), so the process left running is not silently taken for a stranger. */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ResidentProcessModule from '../src/resident_process.js'

const spies = vi.hoisted(() => ({ terminate: vi.fn() }))

vi.mock('../src/resident_process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ResidentProcessModule>()
  return { ...actual, isResidentOfInstall: (cmd: string) => cmd.includes('--worker-daemon'), terminateProcessTree: spies.terminate }
})

const { displacedWorkerPath, retireDisplacedWorker, workerErrorLogPath } = await import('../src/worker_lifecycle.js')

let dir: string
const decoys: ChildProcess[] = []

// HAND-DERIVED: a live process that is not this one and holds no lease, which is all retireDisplacedWorker needs of a holder; the note line format `<pid> <ms> <dir>` is read off tests/worker_displaced_note.test.ts::noteLine.
function startHolder(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker-daemon'], { stdio: 'ignore', windowsHide: true })
  decoys.push(child)
  return child.pid!
}

function noteFor(pid: number): void {
  fs.writeFileSync(displacedWorkerPath(dir), `${pid} ${Date.now()} ${dir}\n`)
}

function errorLog(): string {
  return fs.existsSync(workerErrorLogPath(dir)) ? fs.readFileSync(workerErrorLogPath(dir), 'utf8') : ''
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-displaced-hidden-'))
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true })
  spies.terminate.mockClear()
})

afterEach(() => {
  for (const child of decoys.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('retireDisplacedWorker over a holder whose command line is hidden', () => {
  it('signals nobody and names the holder in the error log', () => {
    const holder = startHolder()
    noteFor(holder)

    retireDisplacedWorker(dir, { readCommandLine: () => '' })

    expect(spies.terminate).not.toHaveBeenCalled()
    const log = errorLog()
    expect(log).toContain(`pid ${holder}`)
    expect(log).toContain('command line is hidden')
    expect(log).toContain('not ended')
  }, 60_000)

  it('names the holder when the second read, taken right before the kill, is the one that comes back hidden', () => {
    const holder = startHolder()
    noteFor(holder)
    const answers = ['node launcher.mjs --worker-daemon', '']

    retireDisplacedWorker(dir, { readCommandLine: () => answers.shift() ?? null })

    expect(spies.terminate).not.toHaveBeenCalled()
    expect(errorLog()).toContain(`pid ${holder}`)
  }, 60_000)

  it('says nothing for a holder whose command line cannot be read, or reads as another program', () => {
    const unreadable = startHolder()
    const stranger = startHolder()
    fs.writeFileSync(displacedWorkerPath(dir), [unreadable, stranger].map((pid) => `${pid} ${Date.now()} ${dir}\n`).join(''))

    retireDisplacedWorker(dir, { readCommandLine: (pid) => (pid === unreadable ? null : 'node other.js') })

    expect(spies.terminate).not.toHaveBeenCalled()
    expect(errorLog()).toBe('')
  }, 60_000)
})
