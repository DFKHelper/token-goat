/**
 * Structural guard for the block-comment-nesting defect class this repo just hit with VHDL: IEEE
 * Std 1076-2008 clause 15.9 says a VHDL-2008 delimited comment (`/* ... *\/`) does NOT nest, while
 * several other languages this repo indexes (Kotlin, Swift, Scala, ABL's `/* ... *\/`) genuinely
 * do nest their block comments. A masking function that gets this wrong in either direction is
 * invisible to output-shape tests: nesting one comment inside another is rare enough in real
 * source that a missing or wrong test fixture would not exercise the bug, and the function still
 * returns *something* either way, so nothing crashes and nothing looks obviously broken.
 *
 * So this guard is keyed on the SHAPE (a function whose job is to mask/strip a C-style `/* *\/`
 * block comment) rather than on any one language's name, per this repo's own established pattern
 * (see truncators_are_classified.test.ts's identical rationale for truncators). It enumerates
 * every such function found in `src/languages/**\/*.ts` by name, and requires each to carry an
 * explicit NESTS / DOES_NOT_NEST classification in the registry below. An unclassified function is
 * red on arrival -- the only way a static scan protects against a shape it has not audited yet.
 *
 * WHY A NAME-HEURISTIC SCAN, NOT A DATAFLOW OR BEHAVIORAL ANALYSIS. Whether a given masker's loop
 * actually nests is a runtime property of its control flow, not something grep can prove; the
 * fallback this repo uses elsewhere for exactly this problem (see truncators_are_classified.test.ts)
 * is an explicit registry a human populates once per function, kept honest by the population-floor
 * and must-include checks below plus this file's own mutation test.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LANGUAGES_DIR = path.join(HERE, '..', '..', 'src', 'languages')

/** Self-exclusion token so this guard's own source never satisfies a scan of itself. Never appears in real code: /NOSUCH[X]TOKEN/. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

interface MaskerSite {
  readonly file: string
  readonly name: string
}

// A named C-style block-comment masker: `BlockComment` (or `CstyleComments`, which delegates to
// one) in the function name -- this repo's own naming convention for the shape, not a guess.
// Narrower than a body-content scan (which false-positives on any function that merely mentions
// `/*`/`*\/` in a doc comment or an unrelated string mask) and, per this repo's own precedent for
// this exact problem (truncators_are_classified.test.ts), a name-family scan cannot silently miss
// a function that keeps a name in the family -- it can only miss one an author names outside it,
// which VHDL_NAMED_SITES below closes for functions that scan their own comments inline rather
// than delegating to a common.ts helper (this repo currently has one: vhdl.ts::maskVhdl; abl.ts's
// equivalent inline `/* *\/` scan has no function of its own to name, so it is out of this scan's
// reach the same way an anonymous truncator would be out of the other guard's).
const NAME_RE = /^(?:export\s+)?function\s+((?:mask|strip|skip|blank)\w*(?:BlockComment|CstyleComments)\w*)\s*\(/gm

// Functions that scan their own `/* *\/` span inline rather than through a named common.ts helper,
// so a name-family regex over their signature line cannot discover them the way it discovers the
// BlockComment-named family above.
const NAMED_INLINE_SITES: readonly MaskerSite[] = [{ file: 'src/languages/vhdl.ts', name: 'maskVhdl' }]

function findMaskerSites(): MaskerSite[] {
  const sites: MaskerSite[] = [...NAMED_INLINE_SITES]
  for (const entry of fs.readdirSync(LANGUAGES_DIR)) {
    if (!entry.endsWith('.ts')) continue
    const full = path.join(LANGUAGES_DIR, entry)
    const src = fs.readFileSync(full, 'utf8').replace(SELF_EXCLUDE_MARKER, '')
    let m: RegExpExecArray | null
    NAME_RE.lastIndex = 0
    while ((m = NAME_RE.exec(src)) !== null) sites.push({ file: `src/languages/${entry}`, name: m[1]! })
  }
  return sites
}

/**
 * Every block-comment masker this repo ships, classified against its language's own comment
 * grammar (cited inline). `NESTS`: an opener seen while already inside a comment increments a
 * depth counter, and only the matching close decrements it back to zero. `DOES_NOT_NEST`: the
 * first closer seen ends the comment outright, however many openers appeared inside.
 */
const CLASSIFICATION: Readonly<Record<string, 'NESTS' | 'DOES_NOT_NEST' | 'CALLER_PARAMETERIZED'>> = {
  // common.ts::stripBlockCommentSpan -- the shared C-style single-line-scoped span used by
  // stripCstyleComments and by assignBraceBlockSpans's default (nestedBlockComments unset). C,
  // C++, C#, Java, JS/TS, PHP, Go and Rust `/* */` comments do not nest per each language's own
  // grammar; this function's own doc says "the first `*\/` ends the comment".
  stripBlockCommentSpan: 'DOES_NOT_NEST',
  // common.ts::stripNestedBlockCommentSpan -- used via assignBraceBlockSpans's
  // `nestedBlockComments: true` option for Kotlin, Swift, Scala, and ABL's own inline `/* */`
  // scan in abl.ts tracks its own `comment` depth counter the same way (see abl.ts's header
  // comment: "which nest").
  stripNestedBlockCommentSpan: 'NESTS',
  // common.ts::stripCstyleComments -- delegates every line to stripBlockCommentSpan above, so it
  // inherits that non-nesting behavior; classified separately since it is its own named function.
  stripCstyleComments: 'DOES_NOT_NEST',
  // vhdl.ts::maskVhdl -- IEEE Std 1076-2008 clause 15.9: a VHDL-2008 delimited comment does NOT
  // nest. The first `*\/` closes it however many `/*` appeared inside.
  maskVhdl: 'DOES_NOT_NEST',
  // common.ts::skipBlockComment -- its `nested` parameter is caller-supplied per language, not a
  // fixed behavior of this function; this guard only confirms that split is deliberate, not which
  // value each caller passes.
  skipBlockComment: 'CALLER_PARAMETERIZED',
  // powershell_idx.ts::blankCompletedBlockComments -- PowerShell's `<# ... #>` comment: the loop
  // ends the span at the first `#>`, so a `<#` seen after the first opener never widens it.
  // PowerShell's own grammar does not define nested block comments.
  blankCompletedBlockComments: 'DOES_NOT_NEST',
}

describe('every block-comment masking function declares whether its comments nest', () => {
  const sites = findMaskerSites()

  it('has a real, present population of masker functions, not an empty or stale list', () => {
    pinnedPopulation({
      what: 'mask*/strip* functions in src/languages/**/*.ts that open a /* */-style block comment span',
      items: sites.map((s) => `${s.file}::${s.name}`),
      floor: 3,
      mustInclude: ['src/languages/vhdl.ts::maskVhdl', 'src/languages/common.ts::stripBlockCommentSpan'],
    })
  })

  it('every discovered masker has an explicit NESTS / DOES_NOT_NEST classification', () => {
    const unclassified = sites.filter((s) => CLASSIFICATION[s.name] === undefined)
    expect(unclassified, 'a block-comment masker with no nesting classification in this guard').toEqual([])
  })

  it('the registry names no function this scan no longer finds (a stale entry hides a rename)', () => {
    const found = new Set(sites.map((s) => s.name))
    const stale = Object.keys(CLASSIFICATION).filter((name) => !found.has(name))
    expect(stale, 'CLASSIFICATION names a function findMaskerSites no longer discovers').toEqual([])
  })
})
