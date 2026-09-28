/** Full-scope symbol scanning for the commands that filter symbol names client-side. `querySymbols` applies its `limit` in SQL, so a caller that asks for one capped page and then narrows it with a JavaScript predicate only ever sees matches that sorted inside that page. Several commands papered over this by passing a deliberately large cap (20,000) and treating it as "everything" -- but three indexed projects on the machine this was measured on exceed it, one of them by 11.7x (234,675 symbols), so `find` and `locate` answered from the alphabetically first 8.5% of that project and reported the other 91.5% as absent. Worse than absent: both fall back to near-name matching when nothing matched, so a symbol that is indexed came back as a confident list of unrelated files. Paging the whole scope removes the window instead of widening it. The pages are keyset pages over the file-path index rather than `querySymbols` `OFFSET` pages, which the first version of this walk used and which made it cost minutes on a large project: see {@link forEachSymbol}. This lives here rather than as a new `querySymbols` option because src/index_reader.ts is hashed into EMBED_FINGERPRINT: editing it would re-embed every already-indexed file on every machine. `querySymbols({ limit: -1 })` does already mean "no limit" -- SQLite reads a negative LIMIT as unbounded, and the kind-scoped callers in graph_analysis.ts and graph_inspection.ts use it. It is not the fix here because these callers scan a whole project rather than one `kind`: a single unbounded array would hold every row at once, where paging holds one page and lets the caller keep only the names, paths or display rows it will actually use. src/answer_router.ts::resolveSymbolHit pages `querySymbols` by `OFFSET` and deliberately does not use this: it asks for one name, so each of its pages sorts only that name's rows, and it stops on the first acceptable row, on its first page in the common case. */

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import type { querySymbols } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { normalizePath } from './paths.js'
import { pathEqClause, projectScopeClause } from './sql_path.js'
import { foldPath, isCaseInsensitiveFs } from './util.js'

/** Rows fetched per page. Each page is one index seek that reads about as many rows as it returns, so the size only trades statement count against the memory one page holds. */
const SYMBOL_SCAN_PAGE = 10_000

/** The filters a scan takes: the subset of {@link querySymbols}'s that its callers use. They are rebuilt below rather than shared with index_reader.ts's `buildSymbolWhere`, which is not exported and cannot become so without moving EMBED_FINGERPRINT; tests/symbol_scan_keyset.test.ts holds the two to the same rows for every filter. */
export type SymbolScanScope = Pick<NonNullable<Parameters<typeof querySymbols>[0]>, 'rootDir' | 'filePath' | 'name' | 'kind'>

/** One scanned symbol without its body, docstring or parent: what a caller filtering on name and path needs, and none of what makes a row expensive to read. `id` is the rowid, for {@link symbolsById}. */
export interface SymbolHead {
  id: number
  filePath: string
  name: string
  kind: string
  lineStart: number
  lineEnd: number
}

interface ScanRow {
  id: number
  file_path: string
  name: string
  kind: string
  line_start: number
  line_end: number
  k: string
}

