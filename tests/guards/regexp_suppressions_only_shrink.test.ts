/**
 * `eslint-suppressions.json` is a baseline, and a baseline is one edit away from being an excuse.
 *
 * Token-goat runs regular expressions over command output, fetched pages and extracted documents:
 * input it does not control. `regexp/no-super-linear-backtracking` was switched on to gate that
 * surface, and it reported 249 sites. Thirty-nine backtracked exponentially and were fixed by hand;
 * the worst doubled its runtime per flag, so `npm` plus 28 short flags and a rejecting suffix took
 * 1.6 seconds and 40 flags would have taken roughly two hours. The rest are polynomial. They are
 * recorded rather than fixed because the alternative on offer was ESLint's own fixer, which rewrites
 * the patterns mechanically -- inlining raw whitespace codepoint classes and reshaping alternations
 * -- and 52 unreviewed rewrites of pattern-matching code is a worse thing to ship than an
 * enumerated debt list.
 *
 * That trade only holds while the list shrinks. Nothing in ESLint prevents re-running
 * `--suppress-rule` and quietly re-baselining a fresh violation, which would look identical to a
 * clean lint run. This guard is the ratchet: the counts here are the numbers as of the commit that
 * introduced them, and a suppression count that grows fails.
 *
 * Provenance: CAPTURE. Every number below is read from the `eslint-suppressions.json` that
 * `npx eslint src vscode-extension/src --suppress-rule ...` generated, not from any expectation
 * written first.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Suppressions {
  [file: string]: { [rule: string]: { count: number } }
}

function suppressions(): Suppressions {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'eslint-suppressions.json'), 'utf8')) as Suppressions
}

function countsByRule(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rules of Object.values(suppressions())) {
    for (const [rule, { count }] of Object.entries(rules)) out[rule] = (out[rule] ?? 0) + count
  }
  return out
}

/**
 * Ceilings, not equalities. Fixing a suppressed pattern is the point, so a count going down must
 * not fail; only growth is the failure. Lower these numbers in the same commit that fixes the
 * patterns, and the guard keeps its grip at the new level.
 */
const CEILINGS: Readonly<Record<string, number>> = {
  'regexp/no-super-linear-backtracking': 205,
  'regexp/no-misleading-capturing-group': 3,
  'regexp/no-potentially-useless-backreference': 2,
}

const TOTAL_CEILING = 210
const FILE_CEILING = 39

describe('eslint-suppressions.json is a ratchet, not a hiding place', () => {
  it('records suppressions at all, so an emptied file cannot pass as a fixed codebase', () => {
    // A deleted or emptied baseline makes every ceiling below trivially satisfied while the rules
    // it silences are still switched on -- the same green as having fixed all 210.
    expect(Object.keys(suppressions()).length).toBeGreaterThan(0)
  })

  it.each(Object.entries(CEILINGS))('does not grow the suppression count for %s', (rule, ceiling) => {
    const actual = countsByRule()[rule] ?? 0
    expect(
      actual,
      `${rule} now has ${actual} suppressed sites, up from ${ceiling}. A new violation was ` +
        `baselined instead of fixed. Fix the pattern; if the growth is genuinely unavoidable, raise ` +
        `this ceiling in the same commit and say why.`,
    ).toBeLessThanOrEqual(ceiling)
  })

  it('suppresses no rule that has not been accounted for here', () => {
    // Adding a rule to the --suppress-rule list without adding it here would let an entire new
    // category be baselined under a guard that only counts the three it already knows about.
    expect(Object.keys(countsByRule()).sort()).toEqual(Object.keys(CEILINGS).sort())
  })

  it('does not grow in total, or in the number of files carrying debt', () => {
    const total = Object.values(countsByRule()).reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(TOTAL_CEILING)
    expect(Object.keys(suppressions()).length).toBeLessThanOrEqual(FILE_CEILING)
  })

  it('suppresses nothing outside src/ and the extension source', () => {
    // Tests are not linted by the regexp gate, so a suppression pointing at one means the config's
    // `files` globs drifted and the gate is covering something it was never scoped to.
    const stray = Object.keys(suppressions()).filter(
      (f) => !f.startsWith('src/') && !f.startsWith('vscode-extension/src/'),
    )
    expect(stray).toEqual([])
  })

  it('carries no suppression for a rule the config does not enable', () => {
    const config = fs.readFileSync(path.join(repoRoot, 'eslint.config.mjs'), 'utf8')
    for (const rule of Object.keys(CEILINGS)) {
      expect(config, `${rule} is suppressed but no longer enabled; the suppression is dead weight`).toContain(rule)
    }
  })
})
