import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Make ONLY the guarded rmSync/renameSync calls throw, simulating a Windows sharing violation where the .draining file opens for read (readFileSync succeeds) but the delete (and, for the second describe block below, the quarantine rename) fails. Every other fs call — the test's own setup/teardown and worker.ts's other fs use — passes straight through to the real module, so the mock is transparent outside the guarded windows. vi.spyOn cannot patch node:fs (its namespace exports are non-configurable: "Cannot redefine property"), so a module mock with hoisted flags is the portable way to inject these failures.
const mockState = vi.hoisted(() => ({ throwRmSyncOnce: false, throwRenameSyncOnce: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedRmSync = (target: fs.PathLike, options?: fs.RmOptions): void => {
    if (mockState.throwRmSyncOnce) {
      mockState.throwRmSyncOnce = false
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    actual.rmSync(target, options)
  }
  const guardedRenameSync = (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
    if (mockState.throwRenameSyncOnce) {
      mockState.throwRenameSyncOnce = false
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    actual.renameSync(oldPath, newPath)
  }
  return { ...actual, default: actual, rmSync: guardedRmSync, renameSync: guardedRenameSync }
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

describe('drainOnce crash-recovery removal+quarantine both fail (stale .draining reprocessing)', () => {
  let DIR: string

  beforeEach(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-drainfail-'))
  })

  afterEach(() => {
    mockState.throwRmSyncOnce = false
    mockState.throwRenameSyncOnce = false
    fs.rmSync(DIR, { recursive: true, force: true })
  })

  // Regression (M1): when BOTH the rmSync removal AND the renameSync-to-quarantine fallback fail
  // (e.g. a persistent Windows sharing violation, not a one-shot transient failure), the .draining
  // file survives on disk under its original name. The next drain cycle re-reads that same file and
  // reprocesses its paths a second time. This drives the real drainOnce entry point across two
  // consecutive cycles — the only way to observe the duplicate-processing symptom — rather than
  // asserting on cleanup-fallback internals directly.
  it('does not reprocess an abandoned .draining file once both rmSync and the quarantine renameSync fail', () => {
    const c = path.join(DIR, 'c.ts')
    fs.writeFileSync(c, 'export const c = 3\n')
    const drainingPath = path.join(DIR, 'queue', 'dirty.txt.draining')
    fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
    fs.writeFileSync(drainingPath, `${c}\n`)

    // Arm both guards so stage (a)'s rmSync AND its renameSync-to-quarantine fallback both throw
    // once, simulating a lock that survives the entire first drain cycle.
    mockState.throwRmSyncOnce = true
    mockState.throwRenameSyncOnce = true
    const indexed: string[] = []
    const count1 = drainOnce(DIR, (p) => indexed.push(p))

    // The already-read content is still processed this cycle...
    expect(count1).toBe(1)
    expect(indexed).toEqual([c])
    // ...but since both cleanup attempts failed, the .draining file is still on disk under its
    // original name (not quarantined, not removed).
    expect(fs.existsSync(drainingPath)).toBe(true)

    // Second drain cycle: the lock has cleared (guards are no longer armed), so cleanup would now
    // succeed. Pre-fix, the unchanged .draining content is re-read and reprocessed, duplicating `c`
    // in the batch. Post-fix, drainOnce recognizes the unchanged snapshot it already queued last
    // cycle and skips it, while still completing cleanup now that the lock is gone.
    const count2 = drainOnce(DIR, (p) => indexed.push(p))
    expect(count2).toBe(0)
    expect(indexed).toEqual([c])
    expect(fs.existsSync(drainingPath)).toBe(false)
  })
})
