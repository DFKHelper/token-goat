// Finds the tests the import graph (scripts/prepush-graph.mjs) cannot see: a test that names a changed file as text (reads it, scans for it, or spawns it as a program), a test that scans src as text, and a test that spawns the built bundle. They are found by one static text scan of the tracked test files and come in three tiers, nearest first: the tests naming a changed path, then the tests that read src as text (only when src changed), then the tests that spawn the bundle (only when src changed). A scan is a superset on purpose: a test listed here that does not reach the change costs budget, never coverage. Built-in modules only.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { compareCodeUnits, withoutImports } from './prepush-graph.mjs'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// A call that reads file text or lists a directory.
const FS_READ = /\b(?:readFileSync|readdirSync|readFile|readdir|globSync|opendirSync)\b/
// The src directory named as a string or a path segment.
const SRC_DIR = /(?:['"`/]|\bjoin\([^)]*)src['"`/]/
// The shared helper that spawns the built bundle, or the bundle's own path.
const BUNDLE = /helpers\/bundle|dist\/token-goat/

/** @param {string} root @returns {Map<string, string>} repo-relative path -> text of every tracked test file outside tests/fixtures, listed with `git ls-files` so nothing walks the disk */
export function readTrackedTests(root) {
  const out = execFileSync('git', ['ls-files', '-z', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const texts = new Map()
  for (const p of out.split('\0')) {
    if (p === '' || !TEST_FILE.test(p) || p.startsWith('tests/fixtures/')) continue
    texts.set(p, readFileSync(path.join(root, p), 'utf8'))
  }
  return texts
}

/** @param {string} changedPath @returns {string[]} the spellings a test may use for the path: the repo-relative path and the file name with its extension */
function namesOf(changedPath) {
  return [...new Set([changedPath, path.posix.basename(changedPath)])]
}

/** @param {Map<string, string>} texts test text by path @param {string[]} changed repo-relative changed modules and documents @param {boolean} srcChanged true when a file under src changed @returns {string[][]} the tiers, each sorted by path: tests naming a changed path, then (src changed) tests reading src as text, then (src changed) tests spawning the bundle; a test appears in the first tier it qualifies for only */
export function textReaderTiers(texts, changed, srcChanged) {
  const alternatives = changed.flatMap(namesOf).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // A name counts only when it is not the tail of a longer word, so util.ts does not match path_util.ts.
  const named = alternatives.length === 0 ? null : new RegExp(`(?<![\\w.-])(?:${alternatives.join('|')})(?![\\w])`)
  const docsChanged = changed.some((c) => c.startsWith('docs/'))
  const naming = []
  const readers = []
  const spawners = []
  for (const [file, raw] of [...texts].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    // An import of a module is the graph's business; only what a test says outside its imports counts as naming a path or reading src.
    const text = withoutImports(raw)
    if ((named !== null && named.test(text)) || (docsChanged && FS_READ.test(text) && /['"`/]docs['"`/]/.test(text))) naming.push(file)
    else if (srcChanged && FS_READ.test(text) && SRC_DIR.test(text)) readers.push(file)
    else if (srcChanged && BUNDLE.test(raw)) spawners.push(file)
  }
  return [naming, readers, spawners]
}
