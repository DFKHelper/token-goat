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
      // totalCount must report the true 600, not the pre-fix 500 (which was a lie: it hid symbols
      // 501..600 entirely). This asserted truncated:true while outline JSON rows still carried the
      // full symbol body, which made 600 rows overflow the byte budget -- but that was the bloat
      // being measured, not the honesty property this test is named for. With bodies gone the whole
      // file fits, so assert the stronger thing its skeleton sibling already does: the tail symbols
      // are actually present, which is what being past the old cap was supposed to mean.
      expect(parsed.totalCount).toBeGreaterThanOrEqual(n)
      const names = new Set(parsed.items.map((i) => i.name))
      expect(names.has('genFn0')).toBe(true)
      expect(names.has('genFn599')).toBe(true)
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

  // Regression: the 500-symbol fix above moved the fetch cap to SKELETON_SYMBOL_CAP (5000), but
  // prepareSymbolListing still sliced the fetched rows down to that cap before the overflow guard
  // ever computed totalCount from them -- the exact same "SQL LIMIT applied before the count is
  // taken" lie shape, just at a higher threshold. A file with more than 5000 symbols would report
  // totalCount capped at (at most) 5000 instead of its true count. Needs a real file whose symbol
  // count exceeds the cap itself, not just the token-budget guard's own item cap.
  it('runSkeleton --json reports an honest totalCount for a file with more than SKELETON_SYMBOL_CAP (5000) symbols', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-overflow-'))
    try {
      const file = join(root, 'huge.js')
      const n = 5200
      writeFileSync(file, makeManyFunctionsSource(n))
      indexFileSync(normalizePath(file))

      const { text, code } = runSkeleton({ file, json: true })
      expect(code).toBe(0)
      const parsed = JSON.parse(text) as { items: Array<{ name: string }>; truncated: boolean; totalCount: number }

      // Pre-fix: totalCount would have been capped at (at most) 5000, silently lying about the
      // true 5200. Post-fix, a countSymbols() re-query with no LIMIT reports the true total.
      expect(parsed.totalCount).toBe(n)
      expect(parsed.truncated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // HAND-DERIVED: the file is generated here and the expected answer is read off the generator, not off the implementation -- `tailOnlyFn` is the last symbol written, so it is past the cap by construction and any correct `--grep tailOnlyFn` must return exactly it. The third instance of the same shape: the two tests above fixed the *count* the cap lied about, but the rows themselves were still sliced to SKELETON_SYMBOL_CAP before `--grep`/`--min-lines` ran, so a symbol past the 5000th was cut before the predicate ever saw it. The result was an empty listing byte-identical to an honest no-match, under a notice blaming a filter that never examined it -- while `token-goat symbol tailOnlyFn`, which goes through a name-indexed lookup rather than this path, found it instantly.
  it('runOutline --grep finds a symbol that sits past SKELETON_SYMBOL_CAP in source order', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-grep-'))
    try {
      const file = join(root, 'huge.js')
      writeFileSync(file, `${makeManyFunctionsSource(5050)}\nfunction tailOnlyFn(a) {\n  return a\n}\n`)
      indexFileSync(normalizePath(file))

      const { text, code } = runOutline({ file, grep: 'tailOnlyFn', json: true })
      expect(code).toBe(0)
      const parsed = JSON.parse(text) as { items: Array<{ name: string }>; truncated: boolean }
      expect(parsed.items.map((i) => i.name)).toEqual(['tailOnlyFn'])
      // Nothing was left unexamined, so the result must not be flagged as a partial view: a `truncated: true` here would send the caller looking for rows the scan already proved are not there.
      expect(parsed.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // HAND-DERIVED: 20000 symbols is four full pages of the paged scan and still well inside `indexing.large_file_skip_kb` (2048), which is what actually bounds how far this walk can go -- an earlier revision added a second scan cap of its own, and probing the indexer showed no file that reaches it can be indexed at all, so the branch and its notice were unreachable. This pins the property that replaced it: with no filter, a multi-page scan lists the first SKELETON_SYMBOL_CAP symbols and says so, and with a filter it walks every page to the end of the file.
  it('walks every page of a multi-page file and reports truncation only when the match list is full', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-pages-'))
    try {
      const file = join(root, 'pages.js')
      const n = 20000
      writeFileSync(file, makeManyFunctionsSource(n))
      indexFileSync(normalizePath(file))

      const unfiltered = JSON.parse(runOutline({ file, json: true }).text) as { truncated: boolean; totalCount: number }
      expect(unfiltered.truncated).toBe(true)
      expect(unfiltered.totalCount).toBe(n)

      // The last symbol in the file, four pages past the first: found, and not flagged truncated, because the scan reached the end and nothing was left behind.
      const filteredOut = JSON.parse(runOutline({ file, grep: `genFn${n - 1}$`, json: true }).text) as { items: Array<{ name: string }>; truncated: boolean }
      expect(filteredOut.items.map((i) => i.name)).toEqual([`genFn${n - 1}`])
      expect(filteredOut.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The other half of the same change: the no-match notice has to count what the scan actually examined. Pre-fix this said "all 5000 indexed symbols were filtered out" for a 5051-symbol file -- 51 of them were never tested against the pattern, so the notice named a verdict it had not reached and its "widen or drop the filter" advice could not have worked.
  it('runOutline names the true scanned count when nothing matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-skelcap-nomatch-'))
    try {
      const file = join(root, 'huge.js')
      writeFileSync(file, makeManyFunctionsSource(5051))
      indexFileSync(normalizePath(file))

      const { text } = runOutline({ file, grep: 'noSuchSymbolAnywhere' })
      expect(text).toContain('all 5051 indexed symbols were filtered out')
      expect(text).not.toContain('all 5000 indexed symbols')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
