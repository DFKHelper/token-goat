/** Regression: a C/C++ struct/class/union/enum specifier was indexed as a definition wherever it appeared. `struct list *next;`, a `struct list *head` parameter, `class Engine;` and `enum class Mode : int;` each became a symbol, so one real struct produced a dozen same-named rows and `read list.c::list` was ambiguous. Provenance: HAND-DERIVED. Sources are written here and the expected rows (name, kind, line) are counted by hand from them; the node shapes (a definition carries a `body` field of field_declaration_list/enumerator_list, a use or forward declaration does not) are FORMAT-DERIVED from node_modules/tree-sitter-c/src/node-types.json and node_modules/tree-sitter-cpp/src/node-types.json, whose struct/class/union/enum specifiers all declare a `body` field. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-c-tags-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function rows(name: string, source: string, kinds: readonly string[]): Promise<string[]> {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, source)
  const result = await parseFile(file)
  return result.symbols.filter((s) => kinds.includes(s.kind)).map((s) => `${s.kind} ${s.name}@${s.lineStart}`)
}

describe('C/C++ tag specifiers index only definitions', () => {
  it('indexes a C struct once, not once per use or parameter', async () => {
    const source = [
      'struct list { int v; struct list *next; };', // 1
      '',
      'void push(struct list *head) { struct list *cur = head; }', // 3
      'int len(const struct list *l);', // 4
      'enum color { RED };', // 5
      'enum color pick(enum color c);', // 6
      'union u { int a; };', // 7
      'union u *mk(void);', // 8
      'typedef struct { int x; } Anon;', // 9
      '',
    ].join('\n')
    expect(await rows('list.c', source, ['struct', 'enum', 'union', 'type'])).toEqual(['struct list@1', 'enum color@5', 'union u@7', 'type Anon@9'])
  })

  it('skips C++ forward declarations and opaque enums but keeps the definitions', async () => {
    const source = [
      'class Engine;', // 1
      'class Car { Engine *e; };', // 2
      'struct Opaque;', // 3
      'enum class Mode : int;', // 4
      'enum class Real : int { A };', // 5
      'void run(Car *c, struct Opaque *o);', // 6
      '',
    ].join('\n')
    expect(await rows('e.cpp', source, ['struct', 'class', 'enum'])).toEqual(['class Car@2', 'enum Real@5'])
  })
})
