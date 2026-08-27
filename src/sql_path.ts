import { foldPath, isCaseInsensitiveFs, normalizePath } from './util.js'

// Build a `<column> = ?` SQL comparison for path equality. Callers MUST fold the path parameter using foldPath() before binding (see parser.ts, embeddings.ts, index_reader.ts). On case-insensitive filesystems, we fold the column value using TG_LOWER() -- a custom SQL scalar function registered on every connection in db.ts's initConnection() that wraps the exact same foldCase() primitive foldPath() uses on the JS side. SQLite's built-in LOWER() only folds ASCII A-Z (confirmed no custom LOWER override exists), so it would silently diverge from foldPath() for non-ASCII casing (e.g. `Ä` vs `ä`); TG_LOWER keeps SQL-side and JS-side folding byte-for-byte consistent across parser.ts, embeddings.ts, index_reader.ts, worker.ts, and index_prune.ts.
export function pathEqClause(column: string): string {
  return isCaseInsensitiveFs() ? `TG_LOWER(${column}) = ?` : `${column} = ?`
}

// Build a "this row's file_path has that final path segment" comparison, plus the params it binds. Used to narrow a name-only symbol query down to the rows a partial-path spec (`worker.ts::drain`) could possibly match, BEFORE the query's LIMIT truncates the candidate list -- a JS-side suffix filter applied after `ORDER BY file_path ... LIMIT n` silently loses the requested file whenever more than n rows share the symbol name. Basename equality is a necessary condition for either direction of the path-boundary suffix test the caller then applies, because a boundary suffix relation always aligns whole segments, so this narrowing never excludes a row the caller would have accepted. `substr(col, -length(x)) = x` is used instead of `LIKE '%/' || x` so a `_` or `%` in a real file name is not treated as a wildcard, and so the character-count semantics of the comparison come entirely from SQLite rather than being split across JS UTF-16 lengths and SQL character lengths.
export function pathSuffixClause(column: string): {
  clause: string
  params: (baseName: string) => string[]
} {
  const col = isCaseInsensitiveFs() ? `TG_LOWER(${column})` : column
  return {
    // Both separators are accepted because not every writer into `symbols` stores a normalizePath'd (forward-slash) file_path, and the JS-side path-boundary test this narrowing feeds treats `/` and `\` alike.
    clause: `(${col} = ? OR substr(${col}, -length(?)) = ? OR substr(${col}, -length(?)) = ?)`,
    params: (baseName: string): string[] => {
      const folded = foldPath(baseName)
      return [folded, `/${folded}`, `/${folded}`, `\\${folded}`, `\\${folded}`]
    },
  }
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
