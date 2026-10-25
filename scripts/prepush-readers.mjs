// Finds the tests the import graph (scripts/prepush-graph.mjs) cannot see: a test that names a changed file as text (reads it, scans for it, or spawns it as a program), a test that scans src as text, and a test that spawns the built bundle. They are found by one static text scan of the tracked test files and come in three tiers, nearest first: the tests naming a changed path, then the tests that read src as text (only when src changed), then the tests that spawn the bundle (only when src changed). A scan is a superset on purpose: a test listed here that does not reach the change costs budget, never coverage. Built-in modules only.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { compareCodeUnits, relativeSpecifiers, resolveSpecifier, withoutImports } from './prepush-graph.mjs'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
// A call that reads file text or lists a directory.
const FS_READ = /\b(?:readFileSync|readdirSync|readFile|readdir|globSync|opendirSync)\b/
// The src directory named as a string or a path segment.
const SRC_DIR = /(?:['"`/]|\bjoin\([^)]*)src['"`/]/
// The built bundle's file name in any path spelling (a join() of segments still names it), or the shared helper that spawns it.
const BUNDLE = /token-goat\.mjs|helpers\/bundle/
// A string literal that is a URL: a scheme, or a host name followed by a slash (code.claude.com/docs/...).
const URL_SHAPED = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i
// The characters after which a slash opens a regular expression literal rather than dividing.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$/

/** @param {string} root @returns {string[]} every tracked path under tests, listed with `git ls-files` so nothing walks the disk */
function trackedUnderTests(root) {
  return execFileSync('git', ['ls-files', '-z', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter((p) => p !== '')
}

/** @param {string} root @returns {Map<string, string>} repo-relative path -> text of every tracked test file outside tests/fixtures, listed with `git ls-files` so nothing walks the disk */
export function readTrackedTests(root) {
  const texts = new Map()
  for (const p of trackedUnderTests(root)) {
    if (!TEST_FILE.test(p) || p.startsWith('tests/fixtures/')) continue
    texts.set(p, readFileSync(path.join(root, p), 'utf8'))
  }
  return texts
}

/** @param {string} root @returns {Map<string, string>} repo-relative path -> text of every tracked code file under tests that is not a test file (helpers, fixtures, setup): the support a test reaches through an import or a spawned fixture */
export function readTrackedSupport(root) {
  const texts = new Map()
  for (const p of trackedUnderTests(root)) {
    if (TEST_FILE.test(p) || !CODE_FILE.test(p)) continue
    texts.set(p, readFileSync(path.join(root, p), 'utf8'))
  }
  return texts
}

/** @param {Map<string, string>} all repo-relative path -> text of every test and support file @returns {Set<string>} each file that names the built bundle, and each file that imports one of those, to a fixpoint */
function bundleReaders(all) {
  const files = new Set(all.keys())
  const imports = new Map([...all].map(([file, raw]) => [file, relativeSpecifiers(raw).map((spec) => resolveSpecifier(file, spec, files)).filter((t) => t !== null)]))
  const bundle = new Set([...all].filter(([, raw]) => BUNDLE.test(raw)).map(([file]) => file))
  for (let grew = true; grew; ) {
    grew = false
    for (const [file, targets] of imports) {
      if (!bundle.has(file) && targets.some((t) => bundle.has(t))) {
        bundle.add(file)
        grew = true
      }
    }
  }
  return bundle
}

/** @param {string} text @param {number} start index of an opening slash @returns {number} the index just past the slash that closes a regular expression literal starting there, or -1 when none closes on its line */
function regexEnd(text, start) {
  let inClass = false
  for (let j = start + 1; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\n') return -1
    if (c === '\\') j += 1
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return j + 1
  }
  return -1
}

/** @param {string} text @param {number} start index of an opening quote @returns {number} the index just past the closing quote, or -1 when a single or double quote does not close on its line (a template literal may span lines) */
function stringEnd(text, start) {
  const q = text[start]
  for (let j = start + 1; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\\') j += 1
    else if (c === q) return j + 1
    else if (c === '\n' && q !== '`') return -1
  }
  return -1
}

/** @param {string} text @returns {string} the text with each comment and each URL-shaped string literal blanked to spaces (newlines kept), every other character in place; a regular expression literal, and a quote that never closes, are passed over unchanged */
export function withoutCommentsOrUrls(text) {
  const out = []
  let copied = 0
  let prev = ''
  let i = 0
  const blankTo = (to) => {
    out.push(text.slice(copied, i), text.slice(i, to).replace(/[^\n]/g, ' '))
    i = to
    copied = to
  }
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      const nl = text.indexOf('\n', i)
      blankTo(nl === -1 ? text.length : nl)
    } else if (c === '/' && d === '*' && text.indexOf('*/', i + 2) !== -1) {
      blankTo(text.indexOf('*/', i + 2) + 2)
    } else if (c === '/' && (prev === '' || REGEX_AFTER.test(prev)) && regexEnd(text, i) !== -1) {
      i = regexEnd(text, i)
      prev = '/'
    } else if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(text, i)
      if (end === -1) {
        i += 1
        prev = c
      } else if (URL_SHAPED.test(text.slice(i + 1, end - 1))) {
        blankTo(end)
      } else {
        i = end
        prev = c
      }
    } else {
      if (!/\s/.test(c)) prev = c
      i += 1
    }
  }
  out.push(text.slice(copied))
  return out.join('')
}

/** @param {string} changedPath @returns {string[]} the spellings a test may use for the path: the repo-relative path and the file name with its extension */
function namesOf(changedPath) {
  return [...new Set([changedPath, path.posix.basename(changedPath)])]
}

/** @param {Map<string, string>} texts test text by path @param {string[]} changed repo-relative changed modules and documents @param {boolean} srcChanged true when a file under src changed @param {Map<string, string>} [support] the non-test code under tests (helpers, fixtures) a test may reach through an import, which spreads the bundle tier to every test that imports a bundle reader @returns {string[][]} the tiers, each sorted by path: tests naming a changed path, then (src changed) tests reading src as text, then (src changed) tests spawning the bundle; a test appears in the first tier it qualifies for only */
export function textReaderTiers(texts, changed, srcChanged, support = new Map()) {
  const alternatives = changed.flatMap(namesOf).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // A name counts only when it is not the tail of a longer word, so util.ts does not match path_util.ts.
  const named = alternatives.length === 0 ? null : new RegExp(`(?<![\\w.-])(?:${alternatives.join('|')})(?![\\w])`)
  const docsChanged = changed.some((c) => c.startsWith('docs/'))
  const bundle = srcChanged ? bundleReaders(new Map([...support, ...texts])) : new Set()
  const naming = []
  const readers = []
  const spawners = []
  for (const [file, raw] of [...texts].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    // An import of a module is the graph's business; only what a test says outside its imports counts as naming a path or reading src.
    const text = withoutImports(raw)
    // The docs rule reads code only: a comment or a URL that names docs/ is not a read of it.
    const code = docsChanged ? withoutCommentsOrUrls(text) : ''
    if ((named !== null && named.test(text)) || (docsChanged && FS_READ.test(code) && /['"`/]docs['"`/]/.test(code))) naming.push(file)
    else if (srcChanged && FS_READ.test(text) && SRC_DIR.test(text)) readers.push(file)
    else if (srcChanged && bundle.has(file)) spawners.push(file)
  }
  return [naming, readers, spawners]
}

/** @param {string} root @param {string[]} changed repo-relative changed modules and documents @param {boolean} srcChanged true when a file under src changed @returns {string[][]} the tiers of textReaderTiers over the tracked test files of root and their tracked support, the one list the selector and the completeness test both read */
export function readerTiersForRepo(root, changed, srcChanged) {
  return textReaderTiers(readTrackedTests(root), changed, srcChanged, readTrackedSupport(root))
}
