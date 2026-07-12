import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// Regression: worker-errors.log and .draining.corrupt-* quarantine files (see drainOnce's
// cleanup-failure fallback) had no rotation or cleanup mechanism at all -- both could grow
// unbounded over a project's index lifetime. cleanupWorkerStateFiles mirrors the size/age-cutoff
// pattern already used elsewhere in this codebase for other accumulating state (disk_cache.ts's
// pruneBlobs, snapshots.ts's cleanup_stale).
import { cleanupWorkerStateFiles } from '../src/worker.js'

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

  it('is a no-op fail-soft when neither the log file nor the queue dir exist', () => {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-rotate-empty-'))
    try {
      expect(() => cleanupWorkerStateFiles(DIR)).not.toThrow()
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true })
    }
  })
})
