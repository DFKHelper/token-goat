/**
 * Load the regex language adapters before every test file.
 *
 * parser.ts reaches them through a dynamic import (loadRegexExtractors) so hooks never compile them, and its synchronous
 * parse path throws when they are absent. In the shipping paths the CLI's run() and runWorkerLoop await that load; a test
 * that calls indexFileSync or a read command directly has no such entry point, so it is done here instead of in each test.
 *
 * Deliberately importing the registry rather than parser.ts: pulling parser.ts (and its dependency graph) into every test
 * file's module cache would be a much wider graph than the adapters need. The slot key is the one parser.ts reads -- a
 * global symbol, so a vi.resetModules() in a test does not drop the registration.
 *
 * The import has to run inside beforeAll, not at setup-file top level. A setup file is evaluated before the test file,
 * so a top-level import would populate the module cache ahead of that file's hoisted vi.mock calls, and every module the
 * adapter graph touches (`node:fs`, `node:child_process`, `src/util.ts`) would keep its unmocked binding. That is not
 * hypothetical: it broke 11 tests in util.test.ts and project_memory.test.ts, which mock node:fs and node:child_process.
 */
import { beforeAll } from 'vitest'

beforeAll(async () => {
  const slot = globalThis as unknown as Record<symbol, unknown>
  slot[Symbol.for('token-goat.regex-adapters')] ??= await import('../../src/languages/registry.js')
})
