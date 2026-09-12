/**
 * Structural guard for the .cls/LaTeX misclaim defect: `refineLanguageByContent`'s `.cls` chain
 * used to check "is this VB6?" then "is this ABL?" and, failing both, fall through to Apex -- its
 * path-only default -- with no check at all for LaTeX, which also ships a `.cls` file. A LaTeX
 * class file (`\ProvidesClass{...}`) was silently reported as Apex forever, because every check in
 * the chain was a POSITIVE test for one language OTHER than the one that leaked through.
 *
 * The failure shape here is specific to how content-sniffing extensions are written: a sniff
 * function that tests "is this NOT the default language" (a negative test) rather than "does this
 * content carry a marker unique to the language I'm routing TO" (a positive test) will misclaim
 * every third-party format nobody has written a check for yet, silently, because a negative test
 * can never fail loudly on an input it has never seen -- it just returns false and the caller keeps
 * the wrong default.
 *
 * So every exported sniff function in `src/languages/sniff.ts` (the population this repo's own
 * comment there names as "content sniffs that pick a language for an ambiguous extension") must
 * carry an explicit POSITIVE classification in the registry below: a one-line citation of the
 * marker unique to the language it tests for. This does not prove a sniff correct (only that a
 * human read it and named its marker) -- the point, per this repo's own established pattern (see
 * `block_comment_nesting_is_classified.test.ts`, `truncators_are_classified.test.ts`), is that an
 * unaudited or newly-added sniff is red on arrival, not silently trusted.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Content-sniff functions live in two places: src/languages/sniff.ts (the shared home most of them
// use, per its own header comment) and parser_types.ts itself for isVb6ClassModule, which predates
// sniff.ts and stayed put rather than being moved for its own sake. CONTENT_SNIFFS in
// parser_types.ts is the caller that wires every one of these into an extension's refine chain, so
// scanning both files this way names the same population that table draws from.
const SNIFF_FILES = [path.join(HERE, '..', '..', 'src', 'languages', 'sniff.ts'), path.join(HERE, '..', '..', 'src', 'parser_types.ts')]

// `export function is<Name>(content...)`.
const SNIFF_FN_RE = /^export function (is[A-Za-z]\w*)\s*\(/gm

function findSniffFunctions(): string[] {
  const names: string[] = []
  for (const file of SNIFF_FILES) {
    const src = fs.readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    SNIFF_FN_RE.lastIndex = 0
    while ((m = SNIFF_FN_RE.exec(src)) !== null) names.push(m[1]!)
  }
  return names
}

/**
 * Every content sniff this repo ships, with the marker it positively tests for (never "not the
 * default language"). A sniff whose only real work is a negated check of the default -- as the old
 * `.cls` chain effectively was, since VB6 and ABL were checked but nothing else was, so any third
 * unrecognized format fell through to Apex by omission -- must not be added here as POSITIVE; the
 * comment must instead say so honestly, and that dishonesty is exactly what a human reviewer reading
 * this registry is meant to catch that a name-only scan cannot.
 */
const CLASSIFICATION: Readonly<Record<string, 'POSITIVE'>> = {
  // A `.cls` file is a VB6 class module only on the VB6 IDE's own `VERSION 1.0 CLASS` header or an `Attribute VB_Name = "..."` line -- neither is valid Apex or LaTeX.
  isVb6ClassModule: 'POSITIVE',
  // A `.p`/`.w`/`.cls` file is ABL only when its head has a line only ABL writes (a `&ANALYZE-SUSPEND`,
  // a DEFINE/FUNCTION/FOR EACH statement, or a colon-terminated PROCEDURE/CLASS/INTERFACE header).
  isAblSource: 'POSITIVE',
  // A `.m` file is MATLAB/Octave only on its own `function` or `classdef` header line shape.
  isMatlabSource: 'POSITIVE',
  // A `.m` file is Objective-C only on `#import <...>`/`#import "..."`, `@interface`, `@implementation` or `@protocol`.
  isObjcSource: 'POSITIVE',
  // A `.h` file is an Objective-C header only on a leading `@interface` or `@protocol` line.
  isObjcHeader: 'POSITIVE',
  // A `.pp` file is Pascal only on a `unit`/`program`/`library` header (after skipping Pascal's own comment forms).
  isPascalSource: 'POSITIVE',
  // A `.t` file is Perl only on a Perl shebang, `use strict`/`use warnings`/a Test module, `package ...;`, `my $x`, or `sub name {`.
  isPerlSource: 'POSITIVE',
  // A `.pl` file is Prolog only on a `:-` directive or a `head :-` clause (and no Perl marker).
  isPrologSource: 'POSITIVE',
  // A `.cls` file is LaTeX only on its own self-identifying `\ProvidesClass{...}` or a `\documentclass{...}` driver line -- the exact positive check whose absence let a LaTeX .cls be misclaimed as Apex.
  isLatexClassFile: 'POSITIVE',
}

describe('every content-language sniff is a positive test for the language it detects', () => {
  const sites = findSniffFunctions()

  it('has a real, present population of content sniffs, not an empty or stale list', () => {
    pinnedPopulation({
      what: 'exported is* content-sniff functions in src/languages/sniff.ts and parser_types.ts',
      items: sites,
      floor: 5,
      mustInclude: ['isVb6ClassModule', 'isLatexClassFile'],
    })
  })

  it('every discovered sniff carries an explicit POSITIVE classification naming its marker', () => {
    const unclassified = sites.filter((s) => CLASSIFICATION[s] === undefined)
    expect(unclassified, 'a content sniff added with no positive-marker classification in this guard').toEqual([])
  })

  it('the registry names no function this scan no longer finds (a stale entry hides a rename)', () => {
    const found = new Set(sites)
    const stale = Object.keys(CLASSIFICATION).filter((name) => !found.has(name))
    expect(stale, 'CLASSIFICATION names a function findSniffFunctions no longer discovers').toEqual([])
  })
})
