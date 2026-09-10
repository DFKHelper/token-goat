import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- a maintainer script in plain JavaScript, deliberately outside the typed source tree.
import { packageNamesFromBody } from '../scripts/dependabot-body.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// CAPTURE: the body of DFKHelper/token-goat#31, taken with `gh pr view 31 --json body --jq .body` on
// 2026-09-10. Real output from the producer, not a table written to match the regex below it, which
// is the only kind of fixture that can catch Dependabot restyling its own body.
const body = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'dependabot', 'grouped-npm-pr-body.md'), 'utf8')

describe('dependabot pull request body', () => {
  it('reads every package in a grouped batch, and nothing else', () => {
    // The batch #31 actually proposed, in the order the table lists it. An exact match rather than a
    // containment check: a parse that also swept up release-note or commit rows would still satisfy
    // `arrayContaining`, and over-collecting is the failure that would send `npm update` at packages
    // this repository does not depend on.
    expect(packageNamesFromBody(body)).toEqual([
      '@types/jpeg-js',
      '@types/node',
      'lefthook',
      'tsx',
      'typescript-eslint',
      'zod',
      'pdfjs-dist',
    ])
  })

  it('returns nothing for a body with no table, rather than a name-shaped fragment of prose', () => {
    expect(packageNamesFromBody('Bumps zod from 4.5.4 to 4.6.1.\n\nSome prose | with a pipe in it.')).toEqual([])
    expect(packageNamesFromBody('')).toEqual([])
    expect(packageNamesFromBody(undefined)).toEqual([])
  })

  it('takes only rows carrying two backticked versions, which is what separates a package row from the header and the rule beneath it', () => {
    // HAND-DERIVED: the minimal three-line table, written from the markdown spec rather than from the
    // parser. The header and separator are excluded because neither has backticked version cells, not
    // because the name `Package` is filtered by name -- an explicit check for that was in the parser
    // and survived deletion, so it was removed rather than left looking load-bearing.
    expect(packageNamesFromBody('| Package | From | To |\n| --- | --- | --- |\n| zod | `1.0.0` | `1.0.1` |')).toEqual(['zod'])
    // A package genuinely named `Package` is still collected, which is the behaviour the deleted check would have got wrong.
    expect(packageNamesFromBody('| Package | `1.0.0` | `1.0.1` |')).toEqual(['Package'])
  })
})
