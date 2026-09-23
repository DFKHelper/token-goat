/**
 * Full-scope symbol scanning for the commands that filter symbol names client-side.
 *
 * `querySymbols` applies its `limit` in SQL, so a caller that asks for one capped page and then
 * narrows it with a JavaScript predicate only ever sees matches that sorted inside that page.
 * Several commands papered over this by passing a deliberately large cap (20,000) and treating it
 * as "everything" -- but three indexed projects on the machine this was measured on exceed it, one
 * of them by 11.7x (234,675 symbols), so `find` and `locate` answered from the alphabetically
 * first 8.5% of that project and reported the other 91.5% as absent. Worse than absent: both fall
 * back to near-name matching when nothing matched, so a symbol that is indexed came back as a
 * confident list of unrelated files.
 *
 * Paging the whole scope removes the window instead of widening it. `querySymbols` orders by
 * `file_path, line_start, rowid` -- the rowid tie-break is there precisely so successive `OFFSET`
 * pages cannot drop or repeat a row across a page boundary -- so a visitor walk over its pages sees
 * every row in the scope exactly once. This lives here rather than as a new `querySymbols` option
 * because src/index_reader.ts is hashed into EMBED_FINGERPRINT: editing it would re-embed every
 * already-indexed file on every machine to buy a fix that needs no new SQL at all.
 *
 * `querySymbols({ limit: -1 })` does already mean "no limit" -- SQLite reads a negative LIMIT as
 * unbounded, and the kind-scoped callers in graph_analysis.ts and graph_inspection.ts use it. It is
 * not the fix here because these callers scan a whole project rather than one `kind`: a single
 * unbounded array would hold every row's body at once, where paging holds one page and lets the
 * caller keep only the names, paths or display rows it will actually use.
 *
 * src/answer_router.ts::resolveSymbolHit pages the same way and deliberately does not use this: it
 * searches for the first acceptable row rather than visiting every one, so it stops on its first
 * page in the common case and takes a much smaller page size to make that cheap.
 */

import { querySymbols } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'

/** Rows fetched per page. Small enough that a page's bodies are cheap to hold transiently, large enough that a 234k-symbol project costs ~24 queries rather than hundreds -- `OFFSET` re-walks the rows it skips, so more pages is strictly more work. */
const SYMBOL_SCAN_PAGE = 10_000

/**
 * Visit every symbol matching `queryOpts`, in the index's own order, with no cap.
 *
 * `queryOpts` takes the same filters as {@link querySymbols} minus `limit`/`offset`, which this
 * owns. The walk terminates on the first short page: `offset` only ever increases and the table is
 * finite, so there is no bound to disclose and no truncation for a caller to report.
 */
export function forEachSymbol(
  queryOpts: Omit<NonNullable<Parameters<typeof querySymbols>[0]>, 'limit' | 'offset'>,
  visit: (symbol: SymbolEntry) => void,
): void {
  for (let offset = 0; ; offset += SYMBOL_SCAN_PAGE) {
    const rows = querySymbols({ ...queryOpts, limit: SYMBOL_SCAN_PAGE, offset })
    for (const row of rows) visit(row)
    if (rows.length < SYMBOL_SCAN_PAGE) return
  }
}
