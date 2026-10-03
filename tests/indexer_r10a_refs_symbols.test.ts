import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { indexFileSync } from '../src/parser.js'
import { closeDb } from '../src/db.js'
import { queryRefs, querySymbols } from '../src/index_reader.js'
import { findSymbolCandidates, stripHtmlIdSpelling } from '../src/read_spec.js'
import { normalizePath } from '../src/paths.js'

// Every case indexes a real file through indexFileSync (the production default path the worker drains into) and asserts through the same query functions the refs and read commands call. Provenance: HAND-DERIVED throughout. Line numbers, names and parents are computed from the fixture text below; the grammar facts (JSX tag names, Java generic_type nodes, Lua receivers, Dart operator syntax) come from the languages' own documentation (React JSX transform: lowercase tags are intrinsic elements; JLS 15.9 class instance creation; Lua 5.4 manual 3.4.11 function definitions; Dart language tour, overridable operators).
describe('indexer r10a: JSX refs, Java generic instantiations, Lua receivers, Dart operators', () => {
  let dir = ''
  let dbPath = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-r10a-'))
    dbPath = path.join(dir, 'test.db')
  })

  afterEach(() => {
    closeDb(dbPath)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function index(name: string, lines: string[]): string {
    const file = path.join(dir, name)
    fs.writeFileSync(file, lines.join('\n'))
    indexFileSync(file, dbPath)
    return normalizePath(file)
  }

  it('records JSX component usage for tsx and jsx, never an intrinsic element', () => {
    const tsx = index('Page.tsx', [
      'export function Page() {', // 1
      '  return (', // 2
      '    <main>', // 3
      '      <Button label="ok" />', // 4
      '      <Card>x</Card>', // 5
      '      <UI.Panel />', // 6
      '    </main>', // 7
      '  )', // 8
      '}', // 9
    ])
    const jsx = index('list.jsx', ['export function List() {', '  return <div><Card></Card></div>', '}'])

    const button = queryRefs({ name: 'Button' }, dbPath)
    expect(button.map((r) => [r.filePath, r.line, r.context])).toEqual([[tsx, 4, 'Page']])
    expect(queryRefs({ name: 'Card' }, dbPath).map((r) => [r.filePath, r.line, r.context])).toEqual([
      [tsx, 5, 'Page'],
      [jsx, 2, 'List'],
    ])
    expect(queryRefs({ name: 'Panel' }, dbPath).map((r) => r.line)).toEqual([6])
    for (const intrinsic of ['main', 'div']) expect(queryRefs({ name: intrinsic }, dbPath)).toEqual([])
  })

  it('stores a Java generic instantiation under the bare class name', () => {
    const file = index('Demo.java', [
      'import java.util.ArrayList;', // 1
      'class Demo {', // 2
      '  Object of(int a, int b) {', // 3
      '    new ArrayList<String>();', // 4
      '    return new Pair<>(a, b);', // 5
      '  }', // 6
      '}', // 7
    ])
    expect(queryRefs({ name: 'Pair' }, dbPath).map((r) => [r.filePath, r.line, r.context])).toEqual([[file, 5, 'of']])
    expect(queryRefs({ name: 'ArrayList' }, dbPath).map((r) => r.line)).toEqual([4])
    expect(queryRefs({ name: 'Pair<>' }, dbPath)).toEqual([])
  })

  it('gives Lua table methods their receiver as parent so a qualified read resolves', () => {
    const file = index('classes.lua', [
      'local Stack = {}', // 1
      'function Stack:push(v)', // 2
      'end', // 3
      'local Queue = {}', // 4
      'function Queue.new()', // 5
      'end', // 6
      'function Queue:push(v)', // 7
      'end', // 8
      'M = {}', // 9
      'M.sub = function(a)', // 10
      'end', // 11
    ])
    const lines = (spec: string): number[] =>
      findSymbolCandidates('classes.lua', file, spec, dir, dbPath).candidates.map((c) => c.lineStart)
    expect(lines('Queue.push')).toEqual([7])
    expect(lines('Stack.push')).toEqual([2])
    expect(lines('Queue.new')).toEqual([5])
    expect(lines('M.sub')).toEqual([10])
    expect(querySymbols({ name: 'push', filePath: file }, dbPath).map((s) => [s.lineStart, s.parent]).sort()).toEqual([
      [2, 'Stack'],
      [7, 'Queue'],
    ])
  })

  it('indexes Dart operator overloads under the operator symbol', () => {
    const file = index('shape.dart', [
      'class Point {', // 1
      '  final int x;', // 2
      '  Point(this.x);', // 3
      '  Point operator +(Point other) => Point(x + other.x);', // 4
      '  @override', // 5
      '  bool operator ==(Object other) => true;', // 6
      '  int operator [](int i) => i;', // 7
      '  void operator []=(int i, int v) {}', // 8
      '  Point operator -() => this;', // 9
      '  int operator ~/(int d) => d;', // 10
      '  void scale() {}', // 11
      '}', // 12
    ])
    const ops = querySymbols({ filePath: file }, dbPath)
      .filter((s) => s.parent === 'Point' && !/^[A-Za-z]/.test(s.name))
      .map((s) => [s.name, s.lineStart])
      .sort((a, b) => Number(a[1]) - Number(b[1]))
    expect(ops).toEqual([
      ['+', 4],
      ['==', 6],
      ['[]', 7],
      ['[]=', 8],
      ['-', 9],
      ['~/', 10],
    ])
    // Dart's own spelling of the overload, bare and qualified, reaches the same rows `read` resolves.
    for (const spec of ['operator +', 'Point.operator +']) {
      const found = findSymbolCandidates('shape.dart', file, stripHtmlIdSpelling(spec, file), dir, dbPath).candidates
      expect(found.map((c) => c.lineStart)).toEqual([4])
    }
    expect(querySymbols({ name: 'scale', filePath: file }, dbPath).map((s) => s.lineStart)).toEqual([11])
  })
})
