#!/usr/bin/env node
// Chooses which test files a pre-push suite leg runs. The pushed range (remote sha..local sha of each ref line git gives a pre-push hook) is turned into a list: changed test files, `vitest related` on changed modules, every guard test, and when src changed the tests that read the tree or the built bundle. Any doubt (no ref lines, a new or deleted ref, a range git cannot list, a changed path vitest's module graph cannot see) means the full leg. Usage: node scripts/prepush-select.mjs ROOT LEG HEAD_SHA PUSH_FILE STORE. Prints `FULL<TAB>reason` or `FOCUS<TAB>note` and then one repo-relative test or module path per line. Built-in modules only.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { hasUnparsedFailure, readFailure } from './prepush-failed.mjs'
import { treeReaders } from './prepush-tree-readers.mjs'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ZERO_SHA = /^0+$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// TypeScript and JavaScript modules under src/ and tests/: the only paths `vitest related` can follow an import edge from.
const MODULE_PATH = /^(?:src|tests)\/.+\.(?:ts|mts|cts|js|mjs|cjs)$/
const NOT_FOLLOWED = /^tests\/(?:setup|fixtures)\//

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

/** @param {{lref: string, lsha: string, rref: string, rsha: string}} ref @param {string} headSha @returns {{from: string, to: string} | {full: string}} a ref whose range is not a plain remote..local one asks for the full leg */
export function rangeOf(ref, headSha) {
  if (ZERO_SHA.test(ref.lsha)) return { full: `deletion of ${ref.rref}` }
  if (ZERO_SHA.test(ref.rsha)) return { full: `new remote ref ${ref.rref}` }
  if (ref.lsha !== headSha) return { full: `${ref.lref} (${ref.lsha.slice(0, 9)}) is not the checked-out commit ${headSha.slice(0, 9)}` }
  return { from: ref.rsha, to: ref.lsha }
}

/** @param {string} status git's one-letter status @param {string} p repo-relative path @returns {{kind: 'test' | 'module' | 'skip'} | {full: string}} */
export function classifyPath(status, p) {
  if (NOT_FOLLOWED.test(p)) return { full: `${p} is test setup or a fixture, which vitest related cannot see` }
  if (!MODULE_PATH.test(p)) return { full: `${p} is not a src or tests module, so vitest related cannot see what reads it` }
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

/** @param {{ leg: string, headSha: string, pushText: string, env: Record<string, string | undefined>, changed: (from: string, to: string) => {status: string, path: string}[] | null, failed: () => string[], unparsedFailure: () => boolean, exists: (rel: string) => boolean, guards: () => string[], matrix: () => string[], readers: () => string[] | null, }} io every outside fact comes in through here, so the decision is a pure function @returns {{full: true, why: string} | {full: false, files: string[], note: string}} */
export function decideSelection(io) {
  const { leg } = io
  if (io.env['PREPUSH_FULL'] === '1' || io.env['TG_PREPUSH_FULL'] === '1') return { full: true, why: 'PREPUSH_FULL=1' }
  const parsed = parsePushRefs(io.pushText)
  if (parsed.bad !== null) return { full: true, why: `unreadable pushed ref line "${parsed.bad}"` }
  if (parsed.refs.length === 0) return { full: true, why: 'no pushed ref lines on stdin, so the range is unknown' }
  if (io.unparsedFailure()) return { full: true, why: `the last red ${leg} run named no failing test file` }
  const changedRows = new Map()
  for (const ref of parsed.refs) {
    const range = rangeOf(ref, io.headSha)
    if ('full' in range) return { full: true, why: range.full }
    const rows = io.changed(range.from, range.to)
    if (rows === null) return { full: true, why: `git could not list ${range.from.slice(0, 9)}..${range.to.slice(0, 9)}` }
    for (const row of rows) changedRows.set(row.path, row)
  }
  if (changedRows.size === 0) return { full: true, why: 'the pushed range changes no file' }
  const files = new Set()
  let srcChanged = false
  let nChanged = 0
  for (const { status, path: p } of changedRows.values()) {
    const c = classifyPath(status, p)
    if ('full' in c) return { full: true, why: c.full }
    if (p.startsWith('src/')) srcChanged = true
    if (c.kind !== 'skip' && io.exists(p)) {
      files.add(p)
      nChanged += 1
    }
  }
  const failed = io.failed().filter((f) => io.exists(f))
  for (const f of failed) files.add(f)
  const guards = io.guards()
  if (guards.length === 0) return { full: true, why: 'no guard tests found under tests/guards' }
  for (const g of guards) files.add(g)
  let nReaders = 0
  if (srcChanged) {
    const readers = io.readers()
    const matrix = io.matrix()
    if (readers === null || readers.length === 0 || matrix.length === 0) return { full: true, why: 'src changed and the tree-reading and bundle tests could not be listed' }
    for (const r of [...readers, ...matrix]) files.add(r)
    nReaders = readers.length + matrix.length
  }
  const list = [...files].sort()
  const note = `${leg} leg focused: ${list.length} file(s) (${nChanged} changed in the pushed range, ${failed.length} failed before, ${guards.length} guard tests, ${nReaders} tree-reading or bundle tests); set PREPUSH_FULL=1 for the full leg`
  return { full: false, files: list, note }
}

/** @param {string} root @param {string} sub directory under root @param {(name: string) => boolean} keep @returns {string[]} repo-relative test files directly in or below sub */
function listTests(root, sub, keep) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (TEST_FILE.test(e.name) && keep(p)) out.push(p)
    }
  }
  walk(sub)
  return out.sort()
}

function main() {
  const [root, leg, headSha, pushFile, store] = process.argv.slice(2)
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const result = decideSelection({
    leg,
    headSha,
    pushText: pushFile && existsSync(pushFile) ? readFileSync(pushFile, 'utf8') : '',
    env: process.env,
    changed: (from, to) => {
      try {
        git('cat-file', '-e', `${from}^{commit}`)
        return parseNameStatus(git('diff', '-z', '--name-status', '--no-renames', from, to))
      } catch {
        return null
      }
    },
    failed: () => (store ? readFailure(store, leg)?.files ?? [] : []),
    unparsedFailure: () => (store ? hasUnparsedFailure(store, leg) : false),
    exists: (rel) => existsSync(path.join(root, rel)),
    guards: () => listTests(root, 'tests/guards', () => true),
    matrix: () => readdirSync(path.join(root, 'tests')).filter((n) => n.startsWith('command_matrix_e2e') && TEST_FILE.test(n)).map((n) => `tests/${n}`).sort(),
    readers: () => {
      try {
        return treeReaders(root)
      } catch {
        return null
      }
    },
  })
  process.stdout.write(result.full ? `FULL\t${leg} leg full: ${result.why}\n` : `FOCUS\t${result.note}\n${result.files.join('\n')}\n`)
}

if (isMainModule(import.meta.url)) {
  try {
    main()
  } catch (e) {
    process.stdout.write(`FULL\tselection failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
