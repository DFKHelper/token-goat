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
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

// @ts-expect-error -- plain .mjs build helper with JSDoc types, outside tsconfig's include.
import { sweepStaleChunks } from '../../scripts/sweep-chunks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, '..', '..', 'dist')
const ENTRY = path.join(DIST, 'token-goat.core.mjs')
const CORE_CHUNK_PREFIX = 'token-goat-chunk-'

/**
 * Ceiling on what the entry may pull in statically. The split build loads about 2.83 MB of a
 * 3.41 MB output; the pre-split monolith was 3.61 MB in one file. The headroom is deliberate --
 * this is a regression trip-wire for the whole bundle collapsing back into the eager set, not a
 * budget to be tuned on every dependency change.
 *
 * 8 KB was added when origin/main's doctor work merged in: findTopIndexedProjects, the age window on checkUnmappedTools, checkVscodeProjectMcp and cleanupDeprecatedVscodeProjectMcp, alongside the local oversized-db category breakdown that now ships beside it rather than instead of it. Measured 3,411,459 bytes after the merge against the 3,407,872-byte line, which it missed by 3,587. The remaining 4,605 bytes of headroom are deliberate: this is still the collapse trip-wire, and a ceiling raised to within a few hundred bytes of the measurement turns the next unrelated change into a red guard rather than a decision.
 *
 * 4 KB more was added by the per-kind embedding stamp: src/embed_stamp.ts (which extraction kind a path belongs to) plus the kind-scoped reset in src/embeddings.ts and the generated per-kind digest map, all of them on the already-eager embedding path. Measured 3,416,952 bytes against the 3,416,064-byte line, which it missed by 888. The remaining 3,208 bytes of headroom are deliberate, for the same reason the paragraph above gives: the line moves by a measured amount when a feature lands on the eager path, never to whatever the current build happens to weigh.
 *
 * 8 KB more was added by the `answer` question router: src/answer_router.ts, registered from src/cli_cmd_analysis.ts, which is already eager. It pulls in no new chunk -- the eager closure stayed at 31 chunks across all three measurements below -- so the whole cost is the router's own compiled bytes. Three trees measured with the same closure walk this file performs, rebuilt between each: HEAD 3,417,370 bytes; HEAD plus the one-word `--help` group line 3,417,378 (+8); the router wired up 3,424,850 (+7,480 over HEAD), which missed the 3,420,160-byte line by 4,690. The remaining 3,502 bytes of headroom are deliberate, for the same reason both paragraphs above give.
 *
 * 4 KB more was added by bounding the `answer` router's delegates and disclosing what they withhold: the router's shared row cap, the `callers` text-mode truncation notice (which pulls `countRefs`, already exported from the eager `index_reader.ts`), and `symbol --exclude-vendored`. It pulls in no new chunk -- the eager closure stayed at 31 chunks across all four measurements below -- so the whole cost is compiled bytes on the already-eager path. Four trees measured with the same closure walk this file performs, rebuilt between each: HEAD 3,427,946 bytes; plus the router bound 3,428,161 (+215); plus the callers disclosure 3,428,470 (+309); plus `--exclude-vendored` 3,428,908 (+438), which missed the 3,428,352-byte line by 556. The remaining 3,540 bytes of headroom are deliberate, for the same reason every paragraph above gives.
 *
 * 4 KB more was added by the two embedding gates -- src/asset_extensions.ts (the shared non-text extension list, a new leaf module) and src/embed_backfill.ts (the version-keyed sweep, wired into cmdIndex) -- plus the `indexing.max_chunks_per_file` config key. No new chunk: the eager closure stayed at 31 chunks across every measurement, so the whole cost is compiled bytes on the already-eager path. Three trees measured with the same closure walk this file performs, rebuilt between each: HEAD 3,428,908 bytes (the figure the paragraph above records); the gates and the shared extension module alone came in under the 3,432,448-byte line and did not trip this guard; both, with the backfill sweep wired into cmdIndex, 3,433,842 (+4,934 over HEAD), which missed that line by 1,394. Rebuilt four times at that final state, byte-identical each time. The remaining 2,702 bytes of headroom are deliberate, for the same reason every paragraph above gives.
 *
 * 12 KB more was added by line-number addressing on `read` -- the `file:N` / `file:N-M` spec form and the region resolver behind it (parseColonLineSpec, resolveLineRegions, runLineRegion in src/read_spec.ts, wired into runRead and into mcp_server.ts's specFilePart confinement gate). No new chunk and no new module: the eager closure stayed at 31 chunks across both measurements, so the whole cost is compiled bytes on the already-eager read path. Two trees measured with the same closure walk this file performs, rebuilt between each: HEAD 3,434,874 bytes; the line-region path 3,440,241 (+5,367 over HEAD), which overran the previous 3,436,544-byte line by 3,697. Rebuilt three times at that final state, byte-identical each time. An 8 KB bump would have cleared it by only 399 bytes, well under the 2.7-3.5 KB of slack every paragraph above deliberately kept, so this takes 12 KB and leaves 4,495 bytes of headroom, for the same reason those paragraphs give.
 *
 * 8 KB more was bought by the hint-efficacy measurement batch, for the same code the hook-eager paragraph in tests/guards/dist_chunks_deduped.test.ts describes -- the range hint's own net-benefit gate (bash_range_savings.ts, line_regions.ts), the correlator field threaded through hooks_common.ts, and two hint_emissions columns with their migrations in db.ts. No new module and no new chunk: the eager closure held at the same count across both measurements, so the whole cost is compiled bytes on already-eager modules. Two trees measured with the same closure walk this file performs, ceiling temporarily forced to 1 to read the figure at the parent: c6968099 3,440,583 bytes; the batch 3,447,687 (+7,104), which overran the previous 3,444,736-byte line by 2,951. Rebuilt twice at that final state, byte-identical each time. A 4 KB bump would have cleared it by only 1,145 bytes, under the slack every paragraph above keeps, so this takes 8 KB and leaves 5,241 bytes of headroom.
 *
 * 4 KB more was bought by three `semantic` and hint changes: the net-benefit decline reason recorded on every hint that is withheld rather than dropped silently, the fusion rank and retrieval leg carried through to `semantic`'s own output so the number it prints is the number it ranked on, and the `semantic.max_distance` relevance floor with its three config registration sites and its entry in the project-lock list. No new module and no new chunk: the eager closure held at 31 chunks across both measurements, so the whole cost is compiled bytes on already-eager modules. Two trees measured with the same closure walk this file performs, built in separate worktrees off a shared node_modules so neither measurement disturbed the other: HEAD a02ffb02 3,451,345 bytes; the batch 3,453,826 (+2,481), which overran the previous 3,452,928-byte line by 898. Rebuilt three times at that final state, byte-identical each time. This takes 4 KB and leaves 3,198 bytes of headroom, inside the 2.7-5.2 KB slack every paragraph above keeps and for the reason they give.
 *
 * 16 KB more was bought by the compaction-measurement batch: src/manifest.ts (the manifest builder and its printed-path sample, lifted out of compact.ts so the pre_compact hook and the post_compact survival canary cannot drift apart), src/token_estimate.ts (content-class token pricing), src/harness_channels.ts (which harnesses discard a pre_compact return), the post-compaction recovery path in hooks_session_start.ts, web pages in resume.ts's packet, and the estimator calibration in session_audit.ts. Unlike every paragraph above, this one moved the closure itself: 31 chunks before, 35 now, because splitting the manifest out of compact.ts re-partitioned what the eager entry reaches. Measured with the same closure walk this file performs: the previous paragraph's final state 3,453,826 bytes; this batch 3,467,084 (+13,258), which overran the previous 3,457,024-byte line by 10,060. A 12 KB bump would have cleared it by 2,228 bytes, under the 2.7 KB floor every paragraph above keeps, so this takes 16 KB and leaves 6,324 bytes of headroom -- slightly more than the 5.2 KB any single paragraph has kept before, deliberately, because a re-partitioned closure is the one case where the next unrelated change can move by more than its own compiled size.
 */
