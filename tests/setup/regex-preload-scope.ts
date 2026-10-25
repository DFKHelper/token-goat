import * as fs from 'node:fs'
import * as path from 'node:path'

import { importerGraph, testDistances } from '../../scripts/prepush-graph.mjs'

// The module whose synchronous parse path needs the regex adapters loaded: every caller of indexFileSync, parseContent and the read commands imports it.
export const PARSER_MODULE = 'src/parser.ts'

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TEST_FILE = /^tests\/.*\.test\.ts$/
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist'])
// Deeper than any directory under src, tests or scripts.
const MAX_DEPTH = 8

/** Repo-relative path -> text for every code file under src, tests and scripts. A bounded walk of three known roots, not `git ls-files`: a git call is one more thing that times out on a loaded machine. */
export function readScopeSources(root: string): Map<string, string> {
  const sources = new Map<string, string>()
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(child, depth + 1)
      } else if (CODE_FILE.test(entry.name)) {
        sources.set(child, fs.readFileSync(path.join(root, child), 'utf8'))
      }
    }
  }
  for (const top of ['src', 'tests', 'scripts']) {
    if (fs.existsSync(path.join(root, top))) walk(top, 0)
  }
  return sources
}

/** The test files that provably never reach src/parser.ts through a relative import, a dynamic import with a literal specifier, a require or a vitest mock call, sorted. These are the files that may skip loading the adapters: it is a positive list, so a file the scan did not see, or one that reaches the parser, loads them as before. */
export function testsOutsideParser(sources: Map<string, string>): string[] {
  const reaching = testDistances(importerGraph(sources), [PARSER_MODULE])
  return [...sources.keys()].filter((file) => TEST_FILE.test(file) && !reaching.has(file)).sort()
}
