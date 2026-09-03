/**
 * `.tokengoatignore` is read in exactly one place, cmdPack, but the README said `index` honoured
 * it and that `ignores` listed its patterns. Neither was true, and the failure is silent and
 * security-relevant: the file is named "ignore", so someone keeping a directory of credentials out
 * of the index reaches for it first, sees no error, and gets the whole directory indexed anyway.
 * Confirmed live before the fix -- an excluded file's body came straight back out of `symbol`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIgnores } from '../src/text_commands.js'

let root: string
let cwd: string
let written: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ignores-'))
  cwd = process.cwd()
  process.chdir(root)
  written = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(cwd)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ignores reports the scope of .tokengoatignore', () => {
  it('says it applies to pack only, and names the command that does exclude from the index', () => {
    fs.writeFileSync(path.join(root, '.tokengoatignore'), 'secretdir/**\n')

    cmdIgnores({})

    expect(written).toContain('1 pattern')
    expect(written).toContain('pack only')
    expect(written).toContain('does not exclude anything from the symbol index')
    expect(written).toContain('token-goat project exclude')
  })

  it('still names the command that works when there is no ignore file at all', () => {
    cmdIgnores({})

    expect(written).toContain('.tokengoatignore: not present')
    expect(written).toContain('token-goat project exclude')
  })

  it('counts patterns the way pack parses them, so blanks and comments are not patterns', () => {
    fs.writeFileSync(path.join(root, '.tokengoatignore'), '# a comment\n\nsecretdir/**\nvendor/**\n')

    cmdIgnores({})

    expect(written).toContain('2 patterns')
  })

  it('says "1 pattern" rather than "1 patterns"', () => {
    fs.writeFileSync(path.join(root, '.tokengoatignore'), 'only/**\n')

    cmdIgnores({})

    expect(written).toContain('1 pattern,')
    expect(written).not.toContain('1 patterns')
  })

  it('carries the count in --json too, so a scripted check does not have to parse prose', () => {
    fs.writeFileSync(path.join(root, '.tokengoatignore'), 'a/**\nb/**\nc/**\n')

    cmdIgnores({ json: true })

    expect((JSON.parse(written) as { packIgnorePatterns: number }).packIgnorePatterns).toBe(3)
  })
})

// The correction lives wherever `.tokengoatignore` is described, which is the command
// reference -- that moved from README.md into docs/cli.md when the README was split. Both
// files are read, so the guarantee holds whichever one carries the prose, and the combined
// text is asserted non-empty first: a mistyped path would otherwise read as a clean pass on
// the negative check, with only the positive one noticing.
describe('the docs no longer promise indexing honours the file', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const docs = ['README.md', path.join('docs', 'cli.md')]
    .map((rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8'))
    .join('\n')

  it('reads the docs at all, so an empty read cannot pass the negative check', () => {
    expect(docs.length).toBeGreaterThan(10_000)
  })

  it('does not say a rebuild follows a .tokengoatignore change', () => {
    expect(docs).not.toContain('after a `.tokengoatignore` change')
  })

  it('says plainly that the file does not reach the index', () => {
    expect(docs).toContain('it excludes nothing from the symbol index')
  })
})
