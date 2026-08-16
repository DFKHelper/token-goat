/**
 * Structural guard on the `symbols.body` storage choke point.
 *
 * The bug this exists to prevent: `extractJsonSymbols` stored each top-level key's *whole source
 * line* as its body. Minified JSON puts every key on line 1, so every symbol stored a copy of the
 * entire file and stored bytes grew as (keys x file size). One 1.5 MB, 1142-key file inflated
 * `global.db` by 1.6 GB on its own; the index reached 2.9 GB, and reindexing that single file
 * pushed enough bytes through the FTS delete triggers to hold SQLite's writer lock past db.ts's
 * 15s busy_timeout -- surfacing to users as "database is locked" and as multi-minute stalls
 * during `token-goat index`.
 *
 * The permanent architectural defense is not "fix the JSON extractor" (done separately, and only
 * fixes one language). It is that *every* parsed symbol reaches the DB through exactly one INSERT,
 * and that INSERT bounds the body. That makes an unbounded-body bug in any present or future
 * language extractor incapable of bloating the index. These assertions keep that property true.
 *
 * Pure source introspection: no bundle build, no DB, no git fixtures -- this runs in the
 * pre-commit tier so the property is checked before a commit lands, not at push or in CI.
 * The behavioral counterpart, which drives real files through the real pipeline and measures
 * actual stored bytes, is tests/index_amplification_guard.test.ts.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(SRC_DIR, f))
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/** Extract the source text of a top-level `function NAME(...) { ... }` by brace matching. */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?function ${name}\\b`, 'm'))
  expect(start, `expected a top-level function ${name}`).toBeGreaterThanOrEqual(0)
  // Find the body's opening brace, not a brace inside the parameter list -- inline object type
  // literals (`{ body: string; ... }`) live in the params and would otherwise match first.
  let parens = 0
  let seenParams = false
  let open = -1
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '(') {
      parens++
      seenParams = true
    } else if (c === ')') {
      parens--
    } else if (c === '{' && seenParams && parens === 0) {
      open = i
      break
    }
  }
  expect(open, `could not locate body of ${name}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

/**
 * Extract the full argument text of a `receiver.method(...)` call by paren matching.
 *
 * A regex cannot do this: the insert passes several nested calls, and any bounded `[^)]*`
 * pattern stops at the first inner `)`. That truncation is not cosmetic -- a guard reading only
 * a prefix of the argument list would happily miss a raw `s.body` smuggled in after the cut,
 * which is precisely the thing these tests exist to prevent.
 */
function callArgs(src: string, call: string): string {
  const at = src.indexOf(`${call}(`)
  expect(at, `expected a ${call}(...) call`).toBeGreaterThanOrEqual(0)
  const open = at + call.length
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error(`unbalanced parens in ${call}(...)`)
}

