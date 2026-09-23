/**
 * CLI command registration for code analysis, dependency, graph, and git commands.
 */

import type { Command } from 'commander'
import {
  runCallers,
  runCallChain,
  runImpact,
  runDead,
  runDeps,
  runTypes,
  runScope,
  runSimilar,
  runContextFor,
  runTestFor,
  runCoverageGaps,
  runArch,
  runBlame,
  runAsk,
} from './graph_commands.js'
import { runAnswer } from './answer_router.js'
import {
  DEFAULT_AFFECTED_DEPTH,
  runAffected,
} from './affected.js'
import {
  cmdPack,
  cmdTokens,
  cmdBudget,
  cmdFailures,
  cmdCoverageReportGaps,
  cmdConflicts,
} from './cli_diagnostics.js'
import {
  cmdTodo,
  cmdTrace,
  cmdLogfold,
  cmdLockdeps,
} from './text_commands.js'
import {
  cmdHistory,
} from './config_commands.js'
import {
  runExports,
  runImports,
  runFind,
  runLocate,
  runGrep,
} from './read_commands.js'
import {
  runDepDocs,
} from './dep_docs.js'
import {
  runChanged,
  runDiff,
  runLog,
} from './read_git.js'
import {
  runExit,
  runExitText,
  emitExtraFileArgsNote,
  readStdinPaths,
  requireInt,
  requireNonNegativeInt,
  requirePositiveInt,
} from './cli_dispatch.js'

export type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>

