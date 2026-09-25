// An edit queued while the worker claims the queue is not lost. The worker claims `dirty.txt` by renaming it, processes the renamed file, reads it once more and deletes it. A producer that opened `dirty.txt` for append just before the rename still holds the renamed file, so if its write lands after that last read, the path goes out with the delete and the file stays stale in every read command until something edits it again. Provenance: HAND-DERIVED. The interleaving (open, rename, write) is the one the claim's own comment in src/worker.ts::drainOnce describes, forced here by a pass-through `node:fs` that renames the queue at the moment the producer's write begins.
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as NodeFsModule from 'node:fs'

type NodeFs = typeof NodeFsModule

const claim = vi.hoisted(() => ({ queuePath: '', armed: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFs>()
  const claimNow = (): void => {
    claim.armed = false
    actual.renameSync(claim.queuePath, `${claim.queuePath}.draining`)
  }
  // The producer as it wrote before: one call that opens, writes and closes, with the claim forced between the open and the write.
  const appendFileSync = (file: Parameters<NodeFs['appendFileSync']>[0], data: string, ...rest: unknown[]): void => {
    if (!claim.armed || String(file) !== claim.queuePath) return (actual.appendFileSync as (...a: unknown[]) => void)(file, data, ...rest)
    const fd = actual.openSync(claim.queuePath, 'a')
    try {
      claimNow()
      actual.writeFileSync(fd, data)
    } finally {
      actual.closeSync(fd)
    }
  }
  // The producer writing through a descriptor it opened itself: the claim lands between that open and this write.
  const writeFileSync = (file: Parameters<NodeFs['writeFileSync']>[0], ...rest: unknown[]): void => {
    if (claim.armed && typeof file === 'number') claimNow()
    ;(actual.writeFileSync as (...a: unknown[]) => void)(file, ...rest)
  }
  return { ...actual, default: { ...actual, appendFileSync, writeFileSync }, appendFileSync, writeFileSync }
})

const fs = await vi.importActual<NodeFs>('node:fs')
const { appendDirtyPaths, dirtyQueuePath } = await import('../src/hooks_index.js')

afterEach(() => {
  claim.armed = false
})

function liveQueue(): string[] {
  return fs.existsSync(claim.queuePath) ? fs.readFileSync(claim.queuePath, 'utf8').split('\n').filter(Boolean) : []
}

describe('a dirty-queue append that a claim renames mid-write', () => {
  it('lands in the live queue, not only in the claimed file the worker is about to delete', () => {
    claim.queuePath = dirtyQueuePath()
    fs.mkdirSync(path.dirname(claim.queuePath), { recursive: true })
    fs.writeFileSync(claim.queuePath, '/proj/already-queued.ts\n')

    claim.armed = true
    appendDirtyPaths(['/proj/edited-during-the-claim.ts'])

    expect(claim.armed, 'calibration: the claim was forced between the open and the write').toBe(false)
    // What the worker does with the claim once processed: the late path in it goes with the delete.
    fs.rmSync(`${claim.queuePath}.draining`, { force: true })
    expect(liveQueue()).toContain('/proj/edited-during-the-claim.ts')
  })

  it('appends once when no claim intervenes', () => {
    claim.queuePath = dirtyQueuePath()
    fs.mkdirSync(path.dirname(claim.queuePath), { recursive: true })
    fs.writeFileSync(claim.queuePath, '')

    appendDirtyPaths(['/proj/a.ts', '/proj/b.ts'])

    expect(liveQueue()).toEqual(['/proj/a.ts', '/proj/b.ts'])
  })
})
