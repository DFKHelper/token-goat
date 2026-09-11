/**
 * Unit tests for the Assembly (GAS, NASM and IBM HLASM), Windows batch and Erlang adapters: every declaration form each one
 * reads, exact spans and parents, nothing out of a string or a comment, the imports each one emits, and the content routing
 * that decides when an `.asm` file is HLASM rather than NASM. Every adapter also gets a pathological 50 KB line that must
 * scan in under 100 ms.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractAsm, isHlasmSource } from '../src/languages/asm.js'
import { extractBatch } from '../src/languages/batch.js'
import { extractErlang } from '../src/languages/erlang.js'
import { parseFile } from '../src/parser.js'
import { detectLanguage, detectLanguageOfFile, type SymbolEntry } from '../src/parser_types.js'
import { extractImports } from '../src/read_commands.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

interface Result {
  readonly symbols: readonly SymbolEntry[]
  readonly imports: ReadonlyArray<{ readonly target: string }>
}

function shape(r: Result): string[] {
  return r.symbols.map((s) => `${s.kind} ${s.name} ${s.lineStart}-${s.lineEnd} ${s.parent}`.trimEnd())
}

function names(r: Result): string[] {
  return r.symbols.map((s) => s.name)
}

function imports(r: Result): string[] {
  return r.imports.map((i) => i.target)
}

/** The adapter must finish one pathological input in under 100 ms. */
function expectFast(run: () => unknown, label: string): void {
  run()
  const t0 = performance.now()
  run()
  expect(performance.now() - t0, label).toBeLessThan(100)
}

const LINE_50K = 50_000

describe('Assembly adapter, GAS', () => {
  it('reads labels, a macro, the label nested in it, and the .include import', () => {
    const r = extractAsm(fixture('Sample.s'), 'Sample.s')
    expect(shape(r)).toEqual([
      'label main 5-8',
      'label helper 9-12',
      'macro sum 13-16',
      'label inner_label 15-15 sum',
      'label msg 17-18',
    ])
    expect(imports(r)).toEqual(['defs.inc'])
  })

  it('takes no label out of a line comment, a string, or a local label', () => {
    const found = names(extractAsm(fixture('Sample.s'), 'Sample.s'))
    expect(found).not.toContain('not_a_label')
    expect(found).not.toContain('string_label')
    expect(found).not.toContain('.Lloop')
  })

  it('takes no label out of a block comment that runs over several lines', () => {
    const src = 'first:\n        nop\n/*\nhidden:\n*/\nsecond:\n        nop\n'
    expect(shape(extractAsm(src, 'a.s'))).toEqual(['label first 1-5', 'label second 6-7'])
  })
})

describe('Assembly adapter, NASM', () => {
  it('reads %macro, %imacro, a struc with its members, and the %include import', () => {
    const r = extractAsm(fixture('Sample.nasm'), 'Sample.nasm')
    expect(shape(r)).toEqual([
      'macro prologue 6-10',
      'macro Foo 12-14',
      'struct mytype 16-19',
      'label mt_long 17-17 mytype',
      'label mt_word 18-18 mytype',
      'label _start 21-26',
    ])
    expect(imports(r)).toEqual(['macros.mac'])
  })

  it('takes nothing from a directive that has no colon, such as section or global', () => {
    const found = names(extractAsm(fixture('Sample.nasm'), 'Sample.nasm'))
    expect(found).not.toContain('section')
    expect(found).not.toContain('global')
    expect(found).not.toContain('comment_label')
  })
})

describe('Assembly adapter, IBM HLASM', () => {
  it('tells an HLASM file apart from a NASM one by content', () => {
    expect(isHlasmSource(fixture('Sample_hlasm.asm'))).toBe(true)
    expect(isHlasmSource(fixture('Sample.nasm'))).toBe(false)
    expect(isHlasmSource(fixture('Sample.s'))).toBe(false)
  })

  it('reads control sections and a macro named by its prototype statement', () => {
    const r = extractAsm(fixture('Sample_hlasm.asm'), 'Sample.asm')
    expect(shape(r)).toEqual([
      'macro SAVEREGS 9-12',
      'section MAIN 13-15',
      'section SUBRTN 16-17',
      'dummy section MYDATA 18-20',
    ])
  })

  it('takes nothing from a comment statement, which carries an asterisk in the begin column', () => {
    // The name field of the comment statement holds a section operation, so a reader that missed the asterisk would open it.
    const src = '*FAKE    CSECT\nMAIN     CSECT\n         END\n'
    expect(shape(extractAsm(src, 'x.asm'))).toEqual(['section MAIN 2-3'])
  })

  it('ignores what sits past the end column and skips the line a continuation carries over', () => {
    const continued = 'HELLO    DC    C\'X\''.padEnd(71, ' ') + 'X'
    const src = ['MAIN     CSECT', continued, 'FAKE     CSECT', '         END'].join('\n')
    expect(shape(extractAsm(src, 'x.asm'))).toEqual(['section MAIN 1-4'])
  })
})

describe('Windows batch adapter', () => {
  it('reads label blocks and the batch files a call runs', () => {
    const r = extractBatch(fixture('Sample.bat'), 'Sample.bat')
    expect(shape(r)).toEqual(['label start 6-11', 'label end 12-13'])
    expect(imports(r)).toEqual(['helper.bat', 'C:\\tools\\deploy.cmd'])
  })

  it('takes nothing from a :: comment line or a rem line, not even the call each one names', () => {
    const r = extractBatch(fixture('Sample.bat'), 'Sample.bat')
    expect(names(r)).toEqual(['start', 'end'])
    expect(imports(r)).not.toContain('legacy.bat')
    expect(imports(r)).not.toContain('old_deploy.cmd')
  })

  it('ends a label block at the line before the next label', () => {
    const r = extractBatch(':one\r\necho hi\r\n:two\r\necho bye\r\n', 'a.cmd')
    expect(shape(r)).toEqual(['label one 1-2', 'label two 3-4'])
  })
})

