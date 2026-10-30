// Provenance: hand-derived (logic only) from the shape of src/claude_hidden_rules.ts:290 (a file-private helper) and src/parser_treesitter.ts:82 (the export-keyword body prefix). Each fixture is indexed through the production indexFileSync, never hand-inserted rows.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildProjectMap } from '../src/baseline.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/** Write each file under a fresh root, index each one through the production indexer, and return the root. */
function indexProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-evidence-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.writeFileSync(p, text)
    indexFileSync(normalizePath(p))
  }
  return root
}

/** The top-list entries for `name` in a project, as the file each one was defined in. */
function topFilesFor(root: string, name: string): string[] {
  return buildProjectMap(root)
    .topSymbols.filter((s) => s.name === name)
    .map((s) => s.filePath)
}

describe('buildProjectMap top symbols and file-private definitions', () => {
  it('ranks no file-private definition in the top list', () => {
    const root = indexProject({
      'a.ts': 'function result(): number {\n  return 1\n}\n',
      'b.ts': 'export function keepMe(): number {\n  return result() + 1\n}\n',
    })
    const list = buildProjectMap(root).topSymbols
    // Positive fixture: the list must be non-empty, or a broken exclusion would pass by returning nothing.
    expect(list.map((s) => s.name)).toContain('keepMe')
    expect(list.filter((s) => s.name === 'result')).toEqual([])
  })

  it('ranks no file-private definition whose file path holds an apostrophe', () => {
    const root = indexProject({
      "o'brien.ts": 'function result(): number {\n  return 1\n}\n',
      'b.ts': 'export function keepMe(): number {\n  return result() + 1\n}\n',
    })
    const list = buildProjectMap(root).topSymbols
    expect(list.map((s) => s.name)).toContain('keepMe')
    expect(list.filter((s) => s.name === 'result')).toEqual([])
  })

  it('ranks no file-private JavaScript definition in the top list', () => {
    const root = indexProject({
      'a.js': 'function result() {\n  return 1\n}\n',
      'b.js': 'export function keepMe() {\n  return result() + 1\n}\n',
    })
    const list = buildProjectMap(root).topSymbols
    expect(list.map((s) => s.name)).toContain('keepMe')
    expect(list.filter((s) => s.name === 'result')).toEqual([])
  })

  it('keeps a definition exported through an export list', () => {
    const root = indexProject({
      'a.ts': 'function helper(): number {\n  return 1\n}\nexport { helper }\n',
      'b.ts': "import { helper } from './a'\nexport function use(): number {\n  return helper()\n}\n",
    })
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'a.ts'))])
  })

  it('keeps a definition exported as the default', () => {
    const root = indexProject({
      'a.ts': 'function helper(): number {\n  return 1\n}\nexport default helper\n',
      'b.ts': "import helper from './a'\nexport function use(): number {\n  return helper()\n}\n",
    })
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'a.ts'))])
  })

  it('keeps a definition exported as the default through a renamed export list', () => {
    const root = indexProject({
      'a.ts': 'function helper(): number {\n  return 1\n}\nexport { helper as default }\n',
      'b.ts': "import helper from './a'\nexport function use(): number {\n  return helper()\n}\n",
    })
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'a.ts'))])
  })

  it('keeps every definition of a file that uses CommonJS exports (keep on doubt)', () => {
    const root = indexProject({
      'a.js': 'function helper() {\n  return 1\n}\nmodule.exports = { helper }\n',
      'b.js': 'export function use() {\n  return helper()\n}\n',
    })
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'a.js'))])
  })

  it('keeps a keyword-exported definition, the splice shape', () => {
    const root = indexProject({
      'a.ts': 'export function helper(): number {\n  return 1\n}\n',
      'b.ts': "import { helper } from './a'\nexport function use(): number {\n  return helper()\n}\n",
    })
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'a.ts'))])
  })

  it('keeps a declaration file (.d.ts) whole, keep on doubt', () => {
    const root = indexProject({
      'types.d.ts': 'declare function helper(): number;\n',
      'b.ts': "import { helper } from './types'\nexport function use(): number {\n  return helper()\n}\n",
    })
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'types.d.ts'))])
  })

  it('keeps a private definition in a language outside the TypeScript and JavaScript family', () => {
    // Rust exports only `pub` items, so `result` here is file-private, yet it must stay: the candidate set is TS/JS only.
    const root = indexProject({
      'a.rs': 'fn result() -> i32 {\n  1\n}\n',
      'b.rs': 'pub fn use_it() -> i32 {\n  result() + 1\n}\n',
    })
    expect(topFilesFor(root, 'result')).toEqual([normalizePath(path.join(root, 'a.rs'))])
  })

  it('ranks the exported copy of a same-named definition when a longer file-private copy exists', () => {
    const root = indexProject({
      'a.ts':
        'function apply(a: number): number {\n  const doubled = a * 2\n  const tripled = a * 3\n  return doubled + tripled + a\n}\n',
      'b.ts': 'export function apply(a: number): number {\n  return a\n}\n',
      'c.ts': 'export function run(): number {\n  return apply(1)\n}\n',
    })
    // Without the exclusion the longer private copy wins the one-row-per-name choice and the exported copy disappears.
    expect(topFilesFor(root, 'apply')).toEqual([normalizePath(path.join(root, 'b.ts'))])
  })

  it('keeps every candidate of a file it cannot read', () => {
    const root = indexProject({
      'a.ts': 'function helper(): number {\n  return 1\n}\n',
      'b.ts': 'export function use(): number {\n  return helper()\n}\n',
    })
    // Indexed, then removed from disk: the exclusion cannot read its exports, so it must keep the rows.
    fs.rmSync(path.join(root, 'a.ts'))
    expect(topFilesFor(root, 'helper')).toEqual([normalizePath(path.join(root, 'a.ts'))])
  })
})
