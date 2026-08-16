/**
 * Regression: `searchSymbolsFts` (index_reader.ts) used to take no `rootDir` parameter at all,
 * so every caller -- including `runSemantic`'s (read_commands.ts) full-text fallback, used
 * whenever no embedding index is available (no sqlite-vec/@xenova installed, or nothing has been
 * embedded yet) -- queried the FTS index across every project ever indexed into the shared
 * `global.db`, not just the current one. This fallback is NOT an edge case: on installs without
 * the optional embedding deps it's the only path `semantic` ever takes, so cross-project leakage
 * was the default behavior there, not a rare corner case.
 *
 * This test never seeds a real embedding index, so `searchSemantic` degrades to an empty result
 * and `runSemantic` always falls through to the FTS path under test here.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSemantic } from '../src/read_commands.js'

describe('runSemantic FTS fallback project scoping', () => {
  it('does not surface a symbol from a different project sharing a search term', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-sem-fts-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-sem-fts-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      // The shared search term lives inside the function BODY (not a leading /** */ comment --
      // this parser does not attach that as a docstring for a bare `export function`), since
      // searchSymbolsFts's FTS mirror indexes name/body/docstring and body is what's reliably
      // populated here.
      writeFileSync(fileA, 'export function semFtsFnA9k2() { /* semFtsSharedTerm9k2 */ return 1 }\n')
      writeFileSync(fileB, 'export function semFtsFnB9k2() { /* semFtsSharedTerm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        const { text, code } = await runSemantic('semFtsSharedTerm9k2', {})
        expect(code).toBe(0)
        expect(text).toContain('semFtsFnA9k2')
        // rootB's symbol shares the same searchable docstring term but must not leak into
        // rootA-scoped output.
        expect(text).not.toContain('semFtsFnB9k2')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('respects an explicit projectRoot argument over process.cwd()', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-sem-fts-explicit-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-sem-fts-explicit-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      writeFileSync(fileA, 'export function semFtsExplicitFnA9k2() { /* semFtsExplicitTerm9k2 */ return 1 }\n')
      writeFileSync(fileB, 'export function semFtsExplicitFnB9k2() { /* semFtsExplicitTerm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      // process.cwd() stays wherever the test runner happens to be -- projectRoot must still win.
      const { text, code } = await runSemantic('semFtsExplicitTerm9k2', { projectRoot: rootB })
      expect(code).toBe(0)
      expect(text).toContain('semFtsExplicitFnB9k2')
      expect(text).not.toContain('semFtsExplicitFnA9k2')
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('scopes to the whole project root, not just a subdirectory, when invoked with cwd inside a subdirectory (regression)', async () => {
    // Regression: `runSemantic` defaulted its scope to `opts.projectRoot ?? process.cwd()`.
    // `projectScopeClause` does a literal `<root>/` prefix range match with no project-root
    // resolution, so running from a subdirectory silently scoped the search to that subtree
    // only, instead of walking up to the real project root the way other commands in this same
    // file (runFind, runChanged) already do via `resolveProjectRoot`.
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-fts-subdir-root-'))
    const subdir = join(root, 'subdir')
    mkdirSync(subdir)
    try {
      // A package.json marks `root` as the project root that `resolveProjectRoot` should walk
      // up to from `subdir`.
      writeFileSync(join(root, 'package.json'), '{"name":"tg-sem-fts-subdir-fixture"}\n')
      const rootFile = join(root, 'top.ts')
      const subdirFile = join(subdir, 'nested.ts')
      writeFileSync(rootFile, 'export function semFtsSubdirTopFn9k2() { /* semFtsSubdirTerm9k2 */ return 1 }\n')
      writeFileSync(subdirFile, 'export function semFtsSubdirNestedFn9k2() { /* semFtsSubdirTerm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(rootFile))
      indexFileSync(normalizePath(subdirFile))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subdir)
      try {
        const { text, code } = await runSemantic('semFtsSubdirTerm9k2', {})
        expect(code).toBe(0)
        // Both the subtree-local symbol and the project-root-level symbol must be visible --
        // the bug would have scoped the search to `subdir` only and dropped the root-level hit.
        expect(text).toContain('semFtsSubdirNestedFn9k2')
        expect(text).toContain('semFtsSubdirTopFn9k2')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
