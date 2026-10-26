#!/usr/bin/env node
// Chooses which test files a pre-push suite leg runs, within a time budget. The pushed range (remote sha..local sha of each ref line git gives a pre-push hook) is turned into test files in priority order: the files that failed last time, the changed test files, every guard test, the built-bundle matrix when src changed (none of these is ever cut), then the tests that import a changed module, nearest first (scripts/prepush-graph.mjs), then the tests the import graph cannot see: those naming a changed path as text, and when src changed those reading src as text and those spawning the built bundle (scripts/prepush-readers.mjs). Those tests are added while the estimated wall time stays within the leg's budget (scripts/prepush-budget.mjs, costs from the duration table next to the failure record); every one not added is deferred to CI, which runs the full suite, and is listed. A documentation-only push runs the guards and the tests naming the document. A new ref is diffed from its merge base with origin/main. Any doubt (no ref lines, a deleted ref, a new ref with no merge base, a range git cannot list, a pre-push hook file, a changed path outside src, tests and documentation, an unreadable failure record) means the full leg. Usage: node scripts/prepush-select.mjs ROOT LEG HEAD_SHA PUSH_FILE STORE [DEFER_FILE]. Prints `FULL<TAB>reason` or `FOCUS<TAB>note` and then one repo-relative test path per line; DEFER_FILE receives the deferred-to-CI report. Built-in modules only.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { hasUnparsedFailure, readFailure } from './prepush-failed.mjs'
import { coldCostMs, costFn, fillBudget, legBudget, workersFor } from './prepush-budget.mjs'
import { compareCodeUnits, GIT_TIMEOUT_MS, importReach } from './prepush-graph.mjs'
import { readerTiersForRepo } from './prepush-readers.mjs'
import { durationsPath, readDurations } from './test-durations.mjs'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ZERO_SHA = /^0+$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// TypeScript and JavaScript modules under src/ and tests/: the only paths the import graph (scripts/prepush-graph.mjs) follows an edge from.
const MODULE_PATH = /^(?:src|tests)\/.+\.(?:ts|mts|cts|js|mjs|cjs)$/
const NOT_FOLLOWED = /^tests\/(?:setup|fixtures)\//
// A documentation path: a markdown file anywhere or anything under docs/, except in the directories the product, the build, the tests or the hooks read, which stay full.
const DOC_PATH = /^(?:docs\/|.+\.md$)/i
const NOT_DOC = /^(?:src|tests|scripts|\.github|node_modules)\//
// Anything under .lefthook-scripts: the hook decides what runs, so a focused leg cannot vouch for a change to it, and a change runs the full leg.
const HOOK_SCRIPT = /^\.lefthook-scripts\//
// Past this many changed paths the reader scan (one alternation over every path, run over every test text) costs minutes, so the leg runs in full.
const MAX_CHANGED_PATHS = 200

/** @template T @param {() => T} fn a read of the selection's input @returns {T | null} fn's value, or null when fn throws; decideSelection maps null to the full leg, so a failed read never selects nothing */
export function orNull(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

/** @param {(modules: string[]) => {tests: Map<string, number>, setups: string[]}} read one read of the import graph for the changed modules, throws when it cannot be read @returns {{importers: (modules: string[]) => Map<string, number> | null, setups: (modules: string[]) => string[] | null}} both seams share one memo per modules key, and each is null when the read throws */
export function importSeams(read) {
  const memo = new Map()
  const reachFor = (modules) => {
    const key = modules.join('\0')
    if (!memo.has(key)) memo.set(key, orNull(() => read(modules)))
    return memo.get(key)
  }
  return {
    importers: (modules) => reachFor(modules)?.tests ?? null,
    setups: (modules) => reachFor(modules)?.setups ?? null,
  }
}

/** @param {string} text the pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line, per githooks(5) @returns {{refs: {lref: string, lsha: string, rref: string, rsha: string}[], bad: string | null}} bad names the first line that is not four fields with two well-formed shas */
export function parsePushRefs(text) {
  const refs = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const f = line.trim().split(/\s+/)
    if (f.length !== 4 || !SHA.test(f[1]) || !SHA.test(f[3])) return { refs: [], bad: line.trim() }
    refs.push({ lref: f[0], lsha: f[1], rref: f[2], rsha: f[3] })
  }
  return { refs, bad: null }
}

