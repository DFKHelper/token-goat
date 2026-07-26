import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import {
  isParseSkipEligible,
  isTreeSitterAvailable,
  isUnderSkipDir,
  parseFile,
  stripPythonStringQuotes,
} from '../src/parser.js'

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

  it('parses .tsx files with the JSX-aware tsx grammar, not plain typescript (regression: both extensions shared the typescript grammar, which errors on JSX and silently drops trailing symbols)', async () => {
    const file = write(
      'ItemList.tsx',
      [
        "import React from 'react'",
        '',
        'interface ItemListProps {',
        '  items: string[]',
        '}',
        '',
        'export function ItemList(props: ItemListProps) {',
        '  return (',
        '    <>',
        '      {props.items.map((item) => (',
        '        <div key={item} className="item">',
        '          <span>{item}</span>',
        '        </div>',
        '      ))}',
        '    </>',
        '  )',
        '}',
        '',
        'export function formatLabel(raw: string): string {',
        '  return raw.trim().toUpperCase()',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    expect(result.language).toBe('typescript')
    const names = result.symbols.map((s) => s.name)
    // Under the plain `typescript` grammar this JSX produces ERROR nodes and both
    // functions are dropped entirely; only the tsx grammar recovers them.
    expect(names).toContain('ItemListProps')
    expect(names).toContain('ItemList')
    expect(names).toContain('formatLabel')
    const itemList = result.symbols.find((s) => s.name === 'ItemList')
    expect(itemList?.lineStart).toBe(7)
    expect(itemList?.lineEnd).toBe(17)
  })

  it('does not let a previously-parsed .tsx file poison the plain .ts grammar cache entry (regression: cache write used `lang` instead of `cacheKey`, so parsing a .tsx first stored the tsx grammar under the `typescript` key, corrupting every later .ts parse in the same process)', async () => {
    const tsxFile = write(
      'Poison.tsx',
      ['export function Poison() {', '  return <div>hi</div>', '}', ''].join('\n'),
    )
    await parseFile(tsxFile) // populate the cache under 'typescript:tsx'

    const tsFile = write(
      'assertion.ts',
      [
        'function foo(): number { return 1; }',
        'const x = <Foo>someValue;',
        'function bar(): number { return 2; }',
      ].join('\n'),
    )
    const result = await parseFile(tsFile)
    expect(result.language).toBe('typescript')
    const names = result.symbols.filter((s) => s.kind === 'function').map((s) => s.name)
    // Under the poisoned (tsx) grammar, `<Foo>someValue` is parsed as an unclosed
    // JSX element, producing ERROR nodes that drop `bar` entirely.
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

  it('excludes a local named function declaration nested inside a function body from the symbol index (regression: only lexical declarations were scope-gated, not function_declaration)', async () => {
    const file = write(
      'nested_fn.ts',
      [
        'export function outer(): number {',
        '  function localHelper(): number {',
        '    return 1',
        '  }',
        '  return localHelper()',
        '}',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const names = result.symbols.filter((s) => s.kind === 'function').map((s) => s.name)
    expect(names).toContain('outer')
    expect(names).not.toContain('localHelper')
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

  it('includes the decorator line(s) in a decorated function\'s line range and body', async () => {
    const file = write('decorated.py', "@app.route('/x')\ndef foo():\n    pass\n")
    const result = await parseFile(file)
    expect(result.language).toBe('python')
    const foo = result.symbols.find((s) => s.name === 'foo')
    // Regression: decorated_definition has no PY_KIND_BY_TYPE entry, so the symbol was built
    // from the inner function_definition node alone — whose tree-sitter position starts at
    // `def`, not the `@decorator` line above it. `read "file::foo"` then returned a body
    // missing the decorator entirely.
    expect(foo?.kind).toBe('function')
    expect(foo?.lineStart).toBe(1)
    expect(foo?.lineEnd).toBe(3)
    expect(foo?.body.startsWith("@app.route('/x')")).toBe(true)
  })

  it('includes the decorator line(s) in a decorated TS method\'s line range and body', async () => {
    const file = write(
      'decorated.ts',
      'class Foo {\n  @Log()\n  @Cache\n  method() {\n    return 1\n  }\n}\n',
    )
    const result = await parseFile(file)
    expect(result.language).toBe('typescript')
    const method = result.symbols.find((s) => s.name === 'method')
    // Regression: tree-sitter-typescript parses a method's `@decorator` as a standalone
    // `decorator` sibling inside `class_body`, not a field wrapping `method_definition` (unlike a
    // decorated class field, where the decorator IS a field on the node) — so the symbol built
    // from the bare method_definition node started at `method()`, silently dropping both
    // `@decorator` lines above it from `read`/`skeleton` output.
    expect(method?.kind).toBe('method')
    expect(method?.lineStart).toBe(2)
    expect(method?.lineEnd).toBe(6)
    expect(method?.body.startsWith('@Log()')).toBe(true)
  })

  it('stops the decorator walk-back at a preceding sibling method, not bleeding its body into a later decorated method', async () => {
    const file = write(
      'decorated2.ts',
      'class Foo {\n  @A()\n  one() {\n    return 1\n  }\n\n  @B()\n  two() {\n    return 2\n  }\n}\n',
    )
    const result = await parseFile(file)
    const one = result.symbols.find((s) => s.name === 'one')
    const two = result.symbols.find((s) => s.name === 'two')
    // Regression: a decorator walk-back that fails to stop at the first non-`decorator` sibling
    // would consume the previous method (`one`, including its own decorator and body) into
    // `two`'s range instead of stopping at `two`'s own `@B()`.
    expect(one?.lineStart).toBe(2)
    expect(one?.lineEnd).toBe(5)
    expect(two?.lineStart).toBe(7)
    expect(two?.lineEnd).toBe(10)
    expect(two?.body.startsWith('@B()')).toBe(true)
    expect(two?.body).not.toContain('one()')
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

  it('indexes C and C++ named union definitions (kind union)', async () => {
    const cFile = write('u.c', 'union Value {\n  int i;\n  float f;\n};\nstruct Point { int x; };\n')
    const cResult = await parseFile(cFile)
    expect(cResult.language).toBe('c')
    const cUnion = cResult.symbols.find((s) => s.name === 'Value')
    expect(cUnion?.kind).toBe('union') // union_specifier — dropped pre-fix (no kind map entry)
    // The sibling struct still resolves, confirming the union addition didn't disturb it.
    expect(cResult.symbols.some((s) => s.name === 'Point' && s.kind === 'struct')).toBe(true)

    const cppFile = write('u.cpp', 'union Packet {\n  int i;\n  double d;\n};\n')
    const cppResult = await parseFile(cppFile)
    expect(cppResult.language).toBe('cpp')
    const cppUnion = cppResult.symbols.find((s) => s.name === 'Packet')
    expect(cppUnion?.kind).toBe('union') // union_specifier — dropped pre-fix
  })

  it('indexes C and C++ typedef aliases including the anonymous struct/enum/union form (kind type)', async () => {
    // The dominant real-world typedef idiom uses an anonymous tag, so the alias name lives only on
    // the type_definition's declarator chain — every one of these was invisible pre-fix.
    const cFile = write(
      'td.c',
      [
        'typedef struct { int x; int y; } Point;',
        'typedef enum { RED, GREEN } Color;',
        'typedef union { int i; float f; } Value;',
        'typedef int (*Callback)(int, int);', // function-pointer declarator chain
        'typedef int MyInt;',
        'struct Bare { int z; };',
      ].join('\n') + '\n',
    )
    const cResult = await parseFile(cFile)
    expect(cResult.language).toBe('c')
    for (const alias of ['Point', 'Color', 'Value', 'Callback', 'MyInt']) {
      // All typedef aliases index as kind 'type' — every one dropped pre-fix (no type_definition entry).
      expect(cResult.symbols.some((s) => s.name === alias && s.kind === 'type')).toBe(true)
    }
    // The sibling non-typedef struct still resolves as 'struct', confirming the addition didn't disturb it.
    expect(cResult.symbols.some((s) => s.name === 'Bare' && s.kind === 'struct')).toBe(true)

    const cppFile = write('td.cpp', 'typedef struct { double re; double im; } Complex;\n')
    const cppResult = await parseFile(cppFile)
    expect(cppResult.language).toBe('cpp')
    expect(cppResult.symbols.some((s) => s.name === 'Complex' && s.kind === 'type')).toBe(true)
  })

  it('indexes C++ namespace definitions (kind namespace), including nested `A::B` form', async () => {
    // `namespace Foo { ... }` parses as namespace_definition, which had no CPP_KIND_BY_TYPE entry —
    // the namespace itself was invisible to symbol/outline/skeleton even though its nested
    // functions/classes still indexed (extractSimpleSymbols always recurses into children
    // regardless of the parent's kind-map membership).
    const cppFile = write(
      'ns.cpp',
      ['namespace Foo {', '  void bar() {}', '  struct Baz {};', '}', 'namespace A::B {', '  int x;', '}', ''].join(
        '\n',
      ),
    )
    const cppResult = await parseFile(cppFile)
    expect(cppResult.language).toBe('cpp')
    const foo = cppResult.symbols.find((s) => s.name === 'Foo')
    expect(foo?.kind).toBe('namespace') // namespace_definition — dropped pre-fix (no kind map entry)
    // Nested `namespace A::B { ... }` — name lives on a nested_namespace_specifier, not a plain identifier.
    expect(cppResult.symbols.some((s) => s.name === 'A::B' && s.kind === 'namespace')).toBe(true)
    // Children inside the namespace still resolve, confirming the addition didn't disturb them.
    expect(cppResult.symbols.some((s) => s.name === 'bar' && s.kind === 'function')).toBe(true)
    expect(cppResult.symbols.some((s) => s.name === 'Baz' && s.kind === 'struct')).toBe(true)

    // An anonymous `namespace { ... }` has no name field — must not crash and must not emit a
    // symbol with an empty/null name.
    const anonFile = write('ns_anon.cpp', 'namespace {\n  int hidden;\n}\n')
    const anonResult = await parseFile(anonFile)
    expect(anonResult.symbols.some((s) => s.kind === 'namespace' && !s.name)).toBe(false)
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

  it('sniffs a .h file with C++ syntax and parses it with the cpp grammar, not the c grammar', async () => {
    const hFile = write(
      'widget.h',
      ['class Widget {', 'public:', '  int area() { return 4; }', '};', ''].join('\n'),
    )
    const result = await parseFile(hFile)
    expect(result.language).toBe('c') // stored Language stays 'c' for .h, same as tsx stays 'typescript'
    const symNames = result.symbols.map((s) => s.name)
    expect(symNames).toContain('Widget') // class_specifier -- only resolves under the cpp grammar
    expect(symNames).toContain('area')
  })

  it('parses a plain C .h file with the c grammar (no false-positive cpp routing)', async () => {
    const hFile = write('plain.h', 'int add(int a, int b);\n#define MAX 100\n')
    const result = await parseFile(hFile)
    expect(result.language).toBe('c')
    // The prototype itself indexes as a function (see the dedicated prototype test below);
    // #define is preprocessor text, not a tree-sitter declaration, and stays unindexed.
    expect(result.symbols.map((s) => s.name)).toEqual(['add'])
  })

  it('indexes bodiless C/C++ function prototypes (kind function) without false-positiving on variables or function-pointer variables', async () => {
    // Header files are almost entirely prototypes -- a `declaration` node, not `function_definition`
    // (which requires a body). Every one of these was silently dropped pre-fix.
    const cFile = write(
      'proto.h',
      [
        'int add(int a, int b);', // plain prototype
        'int *make_widget(void);', // pointer return type -- wraps in pointer_declarator
        'extern void run(void);', // storage-class specifier prefix
        'int global_var;', // plain variable -- must NOT be indexed as a function
        'extern int gv2;', // extern variable -- must NOT be indexed as a function
        'int (*fp)(int);', // function-pointer VARIABLE -- must NOT be indexed as a function
        '',
      ].join('\n'),
    )
    const cResult = await parseFile(cFile)
    expect(cResult.language).toBe('c')
    const cNames = cResult.symbols.map((s) => s.name)
    for (const fn of ['add', 'make_widget', 'run']) {
      expect(cResult.symbols.some((s) => s.name === fn && s.kind === 'function')).toBe(true)
    }
    expect(cNames).not.toContain('global_var')
    expect(cNames).not.toContain('gv2')
    expect(cNames).not.toContain('fp')

    const cppFile = write('proto.hpp', 'void greet(const char *name);\n')
    const cppResult = await parseFile(cppFile)
    expect(cppResult.language).toBe('cpp')
    expect(cppResult.symbols.some((s) => s.name === 'greet' && s.kind === 'function')).toBe(true)
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

  it('indexes Go interface method signatures (method_elem, not a *_declaration node)', async () => {
    const goFile = write(
      'iface.go',
      [
        'package main',
        '',
        'type Reader interface {',
        '\tRead(p []byte) (n int, err error)',
        '\tClose() error',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(goFile)
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('Reader')
    // Interface method signatures parse as `method_elem`, a distinct node type from
    // `method_declaration` (a concrete method with a receiver and body) -- without its own
    // kind-map entry, every declared method of an interface was invisible to the index.
    expect(names).toContain('Read')
    expect(names).toContain('Close')
  })

  it('indexes TypeScript interface method/property signatures and abstract class method signatures (method_signature/property_signature/abstract_method_signature, distinct node types from method_definition -- no TSJS_KIND_BY_TYPE entry meant every interface member and abstract method was invisible to the index)', async () => {
    const file = write(
      'iface.ts',
      [
        'interface Reader {',
        '  read(len: number): string;',
        '  size: number;',
        '}',
        'abstract class Base {',
        '  abstract run(): void;',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    expect(result.language).toBe('typescript')
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('Reader')
    expect(names).toContain('Base')
    // Interface method signature (method_signature) -- dropped pre-fix.
    expect(names).toContain('read')
    // Interface property signature (property_signature) -- dropped pre-fix.
    expect(names).toContain('size')
    // Abstract class method signature (abstract_method_signature) -- dropped pre-fix.
    expect(names).toContain('run')
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
        '\ttype localIface interface{ LocalMethod() }',
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
    // A function-local interface's methods must not leak into the index either, matching the
    // exclusion of the interface type itself.
    expect(names).not.toContain('localIface')
    expect(names).not.toContain('LocalMethod')
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

  it('excludes function-local const from the Rust index but keeps nested items and associated consts', async () => {
    const rustFile = write(
      'rlocals.rs',
      [
        'const TOP: i32 = 1;',
        'struct Widget { x: i32 }',
        'impl Widget {',
        '    const ASSOC: i32 = 9;',
        '    fn area(&self) -> i32 {',
        '        const LOCAL_C: i32 = 5;',
        '        self.x + LOCAL_C',
        '    }',
        '}',
        'fn outer() {',
        '    const FN_LOCAL: i32 = 2;',
        '    struct NestedS { a: i32 }',
        '    fn inner() {}',
        '    let _ = FN_LOCAL;',
        '    let _ = NestedS { a: 0 };',
        '    inner();',
        '}',
        'let _g = || {',
        '    const CLOSURE_C: i32 = 3;',
        '    CLOSURE_C',
        '};',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    const names = result.symbols.map((s) => s.name)
    // Top-level and associated declarations stay indexed.
    expect(names).toContain('TOP')
    expect(names).toContain('Widget')
    expect(names).toContain('outer')
    expect(names).toContain('ASSOC')
    // Nested named items stay indexed, matching how the TS/JS extractor keeps nested classes and functions.
    expect(names).toContain('NestedS')
    expect(names).toContain('inner')
    // Function-local and closure-local consts are excluded.
    expect(names).not.toContain('LOCAL_C')
    expect(names).not.toContain('FN_LOCAL')
    expect(names).not.toContain('CLOSURE_C')
  })

  it('folds leading Rust attributes (#[derive], #[test], stacked attrs) into the symbol range', async () => {
    const rustFile = write(
      'attrs.rs',
      [
        '#[derive(Debug)]',
        '#[allow(dead_code)]',
        'struct Widget { x: i32 }',
        '',
        '#[test]',
        'fn check() { assert!(true); }',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    const widget = result.symbols.find((s) => s.name === 'Widget')
    expect(widget).toBeDefined()
    // The range starts at the earliest stacked attribute, not the `struct` keyword.
    expect(widget!.lineStart).toBe(1)
    expect(widget!.body).toContain('#[derive(Debug)]')
    expect(widget!.body).toContain('#[allow(dead_code)]')

    const check = result.symbols.find((s) => s.name === 'check')
    expect(check).toBeDefined()
    expect(check!.lineStart).toBe(5)
    expect(check!.body).toContain('#[test]')
  })

  it('indexes Rust module declarations (mod_item), including nested and body-less mods', async () => {
    const rustFile = write(
      'mods.rs',
      [
        'mod config {',
        '    pub fn load() {}',
        '    mod nested {',
        '        pub fn deep() {}',
        '    }',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    fn check() {}',
        '}',
        '',
        'mod bare;',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    expect(result.language).toBe('rust')
    const modules = result.symbols.filter((s) => s.kind === 'module').map((s) => s.name)
    // A top-level mod, a nested mod, a body-less `mod bare;`, and an attributed mod all index.
    expect(modules).toContain('config')
    expect(modules).toContain('nested')
    expect(modules).toContain('tests')
    expect(modules).toContain('bare')
    // The `#[cfg(test)]` attribute folds into the mod's range (starts at the attribute line).
    const testsMod = result.symbols.find((s) => s.name === 'tests' && s.kind === 'module')
    expect(testsMod!.lineStart).toBe(8)
    expect(testsMod!.body).toContain('#[cfg(test)]')
  })

  it('indexes Rust unbodied fn signatures (trait required methods and extern FFI declarations)', async () => {
    const rustFile = write(
      'sigs.rs',
      [
        'trait Repo {',
        '    fn find(&self, id: u32) -> u32;', // required method, no default body
        '    fn save(&mut self) {}', // default-bodied method (function_item) still indexes
        '}',
        '',
        'extern "C" {',
        '    fn abort() -> !;', // foreign-function declaration
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    expect(result.language).toBe('rust')
    const fns = result.symbols.filter((s) => s.kind === 'function').map((s) => s.name)
    // Both the unbodied trait signature and the extern FFI declaration index as 'function'...
    expect(fns).toContain('find')
    expect(fns).toContain('abort')
    // ...alongside the default-bodied trait method, so a trait interface is fully discoverable.
    expect(fns).toContain('save')
    // The trait itself still indexes as before.
    expect(result.symbols.some((s) => s.name === 'Repo' && s.kind === 'trait')).toBe(true)
    // The signature's range covers its single declaration line.
    const find = result.symbols.find((s) => s.name === 'find')!
    expect(find.body).toContain('fn find(&self, id: u32) -> u32;')
  })

  it('indexes a Rust extern "C" foreign-module block with its ABI and #[link] attribute (regression: foreign_mod_item was absent, so the extern block itself never indexed and its FFI declaration lost its only source of ABI/link context when rendered standalone)', async () => {
    const rustFile = write(
      'ffi.rs',
      [
        '#[link(name = "c")]',
        'extern "C" {',
        '    fn abort() -> !;',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    expect(result.language).toBe('rust')
    const extern = result.symbols.find((s) => s.kind === 'extern')
    expect(extern).toBeDefined()
    expect(extern!.name).toBe('extern "C"')
    // Starts at the #[link(...)] attribute line (matches the leadingRustAttributes convention
    // already used for every other Rust item kind), not just the `extern "C"` keyword line.
    expect(extern!.lineStart).toBe(1)
    expect(extern!.body).toContain('#[link(name = "c")]')
    expect(extern!.body).toContain('extern "C"')
    // The FFI declaration inside still indexes as its own standalone 'function' symbol too.
    expect(result.symbols.some((s) => s.name === 'abort' && s.kind === 'function')).toBe(true)
  })

  it('indexes Rust macro_rules! declarative macros, including attributed and nested-in-fn ones', async () => {
    const rustFile = write(
      'macros.rs',
      [
        '#[macro_export]',
        'macro_rules! log_it {',
        '    ($msg:expr) => {',
        '        println!("{}", $msg);',
        '    };',
        '}',
        '',
        'fn helper() {',
        '    macro_rules! inner {', // a macro defined inside a fn body stays indexed (a definition, not a value binding)
        '        () => {};',
        '    }',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    expect(result.language).toBe('rust')
    const macros = result.symbols.filter((s) => s.kind === 'macro').map((s) => s.name)
    expect(macros).toContain('log_it')
    // A macro nested in a function body is still indexed, mirroring nested fns/structs.
    expect(macros).toContain('inner')
    // The `#[macro_export]` attribute folds into the macro's range (starts at the attribute line).
    const logIt = result.symbols.find((s) => s.name === 'log_it' && s.kind === 'macro')!
    expect(logIt.lineStart).toBe(1)
    expect(logIt.body).toContain('#[macro_export]')
    expect(logIt.body).toContain('macro_rules! log_it')
  })

  it('indexes Rust static bindings (excluding function-local statics) and union definitions', async () => {
    const rustFile = write(
      'statics.rs',
      [
        'static GLOBAL_MAX: u32 = 100;',
        'pub static mut COUNTER: i64 = 0;',
        'union MyUnion { f1: u32, f2: f32 }',
        'fn compute() -> u32 {',
        '    static LOCAL_STATIC: u32 = 5;', // function-local static is excluded, like function-local const
        '    union LocalUnion { a: u8 }', // a union nested in a fn body stays indexed (type def, not a value binding)
        '    LOCAL_STATIC',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(rustFile)
    expect(result.language).toBe('rust')
    const statics = result.symbols.filter((s) => s.kind === 'static').map((s) => s.name)
    const unions = result.symbols.filter((s) => s.kind === 'union').map((s) => s.name)
    // Top-level statics (including `pub static mut`) index as kind 'static'.
    expect(statics).toContain('GLOBAL_MAX')
    expect(statics).toContain('COUNTER')
    // A `union` definition indexes as kind 'union'...
    expect(unions).toContain('MyUnion')
    // ...and stays indexed even when nested in a function body, mirroring nested structs/enums.
    expect(unions).toContain('LocalUnion')
    // A function-local `static` is excluded from the global index, matching function-local `const`.
    expect(result.symbols.map((s) => s.name)).not.toContain('LOCAL_STATIC')
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

  it('keeps base HTML heading/id symbols alongside lwc:ref/c-* extraction for an LWC template', async () => {
    const lwcDir = path.join(TMP, 'force-app', 'main', 'default', 'lwc', 'checkoutPanel')
    fs.mkdirSync(lwcDir, { recursive: true })
    const file = path.join(lwcDir, 'checkoutPanel.html')
    fs.writeFileSync(
      file,
      '<template>\n' +
        '  <h2 id="panel-title">Checkout</h2>\n' +
        '  <div lwc:ref="panel"><c-line-item></c-line-item></div>\n' +
        '</template>\n',
    )
    const result = await parseFile(file)
    expect(result.language).toBe('html')
    const symNames = result.symbols.map((s) => s.name)
    expect(symNames).toContain('Checkout') // base HTML heading — dropped pre-fix
    expect(symNames).toContain('panel-title') // base HTML anchor-id — dropped pre-fix
    expect(symNames).toContain('panel') // lwc_ref, still present
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
    expect(variables.length).toBe(3)
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

  it('counts newlines between a JSON key and its colon when computing lineEnd (regression: only the colon-to-value gap was counted, undercounting lineEnd when the key and colon are on different lines)', async () => {
    const file = write(
      'nlkey.json',
      ['{', '  "key"', ': "value on next-next line"', '}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const key = result.symbols.find((s) => s.kind === 'property' && s.name === 'key')
    expect(key?.lineStart).toBe(2)
    expect(key?.lineEnd).toBe(3)
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
    expect(directives.length).toBe(5)
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
    // 1, not 2: extractRefs's dedup key is (name, line) without column, so both `helper()`
    // calls on line 5 collapse into a single recorded ref rather than one per call-site.
    expect(result.refs.length).toBe(1)
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

  // Regression: REF_NOISE_BY_LANG only defined a builtin-noise filter for typescript/python, so
  // go/rust/c/cpp/ruby's bare-identifier stdlib/language builtins (fmt-adjacent bare calls like
  // Go's len/println, Rust's println!/vec! macros, C's printf/malloc) were never filtered out of
  // refs, unlike TS's bare parseInt/setTimeout or Python's bare print/len -- an asymmetric gap in
  // an already-documented mechanism, not a difference in design intent.
  it('filters bare Go builtins (len, println) out of refs but keeps a real helper call', async () => {
    const file = write(
      'noise.go',
      'package main\n' +
        'func helper() int { return 1 }\n' +
        'func driver() {\n' +
        '  s := make([]int, 0)\n' +
        '  println(len(s))\n' +
        '  helper()\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const refNames = result.refs.map((r) => r.name)
    expect(refNames).not.toContain('println')
    expect(refNames).not.toContain('len')
    expect(refNames).not.toContain('make')
    expect(refNames).toContain('helper')
  })

  it('filters bare Rust macros (println!, vec!) out of refs but keeps a real helper call', async () => {
    const file = write(
      'noise.rs',
      'fn helper() -> i32 { 1 }\n' +
        'fn driver() {\n' +
        '  let v = vec![1, 2, 3];\n' +
        '  let h = helper();\n' +
        '  println!("{:?} {}", v, h);\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const refNames = result.refs.map((r) => r.name)
    expect(refNames).not.toContain('println')
    expect(refNames).not.toContain('vec')
    expect(refNames).toContain('helper')
  })

  it('filters bare C stdlib builtins (printf, malloc) out of refs but keeps a real helper call', async () => {
    const file = write(
      'noise.c',
      'int helper(){ return 1; }\n' +
        'void driver(){\n' +
        '  int* p = malloc(sizeof(int));\n' +
        '  printf("%d\n", helper());\n' +
        '  free(p);\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const refNames = result.refs.map((r) => r.name)
    expect(refNames).not.toContain('printf')
    expect(refNames).not.toContain('malloc')
    expect(refNames).not.toContain('free')
    expect(refNames).toContain('helper')
  })

  // Regression: extractRefs only walked call-site node types (call_expression/new_expression),
  // so a symbol used only in a "value position" -- passed as a callback, assigned to a variable,
  // stored as an object-literal value -- was invisible to the refs table. That made `dead`
  // report a false positive (the symbol looked unreferenced despite real usage) and made
  // `refs`/`callers` under-report genuine usages.
  it('captures a function passed as a bare callback argument (value position, not a call site)', async () => {
    const file = write(
      'callback-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(arr: number[]): number[] {\n' +
        '  return arr.map(myHelperFunction)\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  it('captures a function assigned to a variable (value position, not a call site)', async () => {
    const file = write(
      'assignment-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(): unknown {\n' +
        '  const x = myHelperFunction\n' +
        '  return x\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  it('captures a function stored as an object-literal value (value position, not a call site)', async () => {
    const file = write(
      'object-value-ref.ts',
      'function myHelperFunction(): void {}\n' +
        'export function driver(): unknown {\n' +
        '  return { onClick: myHelperFunction }\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
  })

  // Regression: a required_parameter/optional_parameter node's `value` field (the default
  // value expression) was never walked by valueRefIdentifiers, so a symbol used only as a
  // default parameter value -- e.g. `requeue: (a: string) => void = requeueDirtyPath` in
  // worker.ts -- was invisible to the refs table and `dead` reported a false positive despite
  // real usage.
  it('captures a function used as a default parameter value (value position, not a call site)', async () => {
    const file = write(
      'default-param-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(cb: (x: number) => number = myHelperFunction): number {\n' +
        '  return cb(1)\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(4)
  })

  // Regression: argument_list's namedChildren case only matched a bare `identifier` child, so
  // a Python keyword argument's nested value (foo(on_page=myHelperFunction)) -- a
  // keyword_argument node with its own `value` field -- was never walked, making `dead` report
  // a real callback-by-keyword-argument usage (e.g. convert_patent_pdf.py's `add_page_number`
  // passed as `onFirstPage=add_page_number`) as a false-positive dead symbol.
  it('captures a function passed as a Python keyword argument value (value position, not a bare argument)', async () => {
    const file = write(
      'keyword-arg-ref.py',
      'def my_helper_function(x):\n' +
        '    return x + 1\n' +
        '\n' +
        'def driver():\n' +
        '    return foo(on_page=my_helper_function)\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'my_helper_function')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: a call whose callee is a parenthesized `??`/`||`/`&&` fallback expression, e.g.
  // `(override ?? myHelperFunction)(x)`, has no calleeName() match (the callee isn't a bare
  // identifier/member_expression) and no valueRefIdentifiers case walked binary_expression's
  // operands either -- so a symbol used only as the fallback side of such an expression was
  // invisible to refs (found live: src/parser.ts's own `extractWithRegex`, used as
  // `(NO_TREE_SITTER_EXTRACTORS[language] ?? extractWithRegex)(content, filePath)`).
  it('captures a function used as the fallback side of a ?? expression, including when the expression itself is called', async () => {
    const file = write(
      'nullish-fallback-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(override: ((x: number) => number) | undefined, x: number): number {\n' +
        '  return (override ?? myHelperFunction)(x)\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: array-literal elements had no valueRefIdentifiers case, so a symbol used only as
  // an entry in an array literal (const handlers = [myHelperFunction]) was invisible to refs.
  it('captures a function used as an array-literal element (value position, not a call site)', async () => {
    const file = write(
      'array-literal-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(): ((x: number) => number)[] {\n' +
        '  return [myHelperFunction]\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: array-literal elements in Python (a `list` node) had the same gap.
  it('captures a function used as a Python list-literal element (value position, not a call site)', async () => {
    const file = write(
      'list-literal-ref.py',
      'def my_helper_function(x):\n' +
        '    return x + 1\n' +
        '\n' +
        'def driver():\n' +
        '    return [my_helper_function]\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'my_helper_function')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: ternary consequence/alternative branches had no valueRefIdentifiers case, so a
  // symbol used only as one branch of a ternary (const fn = cond ? myHelperFunction : other) was
  // invisible to refs.
  it('captures a function used as a ternary branch (value position, not a call site)', async () => {
    const file = write(
      'ternary-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'function otherFn(x: number): number {\n' +
        '  return x - 1\n' +
        '}\n' +
        'export function driver(cond: boolean): (x: number) => number {\n' +
        '  return cond ? myHelperFunction : otherFn\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(8)
  })

  // Regression: Python's conditional_expression (a if cond else b) has the same gap.
  it('captures a function used as a Python conditional-expression branch (value position, not a call site)', async () => {
    const file = write(
      'conditional-expr-ref.py',
      'def my_helper_function(x):\n' +
        '    return x + 1\n' +
        '\n' +
        'def other_fn(x):\n' +
        '    return x - 1\n' +
        '\n' +
        'def driver(cond):\n' +
        '    return my_helper_function if cond else other_fn\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'my_helper_function')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(8)
  })

  // Regression: a class field initializer (public_field_definition's value field) had no
  // valueRefIdentifiers case, so a symbol used only as a class field's initial value
  // (class C { handler = myHelperFunction }) was invisible to refs.
  it('captures a function used as a class field initializer (value position, not a call site)', async () => {
    const file = write(
      'class-field-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export class Driver {\n' +
        '  handler = myHelperFunction\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('Driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: a bare-identifier return statement (return myHelperFunction) had no
  // valueRefIdentifiers case, since neither grammar names the returned expression a field.
  it('captures a function used as a bare-identifier return value (value position, not a call site)', async () => {
    const file = write(
      'bare-return-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(): (x: number) => number {\n' +
        '  return myHelperFunction\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: Python's bare-identifier return has the same gap.
  it('captures a function used as a Python bare-identifier return value (value position, not a call site)', async () => {
    const file = write(
      'bare-return-ref.py',
      'def my_helper_function(x):\n' +
        '    return x + 1\n' +
        '\n' +
        'def driver():\n' +
        '    return my_helper_function\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'my_helper_function')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: a destructuring default (object_assignment_pattern's `right` field) had no
  // valueRefIdentifiers case, so a symbol used only as a destructured default
  // (const { cb = myHelperFunction } = opts) was invisible to refs.
  it('captures a function used as an object-destructuring default (value position, not a call site)', async () => {
    const file = write(
      'destructure-default-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(opts: { cb?: (x: number) => number }): (x: number) => number {\n' +
        '  const { cb = myHelperFunction } = opts\n' +
        '  return cb\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: an array-destructuring default (assignment_pattern's `right` field) has the same gap.
  it('captures a function used as an array-destructuring default (value position, not a call site)', async () => {
    const file = write(
      'array-destructure-default-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(arr: ((x: number) => number)[]): (x: number) => number {\n' +
        '  const [cb = myHelperFunction] = arr\n' +
        '  return cb\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  // Regression: a template-literal interpolation (template_substitution's sole namedChild) had no
  // valueRefIdentifiers case, so a symbol used only as a template interpolation
  // (`value: ${myHelperFunction}`) was invisible to refs.
  it('captures a function used inside a template-literal interpolation (value position, not a call site)', async () => {
    const file = write(
      'template-literal-ref.ts',
      'function myHelperFunction(x: number): number {\n' +
        '  return x + 1\n' +
        '}\n' +
        'export function driver(): string {\n' +
        '  return `fn: ${myHelperFunction}`\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'myHelperFunction')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
    expect(ref?.line).toBe(5)
  })

  it('captures a base class named in an extends clause (value position, not a call site)', async () => {
    const file = write(
      'extends-clause-ref.ts',
      'export abstract class BaseFilter {\n' +
        '  abstract run(): void\n' +
        '}\n' +
        'export class ConcreteFilter extends BaseFilter {\n' +
        '  run(): void {}\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'BaseFilter')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('ConcreteFilter')
    expect(ref?.line).toBe(4)
  })

  it('captures the object of a member-expression base in an extends clause (e.g. extends ns.Base)', async () => {
    const file = write(
      'extends-member-ref.ts',
      'import * as ns from \'./ns.js\'\n' +
        'export class ConcreteFilter extends ns.BaseFilter {\n' +
        '  run(): void {}\n' +
        '}\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'ns')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('ConcreteFilter')
    expect(ref?.line).toBe(2)
  })

  it('captures a Python function passed as a bare callback argument', async () => {
    const file = write(
      'callback_ref.py',
      'def my_helper_function(x):\n' +
        '    return x + 1\n' +
        'def driver(items):\n' +
        '    return list(map(my_helper_function, items))\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'my_helper_function')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
  })

  it('captures a Python function assigned to a variable', async () => {
    const file = write(
      'assignment_ref.py',
      'def my_helper_function(x):\n' +
        '    return x + 1\n' +
        'def driver():\n' +
        '    x = my_helper_function\n' +
        '    return x\n',
    )
    const result = await parseFile(file)
    const ref = result.refs.find((r) => r.name === 'my_helper_function')
    expect(ref).toBeDefined()
    expect(ref?.context).toBe('driver')
  })

  it('does not record a false value-position ref for an identifier used in a nested expression', async () => {
    // Guard against over-matching: `a.b`, `a + b`, and a call result passed as an argument must
    // never be captured as if the bare name itself were passed/assigned directly.
    const file = write(
      'no-overmatch.ts',
      'function notAValuePositionRef(): number { return 1 }\n' +
        'export function driver(): number {\n' +
        '  const sum = 1 + notAValuePositionRef().length\n' +
        '  return sum\n' +
        '}\n',
    )
    const result = await parseFile(file)
    // notAValuePositionRef IS captured as a call-site ref (it's invoked with parens), but must
    // appear exactly once -- not double-counted by an over-broad value-position match on the
    // same identifier inside the binary expression it's nested in.
    const refs = result.refs.filter((r) => r.name === 'notAValuePositionRef')
    expect(refs).toHaveLength(1)
  })

  it('yields no refs for a language without a tree-sitter grammar', async () => {
    const file = write('notes.md', '# Title\n\nsome prose calling foo()\n')
    const result = await parseFile(file)
    expect(result.refs).toEqual([])
  })

  it('indexes .mdx headings as markdown symbols instead of skipping the file as unknown', async () => {
    // Regression: .mdx had no EXTENSION_LANGUAGE entry, so parseFile/detectLanguage classified
    // it as 'unknown' and cmdIndex skipped it entirely -- no headings ever made it into the
    // symbol index for MDX docs.
    const file = write('guide.mdx', '# Title\n\n## Setup\n\nsome content\n')
    const result = await parseFile(file)
    expect(result.language).toBe('markdown')
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('Title')
    expect(names).toContain('Setup')
  })
})

describe('isTreeSitterAvailable', () => {
  it('returns true for every bundled-grammar language (regression-coverage gap: only typeof was ever checked for the bundled languages, so a regression returning false for all of them -- e.g. an inverted condition -- would still pass "is a boolean")', () => {
    expect(isTreeSitterAvailable('typescript')).toBe(true)
    expect(isTreeSitterAvailable('python')).toBe(true)
    expect(isTreeSitterAvailable('javascript')).toBe(true)
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

describe('isUnderSkipDir', () => {
  it('matches a path segment that is a containing directory, not the file itself (mutation-testing gap: the last segment -- the filename -- must be excluded from the skip-dir check, or a file whose own basename happens to equal a skip_dirs entry gets wrongly treated as living under a skipped directory)', () => {
    expect(isUnderSkipDir('/repo/node_modules/pkg/index.js', ['node_modules'])).toBe(true)
    // The file itself is literally named "dist" (no extension) -- this must NOT match, since
    // skip_dirs describes containing directories, not filenames.
    expect(isUnderSkipDir('/repo/src/dist', ['dist'])).toBe(false)
    expect(isUnderSkipDir('/repo/src/dist/bundle.js', ['dist'])).toBe(true)
  })
})

describe('isParseSkipEligible', () => {
  const cfg = { skip_dirs: [], large_file_skip_kb: 1, large_file_symbol_only_kb: 1048576 }

  it('does not skip a file whose size sits exactly at the cap (mutation-testing gap: the boundary check must be strictly greater-than, not greater-than-or-equal)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'))
    const file = path.join(tmpDir, 'exact.txt')
    fs.writeFileSync(file, Buffer.alloc(1024, 'a'))

    expect(isParseSkipEligible(file, cfg)).toBe(false)

    fs.writeFileSync(file, Buffer.alloc(1025, 'a'))
    expect(isParseSkipEligible(file, cfg)).toBe(true)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
