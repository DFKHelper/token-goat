/**
 * Structural guard on what the core bundle *loads* at startup.
 *
 * Every CLI call and every spawned hook process reads `dist/token-goat.mjs`, which imports
 * `dist/token-goat.core.mjs`. V8 compiles a module in full before running any of it, so code
 * sitting behind a dynamic import is still parsed on every single invocation when esbuild inlines
 * it into one file: only its *execution* is deferred. Building with `splitting: true` moves those
 * bytes into sibling chunks that are read only if the dynamic import actually fires.
 *
 * The assertion is on the static import graph of the built output, not on total bundle size:
 * dropping `splitting: true` leaves the total unchanged while moving every byte back into the
 * eager set, which is exactly the regression this guards. Reading dist/ rather than re-bundling
 * means it checks the artifact that actually ships.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, '..', '..', 'dist')
const ENTRY = path.join(DIST, 'token-goat.core.mjs')
const CORE_CHUNK_PREFIX = 'token-goat-chunk-'

/**
 * Ceiling on what the entry may pull in statically. The split build loads about 2.83 MB of a
 * 3.41 MB output; the pre-split monolith was 3.61 MB in one file. The headroom is deliberate --
 * this is a regression trip-wire for the whole bundle collapsing back into the eager set, not a
 * budget to be tuned on every dependency change.
 */
const MAX_EAGER_BYTES = 3.2 * 1024 * 1024

/** Chunk filenames the given built file imports with a static `import ... from "./..."`. */
function staticChunkImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const out = new Set<string>()
  // esbuild emits static chunk edges as `from"./name.mjs"` or `import"./name.mjs"`; a deferred
  // edge is `import("./name.mjs")` with parentheses, which neither pattern matches.
  for (const re of [/from\s*"(\.\/[^"]+\.mjs)"/g, /(?:^|[;\n])import\s*"(\.\/[^"]+\.mjs)"/g]) {
    for (const m of text.matchAll(re)) if (m[1] !== undefined) out.add(path.basename(m[1]))
  }
  return [...out]
}

/** Transitive closure of static chunk edges starting at the core entry. */
function eagerChunks(): Set<string> {
  const seen = new Set<string>()
  const queue = staticChunkImports(ENTRY)
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined || seen.has(next)) continue
    const full = path.join(DIST, next)
    if (!fs.existsSync(full)) continue
    seen.add(next)
    queue.push(...staticChunkImports(full))
  }
  return seen
}

describe('core bundle stays split', () => {
  it('emits core chunks rather than one monolithic file', () => {
    const chunks = fs.readdirSync(DIST).filter((f) => f.startsWith(CORE_CHUNK_PREFIX))
    expect(chunks.length, 'no core chunks in dist/ -- splitting:true was dropped').toBeGreaterThan(1)
  })

  it('defers at least one chunk instead of importing them all statically', () => {
    // The non-vacuous half: chunks existing proves nothing on its own if the entry statically
    // imports every one of them, which is what a monolith looks like after a mechanical split.
    const all = fs.readdirSync(DIST).filter((f) => f.startsWith(CORE_CHUNK_PREFIX))
    const eager = eagerChunks()
    const deferred = all.filter((f) => !eager.has(f))
    expect(deferred.length, `every core chunk is eagerly imported (${all.length} chunks)`).toBeGreaterThan(0)
  })

  it('keeps the eagerly loaded set under the regression ceiling', () => {
    const eager = eagerChunks()
    let bytes = fs.statSync(ENTRY).size
    for (const chunk of eager) bytes += fs.statSync(path.join(DIST, chunk)).size
    expect(bytes, `eager startup set is ${(bytes / 1024 / 1024).toFixed(2)} MB`).toBeLessThan(MAX_EAGER_BYTES)
  })
})