/** @param {{lref: string, lsha: string, rref: string, rsha: string}} ref @param {string} headSha @param {string | null} [base] the merge base of the pushed commit with origin/main, for a ref the remote does not have yet @returns {{from: string, to: string} | {full: string}} a ref whose range is not a plain remote..local one (or base..local for a new ref) asks for the full leg */
export function rangeOf(ref, headSha, base = null) {
  if (ZERO_SHA.test(ref.lsha)) return { full: `deletion of ${ref.rref}` }
  if (ref.lsha !== headSha) return { full: `${ref.lref} (${ref.lsha.slice(0, 9)}) is not the checked-out commit ${headSha.slice(0, 9)}` }
  if (ZERO_SHA.test(ref.rsha)) return base === null ? { full: `new remote ref ${ref.rref} with no merge base on origin/main` } : { from: base, to: ref.lsha }
  return { from: ref.rsha, to: ref.lsha }
}

/** @param {string} status git's one-letter status @param {string} p repo-relative path @returns {{kind: 'test' | 'module' | 'doc' | 'skip'} | {full: string}} a doc runs the guards and the tests that name it as text (scripts/prepush-readers.mjs), never the full leg */
export function classifyPath(status, p) {
  if (NOT_FOLLOWED.test(p)) return { full: `${p} is test setup or a fixture, which the import graph cannot see` }
  if (HOOK_SCRIPT.test(p)) return { full: `${p} is a pre-push hook file, which the focused leg cannot verify, so the full leg runs` }
  if (DOC_PATH.test(p) && !NOT_DOC.test(p)) return { kind: 'doc' }
  if (!MODULE_PATH.test(p)) return { full: `${p} is not a src or tests module, so the import graph cannot see what reads it` }
  const isTest = p.startsWith('tests/') && TEST_FILE.test(p)
  if (status === 'D') return isTest ? { kind: 'skip' } : { full: `${p} was deleted and its importers cannot be found` }
  return { kind: isTest ? 'test' : 'module' }
}

/** @param {string} out `git diff -z --name-status --no-renames` output @returns {{status: string, path: string}[]} */
export function parseNameStatus(out) {
  const parts = out.split('\0')
  const rows = []
  for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i].slice(0, 1), path: parts[i + 1] })
  return rows
}

