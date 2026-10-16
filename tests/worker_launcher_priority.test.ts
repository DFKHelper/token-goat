/** The launcher lowers the daemon's priority itself, at once, instead of leaving it at the launcher's priority until the daemon's own boot reaches applyIndexingPriority. A launcher is usually a hook running at normal priority, and a daemon takes seconds to boot on a slow or busy machine. The spawn is replaced by a stand-in that never lowers anything, so the only thing that can have lowered it by the time startDetachedWorker returns is startDetachedWorker; the real daemon, on the real default path, is tests/worker_priority_e2e.test.ts. Provenance: HAND-DERIVED. The expectation comes from Node's documented priority scale (os.constants.priority: a larger number is a lower priority). */
import type * as ChildProcessModule from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// tg-no-regex-preload

// The stand-in ends when its owner (this test process) does, or when the test kills it.
const STAND_IN = 'const owner = Number(process.argv[1]); setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 500)'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  return {
    ...real,
    spawn: () => real.spawn(process.execPath, ['-e', STAND_IN, String(process.pid)], { stdio: 'ignore', windowsHide: true }),
  }
})

const { startDetachedWorker } = await import('../src/worker_lifecycle.js')
const { killProcessTree } = await import('../src/process_tree.js')

const tempDirs: string[] = []
const started: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

afterEach(() => {
  for (const pid of started.splice(0)) if (alive(pid)) killProcessTree(pid)
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// The stand-in inherits this process's priority. A test process that already runs below normal (CI under nice, an earlier in-process lowering) would pass whether or not the launcher lowered anything, so there the test is skipped rather than left to pass vacuously.
const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL

describe('startDetachedWorker', () => {
  it.skipIf(os.getPriority(0) >= BELOW_NORMAL)('lowers the daemon it just spawned before it returns', () => {
    expect(os.getPriority(0), 'the test process itself must start above the level it asserts').toBeLessThan(BELOW_NORMAL)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-launcher-priority-'))
    tempDirs.push(dir)
    const pid = startDetachedWorker({ dataDir: dir })
    started.push(pid)
    expect(os.getPriority(pid), 'the freshly spawned daemon is still at the launcher priority').toBeGreaterThanOrEqual(BELOW_NORMAL)
  })
})
