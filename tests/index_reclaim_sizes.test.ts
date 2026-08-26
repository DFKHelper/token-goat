import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { cmdReclaimIndex, comparableSizes } from '../src/index_reclaim.js'
import type { ReclaimResult } from '../src/index_reclaim.js'

/**
 * Which before/after pair `reclaim-index` reports.
 *
 * This is an accounting question, not a plumbing one. VACUUM in WAL mode rewrites the whole
 * database through the sidecar, so a checkpoint that a reader blocks leaves the DB+WAL total
 * holding two copies at once. Subtracting that total reports a *negative* reclaim for a run that
 * genuinely freed space -- a number that is not merely imprecise but points the wrong way, which
 * is the worst shape for a savings figure because a user reads it as the command having made
 * things worse.
 */
function result(over: Partial<ReclaimResult> = {}): ReclaimResult {
  return {
    beforeBytes: 0,
    afterBytes: 0,
    beforeDbBytes: 0,
    afterDbBytes: 0,
    dropped: {},
    rebuilt: false,
    checkpointBusy: false,
    vacuumDeferred: false,
    ...over,
  }
}

describe('reclaim-index size accounting', () => {
  it('reports the main file alone when a blocked checkpoint left the rewrite in the WAL', () => {
    // The real run that motivated this, in bytes: DB+WAL appeared to grow 1345.3 -> 2494.4 MB
    // while the database itself went 1310 -> 1177 MB.
    const sizes = comparableSizes(
      result({
        beforeBytes: 1_410_500_000,
        afterBytes: 2_615_400_000,
        beforeDbBytes: 1_373_683_712,
        afterDbBytes: 1_234_500_000,
        checkpointBusy: true,
      }),
    )

    expect(sizes.freed).toBeGreaterThan(0)
    expect(sizes.before).toBe(1_373_683_712)
    expect(sizes.after).toBe(1_234_500_000)
  })

  it('keeps the DB+WAL total when the checkpoint succeeded', () => {
    // A stale WAL that was folded back really was space held, so counting it is correct here.
    // Without this case a fix could pass by always reporting the main file and silently drop a
    // WAL reclaim from the figure.
    const sizes = comparableSizes(
      result({
        beforeBytes: 500,
        afterBytes: 300,
        beforeDbBytes: 400,
        afterDbBytes: 290,
        checkpointBusy: false,
      }),
    )

    expect(sizes.before).toBe(500)
    expect(sizes.after).toBe(300)
    expect(sizes.freed).toBe(200)
  })

  it('keeps the DB+WAL total when a blocked checkpoint still left the index smaller', () => {
    // checkpointBusy alone is not the trigger. The total only becomes incomparable when it grew,
    // which is the fingerprint of the rewrite still sitting in the sidecar.
    const sizes = comparableSizes(
      result({
        beforeBytes: 900,
        afterBytes: 700,
        beforeDbBytes: 800,
        afterDbBytes: 650,
        checkpointBusy: true,
      }),
    )

    expect(sizes.before).toBe(900)
    expect(sizes.after).toBe(700)
    expect(sizes.freed).toBe(200)
  })

  it('never reports a negative reclaim for a run that shrank the database', () => {
    // The property behind all three cases above, stated once as the thing that must hold.
    for (const checkpointBusy of [true, false]) {
      const sizes = comparableSizes(
        result({
          beforeBytes: 1000,
          afterBytes: checkpointBusy ? 1900 : 800,
          beforeDbBytes: 1000,
          afterDbBytes: 800,
          checkpointBusy,
        }),
      )
      expect(sizes.freed).toBe(200)
    }
  })
})

describe('reclaim-index growth is not reported as a negative saving', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reclaim-grow-'))
  })

  afterEach(() => {
    closeAllDbs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function run(dbPath: string): string {
    const chunks: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      cmdReclaimIndex({ dbPath, force: true })
    } finally {
      process.stdout.write = original
    }
    return chunks.join('')
  }

  it('says the index grew rather than claiming a negative reclaim', () => {
    // Against a path with no database, reclaim-index creates one: every byte is growth and there
    // was never anything to reclaim. Reporting that as "freed -0.2 MB" reads as the command
    // having made things worse, which is the one thing a savings figure must never do.
    const out = run(path.join(dir, 'global.db'))

    expect(out).toContain('grew ')
    expect(out).not.toContain('freed -')
  })
})
