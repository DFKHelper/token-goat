/** A "N more <things>" notice built by hand as `${n} more lines` reads "1 more lines" whenever exactly one thing is hidden, which is how the json_array filter came to print `[... 1 more items not shown]`. Every such notice in src/ goes through `countNoun` from src/util.ts, which picks the noun from the count; this guard fails when a new hand-built plural after a `${count} more` interpolation appears. HAND-DERIVED: the pattern below is the English shape of the defect, not read off any producer. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** `${expr} more ` followed by the words of the notice up to the first punctuation that ends the noun phrase. */
const MORE_AFTER_COUNT_RE = /\$\{([^{}]*)\} more ([^`;,)\]:(—\n]*)/g
/** A word that reads as a hand-written plural: a literal like `lines`/`entries`/`'Collecting' lines`, or an interpolated noun with an `s` glued on (`${noun}s`). */
const PLURAL_WORD_RE = /^(?:[A-Za-z'<>-]*[a-z]s'?|\$\{[^}]*\}s)$/
const NOT_PLURAL_NOUNS = new Set(['is', 'was', 'has', 'its', 'this', 'as', 'us'])

/** Hand-built plurals that are deliberate, each with the reason it is not a printed count. Keyed `relative/path.ts :: matched text`. */
const ALLOWED = new Map<string, string>([
  ['tool_filters/helpers.ts :: ${lines.length} more lines elided by token-goat', 'a byte-budget estimate passed to Buffer.byteLength, never printed; the plural is the longer spelling, so the budget stays conservative for the singular marker the function actually emits'],
  ['hints/markdown_hints.ts :: ${remaining} more headings', 'unreachable with a count of one in production: every caller passes extractMarkdownHeadings at its default 40-heading cap, and 5 guidance lines plus 40 headings never reach the 60-line budget that emits it; editing the file moves the markdown embedding fingerprint and re-embeds every markdown file on upgrade'],
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function handBuiltPlurals(): string[] {
  const found: string[] = []
  for (const file of walk(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/')
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(MORE_AFTER_COUNT_RE)) {
      const words = (m[2] ?? '').trim().split(/\s+/)
      if (words.some((w) => PLURAL_WORD_RE.test(w) && !NOT_PLURAL_NOUNS.has(w))) found.push(`${rel} :: ${m[0].trim()}`)
    }
  }
  return found
}

describe('elision counts agree with their noun', () => {
  const found = handBuiltPlurals()

  it('builds every "N more <things>" notice through countNoun', () => {
    const unexplained = found.filter((f) => !ALLOWED.has(f))
    expect(unexplained).toEqual([])
  })

  it('still finds every allowlisted entry, so a stale allowance cannot hide a new one', () => {
    pinnedPopulation({ what: 'allowlisted hand-built plurals', items: found, floor: ALLOWED.size, mustInclude: [...ALLOWED.keys()] })
  })

  it('flags the shapes the defect takes', () => {
    // HAND-DERIVED: the json_array spelling this guard was written for, an interpolated noun with a glued `s`, and the countNoun form that replaces both.
    const flagged = (src: string): boolean => [...src.matchAll(MORE_AFTER_COUNT_RE)].some((m) => (m[2] ?? '').trim().split(/\s+/).some((w) => PLURAL_WORD_RE.test(w)))
    expect(flagged('`[... ${extra} more items not shown]`')).toBe(true)
    expect(flagged('`+${n} more ${rule} ${noun}s]`')).toBe(true)
    expect(flagged("`[... ${countNoun(extra, 'more item')} not shown]`")).toBe(false)
  })
})
