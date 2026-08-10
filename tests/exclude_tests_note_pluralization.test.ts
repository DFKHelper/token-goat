/**
 * Every `--exclude-tests` surface appends a parenthetical naming how many rows the flag hid.
 * Fourteen call sites across refs/callers/dead/call-chain/impact/semantic each interpolated that
 * string themselves with a hard-coded plural, so hiding exactly one row reported
 * `1 in test files hidden by --exclude-tests` -- confirmed against the shipped binary, on both
 * `refs` and `callers`, before this was extracted into a shared helper.
 *
 * Nothing caught it because every fixture in the suite hid two or more rows: the singular branch
 * of a count-dependent string is invisible to a test that only ever exercises the plural one.
 * These tests pin count == 1 specifically, at the helper and through the real commands.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'
import { countNoun, excludeTestsHiddenNote } from '../src/util.js'

describe('excludeTestsHiddenNote', () => {
  it('uses the singular noun for exactly one hidden row', () => {
    expect(excludeTestsHiddenNote(1)).toBe('1 in test file hidden by --exclude-tests')
  })

  it('uses the plural noun for more than one', () => {
    expect(excludeTestsHiddenNote(2)).toBe('2 in test files hidden by --exclude-tests')
  })

  it('uses the plural noun for zero, matching ordinary English', () => {
    expect(excludeTestsHiddenNote(0)).toBe('0 in test files hidden by --exclude-tests')
  })

  it('never emits the singular count against the plural noun', () => {
    // The exact defect this replaced, stated as its own assertion so a future refactor that
    // reintroduces a hard-coded plural fails here rather than silently shipping.
    expect(excludeTestsHiddenNote(1)).not.toContain('test files')
  })
})

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function addSymbol(file: string, name: string): void {
  getDb(globalDbPath())
    .prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`${normalizePath(root)}/${file}`, name, 'function', 1, 1, '', '')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xtests-plural-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('countNoun', () => {
  it('agrees with a count of one', () => {
    expect(countNoun(1, 'reference')).toBe('1 reference')
  })

  it('agrees with a count above one', () => {
    expect(countNoun(3, 'reference')).toBe('3 references')
  })

  it('agrees with zero, matching ordinary English', () => {
    expect(countNoun(0, 'reference')).toBe('0 references')
  })

  it('takes an explicit plural for nouns that do not just add an s', () => {
    expect(countNoun(2, 'match', 'matches')).toBe('2 matches')
    expect(countNoun(1, 'match', 'matches')).toBe('1 match')
  })
})

describe('the note as rendered by a real command', () => {
  it('symbol says "1 in test file" when one definition was hidden', () => {
    addSymbol('tests/only.test.ts', 'lonelyHelper')

    const { text } = runSymbol({ name: 'lonelyHelper', projectRoot: root, excludeTests: true })

    expect(text).toContain('1 in test file hidden by --exclude-tests')
    expect(text).not.toContain('1 in test files')
  })

  it('symbol says "2 in test files" when two were hidden', () => {
    addSymbol('tests/a.test.ts', 'lonelyHelper')
    addSymbol('tests/b.test.ts', 'lonelyHelper')

    const { text } = runSymbol({ name: 'lonelyHelper', projectRoot: root, excludeTests: true })

    expect(text).toContain('2 in test files hidden by --exclude-tests')
  })
})
