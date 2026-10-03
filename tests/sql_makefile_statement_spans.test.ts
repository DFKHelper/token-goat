import { describe, expect, it } from 'vitest'
import { extractSql } from '../src/languages/sql_idx.js'
import { extractMakefile } from '../src/languages/makefile_idx.js'

const span = (syms: ReturnType<typeof extractSql>, name: string) => {
  const s = syms.filter((x) => x.name === name)
  expect(s).toHaveLength(1)
  return [s[0]!.lineStart, s[0]!.lineEnd]
}

describe('SQL statement spans end at the terminating semicolon', () => {
  // HAND-DERIVED: line numbers counted from the fixture text below; the expected end is the line carrying the `;` that closes each CREATE per the SQL grammar, not what extractSql returns.
  it('a multi-line CREATE TABLE does not absorb later DML or blank lines', () => {
    const content = [
      'CREATE TABLE users (', // 1
      '  id INT,', // 2
      '  name TEXT', // 3
      ');', // 4
      '', // 5
      "INSERT INTO users VALUES (1, 'a');", // 6
      "UPDATE users SET name = 'b';", // 7
      'GRANT SELECT ON users TO bob;', // 8
    ].join('\n')
    expect(span(extractSql(content, 'dump.sql'), 'users')).toEqual([1, 4])
  })

  // HAND-DERIVED: same counting; the trailing block comment and blank lines follow the `;` and are not part of the view or function.
  it('a view, table and function drop trailing comments and blank lines', () => {
    const content = [
      'CREATE TABLE users (', // 1
      '  id INT', // 2
      ');', // 3
      '', // 4
      'CREATE VIEW active_users AS', // 5
      '  SELECT * FROM users', // 6
      '  WHERE id > 0;', // 7
      '/* CREATE INDEX fake_block ON users(id); */', // 8
      '', // 9
      'CREATE FUNCTION do_thing() RETURNS int AS $$', // 10
      'BEGIN', // 11
      '  RETURN 1;', // 12
      'END;', // 13
      '$$ LANGUAGE plpgsql;', // 14
      '', // 15
      '-- trailing note', // 16
      '', // 17
    ].join('\n')
    const syms = extractSql(content, 'schema.sql')
    expect(span(syms, 'users')).toEqual([1, 3])
    expect(span(syms, 'active_users')).toEqual([5, 7])
    expect(span(syms, 'do_thing')).toEqual([10, 14])
  })

  it('a multi-line function body containing semicolons is not cut at the first one', () => {
    const content = ['CREATE FUNCTION f() RETURNS int AS $$', 'BEGIN', '  RETURN 1;', 'END;', '$$ LANGUAGE plpgsql;'].join('\n')
    expect(span(extractSql(content, 'f.sql'), 'f')).toEqual([1, 5])
  })
})

