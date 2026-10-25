/** The pre-push selector must never silently skip a test a change affects: this runs the production scanners over the real tracked tree, so a missed bundle spawner or a missed fixture spawner fails here, not on a push. */
// Provenance: CAPTURE. The expectations are read from this repo's tests/ text at the commit that adds this file (token-goat.mjs spellings, fixture basenames named by test files, the imports each fixture makes); the scanners under test are the production modules, not copies.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importerGraph, readSources, relativeSpecifiers, resolveSpecifier, testDistances } from '../scripts/prepush-graph.mjs'
import { readerTiersForRepo } from '../scripts/prepush-readers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const BUNDLE_NAME = 'token-goat.mjs'
// A src path no other test names (this file names it, so it lands in the named tier): the readers scan then returns the tests that read src or spawn the bundle, and every tier counts as selected.
const NO_NAMED_CHANGE = 'src/__no_such_module__.ts'

const tracked = execFileSync('git', ['ls-files', '-z', 'tests'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  .split('\0')
  .filter((p) => p !== '' && CODE_FILE.test(p))
const testFiles = tracked.filter((p) => TEST_FILE.test(p) && !p.startsWith('tests/fixtures/'))
const fixtures = tracked.filter((p) => p.startsWith('tests/fixtures/') && !TEST_FILE.test(p))
const supportText = new Map(tracked.filter((p) => !TEST_FILE.test(p)).map((p) => [p, readFileSync(path.join(ROOT, p), 'utf8')]))
const testText = new Map(testFiles.map((p) => [p, readFileSync(path.join(ROOT, p), 'utf8')]))

describe('prepush completeness over the real tree', () => {
  it('every test file that reaches token-goat.mjs, directly or through a helper it imports, is a bundle reader', () => {
    const files = new Set(supportText.keys())
    const helpersWithBundle = new Set([...supportText].filter(([, t]) => t.includes(BUNDLE_NAME)).map(([p]) => p))
    const expected = testFiles.filter((p) => {
      const text = testText.get(p) ?? ''
      if (text.includes(BUNDLE_NAME)) return true
      return relativeSpecifiers(text).some((spec) => {
        const target = resolveSpecifier(p, spec, files)
        return target !== null && helpersWithBundle.has(target)
      })
    })
    const reported = new Set(readerTiersForRepo(ROOT, [NO_NAMED_CHANGE], true).flat())
    const missing = expected.filter((p) => !reported.has(p))
    expect(missing).toEqual([])
  })

  it('tests/cli_epipe.test.ts spawns the bundle through a join() path, so a src change selects it as a bundle reader', () => {
    const [, readers, spawners] = readerTiersForRepo(ROOT, [NO_NAMED_CHANGE], true)
    expect([...readers, ...spawners]).toContain('tests/cli_epipe.test.ts')
  })

  it('every test that names a fixture reaches each src module that fixture imports, so a change to that module selects it', () => {
    const sources = readSources(ROOT)
    const graph = importerGraph(sources)
    const files = new Set(sources.keys())
    const missing: string[] = []
    for (const fixture of fixtures) {
      const base = path.posix.basename(fixture)
      const namers = testFiles.filter((t) => (testText.get(t) ?? '').includes(base))
      const srcModules = relativeSpecifiers(readFileSync(path.join(ROOT, fixture), 'utf8'))
        .map((spec) => resolveSpecifier(fixture, spec, files))
        .filter((t): t is string => t !== null && t.startsWith('src/'))
      for (const src of new Set(srcModules)) {
        const reach = testDistances(graph, [src])
        for (const t of namers) if (!reach.has(t)) missing.push(`${t} names ${fixture}, which imports ${src}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('tests/hook_client_held_slots.test.ts reaches src/hook_server.ts through the held_cli_server fixture it spawns', () => {
    const graph = importerGraph(readSources(ROOT))
    expect(testDistances(graph, ['src/hook_server.ts']).has('tests/hook_client_held_slots.test.ts')).toBe(true)
  })
})
