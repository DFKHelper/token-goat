/**
 * Behavioral guard: stored index bytes must stay proportional to source bytes.
 *
 * This is the invariant whose violation produced a 2.9 GB `global.db`, "database is locked"
 * errors, and multi-minute machine stalls during `token-goat index`. The defect was in the JSON
 * extractor -- each top-level key stored its whole source line as its body, and minified JSON
 * puts every key on line 1, so a 1.5 MB file with 1142 keys stored 1.6 GB. But the *class* is
 * language-agnostic: any extractor that derives a body from a line, a region, or a parent node
 * can quietly become quadratic on input whose lines are the whole file.
 *
 * So this test does not assert anything about JSON. It asserts the property that actually
 * matters, measured through the real unmocked pipeline (real file -> indexFileSync -> real DB):
 *
 *     total stored symbol bytes for a file <= AMPLIFICATION_LIMIT x that file's size
 *
 * A quadratic extractor fails this by orders of magnitude, so the limit does not need to be
 * tight to be effective -- it needs to be far below (symbols x file size) and comfortably above
 * legitimate overlap. Nested symbols legitimately double-count (a class body contains its
 * methods' bodies), which is why the limit is not 1x.
 *
 * The structural counterpart -- that the single INSERT bounding every body still exists and
 * still elides rather than truncates -- is tests/guards/symbol_body_bound.test.ts, which runs in
 * the fast pre-commit tier.
 */
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { indexFileSync, MAX_SYMBOL_BODY_CHARS } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'

/**
 * Nesting means a symbol's body can be counted more than once (a class body contains each of its
 * methods). Deeply nested real code stays well under 4x; a quadratic extractor on these fixtures
 * lands in the hundreds. Anything between is a regression worth investigating, not a threshold to
 * relax.
 */
const AMPLIFICATION_LIMIT = 4

interface Fixture {
  /** File name; its extension selects the language extractor under test. */
  readonly name: string
  /** Why this shape is dangerous for a body-from-line extractor. */
  readonly why: string
  readonly content: string
}

/** N top-level keys, entire document on ONE line -- the exact shape that caused the incident. */
function minifiedJson(keys: number): string {
  const parts: string[] = []
  for (let i = 0; i < keys; i++) {
    parts.push(`"key_${i}":{"make":"MAKE_${i}","model":"MODEL_${i}","trim":"TRIM_${i}","year":${2000 + (i % 25)}}`)
  }
  return `{${parts.join(',')}}`
}

/** A minified bundle: many functions, no newlines. */
function minifiedJs(fns: number): string {
  const parts: string[] = []
  for (let i = 0; i < fns; i++) {
    parts.push(`function fn_${i}(a,b){var c=a+b;var d=c*${i};return d-a;}`)
  }
  return parts.join('')
}

/** Many symbols on one line in a curly-brace language. */
function minifiedTs(fns: number): string {
  const parts: string[] = []
  for (let i = 0; i < fns; i++) {
    parts.push(`export function tsFn_${i}(a: number): number { return a + ${i} }`)
  }
  return parts.join(' ')
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'minified.json',
    why: 'the incident shape: every top-level key shares line 1 with the whole document',
    content: minifiedJson(1200),
  },
  {
    name: 'pretty.json',
    why: 'same key count, one key per line -- the control that proves the bound is not vacuous',
    content: JSON.stringify(JSON.parse(minifiedJson(1200)), null, 2),
  },
  {
    name: 'minified.js',
    why: 'a webpack-style bundle: hundreds of functions, zero newlines',
    content: minifiedJs(900),
  },
  {
    name: 'minified.ts',
    why: 'same shape through the TypeScript extractor',
    content: minifiedTs(900),
  },
  {
    name: 'longnames.json',
    why: 'huge repeated identifiers -- proves name/context stay linear (each occurs once in source)',
    content: `{${Array.from(
      { length: 300 },
      (_, i) => `"${'k'.repeat(1500)}_${i}":{"a":${i}}`,
    ).join(',')}}`,
  },
  {
    name: 'sections.md',
    why: 'many flat sections with large bodies -- markdown derives each body from a line range',
    content: Array.from(
      { length: 200 },
      (_, i) => `## Section ${i}\n\n${'lorem ipsum dolor sit amet consectetur '.repeat(50)}\n`,
    ).join('\n'),
  },
]

