/**
 * The sentinel that means "no cap" in a `LIMIT ?` bound parameter.
 *
 * SQLite treats a negative LIMIT as unbounded, including when it arrives as a bound parameter, so
 * every query helper in this codebase accepts -1 without needing a second code path for the
 * uncapped case. Three constants in graph_traversal.ts already encoded that fact independently and
 * read_commands.ts needs it too but cannot import graph_traversal.ts -- that module imports back
 * from read_commands.ts, and a cycle between two widely-imported modules is the shape that passes
 * both typecheck and vitest and only fails once esbuild orders the bundle.
 *
 * This is a leaf with no imports of its own, so nothing can cycle through it.
 */

/** SQLite reads a negative `LIMIT` as unbounded, bound parameter included. Prefer this over a large finite number: a cap chosen as "surely more than anything real" is a silent truncation waiting for a project that outgrows it, and the SQL applies it before any client-side predicate can run. */
export const UNBOUNDED_QUERY_LIMIT = -1
