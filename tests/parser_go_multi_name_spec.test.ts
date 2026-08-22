/**
 * Regression: a Go declaration that names several things at once indexed only the first name.
 *
 * `var alphaVar, betaVar = 1, 2` and `const epsilonC, zetaC = 3, 4` are one `var_spec` /
 * `const_spec` node each, and tree-sitter-go repeats the `name` field on that node.
 * `extractGoSymbols` called `nodeName`, which is `childForFieldName('name')` and returns only the
 * first match, so `betaVar` and `zetaC` were absent from the index entirely: `symbol betaVar`
 * found nothing and `read "file::betaVar"` could not serve a package-level variable that plainly
 * exists in the file.
 *
 * Why didn't a test catch this: the Go fixtures in the suite declare one name per line, which is
 * the common style, and the grouped form (`var ( a int \n b string )`) already worked -- each spec
 * there holds a single name, so the grouped-block test passed while proving nothing about a
 * multi-name spec. The bug lives in the gap between those two shapes, and a `toContain` assertion
 * on the first name is green either way. What catches it is asserting the whole name set.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-go-spec-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

const SOURCE = [
  'package main',
  '',
  'var alphaVar, betaVar = 1, 2',
  '',
  'var gammaVar, deltaVar int',
  '',
  'const epsilonC, zetaC = 3, 4',
  '',
  'var _, keptVar = split()',
  '',
  'var (',
  '\tgroupedA int',
  '\tgroupedB string',
  ')',
  '',
  'func split() (int, int) { return 1, 2 }',
  '',
  'func localsStayOut() {',
  '\tvar localA, localB = 1, 2',
  '\t_ = localA',
  '\t_ = localB',
  '}',
  '',
].join('\n')

describe('Go declarations that name several things at once', () => {
  it('indexes every name on the spec, not just the first', async () => {
    const result = await parseFile(write('a.go', SOURCE))
    expect(
      result.symbols.map((s) => s.name).sort(),
      'a name after the first on a var/const spec was dropped from the index',
    ).toEqual([
      'alphaVar',
      'betaVar',
      'deltaVar',
      'epsilonC',
      'gammaVar',
      'groupedA',
      'groupedB',
      'keptVar',
      'localsStayOut',
      'split',
      'zetaC',
    ])
  })

  it('gives the later names the same kind as the first', async () => {
    const result = await parseFile(write('b.go', SOURCE))
    const kindOf = (n: string): string | undefined => result.symbols.find((s) => s.name === n)?.kind
    expect(kindOf('betaVar')).toBe('variable')
    expect(kindOf('deltaVar')).toBe('variable')
    expect(kindOf('zetaC'), 'a const declared second was not indexed as a const').toBe('const')
  })

  it('keeps a function-local multi-name declaration out of the index', async () => {
    const result = await parseFile(write('c.go', SOURCE))
    const names = result.symbols.map((s) => s.name)
    // The scope gate runs before the per-name loop, so both locals must stay out -- not just the
    // first one, which is all the pre-fix code could ever have emitted.
    expect(names).not.toContain('localA')
    expect(names).not.toContain('localB')
  })

  it('does not index the blank identifier', async () => {
    const result = await parseFile(write('d.go', SOURCE))
    expect(result.symbols.map((s) => s.name), 'the blank identifier became a symbol').not.toContain(
      '_',
    )
  })

  it('cites the declaration line for a name that is not the first', async () => {
    const result = await parseFile(write('e.go', SOURCE))
    const beta = result.symbols.find((s) => s.name === 'betaVar')
    expect(beta?.lineStart).toBe(3)
    expect(result.symbols.find((s) => s.name === 'zetaC')?.lineStart).toBe(7)
  })
})
