import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** Whether a group body holds a quantifier (`*`, `+`, `?`, `{`), an alternation `|`, or a bare `.`, outside a character class. */
function repeats(body: string): boolean {
  let inClass = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if ('*+?{|.'.includes(c)) return true
  }
  return false
}

/** A group's syntax prefix (`?:`, `?=`, `?<name>`), which is not part of its body. */
const GROUP_PREFIX = /^\?(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/

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
      const body = open === undefined ? '' : pattern.slice(open + 1, i).replace(GROUP_PREFIX, '')
      if (open !== undefined && /[*+{]/.test(pattern[i + 1] ?? '') && repeats(body)) found.push(pattern.slice(open, i + 1))
    }
  }
  return found
}

/** The text of a string literal, a template without substitutions (`String.raw` keeps its raw text), or a `+` of those; null when any part is computed. */
function staticText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTaggedTemplateExpression(node) && ts.isNoSubstitutionTemplateLiteral(node.template)
    && ts.isPropertyAccessExpression(node.tag) && node.tag.getText() === 'String.raw') return node.template.rawText ?? node.template.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left)
    const right = staticText(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

/** Every regex literal and `RegExp(` call of a source text, with its 1-based line; pattern is null when a call's first argument is computed, and arg is that argument's source text. */
function regexPatterns(file: string, src: string): Array<{ line: number; pattern: string | null; arg: string }> {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Array<{ line: number; pattern: string | null; arg: string }> = []
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      out.push({ line: lineOf(node), pattern: node.text.slice(1, node.text.lastIndexOf('/')), arg: '' })
    } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression)
      && node.expression.text === 'RegExp') {
      const first = node.arguments?.[0]
      const pattern = first === undefined ? null : staticText(first)
      out.push({ line: lineOf(node), pattern, arg: first?.getText(sf) ?? '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const EXPECTED_FILES = ['unbounded_walk.ts', 'unbounded_walk_scan.ts', 'unbounded_walk_tools.ts', 'unbounded_walk_words.ts', 'unbounded_walk_xargs.ts']

/** Every unbounded_walk module in src whatever its extension, so a new file cannot skip this guard. */
const FILES = pinnedPopulation({
  what: 'src/unbounded_walk* files',
  items: fs.readdirSync(SRC).filter((name) => /^unbounded_walk/.test(name)).sort(),
  floor: EXPECTED_FILES.length,
  mustInclude: ['unbounded_walk_words.ts', 'unbounded_walk_xargs.ts'],
})

/** One site per entry, keyed by file and the exact group text, each with the reason it is linear. */
const LINEAR_BY_DESIGN: ReadonlyArray<{ file: string; group: string; reason: string }> = [
  {
    file: 'unbounded_walk_xargs.ts',
    group: String.raw`(\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)`,
    reason: 'every iteration must open with a literal `/`, which no class inside it matches, so iterations cannot overlap',
  },
  {
    file: 'unbounded_walk_xargs.ts',
    group: String.raw`(?:[A-Za-z0-9_. +-]|\\[|()])`,
    reason: 'the alternatives start with disjoint characters (a class without a backslash, a backslash) and have fixed length',
  },
]

/** RegExp calls whose first argument is computed, keyed by file and its exact source text, each with the reason it is safe. */
const COMPUTED_ARG_ALLOWED: ReadonlyArray<{ file: string; arg: string; reason: string }> = [
  {
    file: 'unbounded_walk_words.ts',
    arg: 'drive + String.raw' + '`[\\\\/]+(home|Users)[\\\\/]*$`',
    reason: 'drive is the fixed three-alternative const on the line above (no quantified group), the rest is a class and a literal group',
  },
  {
    file: 'unbounded_walk_words.ts',
    arg: 'String.raw' + '`^(?:(/)(.*)|(${HOME_PREFIX})(?:[\\\\/](.*))?)$`',
    reason: 'HOME_PREFIX is a fixed alternation of literals and a one-class star; no group in the pattern repeats',
  },
]

describe('the unbounded-walk patterns carry no repeating quantified group', () => {
  it('covers every unbounded_walk module in src, so a new module cannot skip this guard', () => {
    expect(FILES).toEqual(EXPECTED_FILES)
  })

  it.each(FILES)('%s has no regex that quantifies a group whose body repeats, and every RegExp argument is a literal', (file) => {
    const exempt = (group: string): boolean => LINEAR_BY_DESIGN.some((entry) => entry.file === file && entry.group === group)
    const src = fs.readFileSync(path.join(SRC, file), 'utf8')
    const computedAllowed = (arg: string): boolean => COMPUTED_ARG_ALLOWED.some((entry) => entry.file === file && entry.arg === arg)
    const found = regexPatterns(file, src).flatMap(({ line, pattern, arg }) => pattern === null
      ? (computedAllowed(arg) ? [] : [`${file}:${String(line)} RegExp called with a computed pattern: ${arg}`])
      : repeatingGroups(pattern).filter((group) => !exempt(group)).map((group) => `${file}:${String(line)} ${group}`))
    expect(found, `a regex in ${file} quantifies a group whose body repeats, or takes a non-literal pattern; the entries name the line`).toEqual([])
  })

  it('flags the shapes that backtrack, a RegExp string holding one, and no shape without a repeat inside a quantified group', () => {
    // Negative control: without it the per-file rows could pass on a scanner that never matches anything.
    expect(repeatingGroups(String.raw`(\[.*\])+`)).toEqual([String.raw`(\[.*\])`])
    expect(repeatingGroups(String.raw`(a|aa)+`)).toEqual(['(a|aa)'])
    expect(repeatingGroups(String.raw`(a?){30}`)).toEqual(['(a?)'])
    expect(repeatingGroups(String.raw`(?:ab|c)+`)).toEqual(['(?:ab|c)'])
    expect(repeatingGroups(String.raw`(\.)+`)).toEqual([])
    expect(repeatingGroups(String.raw`\[.*\]`)).toEqual([])
    expect(repeatingGroups(String.raw`(ab)+`)).toEqual([])
    expect(regexPatterns('control.ts', "const r = new RegExp('(a?)' + '{30}')")).toEqual([{ line: 1, pattern: '(a?){30}', arg: "'(a?)' + '{30}'" }])
    expect(regexPatterns('control.ts', 'const r = new RegExp(source)')).toEqual([{ line: 1, pattern: null, arg: 'source' }])
  })
})
