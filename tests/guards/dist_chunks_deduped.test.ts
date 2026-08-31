/**
 * Structural guard on what `dist/` *ships*, as opposed to what it loads.
 *
 * The CLI entry (`token-goat.core.mjs`) and the in-process hook library (`token-goat-hook.mjs`)
 * are two entry points over almost the same set of modules. They were built by two separate
 * `esbuild.build()` calls writing into the same directory under disjoint chunk-name prefixes,
 * which meant esbuild had no way to share anything between them: every module both entries reach
 * was emitted twice. `dist/` was 6.75 MB across 31 files with 3.37 MB of it a verbatim second
 * copy, and all of it shipped, because package.json's `files` takes the whole directory. Building
 * both entries in one call lets code splitting share the chunks: 18 files, 3.37 MB, and the
 * packed tarball 1.60 MB -> 0.84 MB.
 *
 * Nothing failed while the copies were there. Both bundles worked, both loaded the same bytes at
 * startup, and every existing guard passed -- the only symptom was that an install downloaded
 * twice what it needed. That is precisely the shape a size assertion catches and a behavioural one
 * does not, so this file asserts on the emitted file set.
 *
 * The three assertions are deliberately different questions. Duplicate content catches the
 * regression directly. Shared chunks keep that from passing vacuously: deleting one entry
 * entirely would also remove every duplicate. The hook's eager ceiling covers the risk the merge
 * itself introduced, since sharing chunks across entries re-draws every chunk boundary and could
 * have pulled bytes the hook only needs lazily into the set it parses on every tool call.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

import { CORE_BUNDLE, HOOK_BUNDLE, ROOT } from '../helpers/bundle.js'

const DIST = path.join(ROOT, 'dist')
/** The named outputs. Everything else in dist/ is a content-hashed chunk. */
const ENTRY_FILES = new Set(['token-goat.mjs', 'token-goat.core.mjs', 'token-goat-hook.mjs'])

/**
 * Ceiling on what the hook entry pulls in statically, mirroring the core's ceiling in
 * core_bundle_stays_split.test.ts. A bridge `import()`s this bundle on nearly every tool call and
 * V8 parses every byte of the eager set before running any of it. Measured at 1.837 MB across 7
 * chunks both before and after the two builds were merged; the headroom is a regression trip-wire,
 * not a budget to re-tune on every dependency change.
 */
const MAX_HOOK_EAGER_BYTES = 2.4 * 1024 * 1024

/** Chunk filenames `file` imports with a static `import ... from "./..."`, not a deferred one. */
function staticChunkImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const out = new Set<string>()
  // A deferred edge is `import("./name.mjs")` with parentheses, which neither pattern matches.
  for (const re of [/from\s*"(\.\/[^"]+\.mjs)"/g, /(?:^|[;\n])import\s*"(\.\/[^"]+\.mjs)"/g]) {
    for (const m of text.matchAll(re)) if (m[1] !== undefined) out.add(path.basename(m[1]))
  }
  return [...out]
}

