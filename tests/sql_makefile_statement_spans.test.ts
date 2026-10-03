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