/**
 * Total stored bytes attributable to one indexed file, across every text column that holds
 * file-derived content -- not just `body`.
 *
 * Measuring the whole row rather than the one column that broke matters. `body` went quadratic
 * because it was derived from a *line*, which many symbols share. Any column derived from a
 * shared region can do the same: `docstring` is the live candidate (no extractor populates it
 * today, but a file-level doc comment attributed to every symbol in the file is exactly the
 * shared-region shape). `name` and `context` are linear by construction -- each stores a
 * substring that occurs once in the source -- but asserting on the whole row means a future
 * column does not need someone to remember to add it here.
 */
function storedBodyBytes(filePath: string): { total: number; max: number; rows: number } {
  const db = getDb(globalDbPath())
  const sym = db.prepare(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(LENGTH(name) + LENGTH(body) + LENGTH(COALESCE(docstring, ''))), 0) AS total,
            COALESCE(MAX(LENGTH(body)), 0) AS max
       FROM symbols WHERE file_path = ?`,
  ).get(filePath) as { rows: number; total: number; max: number }
  const ref = db.prepare(
    `SELECT COALESCE(SUM(LENGTH(name) + LENGTH(COALESCE(context, ''))), 0) AS total
       FROM refs WHERE file_path = ?`,
  ).get(filePath) as { total: number }
  return { rows: sym.rows, max: sym.max, total: sym.total + ref.total }
}

describe('index storage amplification (real pipeline)', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    '%s keeps stored symbol bytes proportional to file size',
    (_name, fixture) => {
      const root = mkdtempSync(join(tmpdir(), 'tg-amp-'))
      try {
        const file = join(root, fixture.name)
        writeFileSync(file, fixture.content)
        const fileBytes = statSync(file).size
        const key = normalizePath(file)

        indexFileSync(key)
        const { total, max, rows } = storedBodyBytes(key)

        // A fixture that indexes nothing would pass the bound trivially and silently stop
        // guarding anything, which is how this class of test rots. Require real symbols.
        expect(rows, `${fixture.name} indexed no symbols -- ${fixture.why}`).toBeGreaterThan(10)

        expect(
          total,
          `${fixture.name}: stored ${total} body bytes for a ${fileBytes}-byte file across ${rows} ` +
            `symbols (${(total / fileBytes).toFixed(1)}x). ${fixture.why}. An extractor that derives ` +
            `each symbol's body from its whole source line goes quadratic on this input.`,
        ).toBeLessThanOrEqual(fileBytes * AMPLIFICATION_LIMIT)

        // The per-row cap is the backstop that holds even if an extractor does go quadratic.
        expect(max).toBeLessThanOrEqual(MAX_SYMBOL_BODY_CHARS)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('bounds a file whose every symbol would carry the whole document', () => {
    // The worst case stated directly: one line, maximal key count, each key's *source line* is
    // the entire file. Pre-fix this stored ~keys x fileBytes. The assertion is deliberately
    // written against the multiple, not an absolute byte count, so it stays meaningful if the
    // fixture size changes.
    const root = mkdtempSync(join(tmpdir(), 'tg-amp-worst-'))
    try {
      const file = join(root, 'worst.json')
      const content = minifiedJson(3000)
      writeFileSync(file, content)
      const key = normalizePath(file)
      indexFileSync(key)

      const { total, rows } = storedBodyBytes(key)
      expect(rows).toBeGreaterThan(1000)
      // Pre-fix this ratio was ~= rows (3000x). Post-fix it is ~1x.
      expect(total / content.length).toBeLessThan(AMPLIFICATION_LIMIT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
