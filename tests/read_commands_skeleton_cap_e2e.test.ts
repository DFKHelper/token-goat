/**
 * End-to-end regression for the skeleton/outline "500-symbol silent truncation" bug: the shared
 * prologue (prepareSymbolListing) fetched symbols with a hard `querySymbols({ limit: 500 })`, then
 * handed the already-capped ≤500 rows to the overflow guard. The guard computes `truncated`/
 * `totalCount` from its *input*, so a file that indexes to more than 500 symbols (a real 5000-line
 * demonolith easily does) reported `totalCount: 500, truncated: false` and a header that stopped at
 * the 500th symbol -- silently hiding every symbol past it while claiming the listing was complete.
 * That defeats the entire point of skeleton/outline: replacing a full-file read of a large file
 * with a cheap, *complete* symbol map. An agent navigating by skeleton would never see functions
 * declared past the 500th symbol.
 *
 * These tests drive the REAL, unmocked pipeline: a real generated source file with >500 symbols,
 * a real indexFileSync, and the real runSkeleton/runOutline querying the real (test-isolated)
 * global.db -- no injected querySymbols, which is exactly the "injected-seam trap" CLAUDE.md warns
 * about (the mocked read_commands.test.ts suite passes querySymbols a small array that ignores the
 * SQL limit entirely, so it could never have caught this). Mirrors the real-DB harness in
 * read_commands_stale_self_heal_e2e.test.ts.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSkeleton, runOutline } from '../src/read_commands.js'

/** Generate a JS source file with `n` distinct top-level functions, each a few lines long. */
function makeManyFunctionsSource(n: number): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(`function genFn${i}(a, b) {`)
    lines.push(`  return a + b + ${i}`)
    lines.push(`}`)
    lines.push('')
  }
  return lines.join('\n')
}

describe('skeleton/outline symbol-cap honesty (real pipeline, no injected callbacks)', () => {
  it('runSkeleton --json returns every symbol and an honest totalCount for a file with more than 500 symbols', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-skeleton-'))
    try {
      const file = join(root, 'many.js')
      const n = 600
      writeFileSync(file, makeManyFunctionsSource(n))
      indexFileSync(normalizePath(file))

      const { text, code } = runSkeleton({ file, json: true })
      expect(code).toBe(0)
      const parsed = JSON.parse(text) as { items: Array<{ name: string }>; truncated: boolean; totalCount: number }

      // Pre-fix: the hard `limit: 500` capped this at 500 and reported truncated:false. The tail
      // functions (genFn500..genFn599) were silently absent from both the items and the count.
      expect(parsed.totalCount).toBeGreaterThanOrEqual(n)
      const names = new Set(parsed.items.map((i) => i.name))
      expect(names.has('genFn0')).toBe(true)
      expect(names.has('genFn599')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runOutline --json also surfaces symbols past the old 500-row cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-outline-'))
    try {
      const file = join(root, 'many.js')
      const n = 600
      writeFileSync(file, makeManyFunctionsSource(n))
      indexFileSync(normalizePath(file))

      const { text, code } = runOutline({ file, json: true })
      expect(code).toBe(0)
      const parsed = JSON.parse(text) as { items: Array<{ name: string }>; truncated: boolean; totalCount: number }
      // outline JSON rows carry the full symbol body, so 600 of them exceed the token budget and
      // the overflow guard honestly caps the *items* -- but totalCount must still report the true
      // 600, not the pre-fix 500 (which was a lie: it hid symbols 501..600 entirely).
      expect(parsed.totalCount).toBeGreaterThanOrEqual(n)
      expect(parsed.truncated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runSkeleton text header reflects the true symbol count, not a 500 cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-text-'))
    try {
      const file = join(root, 'many.js')
      const n = 600
      writeFileSync(file, makeManyFunctionsSource(n))
      indexFileSync(normalizePath(file))

      const { text, code } = runSkeleton({ file })
      expect(code).toBe(0)
      // Pre-fix the header read "(500 symbols, ...)"; post-fix it reports the real count.
      expect(text).not.toContain('(500 symbols,')
      expect(text).toContain(`(${n} symbols,`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
