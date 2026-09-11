/**
 * Unit tests for the ABAP, SAS, PL/I, RPG, JCL and OpenEdge ABL adapters: every declaration form each reads, exact spans and parents, nothing out of strings, comments or in-stream data, the imports each emits, and the content routing that decides when a `.p`, `.w` or `.cls` is ABL. Every adapter also gets a pathological 50 KB line that must scan in under 100 ms.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractAbap } from '../src/languages/abap.js'
import { extractAbl, isAblSource } from '../src/languages/abl.js'
import { extractApex } from '../src/languages/apex.js'
import { extractJcl } from '../src/languages/jcl.js'
import { extractPli } from '../src/languages/pli.js'
import { extractRpg } from '../src/languages/rpg.js'
import { extractSas } from '../src/languages/sas.js'
import type { StatementAdapterResult } from '../src/languages/span_collector.js'
import { parseFile } from '../src/parser.js'
import { detectLanguage, detectLanguageOfFile, refineLanguageByContent } from '../src/parser_types.js'
import { extractImports } from '../src/read_commands.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')
const APEX_FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'salesforce-dx', 'force-app', 'main', 'default', 'classes', 'SafeNavigationService.cls')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

function shape(r: StatementAdapterResult): string[] {
  return r.symbols.map((s) => `${s.kind} ${s.name} ${s.lineStart}-${s.lineEnd} ${s.parent ?? ''}`.trimEnd())
}

function imports(r: StatementAdapterResult): string[] {
  return r.imports.map((i) => i.target)
}

/** Median-free worst case: the adapter must finish one pathological input in under 100 ms. */
function expectFast(run: () => unknown, label: string): void {
  run()
  const t0 = performance.now()
  run()
  expect(performance.now() - t0, label).toBeLessThan(100)
}

const LINE_50K = 50_000

describe('ABAP adapter', () => {
  it('reads the fixture: program, class definition and implementation, method under its class, form, and the INCLUDE', () => {
    const r = extractAbap(fixture('Sample.abap'), 'Sample.abap')
    expect(shape(r)).toEqual(['program zdemo_sales 2-16', 'class lcl_order 5-8', 'implementation lcl_order 9-13', 'method total 10-12 lcl_order', 'form print_line 14-16'])
    expect(imports(r)).toEqual(['zdemo_top'])
  })

  it('reads every block form in any case, skips DEFERRED and LOCAL FRIENDS, and reads nothing inside a macro', () => {
    // FORMAT-DERIVED: https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapfunction.htm , https://help.sap.com/doc/abapdocu_753_index_htm/7.53/en-US/abapinterface_definition.htm , https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapmodule.htm , https://help.sap.com/doc/abapdocu_751_index_htm/7.51/en-us/abapclass_deferred.htm (the LOCAL FRIENDS form is on the same page).
    const src = [
      'report zlow.',
      'class lcl_a definition.',
      'endclass.',
      'Class lcl_a Implementation.',
      '  Method run.',
      '  EndMethod.',
      'endclass.',
      'interface lif_x.',
      'endinterface.',
      'function z_func.',
      'endfunction.',
      'module status_0100 output.',
      'endmodule.',
      'define mac.',
      '  form fake.',
      'end-of-definition.',
      'class lcl_b definition local friends lcl_a.',
      'interface lif_y deferred.',
      'include structure zs_line.',
    ].join('\n')
    const r = extractAbap(src, 'zlow.abap')
    expect(shape(r)).toEqual([
      'program zlow 1-19',
      'class lcl_a 2-3',
      'implementation lcl_a 4-7',
      'method run 5-6 lcl_a',
      'interface lif_x 8-9',
      'function z_func 10-11',
      'module status_0100 12-13',
      'macro mac 14-16',
    ])
    expect(imports(r)).toEqual([])
  })

  it('reads nothing out of star comments, quote comments or literals, and splits chained statements', () => {
    // FORMAT-DERIVED: comment forms per https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/abencomments_guidl.htm ; FORM per https://help.sap.com/doc/abapdocu_751_index_htm/7.51/en-us/abapform.htm
    const src = ['* FORM ghost.', 'WRITE: `FORM tmpl.`, |FORM { x } str.|. " FORM c.', 'FORM real.', 'ENDFORM.'].join('\n')
    expect(shape(extractAbap(src, 'c.abap'))).toEqual(['form real 3-4'])
  })

  it('scans a pathological 50 KB line in under 100 ms', () => {
    for (const line of ['CLASS '.repeat(LINE_50K / 6), "'".repeat(LINE_50K), 'a:'.repeat(LINE_50K / 2), 'x'.repeat(LINE_50K)]) {
      expectFast(() => extractAbap(line, 'p.abap'), 'abap')
    }
  })
})

