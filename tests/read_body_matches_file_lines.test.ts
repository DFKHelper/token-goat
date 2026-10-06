/** Regression: a symbol read printed different bytes from an `@N-M` read of the same lines. Provenance: HAND-DERIVED. Each test writes its own source file and counts its line numbers by hand (1-based); the expected text is that file's own lines rejoined with `\n`, the shape an `@N-M` read prints. The real pipeline is driven: indexFileSync into the isolated DB, then runRead/runSymbol/runBriefCore. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runBriefCore } from '../src/read_brief.js'
import { resolveBody, runRead } from '../src/read_commands.js'
import { runSymbol } from '../src/read_symbol.js'

function withSource(name: string, text: string, fn: (file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tg-bodylines-'))
  try {
    const file = join(root, name)
    writeFileSync(file, text)
    indexFileSync(normalizePath(file))
    fn(file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('a symbol read prints the lines an @N-M read of its span prints', () => {
  // 1 export function crlfBodyA() { / 2   return 1; / 3 } / 4 (blank) / 5 export function crlfBodyB() { / 6   return 2; / 7 }, every line ending in CRLF.
  const CRLF_SOURCE = ['export function crlfBodyA() {', '  return 1;', '}', '', 'export function crlfBodyB() {', '  return 2;', '}', ''].join('\r\n')
  const CRLF_A = ['export function crlfBodyA() {', '  return 1;', '}'].join('\n')

  it('ends lines with LF on a CRLF file, as the range read does', () => {
    withSource('crlf_body.ts', CRLF_SOURCE, (file) => {
      const ranged = runRead({ spec: `${file}@1-3` })
      expect(ranged.text).toContain(CRLF_A)
      const read = runRead({ spec: `${file}::crlfBodyA` })
      expect(read.code).toBe(0)
      expect(read.text).toContain(CRLF_A)
      expect(read.text).not.toContain('\r')
      const json = JSON.parse(runRead({ spec: `${file}::crlfBodyA`, json: true }).text) as { body: string }
      expect(json.body).toBe(CRLF_A)
      expect(runSymbol({ name: 'crlfBodyA' }).text).not.toContain('\r')
      expect(runBriefCore({ spec: `${file}::crlfBodyA` }).text).not.toContain('\r')
    })
  })

  // 1 export class IndentWidget { / 2   name = "w"; / 3   @logged / 4   render(): string { / 5     return this.name; / 6   } / 7   static makeIndentWidget(): IndentWidget { / 8     return new IndentWidget(); / 9   } / 10 }
  const CLASS_SOURCE = ['export class IndentWidget {', '  name = "w";', '  @logged', '  render(): string {', '    return this.name;', '  }', '  static makeIndentWidget(): IndentWidget {', '    return new IndentWidget();', '  }', '}', ''].join('\n')
  const MAKE = ['  static makeIndentWidget(): IndentWidget {', '    return new IndentWidget();', '  }'].join('\n')
  const RENDER = ['  @logged', '  render(): string {', '    return this.name;', '  }'].join('\n')

  it('keeps a nested member\'s first-line indent, as the range read does', () => {
    withSource('indent_body.ts', CLASS_SOURCE, (file) => {
      expect(runRead({ spec: `${file}@7-9` }).text).toContain(MAKE)
      expect(runRead({ spec: `${file}::makeIndentWidget` }).text).toContain(MAKE)
      const json = JSON.parse(runRead({ spec: `${file}::makeIndentWidget`, json: true }).text) as { body: string }
      expect(json.body).toBe(MAKE)
      expect(runSymbol({ name: 'makeIndentWidget' }).text).toContain(MAKE)
      expect(runBriefCore({ spec: `${file}::makeIndentWidget` }).text).toContain(MAKE)
      // A decorated member's stored body starts at the decorator, which loses its indent the same way.
      expect(runRead({ spec: `${file}::render` }).text).toContain(RENDER)
    })
  })

  // 1 class IndentPy: / 2     def indent_py_method(self): / 3         return 1
  it('keeps a python method\'s first-line indent', () => {
    withSource('indent_body.py', ['class IndentPy:', '    def indent_py_method(self):', '        return 1', ''].join('\n'), (file) => {
      expect(runRead({ spec: `${file}::indent_py_method` }).text).toContain(['    def indent_py_method(self):', '        return 1'].join('\n'))
    })
  })

  it('keeps the stored text when the file no longer opens that line with it', () => {
    // runRead reindexes a stale file first, so the stale row is handed to resolveBody directly.
    withSource('indent_stale.ts', CLASS_SOURCE, (file) => {
      writeFileSync(file, ['export class IndentWidget {', '  name = "w";', '  rewritten = 1;', '  rewritten = 2;', '  rewritten = 3;', '  rewritten = 4;', '  other(): void {}', '}', ''].join('\n'))
      const stored = ['static makeIndentWidget(): IndentWidget {', '    return new IndentWidget();', '  }'].join('\n')
      expect(resolveBody({ body: stored, filePath: file, lineStart: 7, lineEnd: 9, kind: 'method' })).toBe(stored)
    })
  })

  it('leaves a top-level symbol flush left', () => {
    withSource('indent_top.ts', CLASS_SOURCE, (file) => {
      const json = JSON.parse(runRead({ spec: `${file}::IndentWidget`, json: true }).text) as { body: string }
      expect(json.body.split('\n')[0]).toBe('export class IndentWidget {')
    })
  })
})
