// End-to-end regression for `semantic --grep`, against a real indexed project with no mocks
// (mirrors tests/semantic_fts_fallback_project_scope.test.ts's setup). This is the test that
// actually catches the stored-vs-rendered-path bug class this repo has hit before: an anchored
// `^src/` pattern must match the DISPLAY path (toDisplayPath), not the stored absolute path --
// a filter that tested the stored path would match nothing (an absolute path never starts with
// "src/"), so this must observe real matches surviving the filter, not just an absence of the
// wrong file.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSemantic } from '../src/read_commands.js'

describe('runSemantic --grep against a real indexed project (end-to-end, no mocks)', () => {
  it('an anchored ^src/ pattern matches the rendered path, not the stored absolute path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-grep-e2e-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      mkdirSync(join(root, 'tests'), { recursive: true })
      const srcFile = join(root, 'src', 'realA.ts')
      const testFile = join(root, 'tests', 'realB.ts')
      writeFileSync(srcFile, 'export function semGrepE2eFnA9k2() { /* semGrepE2eTerm9k2 */ return 1 }\n')
      writeFileSync(testFile, 'export function semGrepE2eFnB9k2() { /* semGrepE2eTerm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(srcFile))
      indexFileSync(normalizePath(testFile))

      const { text, code } = await runSemantic('semGrepE2eTerm9k2', { projectRoot: root, grep: '^src/' })

      expect(code).toBe(0)
      expect(text).toContain('semGrepE2eFnA9k2')
      expect(text).not.toContain('semGrepE2eFnB9k2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a --grep with no matches renders the filtered-to-empty notice, not "no matches for"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sem-grep-e2e-empty-'))
    try {
      const file = join(root, 'tests', 'onlyTest.ts')
      mkdirSync(join(root, 'tests'), { recursive: true })
      writeFileSync(file, 'export function semGrepE2eEmptyFn9k2() { /* semGrepE2eEmptyTerm9k2 */ return 1 }\n')
      indexFileSync(normalizePath(file))

      const { text, code } = await runSemantic('semGrepE2eEmptyTerm9k2', { projectRoot: root, grep: '^src/' })

      expect(code).toBe(0)
      expect(text).toContain('filtered out by --grep')
      expect(text).not.toContain('no matches for')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
