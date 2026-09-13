/**
 * Unit tests for the COBOL and Natural regex adapters: fixed and free COBOL reference format, nested programs, Area A paragraphs, data items, copybooks, and Natural objects, inline subroutines, DEFINE DATA fields, line-numbered sources, and the refs and imports each emits. Strings and comments must produce nothing.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractCobol } from '../src/languages/cobol.js'
import { extractNatural } from '../src/languages/natural.js'
import { expectFast, LINE_50K } from './helpers/pathological_scan.js'
import { detectLanguage } from '../src/parser_types.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')

type Extracted = ReturnType<typeof extractCobol>

function shape(r: Extracted): string[] {
  return r.symbols.map((s) => `${s.kind} ${s.name} ${s.lineStart}-${s.lineEnd} ${s.parent}`.trimEnd())
}


describe('COBOL adapter', () => {
  it('reads a very large copybook instead of throwing out of the extractor', () => {
    // HAND-DERIVED: a copybook with no division header is a fragment, so the adapter takes the lowest level number it uses. That list holds one entry per data line and has no cap of its own, and spreading a list this size into Math.min exceeds the engine's argument limit -- which threw, so the file indexed to nothing at all rather than to fewer symbols.
    const lines: string[] = []
    for (let i = 0; i < 150_000; i++) lines.push(`       05 FIELD-${i} PIC X.`)
    const r = extractCobol(lines.join('\n'), 'BIG.cpy')
    expect(r.symbols.length).toBeGreaterThan(0)
  })

  it('scans a pathological 50 KB single line quickly', () => {
    // HAND-DERIVED: one very long declaration-shaped line that never terminates, the same backstop shape the other adapter suites use.
    expectFast(() => extractCobol(`       01 ${'A'.repeat(LINE_50K)}`, 'p.cbl'), 'cobol')
  })

  it('reads the fixed-format fixture: program, file description, records, paragraphs, with exact spans', () => {
    const r = extractCobol(fs.readFileSync(path.join(FIXTURES, 'Sample.cbl'), 'utf8'), 'Sample.CBL')
    expect(shape(r)).toEqual([
      'program PAYROLL 2-27',
      'file EMP-FILE 7-10 PAYROLL',
      'variable EMP-REC 8-10 EMP-FILE',
      'variable WS-TOTAL 12-12 PAYROLL',
      'variable WS-COUNT 13-13 PAYROLL',
      'paragraph MAIN-PARA 17-21 PAYROLL',
      'paragraph CALC-PARA 22-24 PAYROLL',
      'paragraph CALC-EXIT 25-26 PAYROLL',
    ])
    expect(r.refs.map((x) => `${x.name}@${x.line}`)).toEqual(['CALC-PARA@18', 'CALC-EXIT@18', 'TAXCALC@19'])
    expect(r.imports.map((i) => i.target)).toEqual(['PAYCONST'])
  })

  it('never reads a keyword inside a string literal as a reference', () => {
    const r = extractCobol(fs.readFileSync(path.join(FIXTURES, 'Sample.cbl'), 'utf8'), 'Sample.cbl')
    expect(r.refs.map((x) => x.name)).not.toContain('NOT-A-PARA')
  })

  it('skips comment, page-eject, debugging and Area B lines, and ignores the sequence area past column 72', () => {
    // HAND-DERIVED from the indicator-area rules at https://www.ibm.com/docs/en/cobol-zos/6.4.0?topic=format-indicator-area.
    const src = [
      '000100 PROCEDURE DIVISION.',
      '000200*BOGUS-COMMENT.',
      '000300/PAGE-EJECT.',
      '000400DDEBUG-PARA.',
      '000500 REAL-PARA.                                                       SEQ00001',
      '000600     NOT-AREA-A.',
      '000700     GO TO REAL-PARA.',
      '000800 EXIT-PARA.',
      '000900     EXIT.',
    ].join('\n')
    const r = extractCobol(src, 'rules.cbl')
    expect(shape(r)).toEqual(['paragraph REAL-PARA 5-7', 'paragraph EXIT-PARA 8-9'])
    expect(r.refs.map((x) => `${x.name}@${x.line}:${x.col}`)).toEqual(['REAL-PARA@7:11'])
  })

  it('reads free format in any case, nests a contained program under its parent, and never takes EXIT for a paragraph', () => {
    // HAND-DERIVED: ISO free-format directive and `*>` comments; END PROGRAM per https://www.ibm.com/docs/en/cobol-zos/6.4.0?topic=programs-conventions-program-names.
    const src = [
      '>>SOURCE FORMAT IS FREE',
      'identification division.',
      'program-id. outer.',
      'procedure division.',
      'main-para. *> the entry',
      '    perform inner-para 3 times',
      '    call "SUBPGM"',
      '    stop run.',
      'inner-para.',
      '    exit.',
      'identification division.',
      'program-id. inner.',
      'procedure division.',
      'only-para.',
      '    goback.',
      'end program inner.',
      'end program outer.',
    ].join('\n')
    const r = extractCobol(src, 'free.cob')
    expect(shape(r)).toEqual([
      'program outer 2-17',
      'paragraph main-para 5-8 outer',
      'paragraph inner-para 9-10 outer',
      'program inner 11-16 outer',
      'paragraph only-para 14-15 inner',
    ])
    expect(r.refs.map((x) => x.name)).toEqual(['inner-para', 'SUBPGM'])
  })

  it('reads a copybook with no division as record-level data items', () => {
    const r = extractCobol(['       01  CUST-REC.', '           05  CUST-ID  PIC 9(5).', '       01  CUST-ADDR.', '           05  STREET   PIC X(30).'].join('\n'), 'CUST.cpy')
    expect(shape(r)).toEqual(['variable CUST-REC 1-2', 'variable CUST-ADDR 3-4'])
  })

  it('maps every COBOL extension, in any case, to cobol', () => {
    for (const p of ['src/PAY.cbl', 'src/PAY.CBL', 'lib/X.cob', 'copy/CUST.cpy', 'a/B.COBOL']) expect(detectLanguage(p), p).toBe('cobol')
  })
})

describe('Natural adapter', () => {
  it('reads the fixture: the object, DEFINE DATA, level-1 fields and views, and an inline subroutine', () => {
    const r = extractNatural(fs.readFileSync(path.join(FIXTURES, 'Sample.nsp'), 'utf8'), 'lib/Sample.NSP')
    expect(shape(r)).toEqual([
      'program Sample 2-20',
      'data DEFINE DATA 2-9 Sample',
      'variable #COUNTER 5-5 Sample',
      'view EMP 6-8 Sample',
      'subroutine ADD-ONE 17-19 Sample',
    ])
    expect(r.refs.map((x) => x.name)).toEqual(['ADD-ONE', 'CALCSUB', 'REPORTP'])
    expect(r.imports.map((i) => i.target)).toEqual(['EMPLDA', 'COPYCC'])
  })

  it('strips four-digit line numbers and reads lowercase keywords', () => {
    const src = ['0010 * header', '0020 define data local', '0030 1 #x (a10)', '0040 end-define', '0050 perform sub-a', '0060 define subroutine sub-a', '0070   callnat "SUBN" #x', '0080 end-subroutine', '0090 end'].join('\n')
    const r = extractNatural(src, 'prog.nsp')
    expect(shape(r)).toEqual(['program prog 2-9', 'data DEFINE DATA 2-4 prog', 'variable #x 3-3 prog', 'subroutine sub-a 6-8 prog'])
    expect(r.refs.map((x) => `${x.name}@${x.line}:${x.col}`)).toEqual(['sub-a@5:5', 'SUBN@7:7'])
  })

  it('reads a local data area as its level-1 fields', () => {
    const r = extractNatural(['* LDA', '1 #A (A10)', '  2 #B (N5)', '1 #C (L)'].join('\n'), 'MYLDA.NSL')
    expect(shape(r)).toEqual(['data_area MYLDA 2-4', 'variable #A 2-3 MYLDA', 'variable #C 4-4 MYLDA'])
  })

  it('reads nothing out of comments or string literals', () => {
    const src = ['* PERFORM FAKE', '** DEFINE SUBROUTINE GHOST', "/* CALLNAT 'NOPE'", "WRITE 'PERFORM NOT-A-SUB' /* FETCH 'X'"].join('\n')
    const r = extractNatural(src, 'c.nsp')
    expect(r.refs).toEqual([])
    expect(shape(r)).toEqual(['program c 4-4'])
  })

  it('scans a pathological 50 KB single line quickly', () => {
    // HAND-DERIVED: one very long declaration-shaped line that never terminates, the same backstop shape the other adapter suites use.
    expectFast(() => extractNatural(`DEFINE SUBROUTINE ${'A'.repeat(LINE_50K)}`, 'p.nsp'), 'natural')
  })

  it('maps every Natural source extension, in any case, and leaves maps and DDMs unmapped', () => {
    for (const p of ['a.nsp', 'A.NSN', 'a.nss', 'a.nsa', 'a.nsl', 'a.nsg', 'a.nsc', 'a.nsh']) expect(detectLanguage(p), p).toBe('natural')
    for (const p of ['a.nsm', 'a.NSD']) expect(detectLanguage(p), p).toBe('unknown')
  })
})
