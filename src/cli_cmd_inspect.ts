import type { Command } from 'commander'
import { resolveProjectRoot } from './project.js'
import {
  emitExtraFileArgsNote,
  noteExtraFileArgs,
  requireNonNegativeInt,
  requirePositiveInt,
  runExit,
  runExitText,
} from './cli_dispatch.js'
import { namedSpecsMergeable, parseLineRange, parseReadSpec, readSpecsMergeable } from './read_spec.js'
import { runBrief } from './read_brief.js'
import { runListSections } from './read_inspect.js'
import { runOutline, runSkeleton, type SkeletonOptions } from './read_outline.js'
import { fileExists, runPeek, runRead } from './read_commands.js'
import { runRefs } from './read_refs.js'
import { runSection } from './read_section.js'
import { runSymbol } from './read_symbol.js'

type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>

interface InspectCommandHandlers {
  cmdSemantic: (
    query: string | undefined,
    more: string[],
    opts: {
      limit?: string
      json?: boolean
      grep?: string
      excludeTests?: boolean
      preflight?: boolean
      warm?: boolean
      distances?: boolean
      all?: boolean
    },
  ) => void | Promise<void>
  cmdSearch: (
    query: string | undefined,
    more: string[],
    opts: {
      limit?: string
      channels?: string
      project?: string | boolean
      json?: boolean
      minScore?: string
    },
  ) => void | Promise<void>
}

