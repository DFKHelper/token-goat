/** Query bounds shared by modules that sit in one import cycle, kept in a leaf with no imports of its own so nothing can cycle through it. graph_traversal.ts imports read_commands.ts, and read_commands.ts and read_spec.ts import each other; a constant one of them reads from another at load time is initialized or not depending on module evaluation order, which differs between tsx (`npm run dev`), vitest and the bundle's chunks, so it can pass typecheck, the suite and the bundle and still throw "before initialization" under tsx. */

/** SQLite reads a negative `LIMIT` as unbounded, bound parameter included, so every query helper accepts this without a second code path for the uncapped case. Prefer this over a large finite number: a cap chosen as "surely more than anything real" is a silent truncation waiting for a project that outgrows it, and the SQL applies it before any client-side predicate can run. */
export const UNBOUNDED_QUERY_LIMIT = -1

/** Symbol rows one file-scoped `querySymbols` page returns. Every caller pins the page to a single file, so this is a per-file ceiling and never a window over a project: a project-wide scan pages with forEachSymbol (symbol_scan.ts) instead. */
export const FIND_SCAN_LIMIT = 20_000
