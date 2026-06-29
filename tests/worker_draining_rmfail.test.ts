import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Make ONLY the guarded rmSync call throw, simulating a Windows sharing violation where the .draining file opens for read (readFileSync succeeds) but the delete fails (rmSync throws EBUSY). Every other fs call — the test's own setup/teardown and worker.ts's other fs use — passes straight through to the real module, so the mock is transparent outside the one guarded window. vi.spyOn cannot patch node:fs (its namespace exports are non-configurable: "Cannot redefine property"), so a module mock with a hoisted flag is the portable way to inject this failure.
const mockState = vi.hoisted(() => ({ throwRmSyncOnce: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedRmSync = (target: fs.PathLike, options?: fs.RmOptions): void => {
    if (mockState.throwRmSyncOnce) {
      mockState.throwRmSyncOnce = false
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    actual.rmSync(target, options)
  }
  return { ...actual, default: actual, rmSync: guardedRmSync }
})

import * as fs from 'node:fs'

import { drainOnce } from '../src/worker.js'

describe('drainOnce crash-recovery removal failure', () => {
  let DIR: string

  beforeEach(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rmfail-'))
  })

  afterEach(() => {
    mockState.throwRmSyncOnce = false
    fs.rmSync(DIR, { recursive: true, force: true })
  })

  it('does not discard already-read paths when the .draining removal fails (Windows sharing violation)', () => {
    // Regression: stage (a) read the abandoned .draining file and removed it inside ONE try, so an rmSync failure after a successful readFileSync hit the shared catch and ran `return 0`, discarding the already-read paths — those files never reindexed. The split-catch fix keeps the read data and processes it even when removal fails.
    const c = path.join(DIR, 'c.ts')
    fs.writeFileSync(c, 'export const c = 3\n')
    const drainingPath = path.join(DIR, 'queue', 'dirty.txt.draining')
    fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
    fs.writeFileSync(drainingPath, `${c}\n`)

    // Arm the guard so the next rmSync (the stage-(a) .draining removal) throws once.
    mockState.throwRmSyncOnce = true
    const indexed: string[] = []
    const count = drainOnce(DIR, (p) => {
      indexed.push(p)
    })

    // Pre-fix the shared catch discards rawSnapshot and returns 0 (nothing indexed); post-fix the read path survives and is processed.
    expect(count).toBe(1)
    expect(indexed).toContain(c)
  })
})