describe('Erlang adapter', () => {
  it('reads the module, functions with every clause, records, macros and types, and the include and import attributes', () => {
    const r = extractErlang(fixture('Sample.erl'), 'Sample.erl')
    expect(shape(r)).toEqual([
      'module sample 2-2',
      'macro MAX_TRIES 8-8',
      'record point 9-9',
      'type shape 10-10',
      'function fact 13-17',
      'function area 19-22',
      'function quoted 24-28',
    ])
    expect(imports(r)).toEqual(['sample.hrl', 'kernel/include/file.hrl', 'lists'])
  })

  it('does not end a form on a period inside a comment, a string, a quoted atom, a character literal or a float', () => {
    expect(names(extractErlang(fixture('Sample.erl'), 'Sample.erl'))).not.toContain('ok')
    const r = extractErlang('f() ->\n    X = 1.5,\n    "a. b",\n    \'c. d\',\n    $.,\n    X.\ng() -> ok.\n', 'a.erl')
    expect(shape(r)).toEqual(['function f 1-6', 'function g 7-7'])
  })

  it('takes no symbol out of an -export attribute or a comment', () => {
    const found = names(extractErlang(fixture('Sample.erl'), 'Sample.erl'))
    expect(found).not.toContain('export')
    expect(found).not.toContain('reverse')
  })
})

describe('the batch D adapters scan a pathological line fast', () => {
  it('scans a 50 KB assembly line', () => {
    expectFast(() => extractAsm(`${'a'.repeat(LINE_50K)}:\n`, 'big.s'), 'GAS label')
    expectFast(() => extractAsm(`${' '.repeat(LINE_50K)}.macro x\n`, 'big.s'), 'GAS macro')
    expectFast(() => extractAsm(`MAIN     CSECT\n${'A'.repeat(LINE_50K)}     DS    CL8\n`, 'big.asm'), 'HLASM statement')
  })

  it('scans a 50 KB batch line', () => {
    expectFast(() => extractBatch(`:${'a'.repeat(LINE_50K)}\n`, 'big.bat'), 'batch label')
    expectFast(() => extractBatch(`call ${'a'.repeat(LINE_50K)}.bat\n`, 'big.bat'), 'batch call')
  })

  it('scans a 50 KB Erlang line', () => {
    expectFast(() => extractErlang(`f() -> "${'a'.repeat(LINE_50K)}".\n`, 'big.erl'), 'Erlang string')
    expectFast(() => extractErlang(`%${'a'.repeat(LINE_50K)}\ng() -> ok.\n`, 'big.erl'), 'Erlang comment')
  })
})

describe('language detection and collision routing through the real entry points', () => {
  const dirs: string[] = []

  function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-label-'))
    dirs.push(dir)
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return file
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('maps every batch D extension to its language', () => {
    const cases: Array<[string, string]> = [
      ['a.s', 'asm'],
      ['a.S', 'asm'],
      ['a.asm', 'asm'],
      ['a.nasm', 'asm'],
      ['a.bat', 'batch'],
      ['a.cmd', 'batch'],
      ['a.erl', 'erlang'],
      ['a.hrl', 'erlang'],
    ]
    for (const [basename, language] of cases) expect(detectLanguage(basename), basename).toBe(language)
  })

  it('indexes an HLASM .asm and a NASM .asm through parseFile, each read as its own dialect', async () => {
    const hlasm = tmpFile('LEGACY.asm', fixture('Sample_hlasm.asm'))
    expect(detectLanguageOfFile(hlasm)).toBe('asm')
    const legacy = await parseFile(hlasm)
    expect(legacy.symbols.map((s) => s.name)).toContain('MAIN')
    expect(legacy.symbols.map((s) => s.name)).not.toContain('prologue')

    const nasm = tmpFile('boot.asm', fixture('Sample.nasm'))
    expect(detectLanguageOfFile(nasm)).toBe('asm')
    const boot = await parseFile(nasm)
    expect(boot.symbols.map((s) => s.name)).toContain('prologue')
    expect(boot.symbols.map((s) => s.name)).not.toContain('MAIN')
  })

  it('indexes a batch file and an Erlang header through parseFile', async () => {
    const bat = await parseFile(tmpFile('deploy.cmd', fixture('Sample.bat')))
    expect(bat.symbols.map((s) => s.name)).toEqual(['start', 'end'])
    const hrl = await parseFile(tmpFile('sample.hrl', fixture('Sample.erl')))
    expect(hrl.symbols.map((s) => s.name)).toContain('point')
  })

  it('lists the imports of each batch D extension through extractImports', () => {
    expect(extractImports(fixture('Sample.s'), '.s')).toEqual(['defs.inc'])
    expect(extractImports(fixture('Sample.nasm'), '.nasm')).toEqual(['macros.mac'])
    expect(extractImports(fixture('Sample.bat'), '.bat')).toEqual(['helper.bat', 'C:\\tools\\deploy.cmd'])
    expect(extractImports(fixture('Sample.erl'), '.erl')).toEqual(['sample.hrl', 'kernel/include/file.hrl', 'lists'])
  })
})
