// HAND-DERIVED: each case is a document and a path built here so the command must fail (a key the document does not hold, a file that does not exist, text that is not JSON, a fan-out that matches nothing), and the expected first line is the `token-goat: ` prefix formatCommandError puts on every other command failure; worked out from the inputs, not from running the commands.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
  dir = mkdtempSync(join(tmpdir(), 'tg-query-err-prefix-'))
  writeFileSync(join(dir, 'doc.json'), JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }))
  writeFileSync(join(dir, 'doc.yaml'), 'items:\n  - id: 1\n  - id: 2\n')
  writeFileSync(join(dir, 'doc.xml'), '<r><i>1</i><i>2</i></r>\n')
  writeFileSync(join(dir, 'broken.json'), '{ "items": [ ')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CASES: Array<[string, () => string[], string]> = [
  ['json-query, a key the document lacks', () => ['json-query', join(dir, 'doc.json'), 'items.missing'], 'missing'],
  ['json-query, a fan-out matching nothing', () => ['json-query', join(dir, 'doc.json'), 'items[*].nope'], 'nope'],
  ['json-query, a missing file', () => ['json-query', join(dir, 'absent.json'), 'items'], 'Could not read'],
  ['json-query, unparseable text', () => ['json-query', join(dir, 'broken.json'), 'items'], 'Failed to parse JSON'],
  ['json-query, a bad --head', () => ['json-query', join(dir, 'doc.json'), 'items', '--head', 'x'], '--head'],
  ['yaml-query, a key the document lacks', () => ['yaml-query', join(dir, 'doc.yaml'), 'items.missing'], 'missing'],
  ['yaml-query, a missing file', () => ['yaml-query', join(dir, 'absent.yaml'), 'items'], 'Could not read'],
  ['xml-query, an element the document lacks', () => ['xml-query', join(dir, 'doc.xml'), 'r.zzz'], 'No elements matched path'],
  ['xml-query, a missing file', () => ['xml-query', join(dir, 'absent.xml'), 'r.i'], 'Could not read'],
  ['mcp-output --json-query, a fan-out matching nothing', () => ['mcp-output', '--file', join(dir, 'doc.json'), '--json-query', 'items[*].nope'], 'nope'],
]

describe.each(CASES)('%s, in the built bundle', (_name, argv, mention) => {
  it('exits 1 with a stderr line that starts with the token-goat: prefix', () => {
    const res = run(argv())
    expect(res.code).toBe(1)
    const first = res.err.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
    expect(first.startsWith('token-goat: ')).toBe(true)
    expect(first.startsWith('token-goat: token-goat:')).toBe(false)
    expect(res.err).toContain(mention)
  })
})
