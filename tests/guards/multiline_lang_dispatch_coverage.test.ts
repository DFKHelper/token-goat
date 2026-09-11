/**
 * Guard: every `MultilineStringLang` member has a decided position in the adapter dispatch table.
 *
 * The bug shape this exists for: a dispatch-table entry silently missing an option its language
 * supports. `powershell` declared a multi-line string form in `MultilineStringLang` but its
 * `assignBraceBlockSpans` call omitted `multilineLang`, so the pass that widens a placeholder span
 * to the real body walked braces over raw here-string text. Nothing failed: the omission is
 * invisible to every test that calls an extractor directly, because the widening happens in the
 * wrapper the table supplies.
 *
 * So each member must be either wired (`multilineLang: '<lang>'` in its table entry) or listed in
 * EXEMPT with a reason, and every reason is checked against a marker in the source rather than
 * taken on trust: an exemption that stops being true fails here instead of reading as a decision.
 * Adding a tenth member to the union without a decision fails too, since the union must equal the
 * wired set plus the exempt set exactly.
 *
 * The union members and the table entries are FORMAT-DERIVED, read off the two source files this
 * test parses (`src/languages/common.ts` and `src/parser.ts`), which is the right source here
 * because the claim under test is a relationship between those two files and nothing else.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMMON_SRC = readFileSync(path.join(ROOT, 'src', 'languages', 'common.ts'), 'utf8')
const PARSER_SRC = readFileSync(path.join(ROOT, 'src', 'parser.ts'), 'utf8')
const R_SRC = readFileSync(path.join(ROOT, 'src', 'languages', 'r.ts'), 'utf8')

/**
 * Why a language that declares a multi-line string form still does not pass `multilineLang` to
 * `assignBraceBlockSpans`. `marker` is the source text that has to be present for the reason to
 * still hold, and `where` says which file it has to be present in.
 */
const EXEMPT: Record<string, { reason: string; where: 'entry' | 'r.ts'; markers: readonly string[] }> = {
  csharp: {
    reason: 'C# has two multi-line forms and the brace scanner expresses both directly: `stringEscapes: csharp` makes a verbatim `@"..."` opaque (doubled `""` is the escaped quote), and `rawStringQuotes` measures a variable-length `"""` run. A pre-pass mask adds nothing the scanner does not already do.',
    where: 'entry',
    markers: ["stringEscapes: 'csharp'", 'rawStringQuotes: true'],
  },
  kotlin: {
    reason: 'Kotlin\'s only multi-line form is the fixed `"""` raw string, which `tripleQuote` jumps over whole inside the brace scan.',
    where: 'entry',
    markers: ['tripleQuote: true'],
  },
  scala: {
    reason: 'Scala\'s only multi-line form is the fixed `"""` string literal (an `s`/`f` interpolator prefix sits before the delimiter and does not change it), which `tripleQuote` covers.',
    where: 'entry',
    markers: ['tripleQuote: true'],
  },
  dart: {
    reason: 'Dart spells its multi-line strings with the fixed `"""` and `\'\'\'` delimiters (an `r` raw prefix sits before the delimiter), and the entry passes both `tripleQuote` and `tripleSingleQuote`.',
    where: 'entry',
    markers: ['tripleQuote: true', 'tripleSingleQuote: true'],
  },
  elixir: {
    reason: 'Elixir blocks are `do ... end`, not braces, so the entry never calls assignBraceBlockSpans at all and there is no option to pass. extractElixir masks its own heredocs per line before matching.',
    where: 'entry',
    markers: ['extractElixir(content, filePath).symbols'],
  },
  r: {
    reason: 'The r entry never calls assignBraceBlockSpans either: extractR computes its own spans, and its brace walk passes `rRawStrings` so a raw character constant is skipped by its own mirrored closer. An ordinary R string that runs across lines is already handled by the scanner\'s quote state, which carries across newlines.',
    where: 'r.ts',
    markers: ['rRawStrings: true'],
  },
}

