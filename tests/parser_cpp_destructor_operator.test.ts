/** Regression: a C++ destructor (`~Widget() {}`) or operator overload (`operator==`) defined inside its class was not indexed, because the declarator walk only knew identifier, field_identifier and qualified_identifier. Provenance: HAND-DERIVED for the expected rows (counted by hand from the source below) and FORMAT-DERIVED for the node types: destructor_name and operator_name are declared in node_modules/tree-sitter-cpp/src/node-types.json, and a dump of this exact text shows them as the `declarator` child of function_declarator in-class, and as the `name` of a qualified_identifier out of class. The spelling (`~Widget`, `operator==`) is the one the ref extractor records for a call, quoted from the existing `~Foo` / `operator()` cases in tests/parser.test.ts. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cpp-dtor-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('C++ destructors and operators', () => {
  it('indexes them in-class and out-of-class with the owning class as parent', async () => {
    const source = [
      'class Widget {', // 1
      'public:', // 2
      '  ~Widget() {}', // 3
      '  Widget& operator=(const Widget& o) { return *this; }', // 4
      '  bool operator==(const Widget& o) const { return true; }', // 5
      '  int area() { return 4; }', // 6
      '};', // 7
      'Gadget::~Gadget() {}', // 8
      'bool Gadget::operator==(const Gadget& o) const { return true; }', // 9
      'Widget operator+(Widget a, Widget b);', // 10
      'void ns::Tool::run() {}', // 11
      'int& ref() { static int x; return x; }', // 12 (a reference return type nests the declarator without a field name)
      '',
    ].join('\n')
    const file = path.join(TMP, 'w.cpp')
    fs.writeFileSync(file, source)
    const result = await parseFile(file)
    expect(result.symbols.filter((s) => s.kind === 'function').map((s) => `${s.name}@${s.lineStart} parent=${s.parent}`)).toEqual([
      '~Widget@3 parent=Widget',
      'operator=@4 parent=Widget',
      'operator==@5 parent=Widget',
      'area@6 parent=Widget',
      '~Gadget@8 parent=Gadget',
      'operator==@9 parent=Gadget',
      'operator+@10 parent=',
      'run@11 parent=Tool',
      'ref@12 parent=',
    ])
  })
})
