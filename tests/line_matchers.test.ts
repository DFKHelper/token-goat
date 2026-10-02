/** The linear matchers in src/line_matchers.ts replace regexes that backtracked quadratically. Each is checked exhaustively against the original regex over every short string drawn from an alphabet chosen to hit its edge cases, then run on a 200,000-character pathological line. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { extractCssSymbols, extractMarkdownSymbols, extractTomlSymbols } from '../src/parser_structured.js'
import { findMarkdownHeaders } from '../src/section_reader.js'
import { ATX_CLASS_BREAK_RE, ATX_DOT_BREAK_RE, matchAtxHeading, matchCssSelectorSpan, matchTableHeaderName, matchTomlSectionName } from '../src/line_matchers.js'

// Provenance: HAND-DERIVED these four oracles are the regexes removed from src/parser_structured.ts and src/section_reader.ts, copied verbatim from the parent commit.
const ATX_PARSER_ORACLE = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/
const ATX_SECTION_ORACLE = /^(#{1,6})\s+([^\r\n]+?)(?:\s+#+)?\s*$/
const TOML_ORACLE = /^\s*\[\[?\s*([^\]]+)\s*\]/
const TABLE_ORACLE = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:[#;].*)?$/
const CSS_ORACLE = /^[ \t]*([^{}@][^{]*)\{/d

function everyString(alphabet: readonly string[], maxLength: number): string[] {
  let layer = ['']
  const all = ['']
  for (let n = 0; n < maxLength; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c))
    for (const item of layer) all.push(item)
  }
  return all
}

function firstDifference<T>(inputs: string[], expected: (s: string) => T, actual: (s: string) => T): string | null {
  for (const s of inputs) {
    const a = JSON.stringify(actual(s))
    const e = JSON.stringify(expected(s))
    if (a !== e) return `${JSON.stringify(s)}: matcher ${a}, regex ${e}`
  }
  return null
}

describe('matchAtxHeading', () => {
  const inputs = everyString(['#', ' ', 'a', '\r', '\u{2028}'], 7)

  it('agrees with the parser regex on every short string', () => {
    const regex = (s: string) => {
      const m = ATX_PARSER_ORACLE.exec(s)
      return m === null ? null : { level: (m[1] as string).length, name: (m[2] as string).trim() }
    }
    expect(firstDifference(inputs, regex, (s) => matchAtxHeading(s, ATX_DOT_BREAK_RE, false))).toBeNull()
  })

  it('agrees with the section reader regex on every short string', () => {
    const regex = (s: string) => {
      const m = ATX_SECTION_ORACLE.exec(s)
      return m === null ? null : { level: (m[1] as string).length, name: (m[2] as string).trim() }
    }
    expect(firstDifference(inputs, regex, (s) => matchAtxHeading(s, ATX_CLASS_BREAK_RE, true))).toBeNull()
  })

  it('keeps ordinary headings: level, closing hashes and an empty-looking title', () => {
    expect(matchAtxHeading('## Install ##', ATX_DOT_BREAK_RE, false)).toEqual({ level: 2, name: 'Install' })
    expect(matchAtxHeading('# C#', ATX_DOT_BREAK_RE, false)).toEqual({ level: 1, name: 'C#' })
    expect(matchAtxHeading('####### seven', ATX_DOT_BREAK_RE, false)).toBeNull()
    expect(matchAtxHeading('#no-space', ATX_DOT_BREAK_RE, false)).toBeNull()
  })

  it('finishes a 200,000-character line of spaces and still names the heading', () => {
    const line = '# a' + ' '.repeat(200_000) + 'b'
    expect(matchAtxHeading(line, ATX_DOT_BREAK_RE, false)).toEqual({ level: 1, name: 'a' + ' '.repeat(200_000) + 'b' })
    expect(matchAtxHeading(line, ATX_CLASS_BREAK_RE, true)?.level).toBe(1)
    expect(matchAtxHeading('#' + ' '.repeat(200_000), ATX_DOT_BREAK_RE, false)).toEqual({ level: 1, name: '' })
  })
})

describe('matchTomlSectionName', () => {
  it('agrees with the TOML regex on every short string', () => {
    const regex = (s: string) => TOML_ORACLE.exec(s)?.[1] ?? null
    expect(firstDifference(everyString(['[', ']', ' ', 'a', '\r'], 7), regex, matchTomlSectionName)).toBeNull()
  })

  it('keeps table and array-of-tables names, and finishes a long unterminated header', () => {
    expect(matchTomlSectionName('[package]')?.trim()).toBe('package')
    expect(matchTomlSectionName('[[bin]]')?.trim()).toBe('bin')
    expect(matchTomlSectionName('[a' + ' '.repeat(200_000) + 'b')).toBeNull()
  })
})

describe('matchTableHeaderName', () => {
  it('agrees with the table-header regex on every short string', () => {
    const regex = (s: string) => TABLE_ORACLE.exec(s)?.[1] ?? null
    expect(firstDifference(everyString(['[', ']', ' ', 'a', '#', ';', '\r'], 7), regex, matchTableHeaderName)).toBeNull()
  })

  it('keeps names with trailing comments and finishes a 200,000-bracket line', () => {
    expect(matchTableHeaderName('[ section ]  # note')).toBe('section')
    expect(matchTableHeaderName('[[tool.x]] ; c')).toBe('tool.x')
    expect(matchTableHeaderName('[link](url)')).toBeNull()
    expect(matchTableHeaderName('['.repeat(200_000))).toBeNull()
  })
})

describe('matchCssSelectorSpan', () => {
  it('agrees with the selector regex on every short string', () => {
    const regex = (s: string) => {
      const m = CSS_ORACLE.exec(s)
      const range = (m as (RegExpExecArray & { indices?: Array<[number, number] | undefined> }) | null)?.indices?.[1]
      return range === undefined ? null : { start: range[0], end: range[1] }
    }
    expect(firstDifference(everyString(['{', '}', '@', ' ', '\t', 'a'], 7), regex, matchCssSelectorSpan)).toBeNull()
  })

  it('keeps selectors, and finishes a 200,000-tab line with no brace', () => {
    expect(matchCssSelectorSpan('  .a, .b {')).toEqual({ start: 2, end: 9 })
    expect(matchCssSelectorSpan('@media (x) {')).toBeNull()
    expect(matchCssSelectorSpan('\t'.repeat(200_000) + 'x')).toBeNull()
  })
})

describe('the quadratic-backtracking lint suppression is gone', () => {
  // Provenance: HAND-DERIVED the suppression comment is what let the quadratic regexes past eslint, so its absence is what keeps the rule guarding these files.
  it.each(['src/parser_structured.ts', 'src/section_reader.ts'])('%s does not disable regexp/no-super-linear-backtracking', (file) => {
    expect(readFileSync(join(process.cwd(), file), 'utf8')).not.toContain('no-super-linear-backtracking')
  })
})

describe('the extractors finish on a pathological line and still find ordinary headers', () => {
  // Provenance: HAND-DERIVED the three inputs are the orchestrator's measured worst cases (a heading, a table header and a selector line each followed by a very long whitespace run).
  const long = 100_000

  it('markdown', () => {
    const symbols = extractMarkdownSymbols(`# Top\n# a${' '.repeat(long)}b\n## Next ##\n`, 'a.md')
    expect(symbols.map((s) => s.name)).toEqual(['Top', 'a' + ' '.repeat(long) + 'b', 'Next'])
    expect(findMarkdownHeaders([`# a${' '.repeat(long)}b`, '## Two']).map((h) => h.heading)).toEqual(['a' + ' '.repeat(long) + 'b', 'Two'])
  })

  it('toml', () => {
    const names = extractTomlSymbols(`[package]\n[[bin]]\n[a${' '.repeat(long)}b\n`, 'a.toml').filter((s) => s.kind === 'section').map((s) => s.name)
    expect(names).toEqual(['package', 'bin'])
  })

  it('css', () => {
    const names = extractCssSymbols(`${'\t'.repeat(long)}x\n.a, .b {\n  color: red;\n}\n`, 'a.css').map((s) => s.name)
    expect(names).toEqual(['.a', '.b'])
  })
})