describe('SAS adapter', () => {
  it('reads the fixture: a macro, the data step inside it, a later step, and the %include, but no comment, _null_ or datalines text', () => {
    const r = extractSas(fixture('Sample.sas'), 'Sample.sas')
    expect(shape(r)).toEqual(['macro report 4-12', 'data_step work.summary 6-9 report', 'data_step sales 16-22'])
    expect(imports(r)).toEqual(['setup.sas'])
  })

  it('nests macros in any case and ends a data step at the next PROC', () => {
    // FORMAT-DERIVED: https://support.sas.com/documentation/cdl/en/mcrolref/61885/HTML/default/macro-stmt.htm , DATA https://support.sas.com/documentation/cdl/en/lrdict/64316/HTML/default/a000188132.htm
    const src = ['%MACRO outer;', '  %Macro inner;', '    Data a;', '      x = 1;', '    run;', '  %mend inner;', '%MEND outer;', 'data b; set a;', 'proc sort data=b; run;', 'DATA c;', '  y = 2;'].join('\n')
    expect(shape(extractSas(src, 'm.sas'))).toEqual(['macro outer 1-7', 'macro inner 2-6 outer', 'data_step a 3-5 inner', 'data_step b 8-8', 'data_step c 10-11'])
  })

  it('scans a pathological 50 KB line in under 100 ms', () => {
    for (const line of ['data '.repeat(LINE_50K / 5), '/*'.repeat(LINE_50K / 2), "'".repeat(LINE_50K), '%macro '.repeat(LINE_50K / 7)]) {
      expectFast(() => extractSas(line, 'p.sas'), 'sas')
    }
  })
})

describe('PL/I adapter', () => {
  it('reads the fixture: package, main procedure, nested procedure, and the %INCLUDE, with END label closing its own block', () => {
    const r = extractPli(fixture('Sample.pli'), 'Sample.pli')
    expect(shape(r)).toEqual(['package Payroll 3-20', 'procedure Main 4-19 Payroll', 'procedure Report 13-18 Main'])
    expect(imports(r)).toEqual(['PAYDCL'])
  })

  it('tracks ELSE DO, WHEN DO, SELECT and ON BEGIN blocks in any case, and never emits a %PROCEDURE', () => {
    // FORMAT-DERIVED: https://www.ibm.com/docs/en/epfz/6.2.0?topic=procedures-procedure-statement , https://www.ibm.com/docs/en/epfz/6.2.0?topic=groups-do-statement , https://www.ibm.com/docs/en/epfz/6.2.0?topic=blocks-begin-blocks , https://www.ibm.com/docs/en/epfz/6.2.0?topic=statements-end-statement
    const src = [
      ' p: proc options(main);',
      '   if x then y = 1; else do;',
      '     z = 2;',
      '   end;',
      '   select (x);',
      '     when (1) do;',
      '       z = 3;',
      '     end;',
      '     otherwise;',
      '   end;',
      '   on error begin;',
      "     put list('e');",
      '   end;',
      '   %m: procedure;',
      '   %end;',
      '   Q: Procedure;',
      '   End Q;',
      ' end p;',
    ].join('\n')
    expect(shape(extractPli(src, 'b.pli'))).toEqual(['procedure p 1-18', 'procedure Q 16-17 p'])
  })

  it('drops a numeric sequence field in columns 73-80', () => {
    // FORMAT-DERIVED: margins and sequence numbers per https://www.ibm.com/docs/en/epfz/6.2.0?topic=procedures-procedure-statement (source in columns 2-72).
    const seq = (text: string, n: number): string => text.padEnd(72) + String(n).padStart(8, '0')
    const src = [seq(' A: PROC;', 10), seq('   CALL B;', 20), seq(' END A;', 30), seq(' B: PROC;', 40), seq(' END B;', 50)].join('\n')
    expect(shape(extractPli(src, 's.pl1'))).toEqual(['procedure A 1-3', 'procedure B 4-5'])
  })

  it('scans a pathological 50 KB line in under 100 ms', () => {
    for (const line of ['a: '.repeat(LINE_50K / 3), 'DO '.repeat(LINE_50K / 3), '/*'.repeat(LINE_50K / 2), 'x'.repeat(LINE_50K)]) {
      expectFast(() => extractPli(line, 'p.pli'), 'pli')
    }
  })
})

