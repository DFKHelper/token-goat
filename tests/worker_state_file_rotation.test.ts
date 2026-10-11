import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// Regression: worker-errors.log and .draining.corrupt-* quarantine files (see drainOnce's cleanup-failure fallback) had no rotation or cleanup mechanism at all -- both could grow unbounded over a project's index lifetime. cleanupWorkerStateFiles mirrors the size/age-cutoff pattern already used elsewhere in this codebase for other accumulating state (disk_cache.ts's pruneBlobs, snapshots.ts's cleanup_stale).
import { cleanupWorkerStateFiles } from '../src/worker.js'
import { dirtyQueuePathFor } from '../src/dirty_queue.js'

describe('cleanupWorkerStateFiles', () => {
  it('rotates (truncates) worker-errors.log once it exceeds the size cap', () => {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-log-'))
    try {
      const logPath = path.join(DIR, 'worker-errors.log')
      // Oversized: comfortably past the 5MB cap.
      fs.writeFileSync(logPath, 'x'.repeat(6 * 1024 * 1024))

      cleanupWorkerStateFiles(DIR)

      const statAfter = fs.statSync(logPath)
      expect(statAfter.size).toBeLessThan(6 * 1024 * 1024)
      expect(fs.readFileSync(logPath, 'utf8')).toContain('rotated')
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })

  it('leaves worker-errors.log untouched when it is under the size cap', () => {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-log-small-'))
    try {
      const logPath = path.join(DIR, 'worker-errors.log')
      const content = 'small log entry\n'
      fs.writeFileSync(logPath, content)

      cleanupWorkerStateFiles(DIR)

      expect(fs.readFileSync(logPath, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })

  it('removes .corrupt-* quarantine files older than the age cutoff, keeping recent ones', () => {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-corrupt-'))
    try {
      const queueDir = path.join(DIR, 'queue')
      fs.mkdirSync(queueDir, { recursive: true })
      const staleCorrupt = path.join(queueDir, 'dirty.txt.draining.corrupt-111')
      const freshCorrupt = path.join(queueDir, 'dirty.txt.draining.corrupt-222')
      fs.writeFileSync(staleCorrupt, 'old\n')
      fs.writeFileSync(freshCorrupt, 'new\n')

      const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
      fs.utimesSync(staleCorrupt, staleTime, staleTime)

      cleanupWorkerStateFiles(DIR)

      expect(fs.existsSync(staleCorrupt)).toBe(false)
      expect(fs.existsSync(freshCorrupt)).toBe(true)
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })

  // Provenance: HAND-DERIVED. cleanupWorkerStateFiles runs periodically inside runWorkerLoop over the same directory as the live dirty queue, so only a `.corrupt-` name may make a queue-dir file eligible for age-based deletion; a live queue file past the age cutoff must survive. Moved here from worker.test.ts, where it was the only test that pinned the `.corrupt-` name filter (the old/young quarantine cases there duplicated the test above).
  it('never removes a non-quarantine file in the queue dir, no matter how old', () => {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-live-queue-'))
    try {
      fs.mkdirSync(path.dirname(dirtyQueuePathFor(DIR)), { recursive: true })
      const liveQueuePath = dirtyQueuePathFor(DIR)
      fs.writeFileSync(liveQueuePath, '/still/live/file.ts\n')
      const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
      fs.utimesSync(liveQueuePath, staleTime, staleTime)

      cleanupWorkerStateFiles(DIR)

      expect(fs.existsSync(liveQueuePath)).toBe(true)
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })

  it('removes expired known-root-record markers, keeping ones inside the throttle window', () => {
    // Regression: recordKnownRootThrottled writes one marker per directory ever edited and nothing ever removed them, so a long-lived data dir accumulated hundreds. Deleting an expired one is behaviour-neutral because the throttle already treats a marker older than its one-hour interval as absent.
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-marker-'))
    try {
      const staleMarker = path.join(DIR, 'known-root-record-deadbeefdeadbeef.marker')
      const freshMarker = path.join(DIR, 'known-root-record-cafebabecafebabe.marker')
      const unrelated = path.join(DIR, 'config.toml')
      fs.writeFileSync(staleMarker, '')
      fs.writeFileSync(freshMarker, '')
      fs.writeFileSync(unrelated, 'keep = true\n')

      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000)
      fs.utimesSync(staleMarker, staleTime, staleTime)

      cleanupWorkerStateFiles(DIR)

      expect(fs.existsSync(staleMarker)).toBe(false)
      expect(fs.existsSync(freshMarker)).toBe(true)
      expect(fs.existsSync(unrelated)).toBe(true)
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })

  it('is a no-op fail-soft when neither the log file nor the queue dir exist', () => {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-empty-'))
    try {
      expect(() => cleanupWorkerStateFiles(DIR)).not.toThrow()
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })
})
