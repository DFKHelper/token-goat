/** Members of a one-line type body through the real default path: the dirty queue drained by `drainOnce` with no injected callback, so `makeIndexer` and `indexFileSync` are the production ones, then the symbols rows and the shipped bundle's `read`. PROVENANCE: HAND-DERIVED. The expected rows and spans are counted by hand from the fixture lines below, independently of the extractors. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { BUNDLE } from './helpers/bundle.js'

let TMP: string
let DB_PATH: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tg-oneline-e2e-'))
  DB_PATH = path.join(TMP, 'global.db')
  env = { ...process.env, TOKEN_GOAT_HOME: TMP, LOCALAPPDATA: TMP, XDG_DATA_HOME: TMP, TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' }
  spawnSync('git', ['init', '-q'], { cwd: TMP })
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

/** Writes each file, queues them all, drains once, and returns `kind name parent start-end` rows for the files. */
async function drain(files: Record<string, readonly string[]>): Promise<string[]> {
  const queued: string[] = []
  for (const [name, lines] of Object.entries(files)) {
    const abs = path.join(TMP, name)
    fs.writeFileSync(abs, `${lines.join('\n')}\n`, 'utf8')
    queued.push(normalizePath(abs))
  }
  fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${queued.join('\n')}\n`)
  expect(drainOnce(TMP)).toBe(queued.length)
  await pendingEmbeddings()
  const rows = getDb(DB_PATH).prepare('SELECT name, kind, parent, line_start, line_end FROM symbols ORDER BY line_start, name').all() as Array<{ name: string; kind: string; parent: string | null; line_start: number; line_end: number }>
  return rows.map((r) => `${r.kind} ${r.name} ${r.parent ?? ''} ${r.line_start}-${r.line_end}`)
}

function read(spec: string): string {
  const r = spawnSync(process.execPath, [BUNDLE, 'read', spec], { cwd: TMP, env, encoding: 'utf8', timeout: 60000 })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

describe('one-line type bodies reach the index through the production drain', () => {
  it('PHP: stores each member and reads it alone', async () => {
    expect(await drain({
      'single.php': [
        '<?php',
        'class Single { public function alpha() { return 1; } private $x = 1; const K = 2; }',
        'class Multi { public function beta() { return 2; }',
        '  public function gamma() { return 3; } }',
      ],
    })).toEqual([
      'const K Single 2-2',
      'class Single  2-2',
      'method alpha Single 2-2',
      'var x Single 2-2',
      'class Multi  3-4',
      'method beta Multi 3-3',
      'method gamma Multi 4-4',
    ])
    const alpha = read('single.php::alpha')
    expect(alpha).toContain('public function alpha() { return 1; }')
    expect(alpha).not.toContain('const K')
    const beta = read('single.php::beta')
    expect(beta).toContain('public function beta() { return 2; }')
    expect(beta).not.toContain('gamma')
  }, 60_000)

  it('Kotlin: stores each member and reads it alone', async () => {
    expect(await drain({
      'one.kt': [
        'class KTwo { fun ka(): Int { return 1 }; const val MAX = 3; fun kb() = 4 }',
        'class KThree { fun a() {} fun b() {',
        '    println(1)',
        '  }',
        '}',
      ],
    })).toEqual([
      'class KTwo  1-1',
      'const MAX KTwo 1-1',
      'method ka KTwo 1-1',
      'method kb KTwo 1-1',
      'class KThree  2-5',
      'method a KThree 2-2',
      'method b KThree 2-4',
    ])
    const ka = read('one.kt::ka')
    expect(ka).toContain('fun ka(): Int { return 1 }')
    expect(ka).not.toContain('MAX')
    const b = read('one.kt::b')
    expect(b).toContain('println(1)')
    expect(b).not.toContain('class KThree')
  }, 60_000)

  it('Scala: stores each member and reads it alone', async () => {
    expect(await drain({
      'one.scala': [
        'object STwo { def sa(): Int = { 1 }; val sv = 2; def sb(): Int = 3 }',
        'class SThree { def a(): Unit = {}; def b(): Unit = {',
        '    println(1)',
        '  }',
        '}',
      ],
    })).toEqual([
      'object STwo  1-1',
      'function sa STwo 1-1',
      'function sb STwo 1-1',
      'val sv STwo 1-1',
      'class SThree  2-5',
      'function a SThree 2-2',
      'function b SThree 2-4',
    ])
    const sa = read('one.scala::sa')
    expect(sa).toContain('def sa(): Int = { 1 }')
    expect(sa).not.toContain('val sv')
    const b = read('one.scala::b')
    expect(b).toContain('println(1)')
    expect(b).not.toContain('class SThree')
  }, 60_000)

  it('C#: stores each member and reads it alone', async () => {
    expect(await drain({
      'one.cs': [
        'class CTwo { public int Ca() { return 1; } public int P { get; set; } public int Cb() => 2; }',
        'class CThree { public void A() { } public void B() {',
        '    Console.WriteLine(1);',
        '  }',
        '}',
      ],
    })).toEqual([
      'class CTwo  1-1',
      'method Ca CTwo 1-1',
      'method Cb CTwo 1-1',
      'var P CTwo 1-1',
      'method A CThree 2-2',
      'method B CThree 2-4',
      'class CThree  2-5',
    ])
    const ca = read('one.cs::Ca')
    expect(ca).toContain('public int Ca() { return 1; }')
    expect(ca).not.toContain('get; set;')
    const b = read('one.cs::B')
    expect(b).toContain('Console.WriteLine(1);')
    expect(b).not.toContain('class CThree')
  }, 60_000)
})
