#!/usr/bin/env node
// Lists the test files `vitest related` cannot link to a src/ change: tests that read the source tree through fs (everything under tests/guards, and any test that reads fs and names a src path outside an import) and tests that spawn or read the built bundle in dist. Usage: node scripts/prepush-tree-readers.mjs [ROOT]. Prints one repo-relative path per line, sorted; exits 1 when tests/ cannot be listed, so the caller falls back to the full leg. Built-in modules only.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const BUNDLE_REF = /token-goat(?:\.core|-hook)?\.mjs|helpers\/bundle|\bBUNDLE\b|\bHOOK_BUNDLE\b|\bCORE_BUNDLE\b|makeBundleProject|runBundle|bundleTg|copilot_session_start_tree|['"`]dist['"`]/
const FS_READ = /readFileSync|readdirSync|readdir\(|readFile\(|statSync|existsSync|opendir|ls-files|\bglob/
const IMPORT_LINE = /^\s*(?:import\b|export\b[^=]*\bfrom\b|(?:vi\.)?(?:doMock|mock)\()|\bawait import\(/
const SRC_REF = /['"`]src['"`]|\bsrc\//
const ROOT_PATH = /\b(?:join|resolve)\(|\bROOT\b|\bREPO\b|process\.cwd|__dirname|import\.meta/

/** @param {string} text @returns {boolean} true when the test text opens the built bundle or reads src through fs */
export function readsTreeOrBundle(text) {
  if (BUNDLE_REF.test(text)) return true
  if (!FS_READ.test(text)) return false
  return text.split(/\r?\n/).some((line) => !IMPORT_LINE.test(line) && SRC_REF.test(line) && ROOT_PATH.test(line))
}

/** @param {string} root @returns {string[]} sorted repo-relative test files that a src change can break without an import edge */
export function treeReaders(root) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && p !== 'tests/fixtures') walk(p)
      } else if (TEST_FILE.test(e.name) && (p.startsWith('tests/guards/') || readsTreeOrBundle(readFileSync(path.join(root, p), 'utf8')))) {
        out.push(p)
      }
    }
  }
  walk('tests')
  return out.sort()
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const list = treeReaders(path.resolve(process.argv[2] ?? '.'))
    if (list.length === 0) process.exit(1)
    process.stdout.write(`${list.join('\n')}\n`)
  } catch {
    process.exit(1)
  }
}
