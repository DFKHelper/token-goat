/** Seed a suite's isolated index with the named files of the token-goat repo's own `src` tree, and nothing else. Three suites need real code in the index (`graph_commands`, `json_envelope_shape`, `answer_router`): their integration cases run `types`/`callers`/`impact`/`answer` against it, and on a fresh checkout with an empty index those commands find nothing and exit 1. Each test file gets its own data dir (see tests/setup/isolate-home.ts, which keys the sandbox per file), so this is paid once per file and cannot be shared between them. These suites used to index the whole `src` tree, which grows with every commit: measured on 2026-10-19 (531 files, 9.0 MB, embeddings off), the parse took about 6 s and the row writes about 4 to 6 s on a developer machine, and a windows-latest shard ran the same loop past a 300 s hook ceiling. Which files a suite reads is a short, fixed list, so each suite names its own and the cost no longer follows the tree. A named file that is gone throws rather than shrinking the seed, so a rename fails here with the file's name instead of as an empty `callers` result three hundred lines later. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { indexFileSync } from '../../src/parser.js'
import { normalizePath } from '../../src/util.js'

/** Index each repo-relative file in `files` into the ambient (per-file, sandboxed) index. */
export function indexSrcFiles(files: readonly string[]): void {
  for (const rel of files) {
    const abs = resolve(rel)
    if (!existsSync(abs)) throw new Error(`seed file ${rel} does not exist; update the suite's seed list`)
    indexFileSync(normalizePath(abs))
  }
}