describe('RPG adapter', () => {
  it('reads the **FREE fixture: constant, variable, data structure, prototype, procedure, subroutine, and the /COPY', () => {
    const r = extractRpg(fixture('Sample.rpgle'), 'Sample.rpgle')
    expect(shape(r)).toEqual([
      'constant MAX_ROWS 4-4',
      'variable counter 5-5',
      'data_structure custRec 6-9',
      'prototype getName 10-12',
      'procedure getName 13-23',
      'subroutine loadName 20-22 getName',
    ])
    expect(imports(r)).toEqual(['QRPGLESRC,CUSTPR'])
  })

  it('reads fixed-form P and C specs by column, skipping column-7 comments', () => {
    // FORMAT-DERIVED: P spec name in positions 7-21 and B/E in position 24 per https://www.ibm.com/docs/ssw_ibm_i_72/rzasd/p24.htm ; C spec BEGSR and ENDSR per https://www.ibm.com/docs/en/i/7.4.0?topic=codes-endsr-end-subroutine
    const spec = (...fields: Array<[number, string]>): string => {
      let line = ''
      for (const [pos, text] of fields) line = line.padEnd(pos - 1) + text
      return line
    }
    const src = [
      spec([6, 'P'], [7, 'addOne'], [24, 'B'], [44, 'EXPORT']),
      spec([6, 'D'], [7, 'addOne'], [24, 'PI']),
      spec([6, 'C'], [7, '*'], [12, 'ghost'], [26, 'BEGSR']),
      spec([6, 'C'], [12, 'inner'], [26, 'BEGSR']),
      spec([6, 'C'], [26, 'ENDSR']),
      spec([6, 'P'], [7, 'addOne'], [24, 'E']),
    ].join('\n')
    expect(shape(extractRpg(src, 'fixed.rpgle'))).toEqual(['procedure addOne 1-6', 'subroutine inner 4-5 addOne'])
  })

  it('reads column-limited free form in mixed case and ignores text past column 80', () => {
    // FORMAT-DERIVED: free-form statements in columns 8-80 without **FREE per https://www.ibm.com/docs/en/i/7.3.0?topic=specifications-free-form-definition-statement ; DCL-PROC per https://www.ibm.com/support/knowledgecenter/ssw_ibm_i_73/rzasd/freeprocdef.htm
    const src = ['       Dcl-Proc helper;', '         DCL-S n int(10);'.padEnd(80) + 'dcl-c GHOST 1;', '       End-Proc;'].join('\n')
    expect(shape(extractRpg(src, 'col.sqlrpgle'))).toEqual(['procedure helper 1-3'])
  })

  it('scans a pathological 50 KB line in under 100 ms', () => {
    for (const line of ['**FREE\n' + 'dcl-s '.repeat(LINE_50K / 6), '**FREE\n' + "'".repeat(LINE_50K), 'x'.repeat(LINE_50K), '**FREE\n' + '//'.repeat(LINE_50K / 2)]) {
      expectFast(() => extractRpg(line, 'p.rpgle'), 'rpg')
    }
  })
})

