/**
 * Doctor's oversized-stored-body check, hosted outside cli_doctor.ts.
 *
 * hooks_session_start.ts runs this one check on every SessionStart and needs nothing else from
 * cli_doctor.ts, but a static import of that module pulled its whole dependency graph -- worker,
 * install, ts_refs, cli_context_stats, smol-toml, and through index_health the entire
 * text_commands/read_commands/graph_commands cluster -- into the hook bundle's eager set, which
 * V8 parses in full before any hook runs. cli_doctor.ts re-exports both names so the doctor
 * command and its tests are unaffected. Same split as walk_mode.ts and stdin_json.ts.
 */
import * as fs from 'fs'

import { SYMBOL_BODY_CHAR_CAP } from './constants.js'
import { getDb } from './db.js'
import type { DoctorResult } from './doctor_result.js'
import { extractErrorMessage } from './util.js'

/**
 * Existence probe for a stored symbol body over the cap, exported so the query-plan guard in
 * tests/cli_doctor.test.ts can EXPLAIN the exact text the check runs rather than a retyped copy
 * of it, which would pass while the real query regressed to a full table scan.
 */
export const OVERSIZED_BODY_PROBE_SQL =
  `SELECT 1 FROM symbols WHERE LENGTH(body) > ${SYMBOL_BODY_CHAR_CAP} LIMIT 1`

/**
 * Check the largest stored symbol body against parser.ts's own `MAX_SYMBOL_BODY_CHARS` cap.
 *
 * Total DB size (see {@link DB_SIZE_WARN_BYTES}) is a lagging proxy for the pathology this
 * project actually cares about: an extractor storing far more per symbol than it should. On a
 * large multi-project global index a big total is often legitimate (many symbols, plus embedding
 * vectors), so it can stay comfortably under the size-warn line while still containing genuine
 * damage -- a handful of oversized bodies from a minified/generated file that predate the fix in
 * `boundSymbolBody` (parser.ts). Since every symbol written *after* that fix is capped at
 * `MAX_SYMBOL_BODY_CHARS`, any stored body larger than the cap can only be a pre-fix leftover, so
 * this check goes straight at the direct signal instead of waiting for the total to grow large
 * enough to trip.
 *
 * The cap is read from constants.ts rather than through parser.ts's `MAX_SYMBOL_BODY_CHARS`
 * re-export of it (same value, asserted in tests/cli_doctor.test.ts): parser.ts is 142 KB of
 * extractors this check never calls, and importing it here would put the module straight back on
 * the hook path this file exists to keep it off.
 */
export function checkSymbolBodySize(dbPath: string): DoctorResult {
  if (!fs.existsSync(dbPath)) {
    return { name: 'Symbol body size', status: 'ok', message: 'no database yet' }
  }
  try {
    const db = getDb(dbPath)
    // Existence probe served by idx_symbols_oversized_body (db.ts), a partial index over exactly
    // the violating rows. The threshold is interpolated rather than bound so the comparison text
    // matches the index predicate exactly at prepare time: SQLite will use a partial index only
    // where the query's WHERE implies the index's, and with `> ?` that decision is made against
    // whatever value happens to be bound first, so the same cached statement could be planned as
    // an index lookup or a full scan depending on the caller. Nothing but existence is selected --
    // the message below deliberately omits both the offending row's size and its path, so
    // selecting either would force a table lookup for a value no caller reads. On a healthy index
    // the b-tree is empty, so this answers without touching `symbols` at all.
    // Pinned by an EXPLAIN QUERY PLAN assertion in tests/cli_doctor.test.ts: losing the index
    // still returns the right answer, just 229 ms slower on every SessionStart, which no
    // behavioural test would notice.
    const row = db.prepare(OVERSIZED_BODY_PROBE_SQL).get() as { 1: number } | undefined
    if (row !== undefined) {
      // Deliberately omits row.filePath and row.len: this message is surfaced verbatim by
      // hooks_session_start.ts in the earliest, most cacheable position of a SessionStart
      // request, and both fields are data-derived -- the offending row (LIMIT 1, no ORDER BY)
      // isn't even guaranteed stable across two runs against the same unchanged DB, let alone
      // across a reindex. The remediation command is the actionable content; which specific
      // file happens to be first is not. Keeping this text static means only the ok/warn
      // *presence* of the check varies session to session, never its wording.
      return {
        name: 'Symbol body size',
        status: 'warn',
        message:
          `one or more stored symbol bodies exceed the ${SYMBOL_BODY_CHAR_CAP}-char cap enforced by ` +
          `boundSymbolBody -- likely a pre-fix leftover from a minified/generated file. ` +
          `A plain 'token-goat reclaim-index' (VACUUM only) CANNOT remove these rows -- it only reclaims freed ` +
          `pages, it never deletes row content. Only 'token-goat reclaim-index --rebuild' drops and re-derives ` +
          `them under the cap (stop the worker first with 'token-goat worker stop', since reclaim-index refuses ` +
          `to run while it's live); --rebuild reparses and re-embeds every indexed file across every project and ` +
          `can take a long time on a large multi-project index`,
      }
    }
    return { name: 'Symbol body size', status: 'ok', message: 'no stored symbol body exceeds the cap' }
  } catch (err) {
    return {
      name: 'Symbol body size',
      status: 'warn',
      message: `could not query symbol body size: ${extractErrorMessage(err)}`,
    }
  }
}
