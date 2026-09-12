/**
 * Guard: the hand-maintained grammar-package list must stay in step with the spec-derived language list.
 *
 * `TREE_SITTER_LANGUAGES` is computed from the language spec table, so adding a tree-sitter row to
 * that table extends it automatically. `TREE_SITTER_GRAMMAR_PACKAGES` beside it in parser.ts is a
 * literal array someone has to remember to edit, and nothing tied the two together. They agree
 * today, nine and nine, which is exactly the state in which a drift is invisible: doctor would go
 * on reporting no missing grammar packages for a language whose package it had never heard of.
 *
 * The population is read out of parser.ts's own source rather than imported, because the array is
 * not exported. Reading it textually is the point: this guard has to see the literal a person
 * edits, not a value derived from the same list it is being checked against.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TREE_SITTER_LANGUAGES } from '../../src/language_specs.js'

const PARSER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'parser.ts')

/** The package names in parser.ts's `TREE_SITTER_GRAMMAR_PACKAGES` literal. */
function declaredGrammarPackages(): string[] {
  const source = fs.readFileSync(PARSER_SRC, 'utf8')
  const block = /const TREE_SITTER_GRAMMAR_PACKAGES: readonly string\[\] = \[([\s\S]*?)\]/.exec(source)
  if (block === null) return []
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('tree-sitter grammar packages and tree-sitter languages stay in step', () => {
  it('finds both lists rather than passing on an empty population', () => {
    // Either list going empty would satisfy a set comparison against the other by vacuous
    // agreement, and the regex above is one parser.ts rename away from matching nothing.
    expect(declaredGrammarPackages().length, 'TREE_SITTER_GRAMMAR_PACKAGES was not found in src/parser.ts: the literal was renamed or reformatted, so this guard is reading nothing').toBeGreaterThan(5)
    expect(TREE_SITTER_LANGUAGES.length).toBeGreaterThan(5)
  })

  it('has exactly one grammar package per tree-sitter language', () => {
    const expected = TREE_SITTER_LANGUAGES.map((lang) => `tree-sitter-${lang}`)
    const declared = declaredGrammarPackages()
    const missing = expected.filter((pkg) => !declared.includes(pkg))
    const extra = declared.filter((pkg) => !expected.includes(pkg))
    expect(
      missing,
      `A language is indexed through tree-sitter but its grammar package is not listed in TREE_SITTER_GRAMMAR_PACKAGES, so doctor cannot report it missing: ${missing.join(', ')}`,
    ).toEqual([])
    expect(
      extra,
      `TREE_SITTER_GRAMMAR_PACKAGES names a package no tree-sitter language row asks for: ${extra.join(', ')}`,
    ).toEqual([])
  })
})
