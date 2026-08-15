// Contract tests for tests/helpers/parse-fixture.ts. The 49 migrated tests in
// parser_languages.test.ts exercise the happy path thoroughly, but they would all keep passing if
// two of the helper's guarantees silently regressed, so those two are pinned here.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseFixture, fixtureFile } from './helpers/parse-fixture.js'

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
})
