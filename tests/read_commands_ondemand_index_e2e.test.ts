/**
 * End-to-end regression for the "never-indexed file -> full-Read fallback" friction: the surgical
 * read commands (symbol/read/skeleton/outline) share healStaleIndex, which self-heals a *stale*
 * index (a file already indexed whose on-disk bytes changed) but did nothing for a file that was
 * never indexed at all -- it returned early on `entry === null`. So a file that exists on disk but
 * isn't in the index yet (a project whose background worker never ran or hasn't caught up, or a
 * freshly created/renamed file) produced "No indexed symbols found" / "symbol not found", and the
 * caller fell back to a full-file Read or grep -- re-burning the exact tokens the tool exists to
 * save. Real coracrea-website sessions hit this repeatedly (`token-goat skeleton scripts/... -> no
 * indexed symbols (is it indexed?)`, then a full Read).
 *
 * The fix parses the file once on demand when it is present on disk but absent from the index.
 * These tests drive the REAL, unmocked pipeline: a real on-disk file that is deliberately NEVER
 * indexed (no indexFileSync, no --force-refresh), and the real command functions querying the real
 * (test-isolated) global.db. Mirrors read_commands_stale_self_heal_e2e.test.ts's real-DB harness.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { normalizePath } from '../src/paths.js'
import { runSkeleton, runOutline, runRead, runSymbol } from '../src/read_commands.js'

describe('on-demand index for a never-indexed on-disk file (real pipeline, no injected callbacks)', () => {
  it('runSkeleton parses a never-indexed file on demand instead of returning "no symbols"', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ondemand-skel-'))
    try {
      const file = join(root, 'never.js')
      writeFileSync(file, 'function neverIndexedFn9k(a) {\n  return a * 2\n}\n')
      // Deliberately NO indexFileSync and NO forceRefresh: the file exists on disk but is absent
      // from the index, exactly the session condition.
      const { text, code } = runSkeleton({ file })
      expect(code).toBe(0)
      expect(text).toContain('neverIndexedFn9k')
      expect(text).not.toContain('No indexed symbols found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runOutline parses a never-indexed file on demand', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ondemand-outline-'))
    try {
      const file = join(root, 'never.js')
      writeFileSync(file, 'function neverOutlineFn9k(a) {\n  return a - 1\n}\n')
      const { text, code } = runOutline({ file })
      expect(code).toBe(0)
      expect(text).toContain('neverOutlineFn9k')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runRead resolves file::symbol against a never-indexed file on demand', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ondemand-read-'))
    try {
      const file = join(root, 'never.js')
      writeFileSync(file, 'function neverReadFn9k(a) {\n  return a + 7\n}\n')
      const { text, code } = runRead({ spec: `${file}::neverReadFn9k` })
      expect(code).toBe(0)
      expect(text).toContain('return a + 7')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runSymbol --file resolves a never-indexed file on demand', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ondemand-symbol-'))
    try {
      const file = join(root, 'never.js')
      writeFileSync(file, 'function neverSymbolFn9k(a) {\n  return a\n}\n')
      const { text, code } = runSymbol({ name: 'neverSymbolFn9k', file })
      expect(code).toBe(0)
      expect(text).toContain('neverSymbolFn9k')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still emits a clean no-symbols result for a file that genuinely does not exist on disk (no crash from the on-demand probe)', () => {
    const missing = normalizePath(join(tmpdir(), 'tg-ondemand-does-not-exist-9k', 'ghost.ts'))
    const { code } = runSkeleton({ file: missing })
    expect(code).toBe(1)
  })
})
