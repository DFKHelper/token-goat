/**
 * `token-goat semantic` was the only surgical-read command (unlike symbol/skeleton/outline/refs)
 * with no --json option at all, so an agent consuming its output had no machine-readable path and
 * had to scrape the "# file:start-end (distance N.NNN)\npreview" text blocks. This proves
 * runSemantic's --json path returns a real JSON payload (parseable, carrying filePath/preview per
 * item) instead of the human-formatted block text, on both the FTS-fallback branch (exercised
 * here, since no embedding index is seeded) and the no-match branch.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSemantic } from '../src/read_commands.js'

describe('runSemantic --json', () => {
  it('returns a parseable JSON payload with filePath/preview items on the FTS fallback path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-json-'))
    try {
      const file = join(root, 'a.ts')
      writeFileSync(file, 'export function semJsonFn9k2() { /* semJsonSharedTerm9k2 */ return 1 }\n')
      indexFileSync(normalizePath(file))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text, code } = await runSemantic('semJsonSharedTerm9k2', { json: true })
        expect(code).toBe(0)
        const payload = JSON.parse(text) as {
          source: string
          items: Array<{ filePath: string; preview: string; distance: number | null }>
          truncated: boolean
          totalCount: number
        }
        expect(payload.source).toBe('fts')
        expect(payload.items.length).toBeGreaterThan(0)
        expect(payload.items[0]?.filePath).toContain('a.ts')
        expect(payload.items[0]?.preview).toContain('semJsonFn9k2')
        expect(payload.items[0]?.distance).toBeNull()
        expect(payload.truncated).toBe(false)
        expect(payload.totalCount).toBe(payload.items.length)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The printed score never explained the printed order. Results are sorted by the fused RRF
   * total, but only the dense leg's `distance` was ever rendered, so a real run could show
   * 0.850 above 0.776 above 0.813 -- and an FTS-only row, having no distance at all, showed no
   * score whatsoever. Nothing in the suite asserted this surface, which is why it shipped.
   *
   * PROVENANCE: CAPTURE for the ordering defect (the 0.850/0.776/0.813 sequence above is from a
   * real `token-goat semantic` run against this repo on 2026-09-21); HAND-DERIVED for the
   * assertions below, which check rank against the items array's own order rather than against
   * any expected score, so they cannot agree with a mis-sorted implementation by construction.
   */
  it('ranks every item so the order is reproducible without reading the distance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-rank-'))
    try {
      for (const n of ['a', 'b', 'c']) {
        const file = join(root, `${n}.ts`)
        writeFileSync(file, `export function semRankFn${n}9k3() { /* semRankSharedTerm9k3 */ return 1 }\n`)
        indexFileSync(normalizePath(file))
      }

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text } = await runSemantic('semRankSharedTerm9k3', { json: true })
        const payload = JSON.parse(text) as { items: Array<{ rank: number; rrf: number; retrieval: string; distance: number | null }> }
        expect(payload.items.length).toBeGreaterThan(1)
        // Rank is 1-based and matches position, so a consumer can reproduce the ordering from the
        // payload alone. Asserted against the array index rather than a literal list, since the
        // claim is that rank tracks the order -- not that any particular file wins.
        expect(payload.items.map((r) => r.rank)).toEqual(payload.items.map((_, i) => i + 1))
        // rrf is the actual sort key, so it must be non-increasing down the list. distance is not
        // the sort key and is deliberately not asserted to be ordered.
        const scores = payload.items.map((r) => r.rrf)
        expect(scores).toEqual([...scores].sort((x, y) => y - x))
        // No embedding index is seeded here, so every row came from the keyword pass alone.
        expect(payload.items.every((r) => r.retrieval === 'lexical')).toBe(true)
        expect(payload.items.every((r) => r.distance === null)).toBe(true)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows the rank and names the keyword pass in the human output, where a scoreless row used to be unexplained', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-human-'))
    try {
      for (const n of ['a', 'b']) {
        const file = join(root, `${n}.ts`)
        writeFileSync(file, `export function semHumanFn${n}9k4() { /* semHumanSharedTerm9k4 */ return 1 }\n`)
        indexFileSync(normalizePath(file))
      }

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text } = await runSemantic('semHumanSharedTerm9k4', {})
        expect(text).toContain('# 1. ')
        expect(text).toContain('# 2. ')
        // The row carries no distance because the dense pass never returned it. Saying so is the
        // difference between "ranked by keyword match" and an unexplained blank where every other
        // row prints a number.
        expect(text).toContain('(keyword)')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns a parseable JSON payload with an empty items array on a miss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-json-miss-'))
    try {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text, code } = await runSemantic('noSuchSymbolAtAllZz9k2', { json: true })
        expect(code).toBe(1)
        const payload = JSON.parse(text) as { source: string; items: unknown[]; truncated: boolean; totalCount: number }
        expect(payload.items).toEqual([])
        expect(payload.truncated).toBe(false)
        expect(payload.totalCount).toBe(0)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
