import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: drainOnce's stage (b) rename-to-claim pattern assumes no other writer can touch
// the live dirty-queue file's underlying content once it has been renamed to `.draining`. That
// isn't guaranteed: on Windows, FILE_SHARE_DELETE semantics let a concurrent open-for-append that
// started just before the rename keep writing to the SAME underlying file object, now named
// `.draining`, even though the writer intended to append to the live `dirty.txt` path -- and a
// similar narrow open/rename race exists on POSIX. Without a re-read immediately before deleting
// the claimed `.draining` file, any line appended during that window is silently discarded along
// with the rest of the already-processed batch and never reindexed.
//
// This drives the real drainOnce entry point. The only mocked boundary is node:fs.readFileSync,
// made to answer two different snapshots of the SAME `.draining` path across drainOnce's two
// reads of it (the initial claim-read, and the fix's re-check right before delete) -- simulating
// a concurrent append landing in that exact window. vi.spyOn cannot patch node:fs (its namespace
// exports are non-configurable), so a module mock with a hoisted queue is the portable way to
// inject this, matching the pattern already used in parser_sha_race.test.ts and
// worker_draining_rmfail.test.ts.
const mockState = vi.hoisted(() => ({ target: '', queue: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedReadFileSync = (
    target: fs.PathOrFileDescriptor,
    options?: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | null,
  ): string | Buffer => {
    if (typeof target === 'string' && target === mockState.target && mockState.queue.length > 0) {
      const version = mockState.queue.shift() as string
      return options === 'utf8' ? version : Buffer.from(version, 'utf8')
    }
    return actual.readFileSync(target, options as never)
  }
  return { ...actual, default: actual, readFileSync: guardedReadFileSync }
})

import * as fs from 'node:fs'

import { closeDb } from '../src/db.js'
import { drainOnce } from '../src/worker.js'

describe('drainOnce stage (b) rename-claim race (regression)', () => {
  let DIR: string

  beforeEach(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rename-race-'))
  })

  afterEach(() => {
    mockState.target = ''
    mockState.queue = []
    closeDb(path.join(DIR, 'global.db'))
    fs.rmSync(DIR, { recursive: true, force: true })
  })

  it('forwards a path appended to the underlying .draining file during the claim window back into the live queue instead of losing it', () => {
    const c = path.join(DIR, 'c.ts')
    const d = path.join(DIR, 'd.ts')
    fs.writeFileSync(c, 'export const c = 3\n')
    fs.writeFileSync(d, 'export const d = 4\n')

    const queuePath = path.join(DIR, 'queue', 'dirty.txt')
    const drainingPath = `${queuePath}.draining`
    fs.mkdirSync(path.dirname(queuePath), { recursive: true })
    fs.writeFileSync(queuePath, `${c}\n`)

    // First read of `.draining` (drainOnce's own claim-read) sees only what was live when the
    // rename happened. Second read (the fix's re-check, right before delete) sees an extra line
    // -- simulating a concurrent appendDirtyPath call whose write landed on the same underlying
    // file object after the rename, before this drain cycle deleted it.
    mockState.target = drainingPath
    mockState.queue = [`${c}\n`, `${c}\n${d}\n`]

    const indexed: string[] = []
    const count1 = drainOnce(DIR, (p) => {
      indexed.push(p)
    })

    // Only `c` was in this cycle's claimed batch.
    expect(count1).toBe(1)
    expect(indexed).toEqual([c])
    // Pre-fix: the raced-in `d` line was silently discarded along with the deleted .draining
    // file. Post-fix: it is forwarded back into the live queue for the next cycle to pick up.
    expect(fs.existsSync(queuePath)).toBe(true)
    expect(fs.readFileSync(queuePath, 'utf8')).toContain(d)

    // Next drain cycle claims the forwarded live queue (no more mocked .draining content left, so
    // this cycle reads the real file straight through).
    const count2 = drainOnce(DIR, (p) => {
      indexed.push(p)
    })
    expect(count2).toBe(1)
    expect(indexed).toEqual([c, d])
  })

  it('leaves a normal (non-racing) drain unaffected -- both reads see identical content', () => {
    const c = path.join(DIR, 'c.ts')
    fs.writeFileSync(c, 'export const c = 3\n')

    const queuePath = path.join(DIR, 'queue', 'dirty.txt')
    const drainingPath = `${queuePath}.draining`
    fs.mkdirSync(path.dirname(queuePath), { recursive: true })
    fs.writeFileSync(queuePath, `${c}\n`)

    // Both the claim-read and the re-check see the same unchanged content -- no writer raced
    // the rename this cycle.
    mockState.target = drainingPath
    mockState.queue = [`${c}\n`, `${c}\n`]

    const indexed: string[] = []
    const count = drainOnce(DIR, (p) => {
      indexed.push(p)
    })

    expect(count).toBe(1)
    expect(indexed).toEqual([c])
    // Nothing to forward: the live queue should not exist (the claimed file was fully consumed
    // and cleanly removed).
    expect(fs.existsSync(queuePath)).toBe(false)
    expect(fs.existsSync(drainingPath)).toBe(false)
  })
})
