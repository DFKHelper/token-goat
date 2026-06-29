import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { indexFile, isTreeSitterAvailable, parseFile, stripPythonStringQuotes } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parser-'))
})

afterEach(() => {
  // Close cached SQLite handles first; on Windows an open WAL file blocks the recursive rmSync with EPERM.
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

describe('parseFile', () => {
  it('extracts function declarations from a .ts file', async () => {
    const file = write(
      'a.ts',
      'export function foo(x: number): string { return String(x); }\n' +
        'function bar() { return 1; }\n',
    )
    const result = await parseFile(file)
    expect(result.language).toBe('typescript')
    const names = result.symbols.filter((s) => s.kind === 'function').map((s) => s.name)
    expect(names).toContain('foo')
    expect(names).toContain('bar')
  })

  it('excludes function-local variable declarations from the symbol index (regression: nested lexical_declaration walked unconditionally)', async () => {
    const file = write(
      'scope.ts',
      [
        'export const MODULE_CONST = 1',
        'export function validatedInt(raw: number): number {',
        '  const n = raw + 1',
        '  const tmp = n * 2',
        '  return tmp',
        '}',
        'export class C {',
        '  get tokensSaved(): number {',
        '    const local = this.x',
        '    return local',
        '  }',
        '}',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('MODULE_CONST')
    expect(names).toContain('validatedInt')
    expect(names).toContain('tokensSaved')
    expect(names).not.toContain('n')
    expect(names).not.toContain('tmp')
    expect(names).not.toContain('local')
  })

  it('indexes TS/JS class fields initialized with arrow functions, not data fields', async () => {
    const tsFile = write(
      'widget.ts',
      [
        'class Widget {',
        '  count = 0;',
        '  handleClick = () => { this.count++; };',
        '  render() { return null; }',
        '}',
        '',
      ].join('\n'),
    )
    const tsResult = await parseFile(tsFile)
    const tsNames = tsResult.symbols.map((s) => s.name)
    expect(tsNames).toContain('handleClick') // arrow class field — dropped pre-fix
    expect(tsNames).toContain('render') // regular method — already worked
    expect(tsNames).not.toContain('count') // plain data field — must stay unindexed

    const jsFile = write(
      'widget.js',
      ['class W {', '  onClick = () => {};', '  data = 5;', '}', ''].join('\n'),
    )
    const jsResult = await parseFile(jsFile)
    const jsNames = jsResult.symbols.map((s) => s.name)
    expect(jsNames).toContain('onClick') // JS field_definition arrow — dropped pre-fix
    expect(jsNames).not.toContain('data') // plain data field — must stay unindexed
  })

  it('extracts class definitions from a .py file', async () => {
    const file = write('b.py', 'class Widget:\n    def render(self):\n        pass\n')
    const result = await parseFile(file)
    expect(result.language).toBe('python')
    const cls = result.symbols.find((s) => s.kind === 'class')
    expect(cls?.name).toBe('Widget')
    // The method inside the class is recorded as a method, not a function.
    const method = result.symbols.find((s) => s.name === 'render')
    expect(method?.kind).toBe('method')
  })

  it('labels a method defined inside a control-flow block in a class as a method', async () => {
    const file = write(
      'c.py',
      'class Widget:\n' +
        '    if True:\n' +
        '        def render(self):\n' +
        '            return 1\n',
    )
    const result = await parseFile(file)
    expect(result.language).toBe('python')
    const method = result.symbols.find((s) => s.name === 'render')
    // `render` is inside an `if` block inside the class body — still a method.
    expect(method?.kind).toBe('method')
  })

  it('returns empty symbols for an unknown extension', async () => {
    const file = write('notes.unknownext', 'just some text\nnot code at all\n')
    const result = await parseFile(file)
    expect(result.language).toBe('unknown')
    expect(result.symbols).toEqual([])
  })

  it('returns a numeric duration and never throws on a missing file', async () => {
    const result = await parseFile(path.join(TMP, 'does-not-exist.ts'))
    expect(result.symbols).toEqual([])
    expect(typeof result.duration).toBe('number')
  })

  it('indexes C and C++ function symbols (names live in a declarator chain)', async () => {
    const cFile = write('sym.c', 'int helper(){ return 1; }\nint* driver(){ return helper(); }\n')
    const cResult = await parseFile(cFile)
    expect(cResult.language).toBe('c')
    expect(cResult.symbols.map((s) => s.name)).toContain('helper')
    expect(cResult.symbols.map((s) => s.name)).toContain('driver')

    const cppFile = write('sym.cpp', 'class Widget {\npublic:\n  int area() { return 4; }\n};\nvoid run(){ return; }\n')
    const cppResult = await parseFile(cppFile)
    expect(cppResult.language).toBe('cpp')
    // The free function and the method are both function_definition nodes.
    expect(cppResult.symbols.map((s) => s.name)).toContain('run')
    expect(cppResult.symbols.map((s) => s.name)).toContain('area')
    // The class itself still resolves via its name field.
    expect(cppResult.symbols.map((s) => s.name)).toContain('Widget')
  })

  it('indexes C++ out-of-line method definitions (qualified_identifier declarator)', async () => {
    const cppFile = write(
      'methods.cpp',
      [
        'struct S { int x; };',
        'void S::doThing() {}',
        'int S::compute() { return 0; }',
        '',
      ].join('\n'),
    )
    const result = await parseFile(cppFile)
    expect(result.language).toBe('cpp')
    const symNames = result.symbols.map((s) => s.name)
    expect(symNames).toContain('doThing') // out-of-line method — dropped pre-fix
    expect(symNames).toContain('compute') // out-of-line method — dropped pre-fix
  })

  it('indexes Go type, const, var, and method symbols (names live on *_spec nodes)', async () => {
    const goFile = write(
      'sym.go',
      [
        'package main',
        '',
        'type Widget struct { x int }',
        'type Alias = Widget',
        'const MaxSize = 100',
        'var counter int',
        '',
        'func helper() int { return 1 }',
        'func (w Widget) Method() {}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(goFile)
    expect(result.language).toBe('go')
    const names = result.symbols.map((s) => s.name)
    // type/const/var names live on the nested *_spec nodes, not the declaration wrapper.
    expect(names).toContain('Widget')
    expect(names).toContain('Alias')
    expect(names).toContain('MaxSize')
    expect(names).toContain('counter')
    // The function already resolved; the method previously had no map entry.
    expect(names).toContain('helper')
    expect(names).toContain('Method')
  })
    it('excludes function-local var/const/type declarations from the Go index', async () => {
    const goFile = write(
      'locals.go',
      [
        'package main',
        '',
        'var topVar int',
        'const TopConst = 1',
        'type TopType struct{ a int }',
        '',
        'func foo() {',
        '\tvar localVar int',
        '\tconst localConst = 2',
        '\ttype localType struct{ b int }',
        '\t_ = localVar',
        '\t_ = localConst',
        '}',
        '',
        'var handler = func() {',
        '\tvar closureVar int',
        '\t_ = closureVar',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(goFile)
    const names = result.symbols.map((s) => s.name)
    // Package-level declarations are still indexed.
    expect(names).toContain('topVar')
    expect(names).toContain('TopConst')
    expect(names).toContain('TopType')
    expect(names).toContain('foo')
    expect(names).toContain('handler')
    // Function-local and closure-local declarations are NOT indexed.
    expect(names).not.toContain('localVar')
    expect(names).not.toContain('localConst')
    expect(names).not.toContain('localType')
    expect(names).not.toContain('closureVar')
  })


  it('indexes Rust impl blocks by their implemented type (name lives on the type field)', async () => {
    const rustFile = write(
      'sym.rs',
      [
        'struct Widget { x: i32 }',
        'impl Widget { fn area(&self) -> i32 { self.x } }',
        'trait Drawable { fn draw(&self); }',
        'impl Drawable for Widget { fn draw(&self) {} }',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    expect(result.language).toBe('rust')
    // The impl blocks resolve their name from the `type` field, not `name`.
    const implNames = result.symbols.filter((s) => s.kind === 'impl').map((s) => s.name)
    expect(implNames).toContain('Widget')
    // The struct and trait still resolve via their name field.
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('Widget')
    expect(names).toContain('Drawable')
  })

  it('indexes Ruby classes, modules, methods, and singleton methods', async () => {
    const rubyFile = write(
      'sym.rb',
      [
        'class Widget',
        '  def area',
        '    42',
        '  end',
        '  def self.build',
        '    new',
        '  end',
        'end',
        '',
        'module Helpers',
        '  def run; end',
        'end',
        '',
        'def free_method; end',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rubyFile)
    expect(result.language).toBe('ruby')
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('Widget') // class
    expect(names).toContain('Helpers') // module
    expect(names).toContain('area') // method
    expect(names).toContain('build') // singleton_method (def self.build)
    expect(names).toContain('run') // method inside module
    expect(names).toContain('free_method') // top-level method
  })

  it('indexes Java constructors, records, and annotation types', async () => {
    const javaFile = write(
      'Types.java',
      [
        'class Foo {',
        '  Foo() {}',
        '  Foo(int a) {}',
        '  void doThing() {}',
        '}',
        'record Point(int x, int y) {}',
        '@interface MyAnno { }',
        '',
      ].join('\n'),
    )
    const result = await parseFile(javaFile)
    expect(result.language).toBe('java')
    const symNames = result.symbols.map((s) => s.name)
    expect(symNames).toContain('Point') // record_declaration — dropped pre-fix
    expect(symNames).toContain('MyAnno') // annotation_type_declaration — dropped pre-fix
    // constructor_declaration: 'Foo' = the class plus 2 constructors post-fix (1 pre-fix)
    expect(symNames.filter((n) => n === 'Foo').length).toBeGreaterThanOrEqual(2)
  })
})

describe('indexFile', () => {
  it('upserts symbols into the DB so they can be queried back', async () => {
    const file = write('svc.ts', 'export function login(user: string) { return user; }\n')
    const db = path.join(TMP, 'index.db')

    await indexFile(file, db)
    const hits = querySymbols({ name: 'login' }, db)
    expect(hits.length).toBe(1)
    expect(hits[0]?.kind).toBe('function')
    expect(hits[0]?.filePath).toBe(file)
  })

  it('replaces stale rows on re-index rather than duplicating', async () => {
    const file = write('svc.ts', 'export function login() {}\nexport function logout() {}\n')
    const db = path.join(TMP, 'index.db')

    await indexFile(file, db)
    expect(querySymbols({ filePath: file }, db).length).toBe(2)

    // Rewrite the file with fewer symbols, then re-index.
    fs.writeFileSync(file, 'export function login() {}\n')
    await indexFile(file, db)
    const after = querySymbols({ filePath: file }, db)
    expect(after.map((s) => s.name)).toEqual(['login'])
  })
})

describe('parseFile', () => {
  it('extracts correct line ranges for individual variables in variable_declarator (regression: parent vs child node)', async () => {
    const file = write(
      'vars.ts',
      'const x = 1, y = 2, z = 3;\n',
    )
    const result = await parseFile(file)
    const variables = result.symbols.filter((s) => s.kind === 'variable')
    expect(variables.length).toBeGreaterThanOrEqual(1)
    variables.forEach((v) => {
      expect(v.lineStart).toBe(1)
      expect(v.lineEnd).toBe(1)
    })
  })

  it('extracts JSON properties at top level (regression: depthAtLineStart check)', async () => {
    const file = write(
      'config.json',
      JSON.stringify({
        'name': 'myapp',
        'nested': {
          'key': 'value',
        },
      }, null, 2),
    )
    const result = await parseFile(file)
    const properties = result.symbols.filter((s) => s.kind === 'property')
    const names = properties.map((p) => p.name)
    expect(names).toContain('name')
    expect(names).toContain('nested')
  })

  it('extracts Dockerfile directives in lowercase (regression: case-insensitive keywords)', async () => {
    const file = write(
      'Dockerfile',
      'FROM ubuntu:20.04\n' +
      'RUN apt-get update\n' +
      'COPY ./app /app\n' +
      'ENV NODE_ENV=production\n' +
      'CMD ["node", "server.js"]\n',
    )
    const result = await parseFile(file)
    const directives = result.symbols.filter((s) => s.kind === 'directive')
    expect(directives.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts individual bindings from destructuring declarations (not a junk pattern-named symbol)', async () => {
    const file = write(
      'destructure.ts',
      'const { alpha, beta } = obj;\nconst [first, second] = arr;\nconst { a: b } = obj;\nconst plain = 5;\nconst fn = () => {};\n',
    )
    const result = await parseFile(file)
    const names = result.symbols.map((s) => s.name)
    // Real bindings are indexed:
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
    expect(names).toContain('first')
    expect(names).toContain('second')
    expect(names).toContain('b')        // `const { a: b }` binds the value `b`
    expect(names).not.toContain('a')    // ...not the key `a`
    // Junk pattern-named symbols are gone:
    expect(names).not.toContain('{ alpha, beta }')
    expect(names).not.toContain('[first, second]')
    // Controls (unchanged behavior):
    expect(names).toContain('plain')
    const fnSym = result.symbols.find((s) => s.name === 'fn')
    expect(fnSym?.kind).toBe('function')   // arrow bound to a single identifier stays a 'function'
  })
})

describe('parseFile reference extraction', () => {
  it('extracts call-site refs with the enclosing caller in context (.ts)', async () => {
    const file = write(
      'callers.ts',
      'function helper(): number {\n' +
        '  return 1\n' +
        '}\n' +
        'export function driver(): number {\n' +
        '  return helper() + helper()\n' +
        '}\n',
    )
    const result = await parseFile(file)
    // The defect: refs was hard-coded to []. With extraction wired in, the call to `helper` inside `driver` must be captured, attributed to `driver`.
    expect(result.refs.length).toBeGreaterThan(0)
    const helperRef = result.refs.find((r) => r.name === 'helper')
    expect(helperRef).toBeDefined()
    expect(helperRef?.context).toBe('driver')
    expect(helperRef?.filePath).toBe(file)
    expect(helperRef?.line).toBe(5)
  })

  it('attributes a method call to its enclosing method name (.ts)', async () => {
    const file = write(
      'klass.ts',
      'class Service {\n' +
        '  run(): void {\n' +
        '    this.helper()\n' +
        '  }\n' +
        '  helper(): void {}\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'helper')
    expect(ref?.context).toBe('run')
  })

  it('extracts call-site refs from a .py file with the enclosing def in context', async () => {
    const file = write(
      'callers.py',
      'def helper():\n' +
        '    return 1\n' +
        'def driver():\n' +
        '    return helper()\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'helper')
    expect(ref?.context).toBe('driver')
  })

  it('resolves the enclosing function for a C call (name lives in a declarator chain)', async () => {
    const file = write(
      'callers.c',
      'int helper(){ return 1; }\n' +
        'int* driver(){ return helper(); }\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'helper')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
  })

  it('resolves C++ namespace-qualified call sites (qualified_identifier) in refs', async () => {
    const cppFile = write(
      'qcall.cpp',
      [
        'void f() {',
        '  std::sort(0, 0);',
        '}',
      ].join('\n'),
    )
    const result = await parseFile(cppFile)
    expect(result.language).toBe('cpp')
    const refNames = result.refs.map((r) => r.name)
    // Pre-fix: qualified_identifier (std::sort) would return null, so 'sort' would not appear Post-fix: qualified_identifier returns lastSegment('std::sort') = 'sort'
    expect(refNames).toContain('sort')
  })

  it('yields no refs for a language without a tree-sitter grammar', async () => {
    const file = write('notes.md', '# Title\n\nsome prose calling foo()\n')
    const result = await parseFile(file)
    expect(result.refs).toEqual([])
  })
})

describe('indexFile reference extraction (real write path)', () => {
  it('populates the refs table so queryRefs resolves a caller', async () => {
    const file = write(
      'svc.ts',
      'function helper() { return 2 }\n' +
        'export function driver() { return helper() }\n',
    )
    const db = path.join(TMP, 'index.db')
    await indexFile(file, db)

    const conn = (await import('../src/db.js')).getDb(db)
    const rows = conn.prepare('SELECT name, context FROM refs').all() as Array<{
      name: string
      context: string
    }>
    expect(rows.some((r) => r.name === 'helper' && r.context === 'driver')).toBe(true)
  })
})

describe('isTreeSitterAvailable', () => {
  it('returns a boolean without throwing for every language case', () => {
    expect(typeof isTreeSitterAvailable('typescript')).toBe('boolean')
    expect(typeof isTreeSitterAvailable('python')).toBe('boolean')
    expect(typeof isTreeSitterAvailable('javascript')).toBe('boolean')
    // A language with no bundled grammar is always false.
    expect(isTreeSitterAvailable('erlang')).toBe(false)
    expect(isTreeSitterAvailable('unknown')).toBe(false)
  })
})

describe('stripPythonStringQuotes', () => {
  it('handles empty triple-quoted strings (regression: off-by-one bug)', () => {
    expect(stripPythonStringQuotes('""""""')).toBe('')
    expect(stripPythonStringQuotes("''''''" )).toBe('')
  })
  it('strips triple-quoted strings correctly', () => {
    expect(stripPythonStringQuotes('"""hello"""')).toBe('hello')
    expect(stripPythonStringQuotes("'''world'''")).toBe('world')
  })
  it('strips single-quoted strings correctly', () => {
    expect(stripPythonStringQuotes('"hello"')).toBe('hello')
    expect(stripPythonStringQuotes("'world'")).toBe('world')
  })
  it('handles string prefixes (r, b, f, u)', () => {
    expect(stripPythonStringQuotes('r"raw string"')).toBe('raw string')
    expect(stripPythonStringQuotes('f"formatted"')).toBe('formatted')
  })
})
