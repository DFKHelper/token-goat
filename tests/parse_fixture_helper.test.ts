// Contract tests for tests/helpers/parse-fixture.ts. The 49 migrated tests in
// parser_languages.test.ts exercise the happy path thoroughly, but they would all keep passing if
// two of the helper's guarantees silently regressed, so those two are pinned here.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parserWarmupParses, parseFixture, fixtureFile } from './helpers/parse-fixture.js'

describe('parseFixture', () => {
  it('routes on the full basename, not a synthesised name with the same extension', async () => {
    // package.json parses as a name-keyed language rather than as generic json; a helper that
    // invented its own `fixture.json` would quietly send every such case to the wrong parser and
    // every caller's assertions would still pass against the wrong-but-similar output.
    const result = await parseFixture('package.json', '{"name":"x","version":"1"}')
    expect(result.symbols.map((s) => s.name)).toContain('name')
  })

  it('gives each call its own directory so same-named fixtures never overwrite each other', () => {
    const first = fixtureFile('dup.json', '{"a":1}')
    const second = fixtureFile('dup.json', '{"b":2}')
    expect(path.dirname(first)).not.toBe(path.dirname(second))
    expect(fs.readFileSync(first, 'utf8')).toBe('{"a":1}')
    expect(fs.readFileSync(second, 'utf8')).toBe('{"b":2}')
  })

  it('leaves the fixture readable after parsing, so a failing test can still be debugged', async () => {
    const before = fixtureFile('keep.md', '# Kept\n')
    expect(fs.existsSync(before)).toBe(true)
    await parseFixture('keep.md', '# Kept\n')
    expect(fs.existsSync(before)).toBe(true)
  })

  // The first parseFile call in a worker pays a one-time lazy init of roughly a second, and every
  // later call costs 1-11ms. Unwarmed, that second lands inside whichever test runs first, and under
  // full-suite worker contention it stretched past the 60s testTimeout and failed that test -- always
  // the first of the file, in this file and in parser_markdown_closing_hash.test.ts. The helper now
  // pays it at module evaluation, where no per-test timeout applies. Asserted structurally rather than
  // by timing, because a threshold tight enough to separate cold from warm would flake under the same
  // contention it is meant to defend against.
  it('is already warm before any test body runs, so no test is billed for the parser cold start', () => {
    expect(parserWarmupParses()).toBeGreaterThan(0)
  })
})