/** @param {{ leg: string, headSha: string, pushText: string, env: Record<string, string | undefined>, changed: (from: string, to: string) => {status: string, path: string}[] | null, failed: () => string[], unparsedFailure: () => boolean, exists: (rel: string) => boolean, guards: () => string[], matrix: () => string[], importers: (modules: string[]) => Map<string, number> | null, durations: () => Record<string, number>, workers: number, }} io every outside fact comes in through here, so the decision is a pure function @returns {{full: true, why: string} | {full: false, files: string[], note: string, deferred: string[], deferredReport: string}} files are test files, highest priority first within the never-cut classes; deferredReport is the text that lists what the budget cut, empty when it cut nothing */
export function decideSelection(io) {
  const { leg } = io
  if (io.env['PREPUSH_FULL'] === '1' || io.env['TG_PREPUSH_FULL'] === '1') return { full: true, why: 'PREPUSH_FULL=1' }
  const parsed = parsePushRefs(io.pushText)
  if (parsed.bad !== null) return { full: true, why: `unreadable pushed ref line "${parsed.bad}"` }
  if (parsed.refs.length === 0) return { full: true, why: 'no pushed ref lines on stdin, so the range is unknown' }
  if (io.unparsedFailure()) return { full: true, why: `the last red ${leg} run named no failing test file` }
  const changedRows = new Map()
  for (const ref of parsed.refs) {
    const range = rangeOf(ref, io.headSha, ZERO_SHA.test(ref.rsha) && !ZERO_SHA.test(ref.lsha) ? io.mergeBase(ref.lsha) : null)
    if ('full' in range) return { full: true, why: range.full }
    const rows = io.changed(range.from, range.to)
    if (rows === null) return { full: true, why: `git could not list ${range.from.slice(0, 9)}..${range.to.slice(0, 9)}` }
    for (const row of rows) changedRows.set(row.path, row)
  }
  if (changedRows.size === 0) return { full: true, why: 'the pushed range changes no file' }
  if (changedRows.size > MAX_CHANGED_PATHS) return { full: true, why: `the pushed range changes ${changedRows.size} paths, more than the ${MAX_CHANGED_PATHS} a focused leg reads` }
  const changedTests = []
  const modules = []
  const docs = []
  let srcChanged = false
  for (const { status, path: p } of changedRows.values()) {
    const c = classifyPath(status, p)
    if ('full' in c) return { full: true, why: c.full }
    if (p.startsWith('src/')) srcChanged = true
    if (c.kind === 'doc') {
      docs.push(p)
      continue
    }
    if (c.kind === 'skip' || !io.exists(p)) continue
    if (c.kind === 'test') changedTests.push(p)
    else modules.push(p)
  }
  const guards = io.guards()
  if (guards.length === 0) return { full: true, why: 'no guard tests found under tests/guards' }
  let matrix = []
  if (srcChanged) {
    matrix = io.matrix()
    if (matrix.length === 0) return { full: true, why: 'src changed and the built-bundle matrix tests could not be listed' }
  }
  let distances = new Map()
  if (modules.length > 0) {
    const found = io.importers(modules)
    if (found === null) return { full: true, why: 'the import graph of src and tests could not be read' }
    distances = found
    const setups = io.setups(modules)
    if (setups === null) return { full: true, why: 'the import graph of src and tests could not be read' }
    if (setups.length > 0) return { full: true, why: `${setups[0]} is test setup, which runs before every test` }
  }
  // The tests the import graph cannot see: they name a changed path as text, or (src changed) read src as text or spawn the built bundle.
  let readerTiers = []
  if (modules.length > 0 || docs.length > 0 || srcChanged) {
    const found = io.readers([...modules, ...docs], srcChanged)
    if (found === null) return { full: true, why: 'the test files could not be scanned for readers of the changed files' }
    readerTiers = found
  }
  const failed = io.failed().filter((f) => io.exists(f))
  // Never cut: the last red files, the changed tests, every guard, and the matrix when src changed. Then the importers, nearest first.
  const fixed = [...new Set([...failed, ...changedTests, ...guards, ...matrix])]
  const taken = new Set(fixed)
  const durations = io.durations()
  const cost = costFn(durations)
  const timed = Object.keys(durations).length
  const costSource = timed === 0 ? `no duration table, every file costed at the default ${Math.round(coldCostMs(durations) / 1000)} s` : `${timed} timed files, untimed files costed at their mean ${Math.round(coldCostMs(durations) / 1000)} s`
  const byCost = (a, b) => cost(a) - cost(b) || compareCodeUnits(a, b)
  const importerOrder = [...distances]
    .filter(([f]) => !taken.has(f) && io.exists(f))
    .sort((a, b) => a[1] - b[1] || byCost(a[0], b[0]))
    .map(([f]) => f)
  // After the import tiers, each reader tier in turn; a file already placed higher is not placed again, and every file placed is either kept or listed as deferred.
  const placed = new Set([...taken, ...importerOrder])
  const readerOrder = []
  for (const tier of readerTiers) {
    for (const f of tier.filter((t) => !placed.has(t) && io.exists(t)).sort(byCost)) {
      placed.add(f)
      readerOrder.push(f)
    }
  }
  const budget = legBudget(leg, io.env)
  const fit = fillBudget({ fixed, ordered: [...importerOrder, ...readerOrder], cost, workers: io.workers, budgetS: budget.seconds })
  const keptReaders = fit.kept.filter((f) => !distances.has(f)).length
  const direct = fit.kept.filter((f) => distances.get(f) === 1).length
  const files = [...fixed, ...fit.kept].sort()
  const deferredReport = fit.deferred.length === 0 ? '' : `deferred to CI: ${fit.deferred.length} files (~${Math.round(fit.deferredS)} s)\n${fit.deferred.map((f) => `  ${f}`).join('\n')}\n`
  const note = `${leg} leg focused: ${files.length} file(s), estimated ~${Math.round(fit.estimateS)} s of a ${Math.round(budget.seconds)} s budget (${budget.source}); ${failed.length} failed before, ${changedTests.length} changed tests, ${guards.length} guard tests, ${matrix.length} bundle matrix tests, ${direct} direct and ${fit.kept.length - direct - keptReaders} further importers, ${keptReaders} text or bundle readers; deferred to CI: ${fit.deferred.length} files; costs: ${costSource}; set PREPUSH_FULL=1 for the full leg`
  return { full: false, files, note, deferred: fit.deferred, deferredReport }
}

