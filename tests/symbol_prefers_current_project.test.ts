/** An unconfined `symbol NAME` searches the machine-wide index ordered by file path, so a project whose path sorts earlier buries the current project's own definition: from the token-goat checkout, `symbol parse` listed 31 rows from another project before the first local one and the default page showed none. The current project's rows now lead, the rest follow. PROVENANCE: HAND-DERIVED. Two temp projects are written below: the directory named `aaa-` sorts before `zzz-` and defines 25 functions called `parseThing9k`, the `zzz-` project defines one; the expected order is computed from those names and counts, not from the sort code. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_symbol.js'

let base: string
let early: string
let mine: string

function seed(root: string, rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  indexFileSync(normalizePath(full))
}

beforeAll(() => {
  base = normalizePath(mkdtempSync(join(tmpdir(), 'tg-symfirst-')))
  early = join(base, 'aaa-other')
  mine = join(base, 'zzz-mine')
  for (let i = 0; i < 25; i++) seed(early, `src/m${String(i).padStart(2, '0')}.ts`, `export function parseThing9k(a: number): number {\n  return a + ${i}\n}\n`)
  for (let i = 0; i < 25; i++) seed(mine, `src/l${String(i).padStart(2, '0')}.ts`, `export function onlyHere9k(a: number): number {\n  return a + ${i}\n}\n`)
  seed(mine, 'src/own.ts', 'export function parseThing9k(a: string): string {\n  return a\n}\n')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function fromMine<T>(fn: () => T): T {
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(mine)
  try {
    return fn()
  } finally {
    spy.mockRestore()
  }
}

describe('symbol NAME with no confinement leads with the current project', () => {
  it('prints the cwd project definition first although another project sorts ahead of it', () => {
    const { text, code } = fromMine(() => runSymbol({ name: 'parseThing9k', limit: 20 }))
    expect(code).toBe(0)
    const firstHeader = text.split('\n').find((l) => l.startsWith('# parseThing9k'))
    expect(firstHeader).toContain('src/own.ts')
    // The remaining 19 slots are filled from the other project, so nothing is dropped from the page.
    expect(text.match(/^# parseThing9k/gm)).toHaveLength(20)
    expect(text).toContain('m00.ts')
  })

  it('orders --json the same way and keeps the global total', () => {
    const { text } = fromMine(() => runSymbol({ name: 'parseThing9k', limit: 20, json: true }))
    const payload = JSON.parse(text) as { items: Array<{ filePath: string }>; truncated: boolean; totalCount: number }
    expect(payload.items).toHaveLength(20)
    expect(payload.items[0]?.filePath).toContain('src/own.ts')
    expect(payload.totalCount).toBe(26)
    expect(payload.truncated).toBe(true)
  })

  it('keeps the same order under a client-side filter (--exclude-tests)', () => {
    const { text } = fromMine(() => runSymbol({ name: 'parseThing9k', limit: 20, json: true, excludeTests: true }))
    const payload = JSON.parse(text) as { items: Array<{ filePath: string }>; totalCount: number }
    expect(payload.items[0]?.filePath).toContain('src/own.ts')
    expect(payload.items).toHaveLength(20)
    expect(payload.totalCount).toBe(26)
  })

  it('names the in-project count and the -p escape in the truncation notice', () => {
    const { text } = fromMine(() => runSymbol({ name: 'parseThing9k', limit: 20 }))
    expect(text).toContain('showing 20 of 26 matches')
    expect(text).toContain('1 of the matches are in this project and listed first')
    // The note's own words, not a bare `-p`: every row header carries a mkdtemp path, and a random suffix starting with p puts `-p` in the output whatever the note says.
    expect(text).toContain('pass -p to search only it')
  })

  // HAND-DERIVED: onlyHere9k is defined 25 times, all under the cwd project and nowhere else, so a 20-row page is truncated yet every match is local and -p changes nothing.
  it('omits the -p note when every match is already in this project', () => {
    const { text } = fromMine(() => runSymbol({ name: 'onlyHere9k', limit: 20 }))
    expect(text).toContain('showing 20 of 25 matches')
    expect(text).not.toContain('are in this project')
    expect(text).not.toContain('pass -p')
  })

  it('leaves a confined lookup unchanged: -p from the other project sees only that project', () => {
    const { text } = fromMine(() => runSymbol({ name: 'parseThing9k', limit: 20, projectRoot: normalizePath(early), json: true }))
    const payload = JSON.parse(text) as { items: Array<{ filePath: string }>; totalCount: number }
    expect(payload.totalCount).toBe(25)
    expect(payload.items.every((i) => i.filePath.includes('m'))).toBe(true)
    expect(text).not.toContain('own.ts')
  })

  it('keeps the local row first on a short page filtered by --kind', () => {
    const { text } = fromMine(() => runSymbol({ name: 'parseThing9k', limit: 3, json: true, kind: 'function', file: undefined }))
    const payload = JSON.parse(text) as { items: Array<{ filePath: string }> }
    expect(payload.items[0]?.filePath).toContain('src/own.ts')
    expect(payload.items).toHaveLength(3)
  })
})