/** The `MultilineStringLang` union members, read off the type declaration in common.ts. */
function unionMembers(): string[] {
  const m = /export type MultilineStringLang =([^\n]*(?:\n\s*\|[^\n]*)*)/.exec(COMMON_SRC)
  expect(m, 'MultilineStringLang declaration not found in src/languages/common.ts').not.toBeNull()
  return [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((q) => q[1] as string)
}

/** The body of NO_TREE_SITTER_EXTRACTORS, which is the adapter dispatch table. */
function tableBody(): string {
  const start = PARSER_SRC.indexOf('const NO_TREE_SITTER_EXTRACTORS')
  expect(start, 'NO_TREE_SITTER_EXTRACTORS not found in src/parser.ts').toBeGreaterThan(-1)
  const end = PARSER_SRC.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return PARSER_SRC.slice(start, end)
}

/** One language's entry in the table: from its key to the start of the next top-level key. */
function tableEntry(lang: string): string {
  const body = tableBody()
  const re = new RegExp(`^  ${lang}:`, 'm')
  const m = re.exec(body)
  expect(m, `no \`${lang}\` entry in NO_TREE_SITTER_EXTRACTORS`).not.toBeNull()
  const from = m?.index ?? 0
  const nextKey = /^ {2}[a-z_]+:/m.exec(body.slice(from + 3))
  return nextKey === null ? body.slice(from) : body.slice(from, from + 3 + nextKey.index)
}

describe('MultilineStringLang dispatch coverage', () => {
  const members = unionMembers()
  const wired = new Set(
    [...tableBody().matchAll(/multilineLang: '([a-z_]+)'/g)].map((m) => m[1] as string),
  )

  it('finds a non-empty population to check', () => {
    // A guard whose population empties itself protects nothing, so both sides are floored.
    expect(members.length).toBeGreaterThanOrEqual(9)
    expect(wired.size).toBeGreaterThanOrEqual(3)
  })

  it('every union member is either wired or exempt, and never both', () => {
    for (const lang of members) {
      const isWired = wired.has(lang)
      const isExempt = Object.hasOwn(EXEMPT, lang)
      expect(isWired || isExempt, `${lang} declares a multi-line string form but the adapter table neither passes multilineLang for it nor lists it in EXEMPT with a reason`).toBe(true)
      expect(isWired && isExempt, `${lang} is both wired and exempt: one of the two is stale`).toBe(false)
    }
    // Exactly: adding a tenth member to the union without a decision fails on the first loop, and
    // an EXEMPT key for a language no longer in the union fails here.
    expect([...members].sort()).toEqual([...wired, ...Object.keys(EXEMPT)].sort())
  })

  it('every wired language really carries the option in its own entry', () => {
    expect(wired.size).toBeGreaterThan(0)
    for (const lang of wired) {
      expect(tableEntry(lang), `${lang} is counted as wired but its own entry does not pass multilineLang`).toContain(`multilineLang: '${lang}'`)
    }
  })

  it('every exemption still holds against the marker its reason names', () => {
    const keys = Object.keys(EXEMPT)
    expect(keys.length).toBeGreaterThan(0)
    for (const [lang, { reason, where, markers }] of Object.entries(EXEMPT)) {
      expect(reason.length, `${lang} needs a real reason, not a placeholder`).toBeGreaterThan(40)
      expect(markers.length, `${lang} needs at least one marker so its reason is checked rather than trusted`).toBeGreaterThan(0)
      const haystack = where === 'r.ts' ? R_SRC : tableEntry(lang)
      for (const marker of markers) {
        expect(haystack, `${lang} exemption cites \`${marker}\`, which is no longer in the source it names`).toContain(marker)
      }
    }
  })

  it('the two exempt languages that skip the widening pass really do skip it', () => {
    // These two are exempt because there is no assignBraceBlockSpans call to pass an option to. If
    // one gains a call, the exemption is wrong and the entry needs a fresh decision.
    for (const lang of ['elixir', 'r']) {
      expect(tableEntry(lang), `${lang} now calls assignBraceBlockSpans, so its EXEMPT reason no longer holds`).not.toContain('assignBraceBlockSpans')
    }
  })
})
