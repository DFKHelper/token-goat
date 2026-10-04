// HAND-DERIVED: every expected value is read off DOC by hand under the grammar docs/cli.md documents for json-query ("`|` chains a projection onto a path (`members[] | {id, name}`)", "a projection on a plain object applies once"), and each spaced spec is checked against its unspaced form as well.

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { parseJsonPath, queryJson } from '../src/json_query.js'

const DOC = {
  org: { name: 'Acme', tier: 'gold', size: 40 },
  members: [
    { id: 1, name: 'x', address: { city: 'Oslo' } },
    { id: 2, name: 'y', address: { city: 'Rome' } },
  ],
  'my key': 7,
  'pad ': 9,
}

// A bare key ran up to the next `.`, `[`, `{` or `|`, so the space written before a `|` became part of the name: `org | {name, tier}` looked up the key `org ` and failed, and `..address | city` collected nothing and printed an empty result with exit 0.
describe('json-query path grammar: a space before a pipe', () => {
  it('chains a projection onto a bare key the way the unspaced pipe does', () => {
    const spaced = queryJson(DOC, 'org | {name, tier}')
    expect(spaced).toEqual({ fanned: false, items: [{ name: 'Acme', tier: 'gold' }], truncated: false })
    expect(spaced).toEqual(queryJson(DOC, 'org|{name, tier}'))
  })

  it('reads a key, an index and a nested key after a spaced pipe', () => {
    expect(queryJson(DOC, '.org | .name').items).toEqual(['Acme'])
    expect(queryJson(DOC, 'org | name').items).toEqual(['Acme'])
    expect(queryJson(DOC, 'members | [1]').items).toEqual([{ id: 2, name: 'y', address: { city: 'Rome' } }])
    expect(queryJson(DOC, 'members[0].address | city').items).toEqual(['Oslo'])
  })

  it('keeps every match of a recursive key written before a spaced pipe', () => {
    expect(queryJson(DOC, '..address | city')).toEqual({ fanned: true, items: ['Oslo', 'Rome'], truncated: false })
  })

  it('parses the key before a spaced pipe without the space', () => {
    expect(parseJsonPath('org | name')).toEqual([{ kind: 'key', name: 'org' }, { kind: 'key', name: 'name' }])
    expect(parseJsonPath('..address | city')).toEqual([{ kind: 'recursive_key', name: 'address' }, { kind: 'key', name: 'city' }])
  })

  it('still refuses a recursive descent that names no key before the pipe', () => {
    expect(() => parseJsonPath('..  | city')).toThrow(/expected property name after '\.\.'/)
  })

  it('still reads a key with an inner space bare, and a key with a trailing space through a quoted segment', () => {
    expect(queryJson(DOC, 'my key').items).toEqual([7])
    expect(queryJson(DOC, '["pad "]').items).toEqual([9])
  })
})

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let homeDir: string

function run(args: string[], input: string): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: homeDir,
    encoding: 'utf-8',
    input,
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-pipe-space-'))
})

describe('json-query and yaml-query in the built bundle: a space before a pipe', () => {
  it('json-query chains a projection onto a key written before a spaced pipe', () => {
    const res = run(['json-query', '-', 'org | {name, tier}'], JSON.stringify(DOC))
    expect(res.err).toBe('')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toEqual({ name: 'Acme', tier: 'gold' })
  })

  it('yaml-query chains a projection onto a key written before a spaced pipe', () => {
    const res = run(['yaml-query', '-', 'org | {name, tier}'], 'org:\n  name: Acme\n  tier: gold\n  size: 40\n')
    expect(res.err).toBe('')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toEqual({ name: 'Acme', tier: 'gold' })
  })
})
