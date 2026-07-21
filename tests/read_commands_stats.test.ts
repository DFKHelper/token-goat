/**
 * Regression (#238): the surgical-read command family in read_commands.ts (symbol_lookup,
 * read_replacement, section_replacement/section_read, semantic_search, outline, exports,
 * stub_view, symbol_read) stopped calling recordStat entirely during the Python->TS port, even
 * though src/stats.ts's KIND_TO_SOURCE/COMMAND_KINDS and src/render/stats_renderer.ts's
 * Reads/Lookups groups still define display mappings for all of them -- the same class of bug
 * fixed for image_shrink in commit 231856df.
 *
 * These tests drive the real, unmocked command functions (indexFileSync against a real
 * project, real markdown files on disk) and assert a real stats row appears via summarize()
 * against the real (test-isolated) global stats DB. A synthetic recordStat/DB insert would not
 * catch the original absence, so this must exercise the actual production call path -- see
 * tests/image_shrink.test.ts's equivalent #236 regression test for the same reasoning.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol, runRead, runSection, runSemantic, runImports } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'

describe('read_commands surgical-read stat recording (#238)', () => {
  it('runSymbol records a symbol_lookup stat row through the real global stats DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-symbol-'))
    try {
      const file = join(root, 'a.ts')
      writeFileSync(file, 'export function statRecSymbolFn9k2() {\n  return 1\n}\n')
      indexFileSync(normalizePath(file))

      const before = summarize(30).by_kind['symbol_lookup']
      const beforeEvents = before?.events ?? 0

      const { code } = runSymbol({ name: 'statRecSymbolFn9k2' })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['symbol_lookup']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runRead records a read_replacement stat row through the real global stats DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-read-'))
    try {
      const file = join(root, 'b.ts')
      writeFileSync(file, 'export function statRecReadFn9k2() {\n  return 2\n}\n')
      indexFileSync(normalizePath(file))

      const before = summarize(30).by_kind['read_replacement']
      const beforeEvents = before?.events ?? 0

      const { code } = runRead({ spec: `${file}::statRecReadFn9k2` })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['read_replacement']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runSection records a section_read stat row through the real global stats DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-section-'))
    try {
      const file = join(root, 'doc.md')
      writeFileSync(
        file,
        ['# Title', 'intro', '', '## StatRecHeading9k2', 'section body content here', ''].join('\n'),
      )

      const before = summarize(30).by_kind['section_read']
      const beforeEvents = before?.events ?? 0

      const { code } = runSection({ spec: `${file}::StatRecHeading9k2` })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['section_read']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runSemantic records a semantic_search stat row through the real global stats DB (FTS fallback path)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-semantic-'))
    try {
      const file = join(root, 'c.ts')
      writeFileSync(file, 'export function statRecSemanticFn9k2() { /* statRecSemanticTerm9k2 */ return 3 }\n')
      indexFileSync(normalizePath(file))

      const before = summarize(30).by_kind['semantic_search']
      const beforeEvents = before?.events ?? 0

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { code } = await runSemantic('statRecSemanticTerm9k2', {})
        expect(code).toBe(0)
      } finally {
        cwdSpy.mockRestore()
      }

      const after = summarize(30).by_kind['semantic_search']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runImports records an imports stat row through the real global stats DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-imports-'))
    try {
      const file = join(root, 'd.ts')
      writeFileSync(file, "import { statRecImportsThing9k2 } from './statRecImportsMod9k2.js'\n")

      const before = summarize(30).by_kind['imports']
      const beforeEvents = before?.events ?? 0

      const code = runImports({ file })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['imports']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
