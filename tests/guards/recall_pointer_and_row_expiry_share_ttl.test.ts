import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * S1 (gap_analysis_pass3.md section 4, finding 6): `cache_recall` rows outlived their disk blobs
 * (25,062/30,655 rows measured older than the blob TTL; a 300-row sample of those resolved to
 * ZERO present blobs), and `cli_recall.ts` printed a `token-goat bash-output <id>` pointer for a
 * blob that had already been pruned -- a dead pointer the caller has no way to detect before
 * following it. The fix needed BOTH halves to hold, or the defect just moves:
 *
 *  1. `cli_recall.ts` must never print a per-type recall-command pointer unless the blob it names
 *     is confirmed present on disk right now (see recall_index.ts's `blobStillExists`).
 *  2. `cache_recall` rows must not accumulate forever after their blob expires -- row expiry and
 *     blob-prune TTL must derive from ONE shared constant (DEFAULT_MAX_AGE_MS in disk_cache.ts),
 *     never a second hand-copied number that can silently drift from the real blob lifetime.
 *
 * This is static-analysis only (source text, no DB, no filesystem beyond reading this repo's own
 * source) so it stays on the fast pre-commit tier (tests/guards, see run-guards.sh) rather than
 * the slower pre-push/CI-only tier a real-I/O regression test would need.
 */

const CLI_RECALL_SRC = readFileSync(new URL('../../src/cli_recall.ts', import.meta.url), 'utf-8')
const RECALL_INDEX_SRC = readFileSync(new URL('../../src/recall_index.ts', import.meta.url), 'utf-8')

describe('cache_recall pointer suppression and row-expiry share one TTL constant (S1)', () => {
  it('finds the pointer-emitting line and the row-pruning function at all, so an empty scan cannot pass vacuously', () => {
    expect(CLI_RECALL_SRC).toMatch(/RECALL_COMMAND\[hit\.cacheType\]/)
    expect(RECALL_INDEX_SRC).toMatch(/function pruneCacheRecallRows/)
  })

  it('gates every RECALL_COMMAND pointer template literal on hit.blobPresent, not an unconditional print', () => {
    // The exact call shape a print site uses to build the "run this command to recall the full
    // blob" pointer. Any occurrence of RECALL_COMMAND[...] used to build that pointer text must
    // sit inside a `hit.blobPresent ? ... : ...` conditional (or an equivalent narrowed branch),
    // never printed unconditionally -- an unconditional print is exactly the dead-pointer defect.
    const pointerLines = CLI_RECALL_SRC.split('\n').filter((l) => l.includes('RECALL_COMMAND['))
    expect(pointerLines.length).toBeGreaterThan(0)
    for (const line of pointerLines) {
      expect(line, `pointer-emitting line does not reference blobPresent: ${line.trim()}`).toMatch(/blobPresent/)
    }
  })

  it('pruneCacheRecallRows defaults its max-age parameter to DEFAULT_MAX_AGE_MS imported from disk_cache.ts, not a second hand-copied constant', () => {
    expect(RECALL_INDEX_SRC, 'recall_index.ts must import DEFAULT_MAX_AGE_MS from disk_cache.ts').toMatch(
      /import\s*\{[^}]*\bDEFAULT_MAX_AGE_MS\b[^}]*\}\s*from\s*['"]\.\/disk_cache\.js['"]/,
    )
    expect(
      RECALL_INDEX_SRC,
      'pruneCacheRecallRows must default its maxAgeMs parameter to the shared DEFAULT_MAX_AGE_MS constant, not a duplicated numeric literal',
    ).toMatch(/function pruneCacheRecallRows\([^)]*=\s*DEFAULT_MAX_AGE_MS[^)]*\)/)
  })

  it('indexRecallEntry actually calls pruneCacheRecallRows so rows do not accumulate on every write', () => {
    // Sliced to indexRecallEntry's own body only -- up to the next top-level function declaration
    // -- not a fixed character window. pruneCacheRecallRows is declared immediately after
    // indexRecallEntry in this file, so a window wide enough to reach a real call could instead
    // land on `export function pruneCacheRecallRows(` itself (the definition, not a call site)
    // and pass even with the call deleted from indexRecallEntry's body.
    const start = RECALL_INDEX_SRC.indexOf('function indexRecallEntry')
    expect(start, 'could not find indexRecallEntry in recall_index.ts').toBeGreaterThanOrEqual(0)
    const rest = RECALL_INDEX_SRC.slice(start + 'function indexRecallEntry'.length)
    const nextFnOffset = rest.search(/\n(export )?function /)
    const indexRecallEntryBody = nextFnOffset === -1 ? rest : rest.slice(0, nextFnOffset)
    expect(indexRecallEntryBody).toMatch(/pruneCacheRecallRows\(\)/)
  })
})
