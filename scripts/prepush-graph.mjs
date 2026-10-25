#!/usr/bin/env node
// Finds which test files import a changed module, nearest first. A static scan of the relative import specifiers in src, tests and scripts builds the importer graph; a walk from the changed modules over it gives each test file its distance (1 = imports the module itself). This replaces `vitest related`, which follows importers to any depth and so selects most of the suite whenever a widely imported module changes. Usage: node scripts/prepush-graph.mjs ROOT PATH... prints `<distance><TAB><test file>` per line. Built-in modules only.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const ROOTS = ['src', 'tests', 'scripts']
const SKIPPED_DIRS = new Set(['node_modules', 'fixtures'])
// A relative specifier after an import, re-export, dynamic import, require or a vitest mock call. A specifier built at run time, a path named in a string and a module spawned as a program are not seen: scripts/prepush-readers.mjs finds the tests that reach a module those ways.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire|\b(?:mock|doMock|unmock|doUnmock|importActual|importMock))\s*\(?\s*(['"`])(\.{1,2}(?:\/[^'"`\n]*)?)\1/g
const SOURCE_FOR = { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'], '.jsx': ['.tsx', '.jsx'] }

/** @param {string} a @param {string} b @returns {number} a plain code-unit order, the same on every locale */
export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** @param {string} text @returns {string} the text with every relative import specifier blanked, so what is left names a module only as text */
export function withoutImports(text) {
  return text.replace(SPECIFIER, ' ')
}

/** @param {string} text @returns {string[]} the relative specifiers imported by one file */
export function relativeSpecifiers(text) {
  const out = []
  for (const m of text.matchAll(SPECIFIER)) out.push(m[2])
  return out
}

/** @param {string} from repo-relative importer @param {string} spec relative specifier @param {Set<string>} files every scanned file @returns {string | null} the scanned file the specifier names, trying the extension a `.js` specifier stands for and then a directory index */
export function resolveSpecifier(from, spec, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  const ext = path.posix.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  const tries = [base]
  for (const e of SOURCE_FOR[ext] ?? []) tries.push(stem + e)
  for (const e of ['.ts', '.tsx', '.mts', '.js', '.mjs']) tries.push(base + e, `${base}/index${e}`)
  return tries.find((t) => files.has(t)) ?? null
}

/** @param {Map<string, string>} sources repo-relative path -> file text @returns {Map<string, Set<string>>} module -> the files that import it */
export function importerGraph(sources) {
  const files = new Set(sources.keys())
  const importers = new Map()
  for (const [file, text] of sources) {
    for (const spec of relativeSpecifiers(text)) {
      const target = resolveSpecifier(file, spec, files)
      if (target === null || target === file) continue
      if (!importers.has(target)) importers.set(target, new Set())
      importers.get(target).add(file)
    }
  }
  return importers
}

/** @param {Map<string, Set<string>>} importers @param {string[]} changed repo-relative modules @returns {Map<string, number>} each test file that reaches a changed module through imports, with the fewest import hops (1 = imports it directly); a changed test file is not listed */
export function testDistances(importers, changed) {
  const seen = new Map(changed.map((c) => [c, 0]))
  let frontier = [...changed]
  const tests = new Map()
  for (let hop = 1; frontier.length > 0; hop += 1) {
    const next = []
    for (const m of frontier) {
      for (const importer of importers.get(m) ?? []) {
        if (seen.has(importer)) continue
        seen.set(importer, hop)
        if (TEST_FILE.test(importer)) tests.set(importer, hop)
        next.push(importer)
      }
    }
    frontier = next
  }
  return tests
}

/** @param {string} root @returns {Map<string, string>} repo-relative path -> text for every code file under src, tests and scripts, fixtures and node_modules left out */
export function readSources(root) {
  const sources = new Map()
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(p)
      } else if (CODE_FILE.test(e.name)) {
        sources.set(p, readFileSync(path.join(root, p), 'utf8'))
      }
    }
  }
  for (const r of ROOTS) walk(r)
  return sources
}

/** @param {string} root @param {string[]} changed repo-relative modules @returns {Map<string, number>} test file -> import hops from the nearest changed module */
export function testsImporting(root, changed) {
  return testDistances(importerGraph(readSources(root)), changed)
}

if (isMainModule(import.meta.url)) {
  const [root, ...changed] = process.argv.slice(2)
  if (!root || changed.length === 0) {
    process.stderr.write('usage: node scripts/prepush-graph.mjs ROOT PATH...\n')
    process.exit(2)
  }
  for (const [file, hops] of [...testsImporting(root, changed)].sort((a, b) => a[1] - b[1] || compareCodeUnits(a[0], b[0]))) process.stdout.write(`${hops}\t${file}\n`)
}
