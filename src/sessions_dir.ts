/**
 * Where per-session state blobs live on disk, and nothing else.
 *
 * Its own module rather than a helper inside session_store.ts so that a reader needing only the location -- `cli_stats.ts`'s standalone-run fallback -- can import it without pulling in the whole session serialization layer. `src/constants.ts`, the other plausible home beside `tokenGoatHome()`, is a parser-fingerprint extraction source: editing it restamps every indexed file on every machine, which a path accessor has no business causing.
 */

import * as path from 'node:path'

import { tokenGoatHome } from './constants.js'

/** Subdirectory of {@link tokenGoatHome} holding the per-session state blobs. */
export const SESSIONS_SUBDIR = 'sessions'

/**
 * Directory every session-state blob is written to and read from. The single source of truth for that location: token-goat has two per-user roots, `tokenGoatHome()` and `dataDir()`, and a reader that builds this path from the other one finds an empty directory rather than an error -- which is how `token-goat stats` shipped with a permanently blank top-files section.
 */
export function sessionsDir(): string {
  return path.join(tokenGoatHome(), SESSIONS_SUBDIR)
}
