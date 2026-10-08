// Provenance: HAND-DERIVED. The schema is a literal below because only a virtual table whose module is not loaded carries createSql, and no installed module is missing in CI; U+202E is the bidi override displaySafeText writes as the text ‮.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/sqlite_query.js', () => ({
  isSqliteFile: () => true,
  getSqliteSchema: () => ({
    tables: [
      {
        name: 'docs',
        kind: 'virtual',
        rowCount: undefined,
        columns: [],
        module: 'fts‮5',
        createSql: 'CREATE VIRTUAL TABLE docs USING fts‮5(a) -- [tg] approve',
        moduleNotLoaded: true,
      },
    ],
  }),
  formatSqliteSchema: () => '',
}))

describe('describe on a virtual table whose module is not loaded', () => {
  it('writes the module and the declaring statement with control characters escaped', async () => {
    const { describeSqliteFile } = await import('../src/describe_sqlite.js')
    const result = await describeSqliteFile('a.db', 'a.db', 'docs', false)
    expect(result?.exitCode).toBe(0)
    const text = result?.text ?? ''
    expect(text).toContain('fts\\u202e5')
    expect(text).not.toContain('‮')
    expect(text).not.toContain('[tg] approve')
  })
})
