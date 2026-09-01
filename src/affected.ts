/**
 * `token-goat affected` -- which test files a set of changed source files can reach.
 *
 * Walks the project's internal import graph *backwards* from each changed file: a test that
 * imports a module that imports the changed file is affected, transitively, to a depth bound.
 * The intended use is narrowing a CI or pre-commit run to the tests a diff can actually break:
 *
 *   git diff --name-only HEAD | token-goat affected --stdin --quiet
 *
 * Distinct from `test-for`, which answers a different question: that one asks which tests
 * reference a file's *symbols* by name, one hop, from the symbol index. This one asks which
 * tests *transitively import* a file, from the import graph. A test that imports a helper that
 * imports the changed module references none of its symbols and is invisible to `test-for`,
 * while a test naming a same-named symbol defined elsewhere is visible to `test-for` and not
 * here. Neither subsumes the other.
 *
 * Every way this command can return fewer files than exist says so, because a short list of
 * affected tests and a complete one look identical, and acting on the short one means shipping
 * an untested change believing it was covered: a seed that is not a tracked file is named
 * rather than dropped, and a depth bound that actually cut the walk short is reported with the
 * number of files still unexplored at the frontier.
 */
import * as path from 'node:path'

import { buildImportGraph } from './import_graph.js'
import { normalizePath, toDisplayPath } from './paths.js'
import { getDisplayRoot } from './project.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { countNoun, ensureNewline, foldPath, isTestFile } from './util.js'

/** Default transitive-import depth. Deep enough for realistic helper chains, bounded so a
 * densely-connected graph cannot walk the entire project and report every test as affected. */
export const DEFAULT_AFFECTED_DEPTH = 5

export interface AffectedOptions {
  /** Changed source files (absolute or relative to `cwd`). */
  files: readonly string[]
  cwd?: string
  /** Max reverse-import hops. Defaults to {@link DEFAULT_AFFECTED_DEPTH}. */
  depth?: number
  /** Regex selecting which reached files count as tests. Defaults to the repo-wide `isTestFile`. */
  filter?: string
  json?: boolean
  /** Print bare paths only, for piping straight into a test runner. */
  quiet?: boolean
}

export interface AffectedResult {
  /** Affected test files, root-relative, sorted. */
  testFiles: string[]
  /** Every file reached by the walk, including non-tests. */
  reachedCount: number
  /** Seeds that are not tracked files, so nothing could be traversed from them. */
  unknownSeeds: string[]
  /** True when the depth bound stopped the walk with files still unexplored. */
  depthLimited: boolean
  /** How many files sat unexplored at the frontier when the depth bound hit. */
  unexploredAtFrontier: number
  depth: number
}

