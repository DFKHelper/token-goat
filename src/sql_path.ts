import { foldPath, isCaseInsensitiveFs, normalizePath } from './util.js'

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

/**
 * Build a `<column> LIKE ? ESCAPE '\'` SQL predicate for "file_path is under this project
 * root", plus a matching `param()` function that turns a root directory into the correctly
 * escaped LIKE pattern. Every indexed `file_path` is stored via `normalizePath()`, which
 * always uses forward slashes (see paths.ts) -- so the prefix boundary separator here is
 * always `/`, never `path.sep`, regardless of host platform.
 *
 * Case folding mirrors `pathEqClause`: on a case-insensitive filesystem the column is wrapped
 * in `TG_LOWER()` and the bind parameter is folded with `foldPath()` so SQL-side and JS-side
 * folding stay byte-for-byte consistent.
 *
 * Boundary correctness: the root is suffixed with `/` *before* the trailing `%` wildcard is
 * appended, so a root of `/proj` produces the pattern `/proj/%` -- this matches `/proj/file.ts`
 * and `/proj/sub/file.ts` but NOT `/proj-other/file.ts` (which would incorrectly match a naive
 * `/proj%` pattern).
 *
 * Wildcard escaping: LIKE treats `%` and `_` as wildcards and (implicitly) `\` as nothing
 * special until an ESCAPE clause names it -- so a root path containing a literal `%` or `_`
 * would otherwise wildcard-match unrelated paths. `param()` escapes `\`, `%`, and `_` in the
 * root (backslash first, since it's the escape character itself) before appending the `/%`
 * suffix, which is never escaped -- it's the actual wildcard.
 */
export function projectScopeClause(column: string): { clause: string; param: (root: string) => string } {
  const caseInsensitive = isCaseInsensitiveFs()
  const col = caseInsensitive ? `TG_LOWER(${column})` : column
  return {
    clause: `${col} LIKE ? ESCAPE '\\'`,
    param: (root: string): string => {
      const folded = caseInsensitive ? foldPath(normalizePath(root)) : normalizePath(root)
      const escaped = folded.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
      const withBoundary = escaped.endsWith('/') ? escaped : `${escaped}/`
      return `${withBoundary}%`
    },
  }
}
