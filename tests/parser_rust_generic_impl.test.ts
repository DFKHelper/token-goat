/** Regression: a Rust `impl<T> Wrapper<T>` block was named `Wrapper<T>`, so `read c.rs::Wrapper.get` and refs never matched it. Provenance: HAND-DERIVED for the expected names (the type's bare identifier, read off the source below) and FORMAT-DERIVED for the node shape: impl_item's `type` field can be generic_type, scoped_type_identifier or reference_type per node_modules/tree-sitter-rust/src/node-types.json. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rust-impl-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('Rust impl block names', () => {
  it('drops generic arguments, paths and references from the impl name', async () => {
    const file = path.join(TMP, 'c.rs')
    fs.writeFileSync(
      file,
      [
        'pub struct Wrapper<T> { v: T }',
        'impl<T: Clone> Wrapper<T> {',
        '    pub fn get(&self) -> T { self.v.clone() }',
        '}',
        'impl<T> Tr for Wrapper<T> { fn z(&self) {} }',
        'impl foo::Bar { fn q(&self) {} }',
        'impl Tr for &Foo { fn w(&self) {} }',
        '',
      ].join('\n'),
    )
    const names = (await parseFile(file)).symbols.map((s) => s.name)
    expect(names.filter((n) => n.startsWith('Wrapper'))).toEqual(['Wrapper', 'Wrapper', 'Wrapper'])
    expect(names).toContain('Bar')
    expect(names).toContain('Foo')
    expect(names.some((n) => n.includes('<') || n.includes('&') || n.includes('::'))).toBe(false)
  })
})
