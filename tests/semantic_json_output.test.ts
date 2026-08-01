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