/** @param {string} root @param {string} sub directory under root @param {(name: string) => boolean} keep @returns {string[]} repo-relative test files tracked in or below sub, listed with `git ls-files` so nothing walks the disk; a git call that fails or times out throws, and the leg runs in full */
function listTests(root, sub, keep) {
  const listed = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '--', sub], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).split('\0')
  return listed.filter((p) => p !== '' && TEST_FILE.test(p) && keep(p)).sort()
}

function main() {
  const [root, leg, headSha, pushFile, store, deferFile] = process.argv.slice(2)
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS })
  // One read of the import graph serves both the importer and the setup seams for the same modules.
  const seams = importSeams((modules) => importReach(root, modules))
  const result = decideSelection({
    leg,
    headSha,
    pushText: pushFile && existsSync(pushFile) ? readFileSync(pushFile, 'utf8') : '',
    env: process.env,
    changed: (from, to) => orNull(() => {
      git('cat-file', '-e', `${from}^{commit}`)
      return parseNameStatus(git('diff', '-z', '--name-status', '--no-renames', from, to))
    }),
    failed: () => (store ? readFailure(store, leg)?.files ?? [] : []),
    unparsedFailure: () => (store ? hasUnparsedFailure(store, leg) : false),
    exists: (rel) => existsSync(path.join(root, rel)),
    guards: () => listTests(root, 'tests/guards', () => true),
    matrix: () => readdirSync(path.join(root, 'tests')).filter((n) => n.startsWith('command_matrix_e2e') && TEST_FILE.test(n)).map((n) => `tests/${n}`).sort(),
    mergeBase: (sha) => orNull(() => {
      const base = git('merge-base', sha, 'origin/main').trim()
      return SHA.test(base) ? base : null
    }),
    readers: (named, srcChanged) => orNull(() => readerTiersForRepo(root, named, srcChanged)),
    importers: seams.importers,
    setups: seams.setups,
    durations: () => (store ? readDurations(durationsPath(store), leg) : {}),
    workers: workersFor(process.env, process.platform),
  })
  if (!result.full && deferFile) writeFileSync(deferFile, result.deferredReport)
  process.stdout.write(result.full ? `FULL\t${leg} leg full: ${result.why}\n` : `FOCUS\t${result.note}\n${result.files.join('\n')}\n`)
}

if (isMainModule(import.meta.url)) {
  try {
    main()
  } catch (e) {
    process.stdout.write(`FULL\tselection failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
