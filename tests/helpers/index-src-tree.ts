/**
 * Seed a suite's isolated index with the token-goat repo's own `src` tree.
 *
 * Two suites need it (`graph_commands`, `json_envelope_shape`): their integration cases run
 * `types`/`callers`/`impact` against real code, and on a fresh checkout with an empty index those
 * commands find nothing and exit 1. Each test file gets its own data dir (see
 * tests/setup/isolate-home.ts, which keys the sandbox per file), so this really is paid once per
 * file and cannot be shared between them.
 *
 * It lived twice, copied line for line, along with a timeout constant whose comment described a
 * tree of "213 files, ~4.2MB" that had since grown. One shared home means the measurement can only
 * be wrong in one place.
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { indexFileSync } from '../../src/parser.js'
import { normalizePath } from '../../src/util.js'

/**
 * Per-hook timeout for {@link indexSrcTree}.
 *
 * The hook tree-sitter-parses the whole src tree from scratch: 226 files, 4.24 MB as measured on
 * 2026-08-19. That is ~14s wall on a 26-core developer machine with nothing else running. CI is the
 * hard case: windows-latest has 4 vCPUs and vitest runs four test files at once, so two of these
 * hooks can overlap and contend. At 120s this timed out on all three retry attempts of one run --
 * not a hang, just bounded work that no longer fit. The bound is here to catch a hook that never
 * finishes, and 300s still catches that while leaving room for a loaded runner.
 */
export const WHOLE_SRC_INDEX_TIMEOUT_MS = 300_000

/** Every `.ts` file under `dir`, recursively, excluding generated `.d.ts` declarations. */
function walkTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const child = join(dir, e.name)
    if (e.isDirectory()) return walkTsFiles(child)
    return child.endsWith('.ts') && !child.endsWith('.d.ts') ? [child] : []
  })
}

/** Index the repo's own `src` tree into the ambient (per-file, sandboxed) index. */
export function indexSrcTree(): void {
  for (const file of walkTsFiles(resolve('src'))) indexFileSync(normalizePath(file))
}