describe('symbols.body storage choke point', () => {
  it('has exactly one INSERT INTO symbols in the whole source tree', () => {
    // A second insert path is how the cap gets bypassed: whoever adds it will not know this
    // invariant exists. Fail here instead, and route the new path through writeParseResult.
    // (symbols_fts inserts are the FTS mirror, not the base table, and are excluded.)
    const hits: string[] = []
    for (const file of srcFiles()) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+symbols\b(?!_fts)/i.test(line)) {
            hits.push(`${path.relative(SRC_DIR, file)}:${i + 1}`)
          }
        })
    }
    expect(hits.length, `expected exactly one base-table symbols INSERT, found: ${hits.join(', ')}`).toBe(1)
    expect(hits[0]).toMatch(/^parser\.ts:/)
  })

  it('binds the body column through boundSymbolBody, never a raw symbol body', () => {
    const src = read(path.join(SRC_DIR, 'parser.ts'))
    const args = callArgs(src, 'insSym.run')
    expect(args).toContain('boundSymbolBody(s.body)')
    // ...and must not smuggle the raw body in as well.
    expect(args).not.toMatch(/(?<!boundSymbolBody\()\bs\.body\b/)
  })

  it('binds the docstring column through boundSymbolDocstring, never a raw docstring', () => {
    // symbols.docstring is the second file-derived free-text column on the same row. It is
    // latent today (no extractor populates it), which is exactly why it needs a structural
    // guard rather than a behavioural one: the day an extractor starts filling it, the cap must
    // already be in place instead of being remembered.
    const src = read(path.join(SRC_DIR, 'parser.ts'))
    const args = callArgs(src, 'insSym.run')
    expect(args).toContain('boundSymbolDocstring(s.docstring)')
    expect(args).not.toMatch(/(?<!boundSymbolDocstring\()\bs\.docstring\b/)
  })

  it('truncates an over-cap docstring instead of eliding it', () => {
    // The deliberate inverse of the body contract above, and the reason the two columns cannot
    // share one helper. No line range is recorded for a docstring, so there is no source to
    // re-slice it from: eliding would destroy it outright and flip `outline`'s documented flag
    // to "undocumented" for precisely the most heavily documented symbols. Truncation keeps the
    // signal (the first line, which is all any consumer displays) while still bounding growth.
    const body = functionBody(read(path.join(SRC_DIR, 'parser.ts')), 'boundSymbolDocstring')
    expect(body).toMatch(/\.slice\s*\(/)
    expect(body).toContain('DOCSTRING_TRUNCATION_MARKER')
  })

  it('elides an over-cap body instead of truncating it', () => {
    // Load-bearing distinction. read_commands.ts's resolveBody re-slices an EMPTY stored body
    // from the source file over the symbol's line range, which is what makes the cap lossless.
    // A truncated body is non-empty, so resolveBody serves the prefix as though it were the
    // whole symbol while line_end still advertises the full range -- bounded disk usage bought
    // with a silent correctness regression in `read`/`symbol`/`brief`. Never trade that.
    const body = functionBody(read(path.join(SRC_DIR, 'parser.ts')), 'boundSymbolBody')
    expect(body).toMatch(/return[^]*''|return[^]*""/)
    expect(body).not.toMatch(/\.(slice|substring|substr)\s*\(/)
  })

  it('keeps resolveBody empty-body fallback the reason elision is safe', () => {
    // If resolveBody ever stops re-reading source for an empty body, elision silently becomes
    // data loss. Pin the fallback's existence here so that change cannot land quietly.
    const src = read(path.join(SRC_DIR, 'read_commands.ts'))
    const body = functionBody(src, 'resolveBody')
    // Guards the two halves of the fallback: it must branch on an empty stored body, and it must
    // reconstruct that body by reading the source over [lineStart, lineEnd].
    expect(body).toMatch(/entry\.body\s*!==\s*''/)
    expect(body).toMatch(/readFileText|readFileSync/)
    expect(body).toMatch(/lineStart/)
    expect(body).toMatch(/lineEnd/)
  })

  it('caps bodies at a value small enough to bound a pathological file', () => {
    // The value lives in constants.ts (db.ts bakes it into the partial index backing
    // checkSymbolBodySize, and parser.ts imports db.ts, so it cannot be declared in parser.ts).
    // parser.ts still has to re-export it under the old name, which every caller imports.
    expect(read(path.join(SRC_DIR, 'parser.ts')), 'parser.ts must still export MAX_SYMBOL_BODY_CHARS')
      .toMatch(/export const MAX_SYMBOL_BODY_CHARS\s*=/)
    const src = read(path.join(SRC_DIR, 'constants.ts'))
    const m = /export const SYMBOL_BODY_CHAR_CAP\s*=\s*([^\n]+)/.exec(src)
    expect(m, 'SYMBOL_BODY_CHAR_CAP must exist and be exported').not.toBeNull()
    const value = Number(new Function(`return (${m![1]!})`)())
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThan(0)
    // A generous ceiling, not a style preference: symbols above this size are rare enough that
    // eliding them costs nothing, while a cap raised into the megabytes reopens the door to a
    // multi-gigabyte index. Raising this past 1 MB should be a deliberate, argued change.
    expect(value).toBeLessThanOrEqual(1024 * 1024)
  })

  it('surfaces an oversized index in doctor and points at the recovery command', () => {
    // The 2.9 GB index was invisible until someone went looking. doctor must name the condition
    // and the way out, or the next occurrence is diagnosed from scratch again.
    const src = read(path.join(SRC_DIR, 'cli_doctor.ts'))
    const m = /const DB_SIZE_WARN_BYTES\s*=\s*([^\n]+)/.exec(src)
    expect(m, 'doctor must define a DB size warning threshold').not.toBeNull()
    const value = Number(new Function(`return (${m![1]!.replace(/\/\/.*$/, '')})`)())
    expect(value).toBeGreaterThan(0)
    expect(value).toBeLessThanOrEqual(4 * 1024 * 1024 * 1024)
    expect(src).toContain('reclaim-index')
  })
})
