import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * S3 finding closure (this repo's own refs-noise measurement: `expect` 28,104, `toBe` 12,125,
 * `it` 11,380 rows; 42.7% of this project's refs named no in-project symbol). Commit 1b399f83
 * closed the one unambiguous cause -- esbuild's compiler-injected `__name()` wrapper -- via
 * `COMPILER_ARTIFACT_REF_NAMES` in parser.ts, and deliberately did NOT add a broad stoplist for
 * generic test-framework globals (`expect`, `it`, `describe`, `toBe`, ...).
 *
 * That refusal rests on a measured fact, re-verified independently: `refs <name>` and
 * `callers <name>` resolve by a raw name match against the `refs` table FIRST (queryRefs /
 * resolveCallers), and only consult `symbols` afterward to build a better error message once the
 * name-scoped query already came back empty. Neither command requires `name` to match an
 * in-project symbol to succeed -- `token-goat refs readFileSync` genuinely works today against a
 * dependency/stdlib call site with no in-project definition. A name-based stoplist broad enough to
 * remove `expect`/`it`/`describe`/`toBe` noise would silently drop the exact same rows for any
 * project that defines its OWN symbol under one of those names (a custom `describe`/`it`-shaped
 * DSL, or a hand-rolled `expect()` assertion helper) -- the "silently-emptied enumeration passes
 * forever" failure class this codebase has shipped and fixed before, with no error and no signal
 * that anything was dropped.
 *
 * This guard pins that decision as an enforced invariant rather than a comment someone can drift
 * past: `COMPILER_ARTIFACT_REF_NAMES` may only ever hold confirmed, never-hand-written compiler/
 * bundler artifacts (verified against a real indexed corpus, one entry at a time) -- never a
 * generic test-framework global. Adding one of those names back to "close" this finding again
 * without redoing the retrieval-quality check above is exactly the substituted-defect mistake this
 * finding was reopened over once already.
 *
 * Static analysis only (source text, no DB, no filesystem beyond reading this repo's own source),
 * so this stays on the fast pre-commit tier (tests/guards, see run-guards.sh).
 */

const PARSER_SRC = readFileSync(new URL('../../src/parser.ts', import.meta.url), 'utf-8')

// Generic test-framework globals a real project could plausibly define its own same-named export
// for. Never-hand-written compiler/bundler artifacts (like esbuild's `__name`) are the only thing
// COMPILER_ARTIFACT_REF_NAMES may hold -- this list is what it must never grow to include.
const GENERIC_TEST_FRAMEWORK_NAMES = [
  'expect',
  'it',
  'xit',
  'fit',
  'test',
  'describe',
  'xdescribe',
  'fdescribe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'toBe',
  'toEqual',
  'toContain',
  'toHaveLength',
  'toMatch',
  'toThrow',
  'toBeNull',
  'toBeGreaterThan',
  'toBeCloseTo',
  'assert',
  'assertEqual',
]

describe('COMPILER_ARTIFACT_REF_NAMES stays a narrow compiler-artifact set, never a test-framework stoplist (S3)', () => {
  it('finds the constant at all, so an empty scan cannot pass vacuously', () => {
    expect(PARSER_SRC).toMatch(/const COMPILER_ARTIFACT_REF_NAMES: ReadonlySet<string> = new Set\(\[[^\]]*\]\)/)
  })

  it('contains none of the generic test-framework globals the S3 finding deliberately left unfiltered', () => {
    const match = PARSER_SRC.match(/const COMPILER_ARTIFACT_REF_NAMES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)
    expect(match, 'could not locate COMPILER_ARTIFACT_REF_NAMES literal in parser.ts').not.toBeNull()
    const body = match![1]
    const entries = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
    expect(entries.length, 'COMPILER_ARTIFACT_REF_NAMES must not be empty').toBeGreaterThan(0)
    for (const generic of GENERIC_TEST_FRAMEWORK_NAMES) {
      expect(
        entries,
        `COMPILER_ARTIFACT_REF_NAMES must never include '${generic}' -- it is a generic test-framework global a real project could define its own same-named export for, not an unambiguous compiler/bundler artifact. See this guard's file-level comment before adding it.`,
      ).not.toContain(generic)
    }
  })

  it('stays small enough that any addition is a deliberate, reviewed decision (cap: 8 entries)', () => {
    const match = PARSER_SRC.match(/const COMPILER_ARTIFACT_REF_NAMES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)
    const body = match![1]
    const entries = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)]
    expect(
      entries.length,
      'COMPILER_ARTIFACT_REF_NAMES has grown past its small-and-unambiguous design intent -- re-run the retrieval-quality check (does refs/callers resolve this name independent of an in-project symbol?) before raising this cap.',
    ).toBeLessThanOrEqual(8)
  })
})
