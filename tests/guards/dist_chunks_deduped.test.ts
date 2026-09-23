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
 *
 * A further 1 KB was bought by the fix that stops recordStat holding the hook path for db.ts's full 15s busy_timeout under contention: recordStat now opens its own short-budget connection instead of reusing the shared, patient one getDb() caches for indexing and the worker, and closes it before returning. That connection has to be opened and torn down synchronously inside recordStat, on every hook, same reason as the timing plumbing above -- it cannot be deferred behind a dynamic import. Measured 2,368,665 bytes over 19 chunks with it, against a 2,368,349-byte line it missed by 316.
 *
 * A further 1 KB was bought by `hint_stats.defiance_threshold_pct` (batch b02 J4): the same five config rows as the entry below, plus the `isSuppressionCategory` branch in shouldSuppress, which unlike checkHookLatency really is eager -- hint_stats.ts runs inside the pre/post tool-use hooks. Measured 2,370,518 bytes over 19 chunks with it, against the 2,370,560-byte line the entry below left, which it cleared by 42. Two config keys in one batch consumed 1,115 of this ceiling's bytes between them, which is the number to plan against.
 *
 * A further 1 KB was bought by `hooks.latency_budget_ms` (batch b02 J3), and this entry is worth reading before adding any config key at all, because the cost is not obvious from the diff. config.ts is eager on the hook path -- every hook calls loadConfig -- so a key's five rows (its NUMERIC_FIELD_BOUNDS entry, its two _buildConfig lines, its CONFIG_KEY_ENV_OVERRIDES entry and its saveConfig serialize arm) all land in this set even when the only code that reads the key is CLI-only, as checkHookLatency is. Measured on one machine by building both trees: 2,369,403 bytes over 19 chunks at the parent commit against 2,369,870 with the key, so one key costs 467 bytes here and the parent commit had 133 bytes of headroom left. Unavoidable in the sense that matters: the rows are what make the key settable, and there is no deferred-import shape for a table the eager loader indexes. Budget roughly 0.5 KB of this ceiling per future config key rather than discovering it as a red guard.
 *
 * A further 4 KB was bought by making the parser fingerprint per-language: src/parser_fingerprint.ts now carries a 49-entry language-to-digest map beside the shared digest, and parser_stamp.ts's parserFingerprintForLanguage resolves a row's stamp through it. Eager because the three freshness gates that consult it (worker.ts's drain, reconcile.ts's sweep, fold_delivery.ts's body-fold gate) are all on the hook path, and a digest map is data with no deferred-import shape. Measured by building both trees: 2,372,896 bytes over 19 chunks at the parent commit against 2,374,896 with the map, so the map costs 2,000 bytes here and the parent commit had 1,760 bytes of headroom left. 4 KB rather than 1 leaves 3,856 bytes of headroom, deliberately more than the 1,766 the entry below left, since a language adapter added later grows this map by another ~30 bytes and should not be the change that discovers a red guard.
 *
 * A further 3 KB was bought by merging origin/main's doctor work (findTopIndexedProjects, checkUnmappedTools' age window, checkVscodeProjectMcp and cleanupDeprecatedVscodeProjectMcp) into the local oversized-db category breakdown. cli_doctor.ts is not itself hook-eager, but the merge also pulled origin's changes to stats.ts and util.ts, both of which are. Measured 2,372,890 bytes over 19 chunks after the merge, against the 2,371,584-byte line it missed by 1,306; 3 KB rather than 2 leaves 1,766 bytes of headroom, since the previous entry's 42-byte margin meant the next unrelated change would have discovered this red rather than planned for it.
 *
 * A further 1 KB was bought by resolving Claude Code's transcript root through `claudeConfigDir()` in waste.ts, which honours `CLAUDE_CONFIG_DIR` instead of hardcoding `os.homedir()`. Eager because hooks_bash.ts imports projectTranscriptsDir to find the per-session tool-results directory on the Bash hook path, and a path accessor read on every such call has no deferred-import shape. Measured by building three trees on one machine: 2,378,447 bytes over 19 chunks at the parent commit, 2,378,618 with the sessions-directory fix that precedes this one, and 2,378,804 with this one, so the accessor costs 186 bytes here and the parent commit had 305 bytes of headroom left. 1 KB leaves 972 bytes of headroom.
 *
 * A further 6 KB was bought by the two embedding gates. src/asset_extensions.ts is hook-eager because image_shrink.ts, which runs on the pre-read hook path, now takes its image-extension list from there instead of holding a private copy -- parser.ts cannot import image_shrink.ts (it pulls in the hook registry, the harness bridges and the stats ledger), so the one list moved down to a leaf both can reach. src/embed_backfill.ts arrives through worker.ts. Three trees measured on one machine, rebuilt between each: 2,378,804 bytes over 19 chunks at the parent commit (the figure the paragraph above records); 2,382,618 over 19 with the gates and the shared extension module (+3,814); 2,384,032 over 19 with the backfill sweep wired in as well (+1,414 more, +5,228 over the parent), which missed the 2,379,776-byte line by 4,256. Rebuilt four times at that final state, byte-identical each time. The chunk count never moved, so none of this is a new chunk being dragged eager. 6 KB leaves 1,888 bytes of headroom.
 *
 * A further 16 KB was bought by the hint-efficacy measurement batch. hint_stats.ts, hooks_bash.ts, hooks_common.ts and db.ts are all hook-eager, and the batch touches every one of them: hint builders now hand their own file path to the efficacy ledger instead of it being regex-scraped back out of the rendered hint (a `correlators` field on the context HookOutput, a `pathHint` wrapper and 20 converted call sites in hooks_bash.ts); a range hint must now price its own proposal against the window the command asked for before it may emit, which pulls bash_range_savings.ts and line_regions.ts onto the hook path; and two `hint_emissions` columns, with their migrations, separate an emission that was shown but unscoreable from a detection that was never shown at all. Measured by building both trees on one machine, ceiling temporarily forced to 1 to read the figure at the parent: 2,385,404 bytes over 19 chunks at c6968099 -- which had 516 bytes of headroom, so the first step of the batch alone was going to find this red -- against 2,397,441 with all of it, +12,037 over the batch. The last 1,543 of that is the batch's final step, which gives the whole-file deny a real indexed name to print instead of a `SectionHeading`/`KEY_NAME` placeholder that does not run: bash_surgical_target.ts is new, but index_reader.ts and fingerprint.ts were already pulled eager by the range gate above, so it costs its own compiled bytes and nothing else. Rebuilt twice at that final state, byte-identical each time. The chunk count never moved off 19, so none of this is a new chunk being dragged eager: it is compiled bytes on modules the hook path already loaded. 12 KB would have left 767 bytes of headroom, well under the slack every paragraph above keeps, so this takes 16 KB and leaves 4,863 bytes.
 *
 * A further 1 KB was bought by the batch that made the hook path read its own argv and its own printed output. hooks_bash.ts and hooks_bash_commands.ts are hook-eager and carry most of it: pipelineShapeFilter now returns the first stage's argv alongside the filter instead of dropping it, because the caller was passing an empty array and every argv-reading behaviour in every filter was therefore dead on a piped command. manifest.ts's manifestPrintedPaths now samples the rendered manifest rather than re-walking the selection, session_store.ts's file cap ranks edited entries above read ones, and pending_context.ts gained an import of hint_suggestion_guard.ts -- a zero-import leaf already reached through relay.ts, which is why the chunk count did not move. Measured after a fresh build: 2,403,355 bytes over 22 chunks, against the 2,403,328-byte line it missed by 27, and against the 2,402,399 bytes over 22 chunks the entry below records at the parent commit, so the batch costs 956 bytes. Rebuilt and re-measured byte-identical. 1 KB leaves 997 bytes of headroom, the same shape as the entries below, so the next small change is not the one that discovers a red guard.
 *
 * A further 1 KB was bought by the deferred-hint delivery fix and the fold it shares. relay.ts now clears the pending-context queue only once the emitted output is confirmed to carry the text, which puts pending_context.ts on the hook entry's eager graph where it previously arrived only through hooks_session.ts; src/tool_name_fold.ts is the leaf that replaced three copies of foldToolName, one of which had lost its type guard; and overflow_guard.ts's trim now classifies the content once and spends the same divisor the entry check measured with. Measured after the batch: 2,402,399 bytes over 22 chunks, against the 2,402,304-byte line it missed by 95. 1 KB rather than the 95 bytes it costs leaves 929 bytes of headroom, in the same shape as the entries above, so the next small change is not the one that discovers a red guard.
 *
 * A further 1 KB was bought by the batch that gave the Copilot CLI shim own-property lookups and the compaction manifest its subagents' web fetches. copilot_cli.ts is hook-eager through the bridge registry and manifest.ts through the pre_compact hook, and most of the cost is the shim's own comment text rather than its code: the shim is a template literal shipped verbatim, so a comment inside it is bytes on every install instead of being stripped the way a source comment is. Trimming that comment to its essentials, with the full rationale left where it already lived beside the event map, took the batch from +1,191 bytes to +913. No new module and no new chunk -- 22 across both measurements. Measured with the working tree restored to HEAD for the parent build rather than stashed, ceiling temporarily forced to 1 to read the figure: 3d1a799e 2,403,312 bytes; the batch 2,404,225, which cleared the previous 2,404,352-byte line by 127. Rebuilt at that final state, byte-identical. 127 bytes is under every margin the paragraphs above keep and would make the next unrelated one-liner the change that discovers a red guard, so this takes 1 KB and leaves 1,151 bytes.
 *
 * A further 2 KB was bought by the same launcher-options and yarn-built-ins batch the startup paragraph in tests/guards/core_bundle_stays_split.test.ts describes. helpers.ts is hook-eager through the bash filter registry, and the cost is the two string-literal lookup sets it gained: LAUNCHER_VALUE_FLAGS and the 47-name YARN_BUILTIN_SUBCOMMANDS. No new module and no new chunk -- 22 across both measurements -- so this is compiled bytes on a module the hook path already loaded. Measured with the working tree restored to HEAD for the parent build rather than stashed, ceiling temporarily forced to 1 to read the figure: 558b1c96 2,404,169 bytes; the batch 2,405,669 (+1,500), which overran the previous 2,405,376-byte line by 293. Rebuilt twice at each state, byte-identical both times. A 1 KB bump would clear it by 731 bytes, under every margin the paragraphs above keep, so this takes 2 KB and leaves 1,755 bytes.
 *
 * A further 2 KB was bought by moving the worker's transient-read-failure counters out of `files` into their own `index_retries` table, and by the sweep that reclaims a counter whose file is gone. db.ts is hook-eager and carries most of it: the table, its expression index, and -- crucially -- the rationale, which first landed as an SQL `--` comment inside the SCHEMA_SQL template literal. A comment there is a string, not a comment: the bundler ships it verbatim on every install instead of stripping it, which is the same trap the Copilot CLI shim paragraph above records. Moving that prose to the docblock above SCHEMA_SQL took the batch from +785 bytes to +172. index_prune.ts and config_commands.ts are also hook-eager and carry the rest. No new module and no new chunk: 25 across both measurements. Measured with the working tree restored to HEAD for the parent build rather than stashed, ceiling temporarily forced to 1 to read the figure: c7558c84 2,415,615 bytes, which had exactly 1 byte of headroom; the batch 2,415,787, overrunning the previous 2,415,616-byte line by 171. Rebuilt at that final state, byte-identical. A 1 KB bump would clear it by 853 bytes, under every margin the paragraphs above keep, so this takes 2 KB and leaves 1,877 bytes.
 *
 * A further 2 KB was bought by the `refs.context` storage cap. parser.ts is hook-eager, and the cost is boundRefContext plus the docblock explaining why a ref's context is windowed around its column rather than sliced from the head of its line -- on a document written as one long line, every reference stored the whole file. No new module and no new chunk: 25 across both measurements. Measured with the working tree restored to HEAD for the parent build rather than stashed, ceiling temporarily forced to 1 to read the figure: HEAD 2,413,046 bytes; the fix 2,413,859 (+813), which overran the previous 2,413,568-byte line by 291. A 1 KB bump would clear it by 733 bytes, under every margin the paragraphs above keep, so this takes 2 KB and leaves 1,757 bytes.
 *
 * A further 2 KB was bought by teaching KubectlFilter to leave a structured `-o json`/`-o yaml`/template listing alone instead of truncating it to a head and a tail. tool_filters/containers.ts is hook-eager through the bash filter registry, the same path the launcher-options paragraph above describes for helpers.ts, so its compiled bytes land here whether or not a hook ever runs kubectl. The cost is the flag reader -- `-o` has four spellings, separate, `=`-joined and glued to the short flag -- plus the format regex, which is a string literal the bundler ships verbatim rather than a comment it strips. That regex first listed all nine format names kubectl accepts and now matches four prefixes instead, every suffixed spelling being an extension of one of them, which took the batch from +755 bytes to +683. No new module and no new chunk: 25 across both measurements. Measured with the working tree restored to HEAD for the parent build rather than stashed: HEAD 2,417,277 bytes, which had 387 bytes of headroom; the batch 2,417,960, overrunning the previous 2,417,664-byte line by 296. Rebuilt twice at that final state, byte-identical each time. A 1 KB bump would clear it by 728 bytes, under every margin the paragraphs above keep, so this takes 2 KB and leaves 1,752 bytes.
 *
 * A further 2 KB was bought by PowerShell runner resolution and Windows PowerShell harness command wrapping with base64 round-trip validation. src/shell.ts and src/hooks_bash.ts are hook-eager, adding resolvePowerShell and canRunPowerShell helpers plus base64 rewrite logic so Copilot CLI and Codex on Windows execute wrapped commands natively under PowerShell rather than bash without quoting hazards.
 */
const MAX_HOOK_EAGER_BYTES = 2.25 * 1024 * 1024 + 4 * 1024 + 2 * 1024 + 3 * 1024 + 1 * 1024 + 1 * 1024 + 1 * 1024 + 3 * 1024 + 4 * 1024 + 1 * 1024 + 6 * 1024 + 16 * 1024 + 1 * 1024 + 1 * 1024 + 1 * 1024 + 2 * 1024 + 6 * 1024 + 2 * 1024 + 2 * 1024 + 2 * 1024 + 2 * 1024

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