export function registerAnalysisCommands(program: Command, guard: GuardFn): void {
  program
    .command('exports <file> [more...]')
    .description('list exported (public) symbols in a file (also accepts a comma-separated file list "a,b,c" for one headed block per file)')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'only show exported symbols whose name matches this regex (literal substring if it is not valid regex)')
    .action((file: string, more: string[], opts: { json?: boolean; grep?: string }) =>
      runExit(() => {
        emitExtraFileArgsNote('exports', file, more)
        return runExports({ file, ...(opts.json === true ? { json: true } : {}), ...(opts.grep !== undefined ? { grep: opts.grep } : {}) })
      }),
    )

  program
    .command('imports <file> [more...]')
    .description('list the modules a file imports (also accepts a comma-separated file list "a,b,c" for one headed block per file)')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'only show imports whose module specifier matches this regex (literal substring if it is not valid regex)')
    .action((file: string, more: string[], opts: { json?: boolean; grep?: string }) =>
      runExit(() => {
        emitExtraFileArgsNote('imports', file, more)
        return runImports({ file, ...(opts.json === true ? { json: true } : {}), ...(opts.grep !== undefined ? { grep: opts.grep } : {}) })
      }),
    )

  program
    .command('find <pattern>')
    .description('find files containing a symbol matching a pattern')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results')
    .action((pattern: string, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runFind({
          pattern,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('locate <spec>')
    .description('locate symbol or landmark with exact line spans (supports name or file::name, with fuzzy fallback)')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results (default: 25)')
    .option('-f, --file <path>', 'restrict search to a specific file')
    .action((spec: string, opts: { json?: boolean; limit?: string; file?: string }) =>
      runExit(() =>
        runLocate({
          spec,
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('grep <pattern> [paths...]')
    .description('regex search over files, caching nothing (session-aware grep)')
    .option('-j, --json', 'output as JSON')
    .option('--max-lines <n>', 'max matching lines to print')
    .option('--no-recursive', 'do not descend into subdirectories')
    .option('-C, --context <n>', 'lines of context to show before and after each match')
    .option('--symbol', 'annotate each hit with its enclosing symbol (name and kind)')
    .action((pattern: string, paths: string[] | undefined, opts: { json?: boolean; maxLines?: string; recursive?: boolean; context?: string; symbol?: boolean }) =>
      runExit(() =>
        runGrep({
          pattern,
          ...(paths !== undefined && paths.length > 0 ? { path: paths } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.maxLines !== undefined ? { maxLines: requirePositiveInt('--max-lines', opts.maxLines) } : {}),
          ...(opts.recursive === false ? { recursive: false } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.symbol === true ? { symbol: true } : {}),
        }),
      ),
    )

  program
    .command('callers <symbol>')
    .description('find all callers of a symbol, resolved to their enclosing function (accepts file::symbol to disambiguate which same-named definition is meant)')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max references to scan')
    .option('-C, --context <n>', 'lines of call-site source to show before and after each caller (default 0)')
    .option('--exclude-tests', 'hide callers whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'filter to callers whose enclosing symbol name matches this regex (falls back to a literal substring match when the pattern does not compile)')
    .action((symbol: string, opts: { json?: boolean; limit?: string; context?: string; excludeTests?: boolean; grep?: string }) =>
      runExit(() =>
        runCallers({
          symbol,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        }),
      ),
    )

  program
    .command('call-chain <symbol>')
    .description('transitive callers up toward entry points (BFS, cycle-safe; accepts file::symbol to disambiguate which same-named definition is meant)')
    .option('-d, --depth <n>', 'max BFS depth (default 8)')
    .option('-j, --json', 'output as JSON')
    .option('--exclude-tests', 'hide callers whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'only show chains containing a symbol name matching this regex (literal substring if it is not valid regex)')
    .action((symbol: string, opts: { depth?: string; json?: boolean; excludeTests?: boolean; grep?: string }) =>
      runExit(() =>
        runCallChain({
          symbol,
          ...(opts.depth !== undefined ? { depth: requireInt('--depth', opts.depth) } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        }),
      ),
    )

  program
    .command('impact <symbol>')
    .description('transitive set of callers impacted by a change (with hop depth; accepts file::symbol to disambiguate which same-named definition is meant)')
    .option('--top <n>', 'limit output to top N results')
    .option('-j, --json', 'output as JSON')
    .option('--exclude-tests', 'hide callers whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'only show impacted symbols whose name matches this regex (literal substring if it is not valid regex)')
    .action((symbol: string, opts: { top?: string; json?: boolean; excludeTests?: boolean; grep?: string }) =>
      runExit(() =>
        runImpact({
          symbol,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        }),
      ),
    )

  program
    .command('dead')
    .description('symbols with zero references (default kind: function)')
    .option('-k, --kind <kind>', 'symbol kind(s) to check, comma-separated for a union (function, method, class, ...)')
    .option('--include-private', 'include _-prefixed names')
    .option('--top <n>', 'limit output to top N results')
    .option('-j, --json', 'output as JSON')
    .option('--exclude-tests', 'hide dead symbols defined in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'only show dead symbols whose name matches this regex (literal substring if it is not valid regex)')
    .action((opts: { kind?: string; includePrivate?: boolean; top?: string; json?: boolean; excludeTests?: boolean; grep?: string }) =>
      runExit(() =>
        runDead({
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.includePrivate === true ? { includePrivate: true } : {}),
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        }),
      ),
    )

  program
    .command('deps <file>')
    .description('one-level imports: resolves relative imports to project files, groups others as external')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'only show dependencies whose module specifier matches this regex (literal substring if it is not valid regex)')
    .action((file: string, opts: { json?: boolean; grep?: string }) =>
      runExit(() => runDeps({ file, ...(opts.json === true ? { json: true } : {}), ...(opts.grep !== undefined ? { grep: opts.grep } : {}) })),
    )

  program
    .command('types [file]')
    .description('type-like declarations (type, interface, enum, struct, trait, and Python type classes)')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results per kind')
    .option('--grep <pattern>', 'only show type declarations whose name matches this regex (literal substring if it is not valid regex)')
    .option('--exclude-tests', 'hide type declarations defined in a test file (opt-in; default output is unchanged)')
    .action((file: string | undefined, opts: { json?: boolean; limit?: string; grep?: string; excludeTests?: boolean }) =>
      runExit(() =>
        runTypes({
          ...(file !== undefined ? { file } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
        }),
      ),
    )

  program
    .command('scope <fileColonLine>')
    .description('list symbols enclosing a file:line position, innermost first')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runScope({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('similar <spec>')
    .description('find symbols similar to a given "file::symbol" anchor using FTS (also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('--top <n>', 'max results (default 10)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runSimilar({
          spec,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('context-for <task>')
    .description('suggest token-goat read commands for symbols relevant to a task')
    .option('--top <n>', 'max results (default 12)')
    .option('--budget <n>', 'stop when estimated tokens exceed budget')
    .option('-j, --json', 'output as JSON')
    .action((task: string, opts: { top?: string; budget?: string; json?: boolean }) =>
      runExit(() =>
        runContextFor({
          task,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.budget !== undefined ? { budget: requireInt('--budget', opts.budget) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('test-for <file>')
    .description('list test files that reference symbols defined in a source file')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runTestFor({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('coverage-gaps')
    .description('functions and methods with no references in test files')
    .option('--top <n>', 'limit output to top N results (default 50)')
    .option('--include-private', 'include _-prefixed symbols')
    .option('-j, --json', 'output as JSON')
    .action((opts: { top?: string; includePrivate?: boolean; json?: boolean }) =>
      runExit(() =>
        runCoverageGaps({
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.includePrivate === true ? { includePrivate: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('arch')
    .description('internal import graph analysis: hubs, entry points, cycles, and with --modules the groups of files that mostly import each other')
    .option('--top <n>', 'limit hubs, entry points, modules and cross-module pairs to top N (default 10)')
    .option('--modules', 'also group files into modules by who imports whom, and report which modules reach into which (--json carries the full member list of each)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { top?: string; json?: boolean; modules?: boolean }) =>
      runExit(() =>
        runArch({
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.modules === true ? { modules: true } : {}),
        }),
      ),
    )

  program
    .command('affected [files...]')
    .description('test files that transitively import the given changed files (for narrowing a CI run)')
    .option('--stdin', 'read the changed-file list from stdin, one path per line')
    .option('--depth <n>', `max reverse-import hops (default ${DEFAULT_AFFECTED_DEPTH})`)
    .option('--filter <regex>', 'regex deciding which reached files count as tests (default: the built-in test-file heuristic)')
    .option('-q, --quiet', 'print bare paths only, for piping into a test runner')
    .option('-j, --json', 'output as JSON')
    .action((files: string[], opts: { stdin?: boolean; depth?: string; filter?: string; quiet?: boolean; json?: boolean }) =>
      runExit(() =>
        runAffected({
          files: opts.stdin === true ? [...files, ...readStdinPaths()] : files,
          ...(opts.depth !== undefined ? { depth: requireNonNegativeInt('--depth', opts.depth) } : {}),
          ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
          ...(opts.quiet === true ? { quiet: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('blame <spec>')
    .description('git blame for the line range of a symbol ("file::symbol"; also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runBlame({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('ask <question>')
    .description('(experimental) find relevant code context; synthesize with an LLM if TOKEN_GOAT_ASK_BACKEND is set')
    .option('--top <n>', 'max FTS hits to surface (default 8)')
    .option('-j, --json', 'output as JSON')
    .action((question: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runAsk({
          question,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('answer <question>')
    .description('answer a plain-English question from the index alone, or refuse with a reason (no model call, no inference)')
    .action((question: string) => runExit(() => runAnswer({ question })))

  program
    .command('pack [patterns...]')
    .description('bundle matched files into a single LLM-ready output (Markdown, XML, or plain text)')
    .option('--format <style>', 'output style: md (default), xml, or text', 'md')
    .option('--line-numbers', 'prefix each line with its line number')
    .option('--instruction-file <path>', 'append a task prompt from a file')
    .option('--output <path>', 'write output to a file instead of stdout')
    .option('--no-ignore', 'bypass .tokengoatignore patterns')
    .option('--strip-comments', 'remove language-appropriate comments before packing')
    .option('--scan-secrets', 'scan for credentials; exit 2 if any are found')
    .option('--budget <n>', 'exit 3 if the estimated token count exceeds n')
    .action(guard(cmdPack))

  program
    .command('tokens [patterns...]')
    .description('per-file token footprint table, sorted largest-first')
    .option('--tree', 'group by directory with subtotals and percentage of total')
    .option('--top <n>', 'limit to the N biggest files')
    .option('--asc', 'reverse order (ascending)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdTokens))

  program
    .command('budget <patterns...>')
    .description('estimate the total token cost of a file set')
    .option('--context <n>', 'context window in thousands of tokens (shows % fill)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdBudget))

  program
    .command('failures [src]')
    .description('extract failing test blocks from test runner output (pytest, Jest, Go, Cargo)')
    .option('--runner <name>', 'runner hint: pytest, jest, go, or cargo')
    .option('--delta', 'compare against the previously saved failure set for this project (see --key) and report only newly-failing/newly-fixed tests, with still-failing tests as a count')
    .option('--key <name>', 'scope the --delta baseline to a named suite (default: "default"); use distinct keys to track multiple independent suites in the same project')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdFailures))

  program
    .command('todo [patterns...]')
    .description('scan source files for TODO/FIXME/HACK/XXX/NOTE markers')
    .option('--group <by>', 'group output by file or kind (default: file)')
    .option('--kinds <csv>', 'comma-separated marker kinds to include (default: TODO,FIXME,HACK,XXX,NOTE)')
    .option('-j, --json', 'output as JSON')
    .action((patterns: string[], opts: { group?: string; kinds?: string; json?: boolean }) =>
      guard(() => cmdTodo(patterns, opts))(),
    )

  program
    .command('trace [src]')
    .description('condense a Python traceback to project frames only')
    .option('--keep <n>', 'keep last N project frames (default: all)')
    .option('--bodies', 'resolve each frame to its enclosing symbol and include the full body inline')
    .option('-j, --json', 'output as JSON')
    .action((src: string | undefined, opts: { keep?: string; bodies?: boolean; json?: boolean }) =>
      guard(() => cmdTrace(src, opts))(),
    )

  program
    .command('logfold [src]')
    .description('apply log-noise filters then fold consecutive duplicate lines')
    .option('--tail <n>', 'only process the last N lines of input')
    .option('--no-normalize', 'skip volatile-token normalization (still applies filters and folds)')
    .option('--fold-repeats', 'also fold non-consecutive duplicate lines, attributing the total count to the first occurrence')
    .option('-j, --json', 'output as JSON')
    .action(
      (src: string | undefined, opts: { tail?: string; normalize?: boolean; foldRepeats?: boolean; json?: boolean }) =>
        guard(() =>
          cmdLogfold(src, { tail: opts.tail, noNormalize: opts.normalize === false, foldRepeats: opts.foldRepeats, json: opts.json }),
        )(),
    )

  program
    .command('lockdeps [path]')
    .description('summarize a dependency lockfile (auto-detects package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, uv.lock, Pipfile.lock, Cargo.lock, requirements*.txt)')
    .option('-j, --json', 'output as JSON')
    .option('--package <name>', 'query one package only: its resolved version, direct dependencies, and which direct project dependencies depend on it (npm lockfiles only expose the dependency graph)')
    .action((filePath: string | undefined, opts: { json?: boolean; package?: string }) =>
      guard(() => cmdLockdeps(filePath, opts))(),
    )

  program
    .command('dep-docs <package>')
    .description(
      "extract one installed npm package's README, package.json metadata, and (if resolvable) a compact .d.ts signature outline instead of grepping node_modules",
    )
    .option('-j, --json', 'output as JSON')
    .option('--project <path>', 'project root to resolve node_modules against (defaults to cwd)')
    .action((packageName: string, opts: { json?: boolean; project?: string }) =>
      runExitText(() =>
        runDepDocs({
          packageName,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.project !== undefined ? { projectRoot: opts.project } : {}),
        }),
      ),
    )

  program
    .command('coverage-report-gaps <file>')
    .description(
      'uncovered lines/functions/branches from a code-coverage report instead of a raw Read\n\n' +
        'supports LCOV .info text and Istanbul/nyc JSON (coverage-final.json for per-line/function/branch detail, ' +
        'coverage-summary.json for file-level aggregate counts only); format is auto-detected from content, not the filename',
    )
    .option('--file <path>', "narrow to one source file's gaps (matched exact or as a path suffix against the report's own file keys)")
    .option('--json', 'emit the gap report as JSON instead of text')
    .action(guard(cmdCoverageReportGaps))

  program
    .command('conflicts [path]')
    .description(
      'unresolved git merge-conflict markers (<<<<<<< / ||||||| / ======= / >>>>>>>, two-way or diff3 three-way) instead of a raw Read or grep\n\n' +
        'path may be a single file, a directory (scanned recursively), or omitted entirely (scans the whole project from the current directory); ' +
        'only files with at least one conflict region or malformed-marker warning are reported',
    )
    .option('-C, --context <n>', 'lines of surrounding context to include before and after each conflict region (default: 3)')
    .option('--summary', 'line ranges and ours/base/theirs labels only, omitting the conflict content')
    .option('--json', 'emit the results as JSON instead of text')
    .action(guard(cmdConflicts))

  program
    .command('history')
    .description('show recent session history: bash commands and web fetches (current-session or recent cache)')
    .option('--limit <n>', 'max entries to show (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdHistory(opts))())

  program
    .command('changed [ref]')
    .description('list files or symbols changed since a git ref')
    .option('--since <ref>', 'git ref to compare against (default: HEAD~5)')
    .option('--symbol', 'list symbols instead of files')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'filter to changed files whose path matches this regex (falls back to a literal substring match when the pattern does not compile); applies to file paths even in --symbol mode')
    .option('--exclude-tests', 'hide changed files that live in a test file (opt-in; default output is unchanged); applies to file paths even in --symbol mode')
    .action((ref: string | undefined, opts: { since?: string; symbol?: boolean; json?: boolean; grep?: string; excludeTests?: boolean }) =>
      runExit(() =>
        runChanged({
          ref: opts.since ?? ref ?? 'HEAD~5',
          ...(opts.symbol === true ? { symbolMode: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
        }),
      ),
    )

  program
    .command('diff <spec> [ref]')
    .description('show only the git diff hunk(s) that fall within one symbol\'s line range, e.g. `token-goat diff "file.ts::myFn" HEAD~3..HEAD` (also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, ref: string | undefined, opts: { json?: boolean }) =>
      runExit(() =>
        runDiff({
          spec,
          ...(ref !== undefined ? { ref } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('log <spec> [ref]')
    .description('show git commit history scoped to one symbol\'s line range, e.g. `token-goat log "file.ts::myFn" HEAD~10` (also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('--max-count <n>', 'maximum number of commits to show (default 20)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, ref: string | undefined, opts: { maxCount?: string; json?: boolean }) =>
      runExit(() =>
        runLog({
          spec,
          ...(ref !== undefined ? { ref } : {}),
          ...(opts.maxCount !== undefined ? { maxCount: requireNonNegativeInt('--max-count', opts.maxCount) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )
}