describe('JCL adapter', () => {
  it('reads the fixture: job, in-stream procedure, steps under each, and the INCLUDE, but nothing inside DD DATA', () => {
    const r = extractJcl(fixture('Sample.jcl'), 'Sample.jcl')
    expect(shape(r)).toEqual(['job PAYJOB 2-13', 'procedure CARDS 3-6 PAYJOB', 'step PSTEP 4-6 CARDS', 'step STEP1 8-11 PAYJOB', 'step STEP2 12-13 PAYJOB'])
    expect(imports(r)).toEqual(['SYSOUT2'])
  })

  it('ends DD * data at the next // statement and DLM data only at its delimiter', () => {
    // FORMAT-DERIVED: https://www.ibm.com/docs/en/zos/2.1.0?topic=files-in-stream-data-sets
    const src = ['//J1       JOB 1', '//S1       EXEC PGM=A', '//IN       DD *', 'S9 EXEC PGM=X', '//S2       EXEC PGM=B', '//IN2      DD *,DLM=$$', '//FAKE     EXEC PGM=C', '$$', '//S3       EXEC PGM=D'].join('\n')
    expect(shape(extractJcl(src, 'd.jcl'))).toEqual(['job J1 1-9', 'step S1 2-4 J1', 'step S2 5-8 J1', 'step S3 9-9 J1'])
  })

  it('skips //* comments and ignores columns past 72', () => {
    // FORMAT-DERIVED: https://www.ibm.com/docs/SSLTBW_2.2.0/com.ibm.zos.v2r2.ieab600/iea3b6_JCL_statement_fields.htm
    const src = ['//J2       JOB 1', '//*GHOST   EXEC PGM=X', '//S1       EXEC PGM=A'.padEnd(72) + 'X'].join('\n')
    expect(shape(extractJcl(src, 'c.jcl'))).toEqual(['job J2 1-3', 'step S1 3-3 J2'])
  })

  it('scans a pathological 50 KB line in under 100 ms', () => {
    for (const line of ['//' + ' '.repeat(LINE_50K), '//A ' + 'DD '.repeat(LINE_50K / 3), '//'.repeat(LINE_50K / 2)]) {
      expectFast(() => extractJcl(line, 'p.jcl'), 'jcl')
    }
  })
})

