// The SQLite-file half of `describe`, apart from session_store_schema.ts so that the hook bundle, which reaches that file for its SQL-failure advice, does not carry the table formatting and the overflow cap with it.

import { displaySafeJson, displaySafePath, displaySafeText } from './paths.js'
import { echoedValue } from './hint_suggestion_guard.js'
import { fenceFileFieldIfMatched, fenceJsonStrings } from './untrusted_fence.js'

/** What `describe <db file> [table]` prints, or undefined when `absPath` is not a SQLite database. A failure while reading it is the exit-1 result, not an exception. */
export async function describeSqliteFile(target: string, absPath: string, table: string | undefined, json: boolean): Promise<{ exitCode: number; text: string } | undefined> {
  try {
    const { isSqliteFile, getSqliteSchema, formatSqliteSchema } = await import('./sqlite_query.js')
    const fenceCap = await import('./fence_cap.js')
    const capAndFence = (text: string): string => fenceCap.guardAndFenceFileText(text, 'describe')
    if (isSqliteFile(absPath)) {
      const schema = getSqliteSchema(absPath)
      if (table) {
        const found = schema.tables.find((t) => t.name.toLowerCase() === table.toLowerCase())
        if (!found) {
          const avail = schema.tables.map((t) => displaySafeText(t.name)).join(', ')
          return { exitCode: 1, text: `Table ${echoedValue(table)} not found in SQLite database ${displaySafePath(target)}. Available tables: ${avail}` }
        }
        if (json === true) {
          return { exitCode: 0, text: fenceCap.capListField(found, 'columns', (o) => displaySafeJson(fenceJsonStrings(o, fenceFileFieldIfMatched))) }
        }
        const lines = [
          `# SQLite Table: ${displaySafeText(found.name)} (${displaySafeText(found.kind)}) in ${displaySafePath(target)}`,
          `Row Count: ${found.rowCount ?? 'unknown'}`,
          '',
          '| Column | Type | Nullable | Default | PK |',
          '| :--- | :--- | :--- | :--- | :--- |',
        ]
        for (const col of found.columns) {
          lines.push(`| \`${displaySafeText(col.name)}\` | \`${col.type}\` | ${col.notNull ? 'NO' : 'YES'} | ${col.defaultValue ?? 'NULL'} | ${col.primaryKey ? 'YES' : 'NO'} |`)
        }
        // A virtual table whose module is not loaded has no columns to list: the CREATE statement is its schema.
        if (found.createSql !== undefined) lines.push('', `Module ${displaySafeText(found.module ?? '?')} is not loaded here, so columns are not available. Declared as:`, displaySafeText(found.createSql))
        return { exitCode: 0, text: capAndFence(lines.join('\n')) }
      }
      if (json === true) {
        return { exitCode: 0, text: fenceCap.capListField(schema, 'tables', (o) => displaySafeJson(fenceJsonStrings(o, fenceFileFieldIfMatched))) }
      }
      return { exitCode: 0, text: capAndFence(formatSqliteSchema(schema)) }
    }
  } catch (err: unknown) {
    return { exitCode: 1, text: `Error reading SQLite database ${displaySafePath(target)}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return undefined
}
