import { isCaseInsensitiveFs } from './util.js'

// Build a `<column> = ?` SQL comparison for path equality. Callers MUST fold the path
// parameter using foldPath() before binding (see parser.ts, embeddings.ts, index_reader.ts).
// On case-insensitive filesystems, we fold the column value using TG_LOWER() -- a custom
// SQL scalar function registered on every connection in db.ts's initConnection() that wraps
// the exact same foldCase() primitive foldPath() uses on the JS side. SQLite's built-in
// LOWER() only folds ASCII A-Z (confirmed no custom LOWER override exists), so it would
// silently diverge from foldPath() for non-ASCII casing (e.g. `Ä` vs `ä`); TG_LOWER keeps
// SQL-side and JS-side folding byte-for-byte consistent across parser.ts, embeddings.ts,
// index_reader.ts, worker.ts, and index_prune.ts.
export function pathEqClause(column: string): string {
  return isCaseInsensitiveFs() ? `TG_LOWER(${column}) = ?` : `${column} = ?`
}
