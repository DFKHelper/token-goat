/** Load the regex language adapters before every test file. parser.ts reaches them through a dynamic import (loadRegexExtractors) so hooks never compile them, and its synchronous parse path throws when they are absent. In the shipping paths the CLI's run() and runWorkerLoop await that load; a test that calls indexFileSync or a read command directly has no such entry point, so it is done here instead of in each test. Deliberately importing the registry rather than parser.ts: pulling parser.ts (and its dependency graph) into every test file's module cache would be a much wider graph than the adapters need. The slot key is the one parser.ts reads -- a global symbol, so a vi.resetModules() in a test does not drop the registration. The import runs at setup-file top level, not in a beforeAll: a hook carries hookTimeout, and the import of about seventy modules counted against it and timed out under CPU load, while the runner awaits a setup file's own import with no clock. A top-level import alone would populate the module cache ahead of the test file's hoisted vi.mock calls, so every module the adapter graph touches (`node:fs`, `node:child_process`, `src/util.ts`) would keep its unmocked binding (it broke 11 tests in util.test.ts and project_memory.test.ts); vi.resetModules() right after the load drops that cache, so the test file's own imports evaluate under its mocks, and the adapters stay reachable through the global slots. */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, inject, vi } from 'vitest'

import { loadsRegexAdapters } from './regex-preload-decision.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The globalSetup (build-bundle.ts) lists the test files that never reach src/parser.ts, and such a file skips the load: it has nothing to call the parser with, so the import is pure cost, and under a busy machine it was the cost that ran into hookTimeout. A run without that list (inject gives undefined) loads for every file.
function repoRelative(file: string | undefined): string | null {
  if (!file) return null
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  return rel.startsWith('../') ? null : rel
}

// A test file opts out with a line comment starting `// tg-no-regex-preload`, and only when it drives the built bundle or reads files and never calls the parser in its own process. The opt-out removes about seventy module compiles from the fork's start, which on a slow or busy machine is seconds of fork start per file. A file that opts out and then calls indexFileSync fails at once with the parser's own missing-adapters error, so a wrong opt-out is loud, not silent.
const OPT_OUT = /^\/\/ tg-no-regex-preload\b/m

function optedOut(): boolean {
  const file = expect.getState().testPath
  if (!file) return false
  try {
    return OPT_OUT.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

// Awaited at setup-file top level, where the runner's setup import carries no hook or test clock; a beforeAll here counted the whole import against hookTimeout and tripped under CPU load.
if (loadsRegexAdapters(repoRelative(expect.getState().testPath), inject('outsideParserTests'), optedOut())) {
  const slot = globalThis as unknown as Record<symbol, unknown>
  slot[Symbol.for('token-goat.regex-adapters')] ??= await import('../../src/languages/registry.js')
  slot[Symbol.for('token-goat.salesforce-frontend')] ??= await import('../../src/languages/salesforce_frontend.js')
  // Drop the module cache so the test file's own imports evaluate after its hoisted vi.mock calls; the adapters stay reachable through the global slots above.
  vi.resetModules()
}
