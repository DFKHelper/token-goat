/** `skeleton` printed the decorator or annotation line (`@dataclass`, `@Override`, `@Get(':id')`) in place of the declaration signature, because a symbol's stored body starts at its first decorator and firstBodyLine returned the first non-blank line. Fixture provenance: HAND-DERIVED. Every source below is written for this test in the decorator syntax of its language (PEP 318 for Python, TypeScript experimental decorators, JLS 9.7 annotations); each expected row is the declaration line read off that source by hand, not off what skeleton printed. The index is the real one: indexFileSync into the isolated test home, then runSkeleton, with no injected callback. The `search` symbol channel built its preview from the same body and showed `@property` the same way; those tests drive executeParallelSearch over the same real index. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSkeleton } from '../src/read_outline.js'
import { firstBodyLine } from '../src/read_suggest.js'
import { executeParallelSearch, symbolPreview } from '../src/search/parallel_search.js'

function skeletonOf(name: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-skel-deco-'))
  try {
    const file = join(root, name)
    writeFileSync(file, source)
    indexFileSync(normalizePath(file))
    const { text, code } = runSkeleton({ file })
    expect(code).toBe(0)
    return text
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('firstBodyLine skips leading decorators and annotations', () => {
  it.each([
    ['a plain body', 'function f() {\n  return 1\n}', 'function f() {'],
    ['leading blank lines', '\n\n  def g():\n    pass', '  def g():'],
    ['one decorator', '@dataclass\nclass Point:\n    x: int', 'class Point:'],
    ['stacked decorators', '@Post()\n@HttpCode(204)\ncreate(body: unknown): void {}', 'create(body: unknown): void {}'],
    ['a dotted decorator', '@functools.wraps(fn)\ndef wrapper(*a):\n    pass', 'def wrapper(*a):'],
    ['a multi-line argument list', '@Component({\n  selector: "app",\n  template: "<b>(x)</b>",\n})\nexport class AppComponent {}', 'export class AppComponent {}'],
    ['a parenthesis inside a string argument', "@Get('a)b')\nfind(): void {}", 'find(): void {}'],
    ['a decorator sharing the line with the signature', '@Input() name: string', 'name: string'],
    ['a Java annotation then the signature', '@Override\npublic String toString() {\n  return "";\n}', 'public String toString() {'],
    ['an annotation type declaration, which is the declaration itself', '@interface Marker {\n}', '@interface Marker {'],
    ['a body that is only decorators', '@only', '@only'],
  ])('%s', (_, body, expected) => {
    expect(firstBodyLine(body)).toBe(expected)
  })
})

describe('skeleton shows the signature of a decorated declaration (real index)', () => {
  it('TypeScript class and methods', () => {
    const out = skeletonOf(
      'ctrl.ts',
      ["@Controller('users')", 'export class UsersController {', "  @Get(':id')", '  findOne(id: string): string {', '    return id', '  }', '', '  @Post()', '  @HttpCode(204)', '  create(body: unknown): void {}', '}', ''].join('\n'),
    )
    expect(out).toContain('UsersController  export class UsersController {')
    expect(out).toContain('findOne  findOne(id: string): string {')
    expect(out).toContain('create  create(body: unknown): void {}')
    expect(out).not.toMatch(/@Controller|@Get|@Post|@HttpCode/)
  })

  it('Python functions, a class and a property', () => {
    const out = skeletonOf(
      'deco.py',
      ['import functools', 'from dataclasses import dataclass', '', '@dataclass', 'class Point:', '    x: int = 0', '', '    @property', '    def norm(self):', '        return self.x', '', '@retry(3)', 'async def fetch_data(url):', '    return url', ''].join('\n'),
    )
    expect(out).toContain('Point  class Point:')
    expect(out).toContain('norm  def norm(self):')
    expect(out).toContain('fetch_data  async def fetch_data(url):')
    expect(out).not.toMatch(/@dataclass|@property|@retry/)
  })

  it('Java annotated class and method', () => {
    const out = skeletonOf(
      'Outer.java',
      ['@Deprecated', 'public class Outer {', '  @Override', '  public String toString() {', '    return "o";', '  }', '}', ''].join('\n'),
    )
    expect(out).toContain('Outer  public class Outer {')
    expect(out).toContain('toString  public String toString() {')
    expect(out).not.toMatch(/@Deprecated|@Override/)
  })
})

describe('search previews a decorated symbol from its declaration (real index)', () => {
  afterEach(() => closeAllDbs())

  it('Python property and TypeScript method previews start at the signature', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-search-deco-')))
    try {
      writeFileSync(join(root, 'shape.py'), ['class Shape:', '    @property', '    @functools.cache', '    def area_of_shape(self):', '        return 1', ''].join('\n'))
      writeFileSync(join(root, 'ctl.ts'), ['export class Ctl {', "  @Get(':id')", '  findWidget(id: string): string {', '    return id', '  }', '}', ''].join('\n'))
      for (const f of ['shape.py', 'ctl.ts']) indexFileSync(normalizePath(join(root, f)), globalDbPath())
      const area = await executeParallelSearch({ query: 'area_of_shape', limit: 5, projectRoot: root, channels: ['symbol'] })
      expect(area.results.find((r) => r.name === 'area_of_shape')?.preview).toMatch(/^def area_of_shape\(self\):/)
      const widget = await executeParallelSearch({ query: 'findWidget', limit: 5, projectRoot: root, channels: ['symbol'] })
      expect(widget.results.find((r) => r.name === 'findWidget')?.preview).toMatch(/^findWidget\(id: string\): string \{/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a docstring wins', { name: 'f', docstring: 'Doc.', body: '@x\ndef f(): pass' }, 'Doc.'],
    ['no body', { name: 'f', docstring: null, body: null }, 'Symbol: f'],
    ['a body of only decorators keeps the body', { name: 'f', docstring: null, body: '@only' }, '@only'],
  ])('symbolPreview: %s', (_, sym, expected) => {
    expect(symbolPreview(sym)).toBe(expected)
  })
})
