// HAND-DERIVED: DOC and every expected match/miss are worked out by hand under the json-query grammar docs/cli.md documents (`[*]` fans out, `|` chains the right side onto each item the left side produced, a missing key on an unfanned path exits 1); the miss wording is asserted only by the step it names, not byte for byte.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { noMatchMessage, queryJson } from '../src/json_query.js'

const DOC = { items: [{ name: 'a' }, { name: 'b' }], empty: [] as unknown[] }

// Each of these fanned out and then matched nothing, and every front-end printed one empty line with exit 0: indistinguishable from a value that is an empty string, and unlike an unfanned miss, which exits 1.
const MISSES: Array<[string, RegExp]> = [
  ['items[*].name | [0]', /\[0\] found nothing to index: both values it reached are strings.*--head 1/],
  ['items[*] | [1]', /\[1\] found nothing to index: both values it reached are objects.*list\[1\]\.field/],
  ['items[*].missing', /\.missing found no such key: both values it reached are objects/],
  ['empty[*]', /\[\*\] found nothing to iterate: the value it reached is an empty array/],
  ['..nokey', /\.\.nokey found no key named 'nokey'/],
  ['items[name=zz]', /\[name=zz\] matched no element: the value it reached is an array of 2/],
]

describe('a fanned query that matches nothing says which step came up empty', () => {
  it.each(MISSES)('%s', (spec, why) => {
    const res = queryJson(DOC, spec)
    expect(res.items).toEqual([])
    expect(res.fanned).toBe(true)
    expect(noMatchMessage(spec, res)).toMatch(why)
  })

  // HAND-DERIVED: each document's `items` holds the values listed, so what `.nope` reached is read straight off the input.
  it.each([
    [{ items: [{}, {}] }, 'both values it reached are empty objects'],
    [{ items: [{ a: 1 }, { b: 2 }, { c: 3 }] }, 'the 3 values it reached are all objects'],
    [{ items: [{ a: 1 }] }, 'the value it reached is an object'],
    [{ items: [{ a: 1 }, 1, 2, 's'] }, 'the 4 values it reached are an object, 2 numbers and a string'],
    [{ items: [null, []] }, 'both values it reached are null and an empty array'],
  ])('names what a fan-out reached in agreement with its count (%j)', (doc, reached) => {
    const res = queryJson(doc, 'items[*].nope')
    expect(noMatchMessage('items[*].nope', res)).toBe(`no match for 'items[*].nope': .nope found no such key: ${reached}`)
  })

  it('applies a piped index to each item, so it still reads one element of each array', () => {
    // The pipe chains onto each item rather than collecting the list: this is the per-item semantics `..address | city` already pins in tests/json_query_pipe_spacing.test.ts.
    expect(queryJson({ rows: [[1, 2], [3]] }, 'rows[*] | [0]').items).toEqual([1, 3])
  })

  it('leaves a result that matched something without a miss reason', () => {
    expect(queryJson(DOC, 'items[*].name').emptiedBy).toBeUndefined()
    expect(queryJson(DOC, 'empty').emptiedBy).toBeUndefined()
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
  dir = mkdtempSync(join(tmpdir(), 'tg-fanout-miss-'))
  writeFileSync(join(dir, 'd.json'), JSON.stringify(DOC))
  writeFileSync(join(dir, 'd.yaml'), 'items:\n  - name: a\n  - name: b\nempty: []\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FRONT_ENDS: Array<[string, (spec: string, ...extra: string[]) => string[]]> = [
  ['json-query', (spec, ...extra) => ['json-query', join(dir, 'd.json'), spec, ...extra]],
  ['yaml-query', (spec, ...extra) => ['yaml-query', join(dir, 'd.yaml'), spec, ...extra]],
  ['mcp-output --json-query', (spec, ...extra) => ['mcp-output', '--file', join(dir, 'd.json'), '--json-query', spec, ...extra]],
]

describe.each(FRONT_ENDS)('%s in the built bundle', (_name, argv) => {
  it('exits 1 with the reason when a pipe after a fan-out matches nothing', () => {
    const res = run(argv('items[*].name | [0]'))
    expect(res.code).toBe(1)
    expect(res.out).toBe('')
    expect(res.err).toMatch(/no match for 'items\[\*\]\.name \| \[0\]': \[0\] found nothing to index/)
  })

  it('exits 1 with the reason when a fan-out reaches no key', () => {
    const res = run(argv('items[*].missing'))
    expect(res.code).toBe(1)
    expect(res.out).toBe('')
    expect(res.err).toMatch(/\.missing found no such key/)
  })

  it('prints the empty envelope under --json and still exits 1', () => {
    const res = run(argv('empty[*]', '--json'))
    expect(res.code).toBe(1)
    expect(JSON.parse(res.out)).toEqual({ items: [], truncated: false, totalCount: 0 })
    expect(res.err).toMatch(/\[\*\] found nothing to iterate/)
  })

  it('still prints an empty array that exists, with exit 0', () => {
    const res = run(argv('empty'))
    expect(res.code).toBe(0)
    // mcp-output wraps third-party content in its untrusted fence, so the value is matched as a whole line rather than as the whole output.
    expect(res.out.split(/\r?\n/).map((l) => l.trim())).toContain('[]')
  })

  it('still prints the names a fan-out found, with exit 0', () => {
    const res = run(argv('items[*].name'))
    expect(res.code).toBe(0)
    expect(res.out).toContain('"a"')
    expect(res.out).toContain('"b"')
  })
})
