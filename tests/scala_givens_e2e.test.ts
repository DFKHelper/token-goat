/** Scala 3 given instances through the real default path: the dirty queue drained by `drainOnce` with no injected callback, so `makeIndexer` and `indexFileSync` are the production ones, then the symbols rows and the shipped bundle's `read`. PROVENANCE: FORMAT-DERIVED. The given forms are the examples on https://docs.scala-lang.org/scala3/reference/contextual/givens.html and https://scala-lang.org/api/3.3_LTS/docs/docs/reference/contextual/givens.html; the expected rows and spans are counted from the fixture text in this file, independently of the extractor. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { BUNDLE } from './helpers/bundle.js'

const GIVENS = [
  'trait Ord[T]:',
  '  def compare(x: T, y: T): Int',
  '',
  'given intOrd: Ord[Int] with',
  '  def compare(x: Int, y: Int) =',
  '    if x < y then -1 else if x > y then +1 else 0',
  '',
  'given [T: Ord] => Ord[List[T]]:',
  '  def compare(xs: List[T], ys: List[T]): Int = 0',
  '',
  'given global: ExecutionContext = ForkJoinPool()',
  '',
].join('\n')

let TMP: string
let DB_PATH: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tg-given-e2e-'))
  DB_PATH = path.join(TMP, 'global.db')
  env = { ...process.env, TOKEN_GOAT_HOME: TMP, LOCALAPPDATA: TMP, XDG_DATA_HOME: TMP, TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' }
  spawnSync('git', ['init', '-q'], { cwd: TMP })
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('Scala givens reach the index through the production drain', () => {
  it('stores each given and parents its members to it, and read returns the given body', async () => {
    const abs = path.join(TMP, 'givens.scala')
    fs.writeFileSync(abs, GIVENS, 'utf8')
    fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
    fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${normalizePath(abs)}\n`)
    expect(drainOnce(TMP)).toBe(1)
    await pendingEmbeddings()

    const rows = getDb(DB_PATH).prepare('SELECT name, kind, parent, line_start, line_end FROM symbols ORDER BY line_start, name').all() as Array<{ name: string; kind: string; parent: string | null; line_start: number; line_end: number }>
    expect(rows.map((r) => `${r.kind} ${r.name} ${r.parent ?? ''} ${r.line_start}-${r.line_end}`)).toEqual([
      'trait Ord  1-2',
      'function compare Ord 2-2',
      'object intOrd  4-6',
      'function compare intOrd 5-6',
      'object given_Ord_List  8-9',
      'function compare given_Ord_List 9-9',
      'val global  11-11',
    ])

    const r = spawnSync(process.execPath, [BUNDLE, 'read', 'givens.scala::intOrd'], { cwd: TMP, env, encoding: 'utf8', timeout: 60000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('given intOrd: Ord[Int] with')
    expect(r.stdout).toContain('if x < y then -1 else if x > y then +1 else 0')
    expect(r.stdout).toContain('# 3 lines')
  }, 60_000)
})
