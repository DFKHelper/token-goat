/**
 * End-to-end regression for the "stale-index trap": symbol/read/skeleton/outline used to detect
 * a SHA mismatch between the indexed row and the on-disk file and just prepend a warning telling
 * the agent to re-index or read the file directly -- i.e. the tool's own fallback advice was
 * "burn a full-file read", defeating the entire purpose of a surgical-read tool. The fix
 * (healStaleIndex in read_commands.ts) self-heals inline: on a SHA mismatch it synchronously
 * reparses the one file via the same indexFileSync entry point the worker's dirty-queue drain
 * and --force-refresh already use, then lets the caller's own query pick up the fresh rows.
 *
 * These tests drive the REAL, unmocked pipeline end to end: a real indexFileSync seed, a real
 * on-disk edit made WITHOUT going through appendDirtyPath/the edit hook (so the index is
 * genuinely stale, not just queued), and the real runSymbol/runRead/runSkeleton/runOutline
 * command functions querying the real (test-isolated) global.db -- no injected querySymbols/
 * getFileEntry/indexFileSync callback, which is exactly the "injected-seam trap" CLAUDE.md
 * warns about (a mocked dependency the shipping path doesn't have would hide whether the fix
 * actually works against the production wiring). Mirrors the real-DB pattern already used by
 * tests/read_commands_stats.test.ts (indexFileSync + runSymbol/runRead against the real DB, no
 * mocks) rather than read_commands.test.ts's heavily-mocked unit-test style.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi, afterEach } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import * as parserModule from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { getFileEntry } from '../src/index_reader.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { runSymbol, runRead, runSkeleton, runOutline } from '../src/read_commands.js'

describe('stale-index self-heal (real pipeline, no injected callbacks)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runSymbol serves fresh data (no STALE warning) after an out-of-band edit makes the index stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-selfheal-symbol-'))
    try {
      const file = join(root, 'a.ts')
      writeFileSync(file, 'export function oldSelfHealSym9k(): number {\n  return 1\n}\n')
      indexFileSync(normalizePath(file))

      // Genuine staleness: edit the file directly on disk, bypassing appendDirtyPath/the edit
      // hook entirely, so the index still holds the old row and its stored sha no longer
      // matches the file's current bytes.
      writeFileSync(file, 'export function freshSelfHealSym9k(): number {\n  return 2\n}\n')

      const { text, code } = runSymbol({ name: 'freshSelfHealSym9k', file })
      expect(code).toBe(0)
      expect(text).toContain('freshSelfHealSym9k')
      expect(text).not.toContain('STALE')

      // The DB row itself must have been rewritten, not just the command's own output patched
      // up -- prove the sha now matches the on-disk file.
      const resolved = normalizePath(file)
      const entry = getFileEntry(resolved)
      expect(entry).not.toBeNull()
      expect(entry?.sha).toBe(fingerprintFile(resolved))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runRead resolves file::symbol to the fresh body after an out-of-band edit', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-selfheal-read-'))
    try {
      const file = join(root, 'b.ts')
      writeFileSync(file, 'export function oldSelfHealRead9k(): number {\n  return 1\n}\n')
      indexFileSync(normalizePath(file))

      writeFileSync(file, 'export function freshSelfHealRead9k(): number {\n  return 42\n}\n')

      const { text, code } = runRead({ spec: `${file}::freshSelfHealRead9k` })
      expect(code).toBe(0)
      expect(text).toContain('return 42')
      expect(text).not.toContain('STALE')

      // The stale symbol must genuinely be gone from the index, not just shadowed in output.
      const { code: oldCode } = runRead({ spec: `${file}::oldSelfHealRead9k` })
      expect(oldCode).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runSkeleton and runOutline list the fresh symbol set after an out-of-band edit', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-selfheal-skeleton-'))
    try {
      const file = join(root, 'c.ts')
      writeFileSync(file, 'export function oldSelfHealSkel9k(): number {\n  return 1\n}\n')
      indexFileSync(normalizePath(file))

      writeFileSync(
        file,
        'export function freshSelfHealSkel9k(): number {\n  return 1\n}\n' +
          'export function secondFreshSelfHealSkel9k(): number {\n  return 2\n}\n',
      )

      const skeleton = runSkeleton({ file })
      expect(skeleton.code).toBe(0)
      expect(skeleton.text).toContain('freshSelfHealSkel9k')
      expect(skeleton.text).toContain('secondFreshSelfHealSkel9k')
      expect(skeleton.text).not.toContain('oldSelfHealSkel9k')
      expect(skeleton.text).not.toContain('STALE')

      const outline = runOutline({ file })
      expect(outline.code).toBe(0)
      expect(outline.text).toContain('freshSelfHealSkel9k')
      expect(outline.text).toContain('secondFreshSelfHealSkel9k')
      expect(outline.text).not.toContain('oldSelfHealSkel9k')
      expect(outline.text).not.toContain('STALE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Fail-safe fallback: when the inline reparse itself throws (syntax error, unsupported file
  // type, I/O error), the command must degrade to the pre-existing STALE warning rather than
  // crash or silently serve stale data as if it were fresh. Mirrors worker.test.ts's own
  // "makeIndexer failure handling" regression pattern: mock indexFileSync itself (the narrowest
  // possible seam for deterministic failure injection), throwing only for the one path under
  // test and delegating to the real implementation for everything else -- runSymbol's own
  // resolution/query logic is entirely real.
  it('falls back to the STALE warning (never crashes) when the inline reparse throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-selfheal-fallback-'))
    try {
      const file = join(root, 'd.ts')
      writeFileSync(file, 'export function oldSelfHealFallback9k(): number {\n  return 1\n}\n')
      indexFileSync(normalizePath(file))

      writeFileSync(file, 'export function freshSelfHealFallback9k(): number {\n  return 2\n}\n')

      const resolved = normalizePath(file)
      const realIndexFileSync = parserModule.indexFileSync
      vi.spyOn(parserModule, 'indexFileSync').mockImplementation((filePath, dbPath) => {
        if (filePath === resolved) throw new Error('simulated reparse failure')
        return realIndexFileSync(filePath, dbPath)
      })

      const { text, code } = runSymbol({ name: 'oldSelfHealFallback9k', file })
      // Never crashes: a normal exit code and text, not an uncaught throw.
      expect(code).toBe(0)
      expect(text).toContain('STALE')
      expect(text).toContain('oldSelfHealFallback9k')

      // The DB row must be untouched -- the failed reparse must not have partially written or
      // corrupted anything.
      const entry = getFileEntry(resolved)
      expect(entry?.sha).not.toBe(fingerprintFile(resolved))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
