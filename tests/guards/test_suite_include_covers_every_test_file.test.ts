/**
 * Guard: every tracked test file must be matched by vitest's `include` patterns.
 *
 * The suite used to be defined by subtraction -- no `include`, so vitest's default of `**\/*.test.ts` over the whole working tree, minus a short exclude list. That pulled in test files from untracked working directories, which is how a draft left in a scratch folder broke an unrelated full-suite run with `Cannot find module './helpers/bundle.js'`: it was resolving a relative import from a directory that is not `tests/`.
 *
 * Naming the two real locations fixes that, and introduces the opposite risk, which is the worse one. Under `exclude`-only, a test in a new directory ran without anyone thinking about it. Under `include`, it silently does not run, and a test that never runs is indistinguishable from a test that passes -- no output, no failure, nothing to notice. This guard is the thing that notices.
 *
 * CAPTURE: the file list is `git ls-files`, the repository's own record of what is tracked, not a directory walk -- a walk would also see untracked drafts and build output, which is exactly what the include patterns are meant to leave out.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The `include` patterns, read out of the config's source rather than imported from it.
 *
 * Importing `vitest.config.ts` would pull it into the tests TypeScript project, where it does not currently typecheck -- `minWorkers` is rejected by the vitest types that project resolves -- and `npm run typecheck:tests` fails before the suite ever runs. Reading the source keeps this guard from deciding what belongs in an unrelated tsconfig.
 */
function includePatterns(): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), 'vitest.config.ts'), 'utf8')
  const line = /^\s*include:\s*\[(.*)\],\s*$/m.exec(source)?.[1] ?? ''
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function trackedTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts'], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Minimal glob match for the two shapes used in the include list: a `**` segment matching any number of path segments, and `*` matching within one segment. */
function matchesGlob(pattern: string, filePath: string): boolean {
  const rx = pattern
    .split('/')
    .map((seg) => (seg === '**' ? '(?:[^/]+/)*' : `${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}/`))
    .join('')
    .replace(/\/$/, '')
  return new RegExp(`^${rx}$`).test(filePath)
}

describe('the include patterns cover the whole suite', () => {
  const include = includePatterns()

  it('names its patterns, so the suite is not defined by subtraction again', () => {
    // Also the calibration for the source parse above: a parse that silently found nothing would make every "is it covered" check below fail loudly rather than pass vacuously, but this says which of the two went wrong.
    expect(include).toContain('tests/**/*.test.ts')
    expect(include.length).toBeGreaterThanOrEqual(2)
  })

  it('matches every tracked test file', () => {
    const tracked = trackedTestFiles()
    // Calibration: if `git ls-files` returned nothing, every assertion below would pass vacuously -- the exact shape this repo has been bitten by before (a guard whose population emptied silently).
    expect(tracked.length).toBeGreaterThan(500)

    const uncovered = tracked.filter((f) => !include.some((p) => matchesGlob(p, f)))

    // A file listed here is tracked, ends in .test.ts, and never runs. Either move it under a covered directory or add its directory to `include` in vitest.config.ts.
    expect(uncovered).toEqual([])
  })

  it('does not match a test file outside the tracked test directories', () => {
    // The other half: patterns broad enough to cover everything tracked would also re-admit the untracked drafts this was tightened to keep out.
    for (const stray of ['scratch/draft.test.ts', 'scratch/audit/probe.test.ts', 'src/inline.test.ts']) {
      expect(include.some((p) => matchesGlob(p, stray))).toBe(false)
    }
  })
})
