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
 * The language modules the hook path may compile. Everything else under src/languages/ is an extractor only the indexer
 * calls, and adding one must not grow the eager set -- which is what every adapter batch did before
 * languages/registry.ts existed. Each name here earns its place by being called on the hook path itself.
 */
const EAGER_LANGUAGE_MODULES = new Set([
  'src/languages/common.ts', // heading and line helpers section_reader and the file-type hints call
  'src/languages/ini_idx.ts', // the .env quote scan dotenv redaction and section_reader share
  'src/languages/ipynb_idx.ts', // notebook flattening, reached from parser.ts's own indexing entry points
  'src/languages/salesforce_frontend.ts', // LWC composition inside the tree-sitter parse the read hook's fold calls
  'src/languages/sniff.ts', // the content sniffs detectLanguage runs to tell `.m`, `.pp`, `.h`, `.pl` and `.t` apart
])

/**
 * The `src/...` module markers esbuild writes above each module it inlines, read out of `files`.
 *
 * CAPTURE: the names come from the built bundle itself, not from a list of what we expect to be in it.
 */
function modulesIn(files: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\/\/ (src\/[\w./-]+)$/gm)) out.add(m[1]!)
  }
  return out
}

/**
 * Ceiling on what the hook entry pulls in statically, mirroring the core's ceiling in
 * core_bundle_stays_split.test.ts. A bridge `import()`s this bundle on nearly every tool call and
 * V8 parses every byte of the eager set before running any of it. Measured at 1.837 MB across 7
 * chunks both before and after the two builds were merged; the headroom is a regression trip-wire,
 * not a budget to re-tune on every dependency change. It went 2.4 MB -> 2.6 MB when the Fortran, Pascal, MATLAB
 * and CMake adapters (41 KB, eager like every other adapter) grew the set, and back to 2.25 MB once the adapters moved
 * behind parser.ts's dynamic import of languages/registry.ts. Measured on one machine across that move: 2.430 MB over
 * 7 chunks before, 2.167 MB over 8 after, and 47-53 ms to import the hook bundle before against 42-43 ms after.
 *
 * The 4 KB above the round 2.25 MB was bought by EXIF orientation correction in image_engine.ts, which has to be eager: the pre-read hook is what shrinks images, so the rotation runs on the hook path or not at all. Measured 2,360,603 bytes over 18 chunks with it, against a 2,359,296-byte line it missed by 1,307.
 *
 * A further 2 KB was bought by the structural-index rewrite in bash_structural_index.ts (batch Q): it decides whether to rewrite an `rg`/`grep` structural search into a `token-goat outline`/`imports` call, and that decision has to run inside the synchronous pre_tool_use Bash hook before the tool executes, so it cannot be deferred behind a dynamic import the way a language adapter can. Every module it imports (paths.js, parser_types.js, language_specs.js, tool_filters/helpers.js, bash_extractors.js, fingerprint.js, index_reader.js) was already eager via an existing hook path; the added bytes are its own ~130 lines of recognizer logic. Measured 2,365,172 bytes over 19 chunks with it, against a 2,363,392-byte line it missed by 1,780.
 *
 * A further 3 KB was bought by Batch S's hook wall-clock timing: relayInProcess (relay.ts) now imports recordStat from stats.ts to measure and persist its own duration on every hook invocation, which is unavoidably eager for the same reason as the structural-index rewrite above -- the timer has to close before relayInProcess returns, on every hook, not behind a dynamic import. stats.ts itself was already eager via other hook paths (session_hint, image_shrink, ...); the added bytes are recordStat's new duration_ms plumbing and pruneHookStats. The CLI/doctor-only read side (hookLatencyBreakdown, renderHookLatencyStats) lives in the separate hook_latency.ts on purpose, so it never joins this eager set at all. Measured 2,367,105 bytes over 19 chunks with it, against a 2,365,440-byte line it missed by 1,665. Raise this only for something equally unavoidable, and say here what bought it.
 */
const MAX_HOOK_EAGER_BYTES = 2.25 * 1024 * 1024 + 4 * 1024 + 2 * 1024 + 3 * 1024

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

  it('compiles no regex language adapter on the hook path', () => {
    const eager = [HOOK_BUNDLE, ...[...closure(HOOK_BUNDLE, 'static')].map((c) => path.join(DIST, c))]
    const modules = modulesIn(eager)
    // Non-vacuous: a build whose markers this stopped finding would report an empty adapter set for the wrong reason.
    expect(modules.size, 'no src/ module markers found in the hook eager set').toBeGreaterThan(50)
    const languages = [...modules].filter((m) => m.startsWith('src/languages/')).sort()
    expect(languages.length, 'the hook eager set names no language module at all').toBeGreaterThan(0)
    expect(languages.filter((m) => !EAGER_LANGUAGE_MODULES.has(m))).toEqual([])
  })

  it('reaches a regex adapter only through a deferred chunk', () => {
    // fortran.ts stands for the adapters as a group: it is called from ADAPTER_EXTRACTORS alone, so the hook must be
    // able to reach it (the CLI and worker share these chunks) without compiling it up front.
    const eager = [...closure(HOOK_BUNDLE, 'static')]
    const deferred = [...closure(HOOK_BUNDLE, 'any')].filter((c) => !eager.includes(c))
    const holding = (chunks: string[]): string[] =>
      chunks.filter((c) => modulesIn([path.join(DIST, c)]).has('src/languages/fortran.ts'))
    expect(holding(deferred).length, 'no deferred chunk holds src/languages/fortran.ts').toBeGreaterThan(0)
    expect(holding([...eager, path.basename(HOOK_BUNDLE)]), 'src/languages/fortran.ts is compiled eagerly').toEqual([])
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
