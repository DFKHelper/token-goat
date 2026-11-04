/** `semantic`, `search` and `refs` say how much of the project an empty answer covers, in one sentence built from the DB rows and the indexer's own eligible set (index_health.ts::getFileIndexCoverage). */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return { ...actual, searchSemantic: async () => [], isAvailable: () => true }
})

const { runSemantic } = await import('../src/read_semantic.js')
const { runParallelSearch } = await import('../src/search/search_cli.js')
const { runRefs } = await import('../src/read_refs.js')

let root: string

function capture(fn: () => number): { code: number; stderr: string } {
  let stderr = ''
  const errW = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write
  try {
    return { code: fn(), stderr }
  } finally {
    process.stderr.write = errW
  }
}

// FIXTURE HAND-DERIVED: four tracked .ts files are eligible for the indexer; logo.png has no language and is not an embeddable document, so it is tracked but never counted. Which of the four get rows is chosen below, not read off the code under test.
beforeEach(() => {
  clearModuleCaches()
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-index-coverage-')))
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) fs.writeFileSync(path.join(root, f), `export function fn_${f.slice(0, 1)}(): number {\n  return 1\n}\n`)
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'init', '-q'], { cwd: root })
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], { cwd: root })
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(root, { recursive: true, force: true })
  clearModuleCaches()
})

function indexFiles(names: string[]): void {
  for (const n of names) indexFileSync(path.join(root, n), globalDbPath())
}

const PARTIAL = 'indexed 2 of 4 files in this project, 2 not indexed; an empty result does not cover them. Run `token-goat index .` to add them'
const COMPLETE = 'indexed 4 of 4 files in this project'

describe('semantic no-match result', () => {
  it('names partial coverage', async () => {
    indexFiles(['a.ts', 'b.ts'])
    const { text, code } = await runSemantic('zzqx nonexistent concept', { json: false, projectRoot: root })
    expect(code).toBe(1)
    expect(text).toContain(PARTIAL)
  })

  it('names complete coverage without a gap clause', async () => {
    indexFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const { text } = await runSemantic('zzqx nonexistent concept', { json: false, projectRoot: root })
    expect(text).toContain(COMPLETE)
    expect(text).not.toContain('not indexed')
  })
})

describe('search miss', () => {
  it('names partial coverage', async () => {
    indexFiles(['a.ts', 'b.ts'])
    const { text } = await runParallelSearch({ query: 'zzqxNoSuchName', channels: ['symbol'], projectRoot: root, json: false })
    expect(text).toContain('No results found')
    expect(text).toContain(PARTIAL)
  })

  it('names complete coverage', async () => {
    indexFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const { text } = await runParallelSearch({ query: 'zzqxNoSuchName', channels: ['symbol'], projectRoot: root, json: false })
    expect(text).toContain(COMPLETE)
  })

  it('stays silent when the search found something', async () => {
    indexFiles(['a.ts', 'b.ts'])
    const { text } = await runParallelSearch({ query: 'fn_a', channels: ['symbol'], projectRoot: root, json: false })
    expect(text).toContain('fn_a')
    expect(text).not.toContain('files in this project')
  })
})

describe('refs with no references', () => {
  it('names partial coverage after the ordinary message', () => {
    indexFiles(['a.ts', 'b.ts'])
    const { code, stderr } = capture(() => runRefs({ spec: 'fn_a', projectRoot: root }))
    expect(code).toBe(1)
    expect(stderr).toContain('No references found for')
    expect(stderr).toContain(PARTIAL)
  })

  it('names complete coverage', () => {
    indexFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const { stderr } = capture(() => runRefs({ spec: 'fn_a', projectRoot: root }))
    expect(stderr).toContain(COMPLETE)
  })

  it('prints no coverage line under --json', () => {
    indexFiles(['a.ts', 'b.ts'])
    const { stderr } = capture(() => runRefs({ spec: 'fn_a', projectRoot: root, json: true }))
    expect(stderr).not.toContain('files in this project')
  })
})
