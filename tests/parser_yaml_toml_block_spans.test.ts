/** Regression: a YAML top-level key and a TOML table header were indexed with a one-line span, so `read conf.yaml::database` printed only `database:` and `changed --symbol` could not see an edit inside the block; quoted (`"quoted key":`, `'k':`) and digit-led (`2024:`) YAML keys were not indexed at all, and so did not end the key above them. Provenance: HAND-DERIVED. Sources are written here and every expected span is counted by hand from them, following the YAML 1.2 rule that a block mapping value is the indented (or `- ` sequence) lines that follow, and the TOML spec's rule that a table runs to the next header (https://toml.io/en/v1.0.0#table). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-yaml-toml-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function spans(name: string, source: string, kind: string): Promise<string[]> {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, source)
  const result = await parseFile(file)
  return result.symbols.filter((s) => s.kind === kind).map((s) => `${s.name} ${s.lineStart}-${s.lineEnd}`)
}

describe('YAML top-level key spans', () => {
  it('spans each key through its block, indexes quoted and digit-led keys, and stops at a document marker', async () => {
    const source = [
      '# config', // 1
      'database:', // 2
      '  host: localhost', // 3
      '  port: 5432', // 4
      '', // 5
      '# servers section', // 6
      '"quoted key":', // 7
      '  a: 1', // 8
      "'k':", // 9
      '  - x', // 10
      '2024:', // 11
      '  year: true', // 12
      'list:', // 13
      '- one', // 14
      '- two', // 15
      '', // 16
      '---', // 17
      'other: 1', // 18
      '',
    ].join('\n')
    expect(await spans('conf.yaml', source, 'key')).toEqual(['database 2-4', 'quoted key 7-8', 'k 9-10', '2024 11-12', 'list 13-15', 'other 18-18'])
  })

  it('keeps the whole block in the symbol body', async () => {
    const file = path.join(TMP, 'b.yaml')
    fs.writeFileSync(file, 'database:\n  host: localhost\n  port: 5432\nnext: 1\n')
    const result = await parseFile(file)
    expect(result.symbols.find((s) => s.name === 'database')?.body).toBe('database:\n  host: localhost\n  port: 5432')
  })
})

describe('TOML table spans', () => {
  it('spans each table to its last key before the next header', async () => {
    const source = [
      '# top', // 1
      'title = "x"', // 2
      '', // 3
      '[package]', // 4
      'name = "a"', // 5
      'version = "1"', // 6
      '', // 7
      '# deps', // 8
      '[dependencies]', // 9
      'serde = "1"', // 10
      '', // 11
      '[[bin]]', // 12
      'name = "b"', // 13
      '',
    ].join('\n')
    expect(await spans('c.toml', source, 'section')).toEqual(['package 4-6', 'dependencies 9-10', 'bin 12-13'])
  })
})
