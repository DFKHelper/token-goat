// HAND-DERIVED: each document below holds exactly two matches (or three CSV rows), and `--head 1` therefore hides exactly one (or two), worked out by counting the input by hand; the expected wording is English number agreement, not read off the implementation.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { headElidedNotice } from '../src/query_notices.js'

describe('headElidedNotice', () => {
  it('uses the singular noun for one hidden match and the plural otherwise', () => {
    expect(headElidedNotice(1, 'item')).toBe('...(1 more item elided; use --head to see more)')
    expect(headElidedNotice(2, 'item')).toBe('...(2 more items elided; use --head to see more)')
    expect(headElidedNotice(1, 'element')).toBe('...(1 more element elided; use --head to see more)')
    expect(headElidedNotice(1, 'row')).toBe('...(1 more row elided; use --head to see more)')
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
  dir = mkdtempSync(join(tmpdir(), 'tg-head-elision-'))
  writeFileSync(join(dir, 'd.json'), JSON.stringify({ items: [{ name: 'a' }, { name: 'b' }] }))
  writeFileSync(join(dir, 'd.yaml'), 'items:\n  - name: a\n  - name: b\n')
  writeFileSync(join(dir, 'd.xml'), '<r><i>a</i><i>b</i></r>\n')
  writeFileSync(join(dir, 'd.html'), '<ul><li class="x">a</li><li class="y">b</li></ul>\n')
  writeFileSync(join(dir, 'd.csv'), 'name\na\nb\nc\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ONE_HIDDEN: Array<[string, () => string[], string]> = [
  ['json-query', () => ['json-query', join(dir, 'd.json'), 'items[*].name', '--head', '1'], '(1 more item elided;'],
  ['yaml-query', () => ['yaml-query', join(dir, 'd.yaml'), 'items[*].name', '--head', '1'], '(1 more item elided;'],
  ['mcp-output --json-query', () => ['mcp-output', '--file', join(dir, 'd.json'), '--json-query', 'items[*].name', '--head', '1'], '(1 more item elided;'],
  ['xml-query', () => ['xml-query', join(dir, 'd.xml'), 'r.i', '--head', '1'], '(1 more element elided;'],
  ['html-query', () => ['html-query', join(dir, 'd.html'), 'li', '--head', '1'], '(1 more element elided;'],
  ['html-query --text', () => ['html-query', join(dir, 'd.html'), 'li', '--text', '--head', '1'], '(1 more element elided;'],
  ['html-query --attr', () => ['html-query', join(dir, 'd.html'), 'li', '--attr', 'class', '--head', '1'], '(1 more item elided;'],
]

describe.each(ONE_HIDDEN)('%s in the built bundle with one match hidden by --head', (_name, argv, want) => {
  it('says "1 more <noun>", not "1 more <noun>s"', () => {
    const res = run(argv())
    expect(res.code).toBe(0)
    expect(res.out).toContain(want)
    expect(res.out).not.toMatch(/\b1 more [a-z]+s elided/)
  })
})

describe('csv-query in the built bundle', () => {
  it('keeps the plural for two hidden rows', () => {
    const res = run(['csv-query', join(dir, 'd.csv'), '--head', '1'])
    expect(res.code).toBe(0)
    expect(res.out).toContain('...(2 more rows elided; use --head to see more)')
  })

  it('uses the singular for one hidden row', () => {
    const res = run(['csv-query', join(dir, 'd.csv'), '--head', '2'])
    expect(res.code).toBe(0)
    expect(res.out).toContain('...(1 more row elided; use --head to see more)')
  })
})
