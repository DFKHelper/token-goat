// HAND-DERIVED: the document is 150 single-key objects nested one inside the next, past the 100-level depth ceiling MAX_RECURSIVE_DEPTH documents, and holds no key named `blob` anywhere, so a `..blob` search stops at the ceiling with nothing found; the YAML document is twice the MAX_RECURSIVE_NODES node budget of one-key objects with no `blob` either; both worked out from the construction, not from running the query.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MAX_RECURSIVE_DEPTH, MAX_RECURSIVE_NODES } from '../src/json_query.js'
import { traversalLimitNotice } from '../src/query_notices.js'

function deepDoc(depth: number): unknown {
  let v: unknown = { leaf: 1 }
  for (let i = 0; i < depth; i++) v = { n: v }
  return v
}

describe('traversalLimitNotice', () => {
  it('qualifies the matches shown when there are some', () => {
    expect(traversalLimitNotice(3)).toMatch(/stopped early.*these are not necessarily all the matches/)
  })

  it('says no matches were found before the stop when there are none', () => {
    const line = traversalLimitNotice(0)
    expect(line).toMatch(/^\.\.\.\(no matches: the search stopped at this tool's traversal limit before finding any/)
    expect(line).not.toMatch(/these are not necessarily all the matches/)
  })
})

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let dir: string

function run(args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: dir, LOCALAPPDATA: dir, XDG_DATA_HOME: dir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-trav-zero-'))
  writeFileSync(join(dir, 'deep.json'), JSON.stringify(deepDoc(MAX_RECURSIVE_DEPTH + 50)))
  // The YAML parser itself refuses nesting past 100 levels, so yaml-query reaches the limit through its other ceiling instead: twice MAX_RECURSIVE_NODES objects side by side, none with a `blob` key.
  writeFileSync(join(dir, 'wide.yaml'), `[${Array(MAX_RECURSIVE_NODES * 2).fill('{a: 0}').join(',')}]\n`)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FRONT_ENDS: Array<[string, () => string[]]> = [
  ['json-query', () => ['json-query', join(dir, 'deep.json'), '..blob']],
  ['yaml-query', () => ['yaml-query', join(dir, 'wide.yaml'), '..blob']],
  ['mcp-output --json-query', () => ['mcp-output', '--file', join(dir, 'deep.json'), '--json-query', '..blob']],
]

describe.each(FRONT_ENDS)('%s in the built bundle, stopped by the traversal limit with nothing found', (_name, argv) => {
  it('says plainly that nothing was found before the stop, and still exits 0', () => {
    const res = run(argv())
    // Exit 0, not the exit 1 of a miss: a search the limit cut short is not conclusive (tests/json_query_bounds_are_per_query.test.ts pins this).
    expect(res.code).toBe(0)
    expect(res.out).toContain("no matches: the search stopped at this tool's traversal limit before finding any")
    expect(res.out).not.toContain('these are not necessarily all the matches')
  })
})
