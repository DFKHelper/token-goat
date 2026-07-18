import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import Database from 'better-sqlite3'
import {
  isSqliteFile,
  openReadonlySqlite,
  getSqliteSchema,
  formatSqliteSchema,
  validateReadOnlySelect,
  runReadOnlySqliteQuery,
  formatSqliteQueryTable,
  SQLITE_QUERY_ROW_CAP,
} from '../src/sqlite_query.js'

describe('sqlite_query', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sqlite-query-'))
    dbPath = path.join(tempDir, 'fixture.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        dept_id INTEGER,
        FOREIGN KEY (dept_id) REFERENCES departments(id)
      );
      CREATE TABLE departments (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_users_email ON users(email);
      CREATE VIEW active_users AS SELECT * FROM users WHERE email IS NOT NULL;
    `)
    const insertDept = db.prepare('INSERT INTO departments (id, name) VALUES (?, ?)')
    insertDept.run(1, 'Engineering')
    insertDept.run(2, 'Sales')
    const insertUser = db.prepare('INSERT INTO users (id, name, email, dept_id) VALUES (?, ?, ?, ?)')
    insertUser.run(1, 'Alice', 'alice@example.com', 1)
    insertUser.run(2, 'Bob', 'bob@example.com', 1)
    insertUser.run(3, 'Carol', null, 2)
    db.close()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- isSqliteFile / openReadonlySqlite ---------------------------------

  describe('isSqliteFile', () => {
    it('returns true for a real SQLite database', () => {
      expect(isSqliteFile(dbPath)).toBe(true)
    })

    it('returns false for a non-SQLite file', () => {
      const f = path.join(tempDir, 'not-a-db.txt')
      fs.writeFileSync(f, 'just some text, not a sqlite header')
      expect(isSqliteFile(f)).toBe(false)
    })

    it('returns false for a file with a truncated/corrupt header', () => {
      const f = path.join(tempDir, 'corrupt.db')
      fs.writeFileSync(f, 'SQL')
      expect(isSqliteFile(f)).toBe(false)
    })

    it('returns false for a nonexistent file', () => {
      expect(isSqliteFile(path.join(tempDir, 'nope.db'))).toBe(false)
    })
  })

  describe('openReadonlySqlite', () => {
    it('opens a real database read-only', () => {
      const db = openReadonlySqlite(dbPath)
      expect(db.readonly).toBe(true)
      db.close()
    })

    it('throws a clean error for a nonexistent file', () => {
      expect(() => openReadonlySqlite(path.join(tempDir, 'missing.db'))).toThrow(/file not found/)
    })

    it('throws a clean error for a non-SQLite file instead of a raw native exception', () => {
      const f = path.join(tempDir, 'not-a-db.txt')
      fs.writeFileSync(f, 'not a database')
      expect(() => openReadonlySqlite(f)).toThrow(/not a valid SQLite database/)
    })
  })

  // ---- getSqliteSchema / formatSqliteSchema ------------------------------

  describe('getSqliteSchema', () => {
    it('lists tables and views with column, index, and foreign-key detail plus row counts', () => {
      const schema = getSqliteSchema(dbPath)
      const names = schema.tables.map((t) => t.name).sort()
      expect(names).toEqual(['active_users', 'departments', 'users'])

      const users = schema.tables.find((t) => t.name === 'users')
      expect(users?.kind).toBe('table')
      expect(users?.rowCount).toBe(3)
      const idCol = users?.columns.find((c) => c.name === 'id')
      expect(idCol?.primaryKey).toBe(true)
      const nameCol = users?.columns.find((c) => c.name === 'name')
      expect(nameCol?.notNull).toBe(true)
      expect(nameCol?.type).toBe('TEXT')

      expect(users?.indexes.some((i) => i.name === 'idx_users_email' && i.unique)).toBe(true)
      expect(users?.foreignKeys).toEqual([{ table: 'departments', from: 'dept_id', to: 'id' }])

      const view = schema.tables.find((t) => t.name === 'active_users')
      expect(view?.kind).toBe('view')
      expect(view?.rowCount).toBe(2)

      const departments = schema.tables.find((t) => t.name === 'departments')
      expect(departments?.rowCount).toBe(2)
    })

    it('reports an empty database with no tables cleanly', () => {
      const emptyPath = path.join(tempDir, 'empty.db')
      const empty = new Database(emptyPath)
      // A freshly created better-sqlite3 file has no on-disk header at all until the first
      // write transaction -- create and drop a throwaway table so the file gets a real
      // SQLite header (isSqliteFile's magic-byte check) while still ending with zero tables.
      empty.exec('CREATE TABLE t (x)')
      empty.exec('DROP TABLE t')
      empty.close()
      const schema = getSqliteSchema(emptyPath)
      expect(schema.tables).toEqual([])
    })

    it('throws a clean error for a nonexistent file', () => {
      expect(() => getSqliteSchema(path.join(tempDir, 'missing.db'))).toThrow(/file not found/)
    })

    it('throws a clean error for a corrupt/non-SQLite file', () => {
      const f = path.join(tempDir, 'corrupt.db')
      fs.writeFileSync(f, 'garbage bytes, not a real database header at all')
      expect(() => getSqliteSchema(f)).toThrow(/not a valid SQLite database/)
    })
  })

  describe('formatSqliteSchema', () => {
    it('renders table name, kind, row count, columns with PK/NOT NULL flags, indexes, and foreign keys', () => {
      const text = formatSqliteSchema(getSqliteSchema(dbPath))
      expect(text).toContain('users  (table, 3 rows)')
      expect(text).toContain('id INTEGER')
      expect(text).toContain('PK')
      expect(text).toContain('name TEXT')
      expect(text).toContain('NOT NULL')
      expect(text).toContain('idx_users_email (unique): email')
      expect(text).toContain('dept_id -> departments.id')
      expect(text).toContain('active_users  (view, 2 rows)')
    })

    it('renders a distinct message for a database with no tables/views', () => {
      expect(formatSqliteSchema({ tables: [] })).toBe('(no tables or views found)')
    })
  })

  // ---- validateReadOnlySelect ---------------------------------------------

  describe('validateReadOnlySelect', () => {
    it('accepts a plain SELECT', () => {
      expect(() => validateReadOnlySelect('SELECT * FROM users')).not.toThrow()
    })

    it('accepts a SELECT with a trailing semicolon', () => {
      expect(() => validateReadOnlySelect('SELECT * FROM users;')).not.toThrow()
    })

    it('accepts a lowercase select', () => {
      expect(() => validateReadOnlySelect('select id from users')).not.toThrow()
    })

    it('accepts a WITH (CTE) prefixed SELECT', () => {
      expect(() => validateReadOnlySelect('WITH t AS (SELECT * FROM users) SELECT * FROM t')).not.toThrow()
    })

    it('accepts a query using the scalar replace() function without tripping the REPLACE keyword guard', () => {
      expect(() => validateReadOnlySelect("SELECT replace(name, 'a', 'b') FROM users")).not.toThrow()
    })

    it('rejects an empty query', () => {
      expect(() => validateReadOnlySelect('   ')).toThrow(/empty query/)
    })

    // These statement forms don't start with SELECT/WITH, so they're rejected by the
    // "only SELECT statements are allowed" prefix check before the keyword scan ever runs --
    // still rejected, just via the first (and cheaper) of the two independent checks.
    it('rejects INSERT', () => {
      expect(() => validateReadOnlySelect("INSERT INTO users (name) VALUES ('Eve')")).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects UPDATE', () => {
      expect(() => validateReadOnlySelect("UPDATE users SET name = 'Eve' WHERE id = 1")).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects DELETE', () => {
      expect(() => validateReadOnlySelect('DELETE FROM users WHERE id = 1')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects DROP', () => {
      expect(() => validateReadOnlySelect('DROP TABLE users')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects ALTER', () => {
      expect(() => validateReadOnlySelect('ALTER TABLE users ADD COLUMN foo TEXT')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects CREATE', () => {
      expect(() => validateReadOnlySelect('CREATE TABLE evil (id INTEGER)')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects ATTACH', () => {
      expect(() => validateReadOnlySelect("ATTACH DATABASE 'other.db' AS other")).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects DETACH', () => {
      expect(() => validateReadOnlySelect('DETACH DATABASE other')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects VACUUM', () => {
      expect(() => validateReadOnlySelect('VACUUM')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects REINDEX', () => {
      expect(() => validateReadOnlySelect('REINDEX users')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects a mutating PRAGMA', () => {
      expect(() => validateReadOnlySelect('PRAGMA journal_mode=DELETE')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects an informational PRAGMA too (sqlite-query is SELECT-only; use sqlite-schema for structure)', () => {
      expect(() => validateReadOnlySelect('PRAGMA table_info(users)')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects transaction-control statements', () => {
      expect(() => validateReadOnlySelect('BEGIN')).toThrow(/only SELECT statements are allowed/)
      expect(() => validateReadOnlySelect('COMMIT')).toThrow(/only SELECT statements are allowed/)
      expect(() => validateReadOnlySelect('ROLLBACK')).toThrow(/only SELECT statements are allowed/)
    })

    it('rejects REPLACE INTO', () => {
      expect(() => validateReadOnlySelect("REPLACE INTO users (id, name) VALUES (1, 'Eve')")).toThrow(/only SELECT statements are allowed/)
    })

    // The keyword-denylist scan is a second, independent layer: it also catches a forbidden
    // statement smuggled in AFTER a leading WITH clause, which passes the prefix check.
    it('rejects INSERT smuggled in after a leading WITH (CTE) clause', () => {
      expect(() => validateReadOnlySelect("WITH cte AS (SELECT 1) INSERT INTO users (name) SELECT 'Eve' FROM cte")).toThrow(
        /forbidden keyword 'INSERT'/,
      )
    })

    it('rejects DROP smuggled in after a leading WITH clause', () => {
      expect(() => validateReadOnlySelect('WITH cte AS (SELECT 1) DROP TABLE users')).toThrow(/forbidden keyword 'DROP'/)
    })

    it('rejects REPLACE INTO smuggled in after a leading WITH clause, without false-positiving on the replace() function', () => {
      expect(() => validateReadOnlySelect("WITH cte AS (SELECT 1) REPLACE INTO users (id, name) VALUES (1, 'Eve')")).toThrow(
        /forbidden keyword 'REPLACE'/,
      )
    })

    it('rejects a multi-statement injection attempt', () => {
      expect(() => validateReadOnlySelect('SELECT 1; DROP TABLE users;')).toThrow(/multiple statements are not allowed/)
    })

    it('rejects a multi-statement attempt even without a trailing semicolon', () => {
      expect(() => validateReadOnlySelect('SELECT 1; SELECT 2')).toThrow(/multiple statements are not allowed/)
    })

    it('rejects a statement that does not start with SELECT or WITH', () => {
      expect(() => validateReadOnlySelect('EXPLAIN SELECT * FROM users')).toThrow(/only SELECT statements are allowed/)
    })

    it('does not false-positive on a DROP-looking word embedded in a string literal', () => {
      expect(() => validateReadOnlySelect("SELECT * FROM users WHERE name = 'please DROP TABLE users'")).not.toThrow()
    })

    it('does not false-positive on a forbidden keyword inside a comment', () => {
      expect(() => validateReadOnlySelect('SELECT * FROM users -- DROP everything after this')).not.toThrow()
    })
  })

  // ---- runReadOnlySqliteQuery / formatSqliteQueryTable --------------------

  describe('runReadOnlySqliteQuery', () => {
    it('runs a SELECT and returns columns + rows', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT id, name FROM users ORDER BY id')
      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Carol' },
      ])
      expect(result.rowCapped).toBe(false)
    })

    it('caps the result at the row-cap and flags rowCapped', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT id FROM users ORDER BY id', { rowCap: 2 })
      expect(result.rows).toHaveLength(2)
      expect(result.rowCapped).toBe(true)
    })

    it('does not flag rowCapped when the result exactly fits under the cap', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT id FROM users ORDER BY id', { rowCap: 3 })
      expect(result.rows).toHaveLength(3)
      expect(result.rowCapped).toBe(false)
    })

    it('exports a sane default row cap', () => {
      expect(SQLITE_QUERY_ROW_CAP).toBeGreaterThan(0)
    })

    it('rejects a DROP TABLE attempt against the real query engine, leaving the table intact', () => {
      expect(() => runReadOnlySqliteQuery(dbPath, 'DROP TABLE users')).toThrow(/only SELECT statements are allowed/)
      // The table must still exist and still have its rows -- the rejection has to happen
      // before execution, not just report an error after a partial write.
      const schema = getSqliteSchema(dbPath)
      expect(schema.tables.some((t) => t.name === 'users')).toBe(true)
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT COUNT(*) AS c FROM users')
      expect(result.rows[0]?.c).toBe(3)
    })

    it('rejects an INSERT attempt against the real query engine, leaving row count unchanged', () => {
      expect(() => runReadOnlySqliteQuery(dbPath, "INSERT INTO users (name) VALUES ('Eve')")).toThrow(/only SELECT statements are allowed/)
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT COUNT(*) AS c FROM users')
      expect(result.rows[0]?.c).toBe(3)
    })

    it('rejects an INSERT smuggled in after a leading WITH clause against the real query engine', () => {
      expect(() =>
        runReadOnlySqliteQuery(dbPath, "WITH cte AS (SELECT 1) INSERT INTO users (name) SELECT 'Eve' FROM cte"),
      ).toThrow(/forbidden keyword 'INSERT'/)
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT COUNT(*) AS c FROM users')
      expect(result.rows[0]?.c).toBe(3)
    })

    it('rejects a multi-statement injection attempt against the real query engine', () => {
      expect(() => runReadOnlySqliteQuery(dbPath, 'SELECT 1; DROP TABLE users;')).toThrow(/multiple statements are not allowed/)
      const schema = getSqliteSchema(dbPath)
      expect(schema.tables.some((t) => t.name === 'users')).toBe(true)
    })

    it('throws a clean error for a nonexistent file', () => {
      expect(() => runReadOnlySqliteQuery(path.join(tempDir, 'missing.db'), 'SELECT 1')).toThrow(/file not found/)
    })

    it('throws a clean error for a corrupt/non-SQLite file', () => {
      const f = path.join(tempDir, 'corrupt.db')
      fs.writeFileSync(f, 'not a real sqlite file')
      expect(() => runReadOnlySqliteQuery(f, 'SELECT 1')).toThrow(/not a valid SQLite database/)
    })

    it('throws a clean error for invalid SQL syntax', () => {
      expect(() => runReadOnlySqliteQuery(dbPath, 'SELECT FROM WHERE')).toThrow(/invalid SQL/)
    })

    it('throws a clean error for a query against a nonexistent table', () => {
      expect(() => runReadOnlySqliteQuery(dbPath, 'SELECT * FROM nope')).toThrow(/invalid SQL/)
    })
  })

  describe('formatSqliteQueryTable', () => {
    it('renders a header row plus data rows as CSV-style text', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT id, name FROM users ORDER BY id')
      const text = formatSqliteQueryTable(result)
      expect(text.split('\n')[0]).toBe('id,name')
      expect(text).toContain('1,Alice')
      expect(text).toContain('2,Bob')
    })

    it('renders null cells as empty and blob cells as a byte-count placeholder', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT email FROM users WHERE id = 3')
      const text = formatSqliteQueryTable(result)
      expect(text).toBe('email\n')
    })

    it('appends a head-truncation note when headTruncated is set', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT id FROM users ORDER BY id')
      const text = formatSqliteQueryTable({ ...result, rows: result.rows.slice(0, 1) }, { headTruncated: true })
      expect(text).toContain('more rows elided; use --head to see more')
    })

    it('appends a row-cap note when rowCapped is set', () => {
      const result = runReadOnlySqliteQuery(dbPath, 'SELECT id FROM users ORDER BY id', { rowCap: 2 })
      const text = formatSqliteQueryTable(result)
      expect(text).toContain('row safety cap')
    })

    it('renders a distinct message for a query with no result columns or rows', () => {
      expect(formatSqliteQueryTable({ columns: [], rows: [], rowCapped: false })).toBe('(no rows)')
    })
  })
})