/** Visit every symbol matching `scope` exactly once, with no cap, in the order of the file-path index: the folded file path (the raw one on a case-sensitive filesystem), then rowid. That is not `querySymbols`'s `file_path, line_start, rowid`, so a caller that keeps the first N rows collects them with {@link FirstRows}, which restores that order exactly. Each page resumes after the last row the previous one returned (`key >= last AND (key > last OR id > lastId)`) instead of skipping an `OFFSET`, so every page is one seek on that index and reads only the rows it returns, plus the earlier rows of the one file the previous page ended in. The walk this replaces paged `querySymbols` by `OFFSET`, and its `ORDER BY file_path` is not the order of any index (the index is on the folded path), so every page sorted every row in scope, bodies included, before skipping to its offset: on a 546,394-symbol project its 55 pages grew from 1.2 s to 5.2 s each and one `find` took 165 s. As keyset pages the same project reads in about 1.8 s at a flat 25 ms a page. A resumed page binds the key as its only lower bound: with the project range's own `>=` beside it, SQLite seeked from the start of the range and filtered, and the pages grew again (37 ms to 255 ms). */
export function forEachSymbol(scope: SymbolScanScope, visit: (symbol: SymbolHead) => void): void {
  const key = isCaseInsensitiveFs() ? 'TG_LOWER(file_path)' : 'file_path'
  const where: string[] = []
  const params: (string | number)[] = []
  if (scope.name !== undefined) {
    where.push('name = ?')
    params.push(scope.name)
  }
  if (scope.filePath !== undefined) {
    // The spellings querySymbols matches: the index key, and on a path with a separator the other separator too, since not every writer stored a forward-slash path.
    const fileKey = normalizePath(scope.filePath)
    if (fileKey.includes('/') || fileKey.includes('\\')) {
      const alt = fileKey.includes('/') ? fileKey.replace(/\//g, '\\') : fileKey.replace(/\\/g, '/')
      where.push(`(${pathEqClause('file_path')} OR ${pathEqClause('file_path')})`)
      params.push(foldPath(fileKey), foldPath(alt))
    } else {
      where.push(`(${pathEqClause('file_path')})`)
      params.push(foldPath(fileKey))
    }
  }
  if (scope.kind !== undefined) {
    where.push('kind = ?')
    params.push(scope.kind)
  }
  const [lower, upper] = scope.rootDir === undefined ? [undefined, undefined] : projectScopeClause('file_path').params(normalizePath(scope.rootDir))
  const db = getDb(globalDbPath())
  let last: ScanRow | undefined
  for (;;) {
    const clauses = [...where]
    const bound: (string | number)[] = []
    const from = last?.k ?? lower
    if (from !== undefined) {
      clauses.push(`${key} >= ?`)
      bound.push(from)
    }
    if (upper !== undefined) {
      clauses.push(`${key} < ?`)
      bound.push(upper)
    }
    if (last !== undefined) {
      clauses.push(`(${key} > ? OR id > ?)`)
      bound.push(last.k, last.id)
    }
    const sql = `SELECT id, file_path, name, kind, line_start, line_end, ${key} AS k FROM symbols${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${key}, id LIMIT ?`
    const rows = db.prepare(sql).all(...params, ...bound, SYMBOL_SCAN_PAGE) as ScanRow[]
    for (const r of rows) visit({ id: r.id, filePath: r.file_path, name: r.name, kind: r.kind, lineStart: r.line_start, lineEnd: r.line_end })
    if (rows.length < SYMBOL_SCAN_PAGE) return
    last = rows[rows.length - 1]
  }
}

interface FullRow {
  id: number
  file_path: string
  name: string
  kind: string
  line_start: number
  line_end: number
  body: string | null
  docstring: string | null
  parent: string | null
}

/** Full rows for `ids`, in the order given. A row deleted since it was scanned (the worker reindexed its file in between) is left out rather than invented. */
export function symbolsById(ids: readonly number[]): SymbolEntry[] {
  const db = getDb(globalDbPath())
  const byId = new Map<number, SymbolEntry>()
  // SQLite caps the parameters one statement binds, and a caller's --limit decides how many ids arrive here.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const sql = `SELECT id, file_path, name, kind, line_start, line_end, body, docstring, parent FROM symbols WHERE id IN (${chunk.map(() => '?').join(', ')})`
    for (const r of db.prepare(sql).all(...chunk) as FullRow[]) {
      byId.set(r.id, { filePath: r.file_path, name: r.name, kind: r.kind, lineStart: r.line_start, lineEnd: r.line_end, body: r.body ?? '', docstring: r.docstring ?? '', parent: r.parent ?? '' })
    }
  }
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/** SQLite's BINARY collation, which compares two TEXT values by their UTF-8 bytes. That is code point order. JavaScript's `<` compares UTF-16 units, which agrees everywhere except where a surrogate (half of a code point above U+FFFF) meets a unit from U+E000 to U+FFFF: that unit is the smaller of the two in UTF-16 and the larger as a code point. */
export function compareBinary(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    const xSurrogate = x >= 0xd800 && x <= 0xdfff
    const ySurrogate = y >= 0xd800 && y <= 0xdfff
    if (xSurrogate !== ySurrogate && (xSurrogate ? y : x) >= 0xe000) return xSurrogate ? 1 : -1
    return x - y
  }
  return a.length - b.length
}

