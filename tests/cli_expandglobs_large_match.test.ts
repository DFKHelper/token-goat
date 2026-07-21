// Regression: expandGlobs (src/cli.ts, shared by cmdPack/cmdTokens/cmdBudget) built its
// resolved-path list via `out.push(...hits.map(...))`. Spreading a large glob match set (the
// realistic case for `token-goat tokens '**/*'`/`token-goat budget '**/*'` on a big project) as
// call arguments blows the engine's call-stack limit (RangeError: Maximum call stack size
// exceeded) well within a real project's file count. Worse than a crash: expandGlobs' own
// try/catch swallows that RangeError as "not a valid glob pattern, fall through to literal
// path", so a genuinely huge match set silently becomes zero matched files -- `token-goat
// tokens`/`budget` reports "No files matched" instead of the real, large file list.
import { describe, expect, it } from 'vitest'

import { expandGlobs } from '../src/cli.js'

describe('expandGlobs', () => {
  it('resolves every match instead of silently dropping to zero when a glob pattern matches an array large enough to overflow a spread call', () => {
    const N = 150_000
    const hits = Array.from({ length: N }, (_, i) => `file${i}.ts`)
    // globFnOverride substitutes for fs.globSync so this stays a fast, disk-free unit test --
    // the bug is in expandGlobs' own array handling of whatever glob returns, not in glob
    // matching itself, so a real filesystem with 150k real files would only make the test slow
    // without exercising anything the override doesn't already cover.
    const result = expandGlobs('/repo', ['*.ts'], () => hits)
    expect(result).toHaveLength(N)
    expect(result[0]).toContain('file0.ts')
    expect(result[N - 1]).toContain(`file${N - 1}.ts`)
  })
})
