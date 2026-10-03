import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { indexFileSync } from '../src/parser.js'
import { closeDb } from '../src/db.js'
import { queryRefs } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'

// Provenance: HAND-DERIVED. Lines and expected scope names are computed from the fixture text. The node shapes (public_field_definition with `name`/`value` in tree-sitter-typescript, field_definition with `property`/`value` in tree-sitter-javascript, `pair` with `key`/`value` in both) are FORMAT-DERIVED from node_modules/tree-sitter-typescript/typescript/src/node-types.json and node_modules/tree-sitter-javascript/src/node-types.json. Every case indexes a real file through indexFileSync and asserts through queryRefs, the reader `refs --callers` renders from.
describe('refs scope: class-field arrows and object-literal function properties name their own scope', () => {
  let dir = ''
  let dbPath = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refscope-'))
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

  const contexts = (name: string): Array<[number, string]> =>
    queryRefs({ name }, dbPath).map((r) => [r.line, r.context] as [number, string])

  it('attributes calls inside a TSX class-field arrow and object-literal properties to that member', () => {
    index('comp.tsx', [
      'export class Panel extends React.Component {', // 1
      '  onToggle = () => {', // 2
      '    toggleState()', // 3
      '  }', // 4
      '  render() {', // 5
      '    return renderBody()', // 6
      '  }', // 7
      '}', // 8
      'export const handlers = {', // 9
      '  onSave: () => {', // 10
      '    persistDoc()', // 11
      '  },', // 12
      '  onLoad: function () {', // 13
      '    loadDoc()', // 14
      '  },', // 15
      "  'on-quote': () => {", // 16
      '    quoteCall()', // 17
      '  },', // 18
      '}', // 19
    ])
    expect(contexts('toggleState')).toEqual([[3, 'onToggle']])
    expect(contexts('renderBody')).toEqual([[6, 'render']])
    expect(contexts('persistDoc')).toEqual([[11, 'onSave']])
    expect(contexts('loadDoc')).toEqual([[14, 'onLoad']])
    expect(contexts('quoteCall')).toEqual([[17, 'on-quote']])
  })

  it('does the same for a TS class field with a typed arrow', () => {
    index('svc.ts', [
      'export class Widget {', // 1
      '  count = 0', // 2
      '  handleClick = (e: Event): void => {', // 3
      '    this.count++', // 4
      '    notifyClick(e)', // 5
      '  }', // 6
      '}', // 7
    ])
    expect(contexts('notifyClick')).toEqual([[5, 'handleClick']])
  })

  it('does the same for JS and JSX files (field_definition names the member on `property`)', () => {
    index('widget.js', [
      'export class Widget {', // 1
      '  handleClick = (e) => {', // 2
      '    notifyClick(e)', // 3
      '  }', // 4
      '}', // 5
      'export const cfg = {', // 6
      '  onSave: () => {', // 7
      '    persistDoc()', // 8
      '  },', // 9
      '}', // 10
    ])
    index('view.jsx', [
      'export class View {', // 1
      '  onToggle = () => {', // 2
      '    toggleState()', // 3
      '  }', // 4
      '}', // 5
    ])
    expect(contexts('notifyClick')).toEqual([[3, 'handleClick']])
    expect(contexts('persistDoc')).toEqual([[8, 'onSave']])
    expect(contexts('toggleState')).toEqual([[3, 'onToggle']])
  })

  it('leaves a data field and a non-function property in the enclosing scope', () => {
    index('data.ts', [
      'export class Holder {', // 1
      '  value = computeDefault()', // 2
      '  run() {', // 3
      '    const o = { n: pickNumber() }', // 4
      '    return o', // 5
      '  }', // 6
      '}', // 7
    ])
    expect(contexts('computeDefault')).toEqual([[2, 'Holder']])
    expect(contexts('pickNumber')).toEqual([[4, 'run']])
  })
})