describe('OpenEdge ABL adapter', () => {
  it('reads the .p fixture: temp-table, procedure, function, and the include, but not the FORWARD declaration or string text', () => {
    const r = extractAbl(fixture('Sample.p'), 'Sample.p')
    expect(shape(r)).toEqual(['temp_table ttOrder 4-5', 'procedure calcTotal 8-13', 'function addTax 14-17'])
    expect(imports(r)).toEqual(['inc/common.i'])
  })

  // FORMAT-DERIVED: CLASS https://documentation.progress.com/output/ua/OpenEdge_latest/abl/class-statement.html , CONSTRUCTOR https://documentation.progress.com/output/ua/OpenEdge_latest/abl/constructor-statement.html , METHOD https://documentation.progress.com/output/ua/OpenEdge_latest/abl/method-statement.html , USING https://documentation.progress.com/output/ua/OpenEdge_latest/abl/using-statement.html
  const ABL_CLASS = [
    'USING Progress.Lang.*.',
    'BLOCK-LEVEL ON ERROR UNDO, THROW.',
    'CLASS acme.inventory.Item INHERITS acme.Base:',
    '  DEFINE PRIVATE TEMP-TABLE ttLine NO-UNDO FIELD LineNum AS INTEGER.',
    '  CONSTRUCTOR PUBLIC Item ():',
    '    SUPER().',
    '  END CONSTRUCTOR.',
    '  METHOD PUBLIC INTEGER Count (INPUT pMax AS INTEGER):',
    '    DEFINE VARIABLE i AS INTEGER NO-UNDO.',
    '    blk: DO WHILE TRUE:',
    '      LEAVE blk.',
    '    END.',
    '  END METHOD.',
    'END CLASS.',
  ].join('\n')

  it('reads a class with its temp-table, constructor and method as children, through labeled blocks', () => {
    const r = extractAbl(ABL_CLASS, 'acme/inventory/Item.cls')
    expect(shape(r)).toEqual(['class Item 3-14', 'temp_table ttLine 4-4 Item', 'constructor Item 5-7 Item', 'method Count 8-13 Item'])
    expect(imports(r)).toEqual(['Progress.Lang.*'])
  })

  it('reads an interface with an abstract method, and keywords in any case', () => {
    // FORMAT-DERIVED: INTERFACE https://documentation.progress.com/output/ua/OpenEdge_latest/pdsoe/PLUGINS_ROOT/com.openedge.pdt.langref.help/rfi1424920298704.html , PROCEDURE https://documentation.progress.com/output/ua/OpenEdge_latest/pdsoe/PLUGINS_ROOT/com.openedge.pdt.langref.help/rfi1424920170673.html
    expect(shape(extractAbl(['Interface acme.IShape:', '  method public decimal Area ().', 'End Interface.'].join('\n'), 'IShape.cls'))).toEqual([
      'interface IShape 1-3',
      'method Area 2-2 IShape',
    ])
    expect(shape(extractAbl(['proce doIt:', '  do i = 1 to 3:', '  end.', 'end procedure.'].join('\n'), 'x.p'))).toEqual(['procedure doIt 1-4'])
  })

  it('treats a .p or .w as ABL only on an ABL marker, and a .cls as ABL only after the VB6 check', () => {
    // CAPTURE: lines 1-3 and the include line are verbatim from https://github.com/progress/ADE/blob/a4c50786c109169991ff633eec633f3b1da1adbe/workshop/_timeout.w
    const webObject = ['&ANALYZE-SUSPEND _VERSION-NUMBER WDT_v2r1 WebSpeed-Object', '&ANALYZE-RESUME', '&ANALYZE-SUSPEND _CODE-BLOCK _CUSTOM Definitions', '{ webutil/wstyle.i }', 'PROCEDURE outputHeader:', 'END PROCEDURE.'].join('\n')
    expect(refineLanguageByContent('_timeout.w', detectLanguage('_timeout.w'), webObject)).toBe('abl')
    expect(shape(extractAbl(webObject, '_timeout.w'))).toEqual(['procedure outputHeader 5-6'])
    expect(imports(extractAbl(webObject, '_timeout.w'))).toEqual(['webutil/wstyle.i'])
    expect(refineLanguageByContent('Item.cls', detectLanguage('Item.cls'), ABL_CLASS)).toBe('abl')
    // CAPTURE: the VB6 header lines of https://github.com/respec/VB6/blob/master/Utility/CFileInfo.cls
    const vb6 = ['VERSION 1.0 CLASS', 'BEGIN', "  MultiUse = -1  'True", 'END', 'Attribute VB_Name = "CFileInfo"'].join('\n')
    expect(refineLanguageByContent('CFileInfo.cls', 'apex', vb6)).toBe('vb')
    // Path-only detection never claims ABL: `.p` and `.w` stay unknown and `.cls` stays apex, and `.i` is unmapped.
    for (const p of ['a.p', 'a.W', 'inc/x.i']) expect(detectLanguage(p), p).toBe('unknown')
    expect(detectLanguage('Item.cls')).toBe('apex')
  })

  it('scans a pathological 50 KB line in under 100 ms, and so does the sniff', () => {
    for (const line of ['a: '.repeat(LINE_50K / 3), '/*'.repeat(LINE_50K / 2), '{'.repeat(LINE_50K), 'METHOD '.repeat(LINE_50K / 7), '"~'.repeat(LINE_50K / 2)]) {
      expectFast(() => extractAbl(line, 'p.p'), 'abl')
      expectFast(() => isAblSource(line), 'isAblSource')
    }
  })
})