/** Every chunk `entry` reaches, following `kind` edges transitively. */
function closure(entry: string, kind: 'static' | 'any'): Set<string> {
  const edges =
    kind === 'static'
      ? staticChunkImports
      : (file: string): string[] => {
          const out = new Set<string>()
          for (const m of fs.readFileSync(file, 'utf8').matchAll(/["(]\s*"?(\.\/[^"')]+\.mjs)"/g)) {
            out.add(path.basename(m[1]!))
          }
          return [...out]
        }
  const seen = new Set<string>()
  const queue = edges(entry)
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined || seen.has(next)) continue
    const full = path.join(DIST, next)
    if (!fs.existsSync(full)) continue
    seen.add(next)
    queue.push(...edges(full))
  }
  return seen
}

function chunkFiles(): string[] {
  // Pinned: the dedup check is a comparison across chunks, so an empty or single-element chunk list
  // has nothing to compare and reports "no duplicates" for the same reason an unbuilt tree would.
  return [
    ...pinnedPopulation({
      what: 'dist/ non-entry bundle chunks',
      items: fs.readdirSync(DIST).filter((f) => f.endsWith('.mjs') && !ENTRY_FILES.has(f)),
      floor: 5,
    }),
  ]
}

describe('dist chunks are shared, not duplicated', () => {
  it('emits no two chunks with the same content', () => {
    // Sibling specifiers are normalized away first: two copies of one module differ only in which
    // chunk names they point at, so comparing raw bytes would miss exactly the case that matters.
    // Before the merge this found 8 pairs; the prefixes differed but the code did not.
    const byHash = new Map<string, string[]>()
    for (const f of chunkFiles()) {
      const normalized = fs
        .readFileSync(path.join(DIST, f), 'utf8')
        .replaceAll(/\.\/[A-Za-z0-9._-]+\.mjs/g, './CHUNK.mjs')
      const h = createHash('sha256').update(normalized).digest('hex')
      byHash.set(h, [...(byHash.get(h) ?? []), f])
    }
    const dupes = [...byHash.values()].filter((g) => g.length > 1).map((g) => g.join(' == '))
    expect(dupes, `dist/ ships the same chunk content more than once:\n${dupes.join('\n')}`).toEqual([])
  })

  it('shares chunks between the two entries rather than giving each its own set', () => {
    // The non-vacuous half. Zero duplicates is also what a dist/ holding only one entry's output
    // looks like, so require that the two entries genuinely reach common chunks.
    const core = closure(CORE_BUNDLE, 'any')
    const hook = closure(HOOK_BUNDLE, 'any')
    const shared = [...core].filter((c) => hook.has(c))
    expect(core.size, 'core entry reaches no chunks').toBeGreaterThan(0)
    expect(hook.size, 'hook entry reaches no chunks').toBeGreaterThan(0)
    expect(
      shared.length,
      `the two entries share no chunks (core reaches ${core.size}, hook ${hook.size}) -- they are being built separately again`,
    ).toBeGreaterThan(0)
  })

  it('keeps the hook entry eager set under the regression ceiling', () => {
    const eager = closure(HOOK_BUNDLE, 'static')
    let bytes = fs.statSync(HOOK_BUNDLE).size
    for (const chunk of eager) bytes += fs.statSync(path.join(DIST, chunk)).size
    expect(
      bytes,
      `hook eager set is ${(bytes / 1024 / 1024).toFixed(3)} MB across ${eager.size} chunks`,
    ).toBeLessThan(MAX_HOOK_EAGER_BYTES)
  })

  it('defers at least one chunk from the hook entry', () => {
    // Sharing chunks with the CLI entry could have made every chunk statically reachable from the
    // hook, which is what losing splitting looks like from this side.
    const all = closure(HOOK_BUNDLE, 'any')
    const eager = closure(HOOK_BUNDLE, 'static')
    const deferred = [...all].filter((c) => !eager.has(c))
    expect(deferred.length, `every chunk the hook reaches (${all.size}) is imported eagerly`).toBeGreaterThan(0)
  })

  it('leaves the hook entry free of load-time side effects', () => {
    // The CLI entry calls run() at import time to parse process.argv. Sharing chunks between the
    // two entries is only safe because src/main.ts is reachable from the core entry alone, so that
    // call cannot land in a shared chunk -- assert it by importing the hook bundle with argv the
    // CLI would reject and requiring a silent, successful exit.
    const script = `await import(${JSON.stringify(pathToFileURL(HOOK_BUNDLE).href)})`
    const res = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script, 'definitely-not-a-command'],
      { encoding: 'utf8', cwd: ROOT },
    )
    expect(
      { status: res.status, stderr: res.stderr.trim(), stdout: res.stdout.trim() },
      'importing the hook bundle ran something',
    ).toEqual({ status: 0, stderr: '', stdout: '' })
  })
})
