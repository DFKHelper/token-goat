/** Load the regex language adapters before every test file. parser.ts reaches them through a dynamic import (loadRegexExtractors) so hooks never compile them, and its synchronous parse path throws when they are absent. In the shipping paths the CLI's run() and runWorkerLoop await that load; a test that calls indexFileSync or a read command directly has no such entry point, so it is done here instead of in each test. Deliberately importing the registry rather than parser.ts: pulling parser.ts (and its dependency graph) into every test file's module cache would be a much wider graph than the adapters need. The slot key is the one parser.ts reads -- a global symbol, so a vi.resetModules() in a test does not drop the registration. The import has to run inside beforeAll, not at setup-file top level. A setup file is evaluated before the test file, so a top-level import would populate the module cache ahead of that file's hoisted vi.mock calls, and every module the adapter graph touches (`node:fs`, `node:child_process`, `src/util.ts`) would keep its unmocked binding. That is not hypothetical: it broke 11 tests in util.test.ts and project_memory.test.ts, which mock node:fs and node:child_process. */
import { readFileSync } from 'node:fs'

import { beforeAll, expect } from 'vitest'

// A test file opts out with a line comment starting `// tg-no-regex-preload`, and only when it drives the built bundle or reads files and never calls the parser in its own process. The opt-out removes about seventy module compiles from the fork's start, which on a slow or busy machine is the difference between a hook that finishes and one that hits hookTimeout. A file that opts out and then calls indexFileSync fails at once with the parser's own missing-adapters error, so a wrong opt-out is loud, not silent.
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

beforeAll(async () => {
  if (optedOut()) return
  const slot = globalThis as unknown as Record<symbol, unknown>
  slot[Symbol.for('token-goat.regex-adapters')] ??= await import('../../src/languages/registry.js')
  slot[Symbol.for('token-goat.salesforce-frontend')] ??= await import('../../src/languages/salesforce_frontend.js')
})