function emit(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/**
 * Reverse-BFS the import graph from `opts.files`.
 *
 * Seeds are matched case-folded, since a changed-file list from `git diff` can spell a path
 * differently from the tracked entry on a case-insensitive filesystem, and an unmatched seed
 * would otherwise be silently reported as affecting nothing.
 */
export function computeAffected(opts: AffectedOptions): AffectedResult {
  const cwd = opts.cwd ?? process.cwd()
  const depth = opts.depth ?? DEFAULT_AFFECTED_DEPTH
  const { files, importedBy } = buildImportGraph(cwd)

  // Both sides go through `normalizePath` before folding. The tracked list comes back in the
  // platform's own separator form (`C:\repo\src\a.ts`) while a resolved seed is normalized to
  // forward slashes with a lowercased drive letter, so folding the raw strings makes every seed on
  // Windows an unknown seed -- a total miss that still exits 0 and prints an empty, plausible
  // "nothing is affected". Normalizing also collapses an 8.3 short-name `%TEMP%` segment, which is
  // the other way the same two spellings of one path fail to meet.
  const trackedByFolded = new Map<string, string>()
  for (const f of files) trackedByFolded.set(foldPath(normalizePath(f)), f)

  const unknownSeeds: string[] = []
  let frontier: string[] = []
  const seen = new Set<string>()

  for (const raw of opts.files) {
    const abs = normalizePath(path.resolve(cwd, raw))
    const tracked = trackedByFolded.get(foldPath(abs))
    if (tracked === undefined) {
      unknownSeeds.push(raw)
      continue
    }
    if (seen.has(tracked)) continue
    seen.add(tracked)
    frontier.push(tracked)
  }

  // The seeds themselves are reached at hop 0: a changed test file is affected by its own
  // change, which is exactly what a caller narrowing a test run wants to hear.
  let hops = 0
  while (frontier.length > 0 && hops < depth) {
    const next: string[] = []
    for (const file of frontier) {
      for (const importer of importedBy.get(file) ?? []) {
        if (seen.has(importer)) continue
        seen.add(importer)
        next.push(importer)
      }
    }
    frontier = next
    hops++
  }

  // `frontier` is non-empty here only when the loop exited on the depth bound with newly
  // discovered files it never expanded. Exiting because nothing new was found leaves it empty,
  // which is a complete walk however many hops it took.
  const depthLimited = frontier.length > 0
  // Deliberately not `compileGrepMatcher`: that helper silently degrades an invalid regex to a
  // substring match, which is right for an interactive `grep` and wrong here. `--filter` decides
  // which tests a CI run executes, so a typo quietly matching a different set than intended is
  // the kind of confident wrong answer this command exists to prevent. runAffected validates the
  // pattern up front and refuses instead.
  const matcher = opts.filter === undefined ? null : new RegExp(opts.filter)
  const isAffectedTest = (f: string): boolean => (matcher === null ? isTestFile(f) : matcher.test(f))

  const root = getDisplayRoot(cwd)
  const testFiles = [...seen]
    .filter(isAffectedTest)
    .map((f) => toDisplayPath(root, f))
    .sort()

  return {
    testFiles,
    reachedCount: seen.size,
    unknownSeeds,
    depthLimited,
    unexploredAtFrontier: frontier.length,
    depth,
  }
}

/** CLI entrypoint. Returns the process exit code. */
export function runAffected(opts: AffectedOptions): number {
  if (opts.depth !== undefined && opts.depth <= 0) {
    emitErr(`--depth must be a positive number, got: ${opts.depth}`)
    return 1
  }
  if (opts.files.length === 0) {
    emitErr('No changed files given. Pass paths as arguments, or pipe them in with --stdin.')
    return 1
  }
  if (opts.filter !== undefined) {
    try {
      new RegExp(opts.filter)
    } catch (err) {
      emitErr(`--filter is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  const result = computeAffected(opts)

  if (opts.json === true) {
    emit(JSON.stringify(result, null, 2))
    return 0
  }

  // --quiet is for `... | xargs vitest run`, so stdout carries paths and nothing else. The
  // disclosures still print, on stderr, because a silently-short list is the failure this
  // command exists to avoid and suppressing them would hand a caller a confident wrong answer.
  if (opts.quiet === true) {
    for (const f of result.testFiles) emit(f)
  } else if (result.testFiles.length === 0) {
    // Two different empty answers, and conflating them is the failure this command exists to
    // prevent. "No test files import 0 changed files" is what the shared phrasing produced when
    // every seed was untracked -- a sentence that reads like a searched-and-found-nothing result
    // when in fact nothing was searched at all.
    const traced = opts.files.length - result.unknownSeeds.length
    if (traced === 0) {
      emit(`Nothing could be traced: ${result.unknownSeeds.length === 1 ? 'the file given is not tracked' : 'none of the files given are tracked'} in this project.`)
    } else {
      emit(`No test files import ${countNoun(traced, 'changed file')} (within ${countNoun(result.depth, 'hop')}).`)
    }
  } else {
    emit(`${countNoun(result.testFiles.length, 'affected test file')} (${countNoun(result.reachedCount, 'file')} reached within ${countNoun(result.depth, 'hop')}):`)
    for (const f of result.testFiles) emit(`  ${f}`)
  }

  if (result.unknownSeeds.length > 0) {
    emitErr(`Not tracked in this project, so nothing was traced from ${result.unknownSeeds.length === 1 ? 'it' : 'them'}: ${result.unknownSeeds.join(', ')}`)
  }
  if (result.depthLimited) {
    emitErr(`Stopped at --depth ${result.depth} with ${countNoun(result.unexploredAtFrontier, 'file')} still unexplored; more tests may be affected (raise --depth).`)
  }
  return 0
}