/** `querySymbols`'s own order, `file_path, line_start, rowid`, for rows a scan visited in index order. */
export function compareQueryOrder(a: SymbolHead, b: SymbolHead): number {
  return compareBinary(a.filePath, b.filePath) || a.lineStart - b.lineStart || a.id - b.id
}

/** The first `cap` of the rows offered by {@link compareQueryOrder}: the rows `querySymbols` with the same filters and `LIMIT cap` returns, whatever order {@link forEachSymbol} visits them in. A caller that kept the first N rows it met relied on the scan order being the query order, which the keyset scan does not keep. */
export class FirstRows<T extends SymbolHead> {
  private readonly kept: T[] = []
  constructor(private readonly cap: number) {}

  offer(row: T): void {
    const kept = this.kept
    const worst = kept[kept.length - 1]
    if (kept.length >= this.cap && (worst === undefined || compareQueryOrder(row, worst) >= 0)) return
    let lo = 0
    let hi = kept.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareQueryOrder(kept[mid] as T, row) <= 0) lo = mid + 1
      else hi = mid
    }
    kept.splice(lo, 0, row)
    if (kept.length > this.cap) kept.pop()
  }

  rows(): T[] {
    return [...this.kept]
  }
}

/** Most distinct symbol names a miss will rank for near-name suggestions in one project. A backstop rather than a cap an ordinary project meets: the largest project on the machine this was measured on holds 546,394 symbols under 72,406 distinct names, which one names-only query returns in about 0.7 s and ranking scans in milliseconds. Past it the miss says the suggestions were skipped instead of ranking a subset, which would read as the project-wide nearest and not be. */
export const SUGGEST_NAME_BUDGET = 500_000

/** Every distinct symbol name indexed under `rootDir`, or `null` when there are more than `budget` of them. Names only, from one statement served by the `(TG_LOWER(file_path), name)` covering index, so no row's body is read and nothing is paged. A miss used to find its near names with a {@link forEachSymbol} walk when that paged by `OFFSET`, which sent every page through a temp B-tree sort of every row in scope, bodies included (a scan of N rows in pages of P re-sorts about N*N/(2P) rows), and cost minutes. The walk is keyset-paged now, but one statement over a covering index still reads less than a walk of every row. The `LIMIT` makes SQLite stop at the first name past the budget rather than read the rest, and `.all()` rather than an early-exited `iterate()` leaves no half-stepped statement holding a read snapshot open in a long-lived process such as the MCP server. */
export function projectSymbolNames(rootDir: string, budget: number = SUGGEST_NAME_BUDGET): string[] | null {
  const { clause, params } = projectScopeClause('file_path')
  const sql = `SELECT DISTINCT name FROM symbols WHERE ${clause} AND name IS NOT NULL LIMIT ?`
  const names = getDb(globalDbPath()).prepare(sql).pluck().all(...params(rootDir), budget + 1) as string[]
  return names.length > budget ? null : names
}

/** Every JSON or YAML file under `rootDir` that has at least one indexed symbol, sorted: the candidate list a miss hands to findStructuredKeyPath (read_suggest.ts). Walks `files`, one row per file, and asks `symbols` only whether each candidate has a row, instead of reading the file path of every symbol in scope: about 170 ms against 1.7 s on a 546k-symbol project, for the identical set of 15,272 files. The path returned is the one stored on the symbol row, so a caller displays the same spelling it did when it collected these from a full-row scan. LIKE folds ASCII case, so `.JSON` and `.Yml` qualify exactly as they did under the old `toLowerCase().endsWith(...)` test. */
export function projectStructuredFiles(rootDir: string): string[] {
  const { clause, params } = projectScopeClause('f.path')
  const sameFile = isCaseInsensitiveFs() ? 'TG_LOWER(s.file_path) = TG_LOWER(f.path)' : 's.file_path = f.path'
  const sql =
    `SELECT (SELECT s.file_path FROM symbols s WHERE ${sameFile} LIMIT 1) AS fp FROM files f ` +
    `WHERE ${clause} AND (f.path LIKE '%.json' OR f.path LIKE '%.yaml' OR f.path LIKE '%.yml') AND fp IS NOT NULL`
  const files = getDb(globalDbPath()).prepare(sql).pluck().all(...params(rootDir)) as string[]
  return [...new Set(files)].sort()
}
