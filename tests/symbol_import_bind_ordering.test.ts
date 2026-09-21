/**
 * `token-goat symbol NAME` answers "where is this defined", and its rows came back ordered by
 * `file_path, line_start`. That is alphabetical, which has nothing to do with which row is the
 * definition: a one-line `const { ambigProbeFn } = await import('../src/thing.js')` under
 * `scripts/` sorts ahead of the real function under `src/` because "scripts" precedes "src", so
 * the first block a caller reads is an import statement. The skill text points agents at this
 * command for exactly this question, so the first row is the one that gets acted on.
 *
 * PROVENANCE: CAPTURE. The fixture is the reduced form of a real run against a scratch project on
 * 2026-09-21, which printed `# ambigProbeFn (variable) - scripts/use.ts:1-1` above
 * `# ambigProbeFn (function) - src/thing.ts:1-3`. The file names are chosen for that alphabetical
 * relationship, which is the mechanism under test, rather than copied from the matcher's own source.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'

function seed(root: string, files: ReadonlyArray<readonly [string, string]>): void {
  for (const [rel, body] of files) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
    indexFileSync(normalizePath(full))
  }
}

describe('symbol NAME leads with a definition rather than an import re-bind', () => {
  it('puts the function ahead of a destructuring import that sorts earlier by file path', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-symbind-'))
    try {
      seed(root, [
        ['scripts/use.ts', `const { ambigProbeFn9k7 } = await import('../src/thing.js')\n`],
        ['src/thing.ts', `export function ambigProbeFn9k7(a: number): number {\n  return a + 1\n}\n`],
      ])

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text } = runSymbol({ name: 'ambigProbeFn9k7', projectRoot: root })
        const defAt = text.indexOf('src/thing.ts')
        const bindAt = text.indexOf('scripts/use.ts')
        // Both still present: this reorders and never filters, so the re-bind stays discoverable.
        expect(defAt).toBeGreaterThanOrEqual(0)
        expect(bindAt).toBeGreaterThanOrEqual(0)
        expect(defAt).toBeLessThan(bindAt)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a genuine exported const alone, which is the row a kind-based rule would have sunk', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-symconst-'))
    try {
      // Both rows are kind `variable`. Ordering on kind would have been unable to tell them apart,
      // and sinking this one would answer a "where is it defined" question with the wrong file.
      seed(root, [
        ['src/consts.ts', `export const sharedName9k7 = ['a', 'b']\n`],
        ['tests/use.test.ts', `const { sharedName9k7 } = require('../src/consts.js')\n`],
      ])

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text } = runSymbol({ name: 'sharedName9k7', projectRoot: root })
        expect(text.indexOf('src/consts.ts')).toBeLessThan(text.indexOf('tests/use.test.ts'))
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('negative control: with no import re-bind in the set, the original file-path order is untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-symplain-'))
    try {
      seed(root, [
        ['a/one.ts', `export function plainDup9k7(): number {\n  return 1\n}\n`],
        ['b/two.ts', `export function plainDup9k7(): number {\n  return 2\n}\n`],
      ])

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const { text } = runSymbol({ name: 'plainDup9k7', projectRoot: root })
        // A stable sort over an all-equal key must not disturb anything. Without this, a switch to
        // an unstable comparator or a broader rule would go unnoticed on ordinary lookups.
        expect(text.indexOf('a/one.ts')).toBeLessThan(text.indexOf('b/two.ts'))
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
