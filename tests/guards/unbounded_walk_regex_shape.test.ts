import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** Whether a group body holds an unescaped `*`, an unescaped `+`, or a bare `.`, outside a character class. */
function repeats(body: string): boolean {
  let inClass = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '*' || c === '+' || c === '.') return true
  }
  return false
}

/** Each group of a regex body that a `*`, `+` or `{` quantifies and whose body repeats: the backtracking shape `a60e0f080` shipped. */
function repeatingGroups(pattern: string): string[] {
  const found: string[] = []
  const opens: number[] = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '(') opens.push(i)
    else if (c === ')') {
      const open = opens.pop()
      const body = open === undefined ? '' : pattern.slice(open + 1, i)
      if (open !== undefined && /[*+{]/.test(pattern[i + 1] ?? '') && repeats(body)) found.push(pattern.slice(open, i + 1))
    }
  }
  return found
}

/** Every regex literal of a source file, with its 1-based line and its pattern text (flags cut off). */
function regexLiterals(file: string): Array<{ line: number; pattern: string }> {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Array<{ line: number; pattern: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      out.push({ line, pattern: node.text.slice(1, node.text.lastIndexOf('/')) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const FILES = ['unbounded_walk.ts', 'unbounded_walk_scan.ts', 'unbounded_walk_tools.ts', 'unbounded_walk_words.ts', 'unbounded_walk_xargs.ts']

/** One site per entry, keyed by file and the exact group text: the group is linear because every iteration must open with a literal `/`, which no class inside it matches, so iterations cannot overlap. */
const LINEAR_BY_DESIGN: ReadonlyArray<{ file: string; group: string }> = [
  { file: 'unbounded_walk_xargs.ts', group: String.raw`(\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)` },
]

describe('the unbounded-walk patterns carry no repeating quantified group', () => {
  it('covers every unbounded_walk module in src, so a new module cannot skip this guard', () => {
    const present = pinnedPopulation({
      what: 'src/unbounded_walk*.ts files',
      items: fs.readdirSync(SRC).filter((name) => /^unbounded_walk.*\.ts$/.test(name)).sort(),
      floor: FILES.length,
      mustInclude: ['unbounded_walk_words.ts', 'unbounded_walk_xargs.ts'],
    })
    expect(present).toEqual([...FILES].sort())
  })

  it.each(FILES)('%s has no regex literal whose quantified group repeats', (file) => {
    const exempt = (group: string): boolean => LINEAR_BY_DESIGN.some((entry) => entry.file === file && entry.group === group)
    const found = regexLiterals(file).flatMap(({ line, pattern }) =>
      repeatingGroups(pattern).filter((group) => !exempt(group)).map((group) => `${file}:${String(line)} ${group}`))
    expect(found, `a regex literal in ${file} quantifies a group whose body repeats (a backtracking shape); the entries name the line`).toEqual([])
  })

  it('flags the shape that backtracked, and no shape without a repeat inside a quantified group', () => {
    // Negative control: without it the per-file rows could pass on a scanner that never matches anything.
    expect(repeatingGroups(String.raw`(\[.*\])+`)).toEqual([String.raw`(\[.*\])`])
    expect(repeatingGroups(String.raw`(\.)+`)).toEqual([])
    expect(repeatingGroups(String.raw`\[.*\]`)).toEqual([])
    expect(repeatingGroups(String.raw`(ab)+`)).toEqual([])
  })
})
