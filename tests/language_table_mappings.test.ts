/**
 * The file types added to the language table in 2.9.11, driven through the real default index path (indexFileSync -> symbols table -> querySymbols), plus the PL/SQL package support in the SQL adapter, COBOL continuation lines, and the partial-refs notice for COBOL and Natural.
 *
 * Every fixture below is HAND-DERIVED from the language's own documentation, cited next to it, never from this repo's extractor regexes.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { extractCobol } from '../src/languages/cobol.js'
import { indexFileSync } from '../src/parser.js'
import { detectLanguage } from '../src/parser_types.js'
import { refBlindLanguageNotice } from '../src/ref_blindness.js'

let tmpDirs: string[] = []
afterEach(() => {
  closeAllDbs()
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

/** Index one file under `basename` through indexFileSync and return its symbols as `kind name start-end parent`. */
function indexed(basename: string, lines: readonly string[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lang-table-'))
  tmpDirs.push(dir)
  const file = path.join(dir, basename)
  fs.writeFileSync(file, lines.join('\n'))
  const db = path.join(dir, 'index.db')
  indexFileSync(file, db)
  return querySymbols({ filePath: file }, db).map((s) => `${s.kind} ${s.name} ${s.lineStart}-${s.lineEnd} ${s.parent ?? ''}`.trimEnd())
}

const names = (rows: readonly string[]): string[] => rows.map((r) => r.split(' ')[1] ?? '')

describe('shell dialects index as bash', () => {
  // HAND-DERIVED: both function forms per https://zsh.sourceforge.io/Doc/Release/Shell-Grammar.html (Functions), which ksh and Bats share.
  const SRC = ['function deploy_site {', '  echo deploying', '}', '', 'rollback_site() {', '  echo rolling back', '}']
  it.each(['deploy.zsh', 'deploy.ksh', 'deploy.bats'])('%s', (base) => {
    expect(detectLanguage(base)).toBe('bash')
    expect(names(indexed(base, SRC))).toEqual(['deploy_site', 'rollback_site'])
  })
})

describe('Bazel and Starlark files index as python', () => {
  // HAND-DERIVED: a Starlark macro per https://bazel.build/rules/language and https://bazel.build/extending/macros.
  const SRC = ['load("@rules_cc//cc:defs.bzl", "cc_library")', '', 'def payroll_library(name, srcs):', '    cc_library(name = name, srcs = srcs)']
  it.each(['defs.bzl', 'rules.star', 'BUILD', 'BUILD.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel'])('%s', (base) => {
    expect(detectLanguage(base)).toBe('python')
    expect(names(indexed(base, SRC))).toContain('payroll_library')
  })
})

describe('JSON with comments', () => {
  // HAND-DERIVED: JSON with comments as VS Code writes settings files (https://code.visualstudio.com/docs/languages/json#_json-with-comments); `//` inside a string is text, not a comment.
  it('finds top-level keys past line and block comments, and keeps a // inside a string', () => {
    const rows = indexed('settings.jsonc', [
      '// editor settings',
      '{',
      '  /* block',
      '     comment */',
      '  "editor": {',
      '    "tabSize": 2, // two spaces',
      '    "url": "https://example.com/a//b"',
      '  },',
      '  "files": {}',
      '}',
    ])
    expect(names(rows)).toEqual(['editor', 'files'])
    expect(rows[0]).toMatch(/^\S+ editor 5-8/)
  })

  it('an Avro schema (.avsc) indexes as JSON', () => {
    // HAND-DERIVED: record schema shape per https://avro.apache.org/docs/1.11.1/specification/#schema-record.
    expect(detectLanguage('user.avsc')).toBe('json')
    expect(names(indexed('user.avsc', ['{', '  "type": "record",', '  "name": "User",', '  "fields": []', '}']))).toEqual(['type', 'name', 'fields'])
  })
})

describe('PL/SQL through the SQL adapter', () => {
  it('maps every PL/SQL extension, in any case, to sql', () => {
    for (const e of ['pks', 'pkb', 'pls', 'plsql', 'pck', 'prc', 'fnc', 'trg', 'tps', 'tpb']) {
      expect(detectLanguage(`x.${e}`), e).toBe('sql')
      expect(detectLanguage(`X.${e.toUpperCase()}`), e).toBe('sql')
    }
  })

  it('a package spec: the package ends at END name; and each declaration is a one-statement child', () => {
    // HAND-DERIVED: https://docs.oracle.com/en/database/oracle/oracle-database/23/lnpls/CREATE-PACKAGE-statement.html
    const rows = indexed('payroll_pkg.pks', [
      'CREATE OR REPLACE NONEDITIONABLE PACKAGE payroll_pkg AS',
      '  PROCEDURE raise_salary(p_emp_id NUMBER,',
      '                         p_pct NUMBER);',
      '  FUNCTION total_payroll RETURN NUMBER;',
      'END payroll_pkg;',
      '/',
    ])
    expect(rows).toEqual([
      'sql_package payroll_pkg 1-5',
      'sql_procedure raise_salary 2-3 payroll_pkg',
      'sql_function total_payroll 4-4 payroll_pkg',
    ])
  })

  it('a package body: each subprogram spans to its own END name;, and a quoted, schema-qualified name works', () => {
    // HAND-DERIVED: https://docs.oracle.com/en/database/oracle/oracle-database/23/lnpls/CREATE-PACKAGE-BODY-statement.html
    const rows = indexed('payroll_pkg.pkb', [
      'CREATE OR REPLACE EDITIONABLE PACKAGE BODY hr."PAYROLL_PKG" AS',
      '  PROCEDURE raise_salary(p_emp_id NUMBER, p_pct NUMBER) IS',
      '  BEGIN',
      '    UPDATE employees SET salary = salary * 2 WHERE emp_id = p_emp_id;',
      '  END raise_salary;',
      '',
      '  FUNCTION total_payroll RETURN NUMBER IS',
      '    v_total NUMBER;',
      '  BEGIN',
      '    SELECT SUM(salary) INTO v_total FROM employees;',
      '    RETURN v_total;',
      '  END total_payroll;',
      'END "PAYROLL_PKG";',
      '/',
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^sql_package_body \S*PAYROLL_PKG 1-13$/)
    expect(rows[1]).toMatch(/^sql_procedure raise_salary 2-5 \S*PAYROLL_PKG$/)
    expect(rows[2]).toMatch(/^sql_function total_payroll 7-12 \S*PAYROLL_PKG$/)
  })

  it('a type spec and a type body are two objects, and the body holds its member subprograms', () => {
    // HAND-DERIVED: https://docs.oracle.com/en/database/oracle/oracle-database/23/lnpls/CREATE-TYPE-BODY-statement.html and CREATE-TYPE-statement.html in the same guide.
    const rows = indexed('money_t.tpb', [
      'CREATE OR REPLACE TYPE money_t AS OBJECT (amount NUMBER, MEMBER FUNCTION doubled RETURN NUMBER);',
      '/',
      'CREATE OR REPLACE TYPE BODY money_t AS',
      '  MEMBER FUNCTION doubled RETURN NUMBER IS',
      '  BEGIN',
      '    RETURN amount * 2;',
      '  END doubled;',
      'END;',
      '/',
    ])
    expect(rows).toContain('sql_type money_t 1-1')
    expect(rows.some((r) => r.startsWith('sql_type_body money_t 3-'))).toBe(true)
    expect(rows).toContain('sql_function doubled 4-7 money_t')
    expect(names(rows)).not.toContain('BODY')
  })

  it('a trigger ends at its END name;', () => {
    // HAND-DERIVED: https://docs.oracle.com/en/database/oracle/oracle-database/23/lnpls/CREATE-TRIGGER-statement.html
    const rows = indexed('emp_audit.trg', [
      'CREATE OR REPLACE EDITIONABLE TRIGGER emp_audit',
      '  AFTER UPDATE ON employees',
      '  FOR EACH ROW',
      'BEGIN',
      '  INSERT INTO audit_log VALUES (:OLD.emp_id);',
      'END emp_audit;',
      '/',
      'CREATE TABLE audit_log (emp_id NUMBER);',
    ])
    expect(rows).toContain('sql_trigger emp_audit 1-6')
    expect(rows).toContain('sql_table audit_log 8-8')
  })

  it('a standalone procedure spans to its END name;', () => {
    // HAND-DERIVED: https://docs.oracle.com/en/database/oracle/oracle-database/23/lnpls/CREATE-PROCEDURE-statement.html
    const rows = indexed('purge.prc', [
      'CREATE OR REPLACE PROCEDURE purge_old IS',
      'BEGIN',
      '  DELETE FROM audit_log;',
      'END purge_old;',
      '/',
      '',
      '',
      'CREATE TABLE later_table (id NUMBER);',
    ])
    expect(rows).toContain('sql_procedure purge_old 1-4')
  })
})

describe('COBOL continuation lines', () => {
  it('a PERFORM whose paragraph name continues on the next line is one reference', () => {
    // HAND-DERIVED from https://www.ibm.com/docs/en/cobol-zos/6.4.0?topic=format-continuation-lines: a `-` in column 7 continues the previous line from the first nonblank character in Area B.
    const src = [
      '000100 PROCEDURE DIVISION.',
      '000200 MAIN-PARA.',
      '000300     PERFORM CALC-',
      '000400-        PARA.',
      '000500     DISPLAY "SPLIT',
      '000600-    "PERFORM NOT-A-PARA".',
      '000700 CALC-PARA.',
      '000800     EXIT.',
    ].join('\n')
    const r = extractCobol(src, 'cont.cbl')
    expect(r.refs.map((x) => `${x.name}@${x.line}`)).toEqual(['CALC-PARA@3'])
    expect(r.symbols.map((s) => s.name)).toEqual(['MAIN-PARA', 'CALC-PARA'])
  })
})

describe('reference notice for COBOL and Natural', () => {
  it('says which references are recorded instead of claiming none are', () => {
    for (const [lang, recorded] of [['cobol', "PERFORM, GO TO and CALL 'literal'"], ['natural', "PERFORM, CALLNAT 'literal' and FETCH 'literal'"]] as const) {
      const msg = refBlindLanguageNotice('CALC-PARA', lang, 'PAY.cbl')
      expect(msg).toContain(`${recorded} are recorded as references`)
      expect(msg).toContain('an empty result is not evidence the name is unused')
      expect(msg).not.toContain('call sites are not indexed')
    }
    expect(refBlindLanguageNotice('X', 'vb', 'a.vb')).toContain('Visual Basic call sites are not indexed')
  })
})