const MAX_EAGER_BYTES = 3.25 * 1024 * 1024 + 24 * 1024 + 12 * 1024 + 8 * 1024 + 4 * 1024 + 16 * 1024

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

/** Chunk filenames the given built file imports at all, deferred edges included. */
function allChunkImports(file: string): string[] {
  const out = new Set<string>()
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/["(]\s*"?(\.\/[^"')]+\.mjs)"/g)) {
    out.add(path.basename(m[1]!))
  }
  return [...out]
}

/** Transitive closure of chunk edges starting at the core entry, following `edges`. */
function closure(edges: (file: string) => string[]): Set<string> {
  const seen = new Set<string>()
  const queue = edges(ENTRY)
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

/** The chunks the core entry parses before running anything. */
const eagerChunks = (): Set<string> => closure(staticChunkImports)

describe('core bundle stays split', () => {
  it('emits core chunks rather than one monolithic file', () => {
    const chunks = fs.readdirSync(DIST).filter((f) => f.startsWith(CORE_CHUNK_PREFIX))
    expect(chunks.length, 'no core chunks in dist/ -- splitting:true was dropped').toBeGreaterThan(1)
  })

  it('defers at least one chunk instead of importing them all statically', () => {
    // The non-vacuous half: chunks existing proves nothing on its own if the entry statically
    // imports every one of them, which is what a monolith looks like after a mechanical split.
    // Scoped to the chunks this entry actually reaches, not everything sharing the prefix: one
    // build now emits both entries into the same prefix, so a chunk only the hook library reaches
    // would otherwise count as deferred here and let the assertion pass with the core deferring
    // nothing at all.
    const all = closure(allChunkImports)
    const eager = eagerChunks()
    const deferred = [...all].filter((f) => !eager.has(f))
    expect(deferred.length, `every chunk the core reaches is eagerly imported (${all.size} chunks)`).toBeGreaterThan(0)
  })

  it('keeps the eagerly loaded set under the regression ceiling', () => {
    const eager = eagerChunks()
    let bytes = fs.statSync(ENTRY).size
    for (const chunk of eager) bytes += fs.statSync(path.join(DIST, chunk)).size
    expect(bytes, `eager startup set is ${(bytes / 1024 / 1024).toFixed(2)} MB`).toBeLessThan(MAX_EAGER_BYTES)
  })

  it('leaves dist/ internally consistent: every chunk an emitted file imports exists on disk', () => {
    // Splitting made a partial dist/ possible for the first time. The stale-chunk sweep used to run
    // before its build, so mid-build the previous entry was still present and still importing
    // chunks that had just been deleted; anything starting the CLI then died with
    // ERR_MODULE_NOT_FOUND. Both static and dynamic edges are checked here, since a dynamic one
    // fails just as hard, only later.
    // Pinned: ENTRY is always in this list, so `files` is never empty and the resolvability sweep
    // below would still look busy after the chunk glob stopped matching anything. The floor is on
    // the chunks specifically, which is the part that can silently go to zero.
    const chunks = pinnedPopulation({
      what: `dist/${CORE_CHUNK_PREFIX}*.mjs core chunks`,
      items: fs.readdirSync(DIST).filter((f) => f.startsWith(CORE_CHUNK_PREFIX)),
      floor: 5,
    })
    const files = [ENTRY, ...chunks.map((f) => path.join(DIST, f))]
    const missing: string[] = []
    for (const file of files) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/["(]\s*"?(\.\/token-goat-chunk-[^"')]+\.mjs)"/g)) {
        const target = path.join(DIST, m[1]!.slice(2))
        if (!fs.existsSync(target)) missing.push(`${path.basename(file)} -> ${m[1]}`)
      }
    }
    expect(missing, 'dangling chunk imports in dist/').toEqual([])
  })

})

describe('sweepStaleChunks', () => {
  // Tested directly rather than by asserting dist/ is orphan-free after the fact: the suite's
  // globalSetup rebuilds before any test runs, and on a fresh checkout that build starts from an
  // empty dist/, so an end-state assertion there passes even with the sweep deleted outright.
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sweep-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const write = (name: string): string => { fs.writeFileSync(path.join(dir, name), 'x'); return name }

  it('removes a prefixed chunk this build did not emit', () => {
    write('token-goat-chunk-OLD.mjs')
    const kept = write('token-goat-chunk-NEW.mjs')
    expect(sweepStaleChunks(dir, CORE_CHUNK_PREFIX, [`dist/${kept}`])).toEqual(['token-goat-chunk-OLD.mjs'])
    expect(fs.readdirSync(dir)).toEqual([kept])
  })

  it('keeps an unchanged chunk, which is re-emitted under the same content-hashed name', () => {
    const same = write('token-goat-chunk-SAME.mjs')
    expect(sweepStaleChunks(dir, CORE_CHUNK_PREFIX, [`dist/${same}`])).toEqual([])
    expect(fs.existsSync(path.join(dir, same))).toBe(true)
  })

  it('never touches a differently-prefixed chunk or the entry files', () => {
    // Prefix scoping is what lets one build sweep its own chunks and, in a second call, clear the
    // legacy token-goat-hook-chunk- set left behind by the era of two separate builds. A sweep
    // matching too broadly would take the entry files with it, and unlike a stale chunk, nothing
    // recreates those until the next build.
    write('token-goat-hook-chunk-A.mjs')
    write('token-goat.core.mjs')
    write('token-goat.mjs')
    expect(sweepStaleChunks(dir, CORE_CHUNK_PREFIX, [])).toEqual([])
    expect(fs.readdirSync(dir).sort()).toEqual(['token-goat-hook-chunk-A.mjs', 'token-goat.core.mjs', 'token-goat.mjs'])
  })

  it('accepts absolute and backslash-separated emitted paths', () => {
    const kept = write('token-goat-chunk-ABS.mjs')
    expect(sweepStaleChunks(dir, CORE_CHUNK_PREFIX, [`C:\\build\\dist\\${kept}`])).toEqual([])
    expect(fs.existsSync(path.join(dir, kept))).toBe(true)
  })

  it('treats a missing directory as nothing to sweep', () => {
    expect(sweepStaleChunks(path.join(dir, 'nope'), CORE_CHUNK_PREFIX, [])).toEqual([])
  })

  it('an empty prefix clears an orphaned entry file from a retired name, but never a non-.mjs file', () => {
    // A prior entry-point name (e.g. before ENTRY_POINTS was renamed) leaves its output behind
    // forever: unlike a chunk, nothing re-emits it under a new content hash, and package.json's
    // `files: ["dist/"]` ships it in the tarball. Widening the prefix to '' is how the build
    // catches that case too, so it must not also catch a tracked non-build file like dist/.npmignore
    // that merely happens to sit in the same directory.
    write('_m.mjs')
    const keptEntry = write('token-goat.core.mjs')
    const keptChunk = write('token-goat-chunk-NEW.mjs')
    fs.writeFileSync(path.join(dir, '.npmignore'), '*.whl\n')

    expect(sweepStaleChunks(dir, '', [`dist/${keptEntry}`, `dist/${keptChunk}`])).toEqual(['_m.mjs'])
    expect(fs.readdirSync(dir).sort()).toEqual(['.npmignore', keptChunk, keptEntry].sort())
  })
})