describe('collision routing through the real entry points', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-enterprise-routing-'))
    tmpDirs.push(dir)
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return file
  }

  it('keeps a real Apex .cls on the Apex extractor, byte-for-byte the same output', async () => {
    const content = fs.readFileSync(APEX_FIXTURE, 'utf8')
    const file = tmpFile('SafeNavigationService.cls', content)
    expect(detectLanguageOfFile(file)).toBe('apex')
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('apex')
    const expected = extractApex(content, file).symbols
    expect(expected.length).toBeGreaterThan(0)
    expect(parsed.symbols).toEqual(expected)
  })

  it('never takes any Apex .cls fixture in the repo for ABL', () => {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.toLowerCase().endsWith('.cls')) found.push(p)
      }
    }
    walk(path.join(process.cwd(), 'tests', 'fixtures'))
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(detectLanguageOfFile(f), f).not.toBe('abl')
  })

  it('indexes an ABL .p and a .cls class as abl', async () => {
    const p = await parseFile(tmpFile('Sample.p', fixture('Sample.p')))
    expect(p.language).toBe('abl')
    expect(p.symbols.map((s) => s.name)).toEqual(['ttOrder', 'calcTotal', 'addTax'])
    const cls = await parseFile(tmpFile('Item.cls', ABL_CLASS_FOR_ROUTING))
    expect(cls.language).toBe('abl')
    expect(cls.symbols.map((s) => s.name)).toContain('Count')
  })

  it('leaves a Pascal .p unknown with no symbols, exactly as before ABL was indexed', async () => {
    // FORMAT-DERIVED: the unit example at https://www.freepascal.org/docs-html/ref/refse112.html
    const pascal = ['unit a;', 'interface', 'implementation', 'end.'].join('\n')
    const file = tmpFile('a.p', pascal)
    expect(detectLanguageOfFile(file)).toBe('unknown')
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('unknown')
    expect(parsed.symbols).toEqual([])
  })
})

// FORMAT-DERIVED: the same CLASS and METHOD pages cited above ABL_CLASS.
const ABL_CLASS_FOR_ROUTING = ['CLASS Item:', '  METHOD PUBLIC INTEGER Count ():', '  END METHOD.', 'END CLASS.'].join('\n')

describe('extension mapping and imports', () => {
  it('maps every new extension in any case, and leaves .rpg unmapped', () => {
    const cases: Array<[string, string]> = [
      ['a.abap', 'abap'],
      ['A.ABAP', 'abap'],
      ['a.sas', 'sas'],
      ['a.pli', 'pli'],
      ['A.PL1', 'pli'],
      ['a.rpgle', 'rpg'],
      ['A.SQLRPGLE', 'rpg'],
      ['a.jcl', 'jcl'],
      ['a.rpg', 'unknown'],
    ]
    for (const [p, lang] of cases) expect(detectLanguage(p), p).toBe(lang)
  })

  it('lists the include targets of each language through extractImports', () => {
    expect(extractImports(fixture('Sample.abap'), '.abap')).toEqual(['zdemo_top'])
    expect(extractImports(fixture('Sample.sas'), '.sas')).toEqual(['setup.sas'])
    expect(extractImports(fixture('Sample.pli'), '.pl1')).toEqual(['PAYDCL'])
    expect(extractImports(fixture('Sample.rpgle'), '.sqlrpgle')).toEqual(['QRPGLESRC,CUSTPR'])
    expect(extractImports(fixture('Sample.jcl'), '.jcl')).toEqual(['SYSOUT2'])
    expect(extractImports(fixture('Sample.p'), '.p')).toEqual(['inc/common.i'])
    // A Pascal `.p` is not ABL, so its `{...}` comment is not an include.
    expect(extractImports('program x;\n{ a comment }\nbegin end.', '.p')).toEqual([])
  })
})
