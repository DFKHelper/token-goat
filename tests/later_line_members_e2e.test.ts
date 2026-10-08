/** Members declared after a block or a nested type opened on an earlier line, and Swift enum cases, through the real default path: the dirty queue drained by `drainOnce` with no injected callback, then the symbols rows and the shipped bundle's `read`. PROVENANCE: HAND-DERIVED. The expected rows and spans are counted by hand from the fixture lines below, independently of the extractors. */
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

describe('members past a block or nested type opened on an earlier line reach the index through the production drain', () => {
  it('PHP: indexes the function after the `}` that closes another', async () => {
    expect(await drain({
      'p.php': [
        '<?php', // 1
        'class C {', // 2
        '    function f()', // 3
        '    {', // 4
        '        return 1; } function g() {}', // 5
        '}', // 6
      ],
    })).toEqual(['class C  2-6', 'method f C 3-5', 'method g C 5-5'])
    const g = read('p.php::g')
    expect(g).toContain('function g() {}')
  }, 60_000)

  it('Kotlin: keeps the members of a nested type opened on its parent header line', async () => {
    expect(await drain({
      'k.kt': [
        'class C { class B {', // 1
        '    fun x() = 1', // 2
        '}', // 3
        '    fun after() = 2', // 4
        '}', // 5
      ],
    })).toEqual(['class B C 1-3', 'class C  1-5', 'method x B 2-2', 'method after C 4-4'])
    const x = read('k.kt::x')
    expect(x).toContain('fun x() = 1')
    expect(x).not.toContain('after')
  }, 60_000)

  it('C#: keeps the members of a nested type opened on its parent header line', async () => {
    expect(await drain({
      'c.cs': [
        'class C { class B {', // 1
        '    void X() {}', // 2
        '}', // 3
        '    void After() {}', // 4
        '}', // 5
      ],
    })).toEqual(['class B C 1-3', 'class C  1-5', 'method X B 2-2', 'method After C 4-4'])
    const x = read('c.cs::X')
    expect(x).toContain('void X() {}')
    expect(x).not.toContain('After')
  }, 60_000)

  it('Swift: indexes enum cases and the member after the `}` that closes another', async () => {
    expect(await drain({
      's.swift': [
        'enum E { case a, b }', // 1
        'class C {', // 2
        '    func prev() {', // 3
        '    } func next() {}', // 4
        '}', // 5
      ],
    })).toEqual(['enum E  1-1', 'enum_member a E 1-1', 'enum_member b E 1-1', 'class C  2-5', 'method prev C 3-4', 'method next C 4-4'])
    const next = read('s.swift::next')
    expect(next).toContain('func next() {}')
  }, 60_000)

  it('Scala: indexes a def with no parameter list and spans its indented body', async () => {
    expect(await drain({
      'sc.scala': [
        'object O {', // 1
        '  def b =', // 2
        '    1 + 2', // 3
        '  def c = 3', // 4
        '}', // 5
      ],
    })).toEqual(['object O  1-5', 'function b O 2-3', 'function c O 4-4'])
    const b = read('sc.scala::b')
    expect(b).toContain('1 + 2')
    expect(b).not.toContain('def c')
  }, 60_000)

  it('Kotlin: an abstract member followed by an init block keeps its own one-line span', async () => {
    expect(await drain({
      'k.kt': [
        'abstract class A {', // 1
        '    abstract fun f(): Int', // 2
        '    init {', // 3
        '        println(1)', // 4
        '    }', // 5
        '    fun g() = 2', // 6
        '}', // 7
      ],
    })).toEqual(['class A  1-7', 'method f A 2-2', 'method g A 6-6'])
    const f = read('k.kt::f')
    expect(f).toContain('abstract fun f(): Int')
    expect(f).not.toContain('println')
  }, 60_000)

  it('Scala 3: a braceless class nested in a braceless class keeps both and their members', async () => {
    expect(await drain({
      's3.scala': [
        'class C(x: Int):', // 1
        '  class B(y: Int):', // 2
        '    def f = 1', // 3
        '    def g(): Int =', // 4
        '      val q = 2', // 5
        '      q', // 6
        '  def after = 3', // 7
        'end C', // 8
      ],
    })).toEqual(['class C  1-8', 'class B C 2-6', 'function f B 3-3', 'function g B 4-6', 'function after C 7-7'])
    const g = read('s3.scala::g')
    expect(g).toContain('val q = 2')
    expect(g).not.toContain('def after')
  }, 60_000)

  it('Kotlin: an expression body whose `=` starts the next line spans to the end of the expression', async () => {
    expect(await drain({
      'eq.kt': [
        'class A {', // 1
        '    fun f(): Int', // 2
        '        = init(3)', // 3
        '    fun g(): Int', // 4
        '        = compute(', // 5
        '            4)', // 6
        '    fun h() = 1', // 7
        '}', // 8
      ],
    })).toEqual(['class A  1-8', 'method f A 2-3', 'method g A 4-6', 'method h A 7-7'])
    const f = read('eq.kt::f')
    expect(f).toContain('= init(3)')
    expect(f).not.toContain('fun g')
  }, 60_000)
})
