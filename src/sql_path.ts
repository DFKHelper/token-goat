import { foldPath, isCaseInsensitiveFs, normalizePath } from './util.js'

// Build a `<column> = ?` SQL comparison for path equality. Callers MUST fold the path parameter using foldPath() before binding (see parser.ts, embeddings.ts, index_reader.ts). On case-insensitive filesystems, we fold the column value using TG_LOWER() -- a custom SQL scalar function registered on every connection in db.ts's initConnection() that wraps the exact same foldCase() primitive foldPath() uses on the JS side. SQLite's built-in LOWER() only folds ASCII A-Z (confirmed no custom LOWER override exists), so it would silently diverge from foldPath() for non-ASCII casing (e.g. `Ä` vs `ä`); TG_LOWER keeps SQL-side and JS-side folding byte-for-byte consistent across parser.ts, embeddings.ts, index_reader.ts, worker.ts, and index_prune.ts.
export function pathEqClause(column: string): string {
  return isCaseInsensitiveFs() ? `TG_LOWER(${column}) = ?` : `${column} = ?`
}

/**
 * Build a half-open range predicate for "file_path is under this project root", plus a matching
 * `params()` function that turns a root directory into the two bounds it binds. Every indexed
 * `file_path` is stored via `normalizePath()`, which always uses forward slashes (see paths.ts)
 * -- so the prefix boundary separator here is always `/`, never `path.sep`, regardless of host
 * platform.
 *
 * Case folding mirrors `pathEqClause`: on a case-insensitive filesystem the column is wrapped
 * in `TG_LOWER()` and the bind parameters are folded with `foldPath()` so SQL-side and JS-side
 * folding stay byte-for-byte consistent.
 *
 * Boundary correctness: the lower bound is the root suffixed with `/`, so a root of `/proj`
 * produces `>= '/proj/'` -- this matches `/proj/file.ts` and `/proj/sub/file.ts` but NOT
 * `/proj-other/file.ts`. The upper bound replaces that trailing `/` (U+002F) with `0` (U+0030),
 * the next code point, so the range holds exactly the strings that begin with the lower bound
 * and nothing else: to land inside it a string must share every character up to the separator
 * and then carry a character in `['/', '0')`, which is only `/` itself.
 *
 * This used to be `LIKE ? ESCAPE '\'`, which was correct but could not be served from an index:
 * SQLite's LIKE-to-range optimization is disabled outright whenever an ESCAPE clause is present,
 * so every project-scoped query scanned the whole machine-wide index and then filtered. Writing
 * the range out by hand is what the optimization would have produced anyway, and it needs no
 * wildcard escaping at all, since `%` and `_` in a root path are now ordinary characters. It
 * also drops LIKE's implicit ASCII case folding, which on a case-sensitive filesystem let a
 * project at `/home/x/Repo` match rows belonging to a genuinely different `/home/x/repo`.
 */
export function projectScopeClause(column: string): {
  clause: string
  params: (root: string) => [string, string]
} {
  const caseInsensitive = isCaseInsensitiveFs()
  const col = caseInsensitive ? `TG_LOWER(${column})` : column
  return {
    // Parenthesised so an OR anywhere in the surrounding WHERE cannot bind tighter than the pair.
    clause: `(${col} >= ? AND ${col} < ?)`,
    params: (root: string): [string, string] => {
      const folded = caseInsensitive ? foldPath(normalizePath(root)) : normalizePath(root)
      const lower = folded.endsWith('/') ? folded : `${folded}/`
      const upper = `${lower.slice(0, -1)}0`
      return [lower, upper]
    },
  }
}