export function registerInspectCommands(program: Command, guard: GuardFn, handlers: InspectCommandHandlers): void {
  program
    .command('symbol [name] [more...]')
    .description('search for a symbol by name, or project-wide by --grep name pattern')
    .option('-l, --limit <n>', 'max results')
    .option('-f, --file <path>', 'restrict to one file')
    .option('-k, --kind <kind>', 'restrict to one kind (function, class, ...)')
    .option('-p, --project [path]', 'scope search to one project root instead of the global index (defaults to cwd)')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'only show symbols whose name matches this regex (literal substring if it is not valid regex); cannot be combined with <name>')
    .option('--exclude-tests', 'hide symbols defined in a test file (opt-in; default output is unchanged)')
    .option('--exclude-vendored', 'hide symbols defined under a dependency or build directory the indexer skips (node_modules, dist, site-packages, ...) (opt-in; default output is unchanged)')
    .option('--stats', 'add per-result reference count and doc-coverage flag (project-wide count per NAME, not per definition site -- same-named symbols across files share a count)')
    // Commander names the attribute after the last flag of a `--a, --b` pair, so this arrives as `signature`, never `sig`.
    .option('--sig, --signature', 'only output the declaration signature, omitting implementation body')
    .action((name: string | undefined, more: string[], opts: { limit?: string; file?: string; kind?: string; project?: string | boolean; json?: boolean; grep?: string; excludeTests?: boolean; excludeVendored?: boolean; stats?: boolean; signature?: boolean }) => {
      let projectRoot: string | undefined
      if (opts.project === true) {
        projectRoot = resolveProjectRoot({ project: process.cwd() })
      } else if (typeof opts.project === 'string') {
        projectRoot = resolveProjectRoot({ project: opts.project })
      }
      return runExitText(() =>
        noteExtraFileArgs(
          'symbol',
          name ?? '',
          more,
          () =>
            runSymbol({
              ...(name !== undefined ? { name } : {}),
              limit: opts.limit !== undefined ? requirePositiveInt('--limit', opts.limit) : 20,
              ...(opts.file !== undefined ? { file: opts.file } : {}),
              ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
              ...(projectRoot !== undefined ? { projectRoot } : {}),
              ...(opts.json === true ? { json: true } : {}),
              ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
              ...(opts.excludeTests === true ? { excludeTests: true } : {}),
              ...(opts.excludeVendored === true ? { excludeVendored: true } : {}),
              ...(opts.stats === true ? { stats: true } : {}),
              ...(opts.signature === true ? { sig: true } : {}),
            }),
          // `symbol` searches one name; there is no comma form that would search several.
          { noun: 'spec', mergeable: false },
        ),
      )
    })

  program
    .command('read <spec> [more...]')
    .description(
      "read one symbol's full body (preferred: separate file and selector, e.g. `read \"src/index.ts\" \"parseThing\"`; raw lines: `read \"src/index.ts\" \"10-20\"`; also accepts the legacy `file::symbol`, `file@START-END`, and `file:LINE[-END]` forms; a trailing @LINE anchor in a legacy `file::symbol@LINE` spec picks a specific candidate by its exact starting line; comma-separated symbols in one selector and cross-file legacy specs remain supported)",
    )
    .option('-j, --json', 'output as JSON')
    .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
    .option('--stats', 'add per-symbol reference count and doc-coverage flag')
    .option('--sig, --signature', 'only output the declaration signature, omitting implementation body')
    .action((spec: string, more: string[], opts: { json?: boolean; forceRefresh?: boolean; stats?: boolean; signature?: boolean }) =>
      runExitText(() => {
        const selector = more.length === 1 ? more[0]! : undefined
        let positionalSpec: string | undefined
        if (
          selector !== undefined &&
          selector.length > 0 &&
          fileExists(spec) &&
          !fileExists(`${spec} ${selector}`)
        ) {
          const rangeSpec = `${spec}@${selector}`
          const range = parseLineRange(rangeSpec)
          if (range !== null && range.file === spec) {
            positionalSpec = rangeSpec
          } else if (!selector.includes('::') && !fileExists(selector)) {
            const symbolSpec = `${spec}::${selector}`
            const parsed = parseReadSpec(symbolSpec)
            if (parsed.file === spec && parsed.symbol === selector) positionalSpec = symbolSpec
          }
        }

        const execute = (readSpec: string) =>
          runRead({
            spec: readSpec,
            ...(opts.json === true ? { json: true } : {}),
            ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
            ...(opts.stats === true ? { stats: true } : {}),
            ...(opts.signature === true ? { sig: true } : {}),
          })
        if (positionalSpec !== undefined) return execute(positionalSpec)
        return noteExtraFileArgs(
          'read',
          spec,
          more,
          () => execute(spec),
          // Whether the comma form the note names would actually run depends on the specs themselves, not on the command: `read` merges `::` specs and nothing else.
          { noun: 'spec', mergeable: readSpecsMergeable([spec, ...more]) },
        )
      }),
    )

  program
    .command('peek <spec>')
    .description('context window around a file:line location (default 5 lines context, e.g. src/index.ts:42)')
    .option('-C, --context <n>', 'lines of context before and after (default: 5)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { context?: string; json?: boolean }) =>
      runExitText(() =>
        runPeek({
          spec,
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('-C/--context', opts.context) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('brief <spec> [more...]')
    .description(
      'symbol body + callers + containing doc section in one call (spec: file::symbol; also accepts the file::symbol@LINE anchor form documented under `read`; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported)',
    )
    .option('-j, --json', 'output as JSON')
    .option('--limit <n>', 'max callers to show (default: 20)')
    .option('-C, --context <n>', 'lines of call-site source to show before and after each caller (default 0)')
    .option('--exclude-tests', 'hide callers whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'only show callers whose enclosing symbol name matches this regex (literal substring if it is not valid regex)')
    .action((spec: string, more: string[], opts: { json?: boolean; limit?: string; context?: string; excludeTests?: boolean; grep?: string }) =>
      runExit(() => {
        emitExtraFileArgsNote('brief', spec, more, { noun: 'spec', mergeable: namedSpecsMergeable([spec, ...more]) })
        return runBrief({
          spec,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requirePositiveInt('--limit', opts.limit) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        })
      }),
    )

  program
    .command('section <spec> [more...]')
    .description(
      'read one section from a file (preferred: separate file and heading arguments, e.g. `section "docs/guide.md" "Lesson 16"`; also accepts legacy `file::heading` specs and comma-separated headings in one selector), or list all sections with --list',
    )
    .option('-j, --json', 'output as JSON')
    .option('--list', 'list all section headings in the file instead of reading one')
    .option('--grep <pattern>', 'with --list, filter headings to this regex; otherwise keep only the matching body lines of each section under their nearest sub-heading (literal substring if it is not valid regex)')
    .option('--max-lines <n>', 'limit returned section content to at most N lines from the top')
    .option('--head <n>', 'alias for --max-lines')
    .action((spec: string, more: string[], opts: { json?: boolean; list?: boolean; grep?: string; maxLines?: string; head?: string }) => {
      const maxLinesRaw = opts.maxLines ?? opts.head
      const maxLines = maxLinesRaw !== undefined ? requireNonNegativeInt('--max-lines', maxLinesRaw) : undefined
      return opts.list === true
        ? runExit(() => {
            // --list reads a plain file and has no comma form, so name no suggestion here.
            emitExtraFileArgsNote('section --list', spec, more, { mergeable: false })
            return runListSections({ file: spec, ...(opts.json === true ? { json: true } : {}), ...(opts.grep !== undefined ? { grep: opts.grep } : {}) })
          })
        : runExitText(() => {
            const selector = more.length === 1 ? more[0]! : undefined
            const positionalSpec =
              selector !== undefined &&
              selector.length > 0 &&
              !selector.includes('::') &&
              fileExists(spec) &&
              !fileExists(`${spec} ${selector}`) &&
              !fileExists(selector)
                ? `${spec}::${selector}`
                : undefined
            const execute = (sectionSpec: string) =>
              runSection({
                spec: sectionSpec,
                ...(opts.json === true ? { json: true } : {}),
                ...(maxLines !== undefined ? { maxLines } : {}),
                ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
              })
            if (positionalSpec !== undefined) return execute(positionalSpec)
            return noteExtraFileArgs(
              'section',
              spec,
              more,
              () => execute(spec),
              { noun: 'spec', mergeable: namedSpecsMergeable([spec, ...more]) },
            )
          })
    })

  program
    .command('semantic [query] [more...]')
    .description('semantic search (falls back to full-text search); several queries run in one call, one headed block per query')
    .option('-l, --limit <n>', 'max results (default: 20; 0 or less is refused)')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'filter to hits whose file path matches this regex (literal substring if it is not valid regex); matched against the path as rendered')
    .option('--exclude-tests', 'hide hits whose file is a test file (opt-in; default output is unchanged)')
    .option('--preflight', 'run semantic embedding preflight check and exit')
    .option('--warm', 'warm up the embedding model session in memory')
    .option('--distances', 'report the closest-distance spread of recorded semantic queries (no query text is stored) and the current weak_distance')
    .option('--all', 'with --distances: every project instead of the current one')
    .action(guard(handlers.cmdSemantic))

  program
    .command('search [query] [more...]')
    .description('parallel multi-angle search fusing symbol, heading, text, and semantic channels concurrently via reciprocal rank fusion')
    .option('-l, --limit <n>', 'max results (default: 20)')
    .option('-c, --channels <list>', 'comma-separated channels to query (symbol,heading,text,semantic)')
    .option('-p, --project [path]', 'scope search to one project root instead of the global index (defaults to cwd)')
    .option('-j, --json', 'output as JSON')
    .option('--min-score <score>', 'minimum reciprocal rank fusion score threshold')
    .action(guard(handlers.cmdSearch))

  // `skeleton` and `outline` are the same command over the same options (see OutlineOptions, which is an alias of SkeletonOptions) and differ only in which renderer they hand the file to. They were registered by two blocks identical line for line apart from the name, description and callee, so a flag added to one silently did not exist on the other. Registered in the original order, so `--help` still lists skeleton before outline.
  const registerSymbolListing = (
    name: string,
    description: string,
    run: (opts: SkeletonOptions) => { text: string; code: number },
  ): void => {
    program
      .command(`${name} <file> [more...]`)
      .description(description)
      .option('-j, --json', 'output as JSON')
      .option('--min-lines <n>', 'only show symbols at least N lines long')
      .option('--grep <pattern>', 'only show symbols whose name matches this regex (literal substring if it is not valid regex)')
      .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
      .option('--stats', 'add per-symbol reference count and doc-coverage flag')
      .action(
        (file: string, more: string[], opts: { json?: boolean; minLines?: string; grep?: string; forceRefresh?: boolean; stats?: boolean }) =>
          runExitText(() =>
            noteExtraFileArgs(name, file, more, () =>
              run({
                file,
                ...(opts.json === true ? { json: true } : {}),
                ...(opts.minLines !== undefined ? { minLines: requireNonNegativeInt('--min-lines', opts.minLines) } : {}),
                ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
                ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
                ...(opts.stats === true ? { stats: true } : {}),
              }),
            ),
          ),
      )
  }

  registerSymbolListing(
    'skeleton',
    'list all symbols in a file without bodies (also accepts a comma-separated file list "a,b,c" for one headed block per file)',
    runSkeleton,
  )
  registerSymbolListing(
    'outline',
    'list symbols with line ranges and docstrings (also accepts a comma-separated file list "a,b,c" for one headed block per file)',
    runOutline,
  )

  program
    .command('refs <spec> [more...]')
    .description('find references to one or more symbols (spec: file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported). For an unambiguous TypeScript symbol, automatically type-resolves candidates via the TypeScript compiler API to drop same-named-different-symbol false positives; falls back to name-based matching when that is not possible.')
    .option('--callers', 'group references by their enclosing caller symbol')
    .option('-l, --limit <n>', 'max results')
    .option(
      '--top <n>',
      'for a high-fanout symbol, group references by file (count only) and show only the top N files by reference count instead of a per-line dump',
    )
    .option('-C, --context <n>', 'lines of call-site source to show before and after each reference (default 0)')
    .option('-j, --json', 'output as JSON')
    .option('--exclude-tests', 'hide references whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'filter to references whose call-site file path matches this regex (falls back to a literal substring match when the pattern does not compile); matched against the path as rendered, so ^src/ matches what you see in every form -- drops test/vendored hits from a wide-fanout symbol')
    .action((spec: string, more: string[], opts: { callers?: boolean; limit?: string; top?: string; context?: string; json?: boolean; excludeTests?: boolean; grep?: string }) =>
      runExit(() => {
        emitExtraFileArgsNote('refs', spec, more, { noun: 'spec', mergeable: namedSpecsMergeable([spec, ...more]) })
        return runRefs({
          spec,
          ...(opts.callers === true ? { callers: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requirePositiveInt('--limit', opts.limit) } : {}),
          ...(opts.top !== undefined ? { top: requirePositiveInt('--top', opts.top) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        })
      }),
    )
}