describe('a function with no body ends at its own semicolon', () => {
  // HAND-DERIVED: DuckDB scalar function syntax (`CREATE FUNCTION name(params) AS expr`, duckdb.org/docs/sql/statements/create_macro, where FUNCTION is an alias of MACRO); the expression ends at the `;` on line 2 and the SELECT after it is a separate statement.
  it('a DuckDB expression function does not absorb the statements after it', () => {
    const content = ['CREATE FUNCTION add_two(a) AS', '  a + 2;', '', 'SELECT 1;', '', 'CREATE TABLE v (', '  id INT', ');'].join('\n')
    expect(span(extractSql(content, 'duck.sql'), 'add_two')).toEqual([1, 2])
  })

  // HAND-DERIVED: SQL-standard / PostgreSQL 14 `RETURN expr` body (postgresql.org/docs/current/sql-createfunction.html); one statement ending on line 3.
  it('a RETURN-expression function ends at its semicolon', () => {
    const content = ['CREATE FUNCTION inc(a int) RETURNS int', '  LANGUAGE sql IMMUTABLE', '  RETURN a + 1;', "INSERT INTO t VALUES (1);"].join('\n')
    expect(span(extractSql(content, 'pg.sql'), 'inc')).toEqual([1, 3])
  })

  // HAND-DERIVED: Oracle PL/SQL function with a declaration section and an unnamed END; its first `;` closes a declaration on line 2, and the body runs to `END;` on line 5.
  it('a PL/SQL function is not cut at its first declaration', () => {
    const content = ['CREATE FUNCTION f RETURN NUMBER AS', '  v NUMBER;', 'BEGIN', '  RETURN v;', 'END;'].join('\n')
    expect(span(extractSql(content, 'ora.sql'), 'f')).toEqual([1, 5])
  })

  // HAND-DERIVED: MySQL function with a BEGIN...END body whose first `;` is inside the body on line 3.
  it('a BEGIN body is not cut at its first statement', () => {
    const content = ['CREATE FUNCTION g() RETURNS INT DETERMINISTIC', 'BEGIN', '  DECLARE x INT;', '  RETURN 1;', 'END;'].join('\n')
    expect(span(extractSql(content, 'my.sql'), 'g')).toEqual([1, 5])
  })

  // HAND-DERIVED: a DuckDB expression body using the `IS NULL` predicate is still one statement ending at the `;` on line 2; the IS is a comparison, not a PL/SQL header.
  it('an IS predicate in an expression body is not read as a PL/SQL header', () => {
    const content = ['CREATE FUNCTION is_missing(a) AS', '  a IS NULL;', '', 'SELECT 1;', 'SELECT 2;'].join('\n')
    expect(span(extractSql(content, 'duck.sql'), 'is_missing')).toEqual([1, 2])
  })

  // HAND-DERIVED: SQL-standard `RETURN expr` body (postgresql.org/docs/current/sql-createfunction.html) whose expression holds an IS predicate and a CAST ... AS; neither opens a body, so the function ends on line 2.
  it('IS and CAST AS inside a RETURN expression do not open a body', () => {
    const content = ['CREATE FUNCTION nz(a int) RETURNS boolean', '  RETURN a IS NOT NULL AND CAST(a AS text) <> \'\';', "INSERT INTO t VALUES (1);", 'SELECT 3;'].join('\n')
    expect(span(extractSql(content, 'pg.sql'), 'nz')).toEqual([1, 2])
  })

  // HAND-DERIVED: a DuckDB function whose parameters are quoted identifiers spelled like keywords; a quoted name is an identifier, so it opens no body and the function ends on line 2.
  it('a quoted parameter named like a keyword does not open a body', () => {
    const content = ['CREATE FUNCTION span_of("begin", "declare") AS', '  "declare" - "begin";', '', 'SELECT 1;', 'SELECT 2;'].join('\n')
    expect(span(extractSql(content, 'duck.sql'), 'span_of')).toEqual([1, 2])
  })

  // HAND-DERIVED: Oracle PL/SQL function header with an IS before its declarations (docs.oracle.com, CREATE FUNCTION statement); the first `;` closes the declaration on line 2 and the body ends at `END;` on line 5.
  it('a PL/SQL RETURN type IS header still opens a body', () => {
    const content = ['CREATE FUNCTION h(p NUMBER) RETURN NUMBER DETERMINISTIC IS', '  v NUMBER;', 'BEGIN', '  RETURN p;', 'END;'].join('\n')
    expect(span(extractSql(content, 'ora.sql'), 'h')).toEqual([1, 5])
  })

  // HAND-DERIVED: a T-SQL procedure body needs no BEGIN, so both SELECTs on lines 3-4 belong to it; only functions are pinned.
  it('a T-SQL procedure without BEGIN keeps its whole body', () => {
    const content = ['CREATE PROCEDURE p AS', '  SET NOCOUNT ON;', '  SELECT 1;', '  SELECT 2;'].join('\n')
    expect(span(extractSql(content, 'ms.sql'), 'p')).toEqual([1, 4])
  })
})

describe('SQL semicolon pin stays inside the statement', () => {
  // HAND-DERIVED: MySQL client `DELIMITER //` script; the table ends at `//` on line 2, and the first `;` after its CREATE is inside the procedure body on line 3.
  it('a table under a custom DELIMITER does not reach into the next procedure', () => {
    const content = ['DELIMITER //', 'CREATE TABLE t (id INT)//', 'CREATE PROCEDURE p() BEGIN SELECT 1; END//', 'DELIMITER ;'].join('\n')
    const syms = extractSql(content, 'd.sql')
    expect(span(syms, 't')).toEqual([2, 2])
    expect(span(syms, 'p')[0]).toBe(3)
  })

  // HAND-DERIVED: a `;` inside a `--` comment is not a terminator, so the table runs to the real `);` on line 4.
  it('a semicolon inside a comment in the column list does not end the table', () => {
    const content = ['CREATE TABLE c (', '  a INT, -- a; b', '  b INT', ');'].join('\n')
    expect(span(extractSql(content, 'c.sql'), 'c')).toEqual([1, 4])
  })
})

describe('Makefile target-specific variable assignments are not rules', () => {
  // HAND-DERIVED: GNU make manual, "Target-specific Variable Values": `target : variable-assignment` with `=`, `:=`, `::=`, `:::=`, `?=`, `+=`, `!=` and optional `override`/`export`/`private`. Line numbers counted from the fixture.
  const assignments = ['CFLAGS += -g', 'VAR = x', 'VAR := x', 'VAR ::= x', 'VAR ?= x', 'VAR != date', 'override VAR = x', 'export VAR := x', 'VAR=x', 'VAR:=x']
  for (const assign of assignments) {
    it(`"build: ${assign}" is not emitted and the real rule stays the only build`, () => {
      const content = ['all: build', '', `build: ${assign}`, 'build: main.o util.o', '\tcc -o build main.o util.o'].join('\n')
      const builds = extractMakefile(content, 'Makefile').filter((s) => s.name === 'build')
      expect(builds.map((s) => [s.lineStart, s.lineEnd])).toEqual([[4, 5]])
    })
  }

  it('a rule with no prerequisites followed by a column-0 assignment is still a rule', () => {
    const content = ['clean:', 'FOO = 1', 'all: clean'].join('\n')
    const names = extractMakefile(content, 'Makefile').map((s) => s.name)
    expect(names).toEqual(['clean', 'all'])
  })

  it('a double-colon rule with prerequisites is still a rule', () => {
    const names = extractMakefile('a:: b c\n\techo\n', 'Makefile').map((s) => s.name)
    expect(names).toEqual(['a'])
  })
})
