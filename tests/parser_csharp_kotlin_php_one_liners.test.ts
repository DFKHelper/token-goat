/** Regression: C#, Kotlin and PHP methods whose brace body closes on the signature line were stored signature-only, Kotlin `fun f() =` bodies continuing on later lines were cut to the first line, and C# operators, conversions, finalizers and indexers were missing. Provenance: HAND-DERIVED for every expected row and span (counted by hand from the source in each test) and FORMAT-DERIVED for the member syntax (C# language reference for operator/finalizer/indexer declarations, Kotlin grammar for function bodies); the `~Calc` / `operator+` spellings follow the C++ names in tests/parser_cpp_destructor_operator.test.ts. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-one-liners-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function symbolsOf(name: string, lines: string[]) {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return (await parseFile(file)).symbols
}

describe('one-line brace bodies keep their whole body', () => {
  it('C# method, constructor and private method', async () => {
    const syms = await symbolsOf('a.cs', [
      'class Calc {', // 1
      '    public Calc() { Init(); }', // 2
      '    public int Add(int a, int b) { return a + b; }', // 3
      '    private void Init() { }', // 4
      '}',
    ])
    expect(syms.find((s) => s.name === 'Add')?.body).toContain('return a + b;')
    expect(syms.find((s) => s.name === 'Calc' && s.kind === 'method')?.body).toContain('Init();')
    expect(syms.find((s) => s.name === 'Init')?.body).toContain('{ }')
  })

  it('Kotlin function', async () => {
    const syms = await symbolsOf('a.kt', ['class R {', '    fun d(x: Int = 3): Int { return x }', '}', 'fun a() { println("a") }'])
    expect(syms.find((s) => s.name === 'd')?.body).toContain('return x')
    expect(syms.find((s) => s.name === 'a')?.body).toContain('println("a")')
  })

  it('PHP method and function', async () => {
    const syms = await symbolsOf('a.php', ['<?php', 'class P {', '    public function a() { return 1; }', '    public function b($x = array(1)) { return $x; }', '}', 'function f() { return 2; }'])
    expect(syms.find((s) => s.name === 'a')?.body).toContain('return 1;')
    expect(syms.find((s) => s.name === 'b')?.body).toContain('return $x;')
    expect(syms.find((s) => s.name === 'f')?.body).toContain('return 2;')
  })

  it('leaves Swift and Scala one-liners exactly as they were', async () => {
    const swift = await symbolsOf('a.swift', ['struct S {', '    func a() { print(1) }', '}'])
    expect(swift.find((s) => s.name === 'a')?.body).toBe('func a() { print(1) }')
    const scala = await symbolsOf('a.scala', ['object O {', '  def a(): Int = { 1 }', '}'])
    expect(scala.find((s) => s.name === 'a')?.body).toBe('def a(): Int = { 1 }')
  })
})

describe('Kotlin expression bodies span every continuation line', () => {
  it('covers call arguments, if/else, chains and operators', async () => {
    const syms = await symbolsOf('k.kt', [
      'class Repo {', // 1
      '    fun all(): List<Int> = listOf(', // 2
      '        1,', // 3
      '        2,', // 4
      '    )', // 5
      '', // 6
      '    fun next() = 1', // 7
      '    fun s(a: Int) =', // 8
      '        if (a > 0)', // 9
      '            1', // 10
      '        else', // 11
      '            2', // 12
      '    fun t(): String = "a" +', // 13
      '        "b"', // 14
      '    fun u() = foo()', // 15
      '        .bar()', // 16
      '    fun d(x: Int = 3): Int { return x }', // 17
      '    fun r() = run { 1 }', // 18
      '    fun v(): Int', // 19
      '}', // 20
      'fun top(x: Int) =', // 21
      '    x * 2', // 22
    ])
    const span = (n: string) => {
      const s = syms.find((x) => x.name === n)
      return [s?.lineStart, s?.lineEnd]
    }
    expect(span('all')).toEqual([2, 5])
    expect(span('next')).toEqual([7, 7])
    expect(span('s')).toEqual([8, 12])
    expect(span('t')).toEqual([13, 14])
    expect(span('u')).toEqual([15, 16])
    expect(span('d')).toEqual([17, 17])
    expect(span('r')).toEqual([18, 18])
    expect(span('v')).toEqual([19, 19])
    expect(span('top')).toEqual([21, 22])
    expect(syms.find((s) => s.name === 'all')?.body).toContain('2,')
  })
})

describe('C# operators, conversions, finalizers and indexers are indexed', () => {
  it('names them like the C++ adapter does', async () => {
    const syms = await symbolsOf('c.cs', [
      'class Calc {', // 1
      '    public static Calc operator +(Calc a, Calc b) { return a; }', // 2
      '    public static implicit operator int(Calc c) { return 1; }', // 3
      '    ~Calc() { Init(); }', // 4
      '    public int this[int i] { get { return i; } }', // 5
      '    public static bool operator ==(Calc a, Calc b)', // 6
      '    {', // 7
      '        return true;', // 8
      '    }', // 9
      '    void Init() { }', // 10
      '}',
    ])
    const by = (n: string) => syms.find((s) => s.name === n)
    expect(by('operator+')?.parent).toBe('Calc')
    expect(by('operator+')?.body).toContain('return a;')
    expect(by('operator int')?.kind).toBe('method')
    expect(by('~Calc')?.kind).toBe('method')
    expect(by('~Calc')?.body).toContain('Init();')
    expect(by('this[]')?.parent).toBe('Calc')
    expect([by('operator==')?.lineStart, by('operator==')?.lineEnd]).toEqual([6, 9])
    expect(by('Init')).toBeDefined()
  })
})
