import fs from 'fs'
import path from 'path'
import os from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead, takePendingLargeFileHint, recordLargeFileHintPending } from '../src/session.js'

const tmpFiles: string[] = []

function makeTmpFile(content = 'data', sizeBytes?: number): string {
  const p = path.join(
    os.tmpdir(),
    `tg-find3-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  )
  // Create file with specified size (or use content length if no size specified)
  const actualContent = sizeBytes !== undefined ? 'x'.repeat(sizeBytes) : content
  fs.writeFileSync(p, actualContent)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string | undefined): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test-finding3',
    raw: {},
  }
}

beforeEach(() => {
  clearModuleCaches()
  // Set a unique session ID for each test
  process.env.CLAUDE_CODE_SESSION_ID = `test-finding3-${Date.now()}`
})

afterEach(() => {
  clearModuleCaches()
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
  delete process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES
})

describe('Finding #3 — large-file hint outcomes logging', () => {
  it('with flag OFF (default): large-file hint does NOT record pending hint', () => {
    const largeFile = makeTmpFile('', 150 * 1024) // 150KB > LARGE_FILE_BYTES (100KB)
    const normalized = normalizePath(largeFile)

    // Verify flag is OFF by default
    expect(process.env.TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES).toBeUndefined()

    // Fire a large-file hint by attempting to read the large file
    const event = readEvent(largeFile)
    const result = preReadHandler(event)

    // Verify the hint was fired (context message about large file)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('large')
    }

    // Verify no pending hint was recorded (with flag off)
    const pending = takePendingLargeFileHint(normalized)
    expect(pending).toBeNull()
  })

  it('with flag ON: large-file hint records pending hint', () => {
    process.env.TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES = '1'
    const largeFile = makeTmpFile('', 150 * 1024) // 150KB
    const normalized = normalizePath(largeFile)

    // Fire a large-file hint
    clearModuleCaches() // Clear to pick up the env var
    const event = readEvent(largeFile)
    const result = preReadHandler(event)

    // Verify the hint was fired
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('large')
    }

    // Verify pending hint WAS recorded (with flag on)
    const pending = takePendingLargeFileHint(normalized)
    expect(pending).toBe(150 * 1024) // Should return the file size
  })

  it('with flag ON: pending hint is consumed when file is re-read (ignored outcome)', () => {
    process.env.TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES = '1'
    const largeFile = makeTmpFile('', 150 * 1024)
    const normalized = normalizePath(largeFile)

    // First read: fire the large-file hint
    clearModuleCaches()
    let event = readEvent(largeFile)
    const result = preReadHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('large')
    }

    // Verify pending hint was recorded
    let pending = takePendingLargeFileHint(normalized)
    expect(pending).toBe(150 * 1024)

    // Restore the hint (because we took it, it was consumed)
    recordLargeFileHintPending(normalized, 150 * 1024)

    // Simulate time passing and a second read attempt in the same session (don't clear caches to keep hints)
    recordFileRead(normalized) // Mark it as read so the re-read dedup logic triggers

    // Second read: re-read the file (full Read, not surgical token-goat read)
    event = readEvent(largeFile)
    preReadHandler(event)

    // Should have recorded "ignored" outcome (hint fired but full read was done)
    // The hint should have been consumed by the re-read handler
    pending = takePendingLargeFileHint(normalized)
    expect(pending).toBeNull() // Should be null because it was consumed
  })

  it('pending hint is not double-consumed', async () => {
    process.env.TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES = '1'
    const largeFile = makeTmpFile('', 150 * 1024)
    const normalized = normalizePath(largeFile)

    // Manually record a pending hint
    clearModuleCaches()
    recordLargeFileHintPending(normalized, 150 * 1024)

    // Take it once
    let pending = takePendingLargeFileHint(normalized)
    expect(pending).toBe(150 * 1024)

    // Try to take it again
    pending = takePendingLargeFileHint(normalized)
    expect(pending).toBeNull() // Should be consumed
  })

  it('multiple large files with hints tracked independently', () => {
    process.env.TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES = '1'
    const file1 = makeTmpFile('', 120 * 1024)
    const file2 = makeTmpFile('', 130 * 1024)
    const normalized1 = normalizePath(file1)
    const normalized2 = normalizePath(file2)

    clearModuleCaches()

    // Fire hint on file1
    let event = readEvent(file1)
    let result = preReadHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('large')
    }

    // Fire hint on file2
    event = readEvent(file2)
    result = preReadHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('large')
    }

    // Verify both pending hints were recorded
    const pending1 = takePendingLargeFileHint(normalized1)
    expect(pending1).toBe(120 * 1024)

    const pending2 = takePendingLargeFileHint(normalized2)
    expect(pending2).toBe(130 * 1024)

    // Both should be null now (consumed)
    expect(takePendingLargeFileHint(normalized1)).toBeNull()
    expect(takePendingLargeFileHint(normalized2)).toBeNull()
  })
})
