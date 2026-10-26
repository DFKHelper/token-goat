/** The pre-push selector must never silently skip a test a change affects: this runs the production scanners over the real tracked tree, so a missed bundle spawner or a missed fixture spawner fails here, not on a push. */
// Provenance: HAND-DERIVED. The expectations are computed here from the repo's tracked tests/ text (the built-bundle names are listed by hand from scripts/build-options.mjs and esbuild.config.mjs; fixture basenames and the imports each fixture makes are read from the files); the scanners under test are the production modules, not copies.
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
// The built entries and chunks a test may spawn or import by name (scripts/build-options.mjs ENTRY_POINTS, the CJS client, and the launcher token-goat.mjs).
const BUNDLE_NAMES = ['token-goat.mjs', 'token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs', 'token-goat-hook-client.cjs']
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
  it('every test file that reaches a built bundle, directly or through any chain of helpers it imports, is a bundle reader', () => {
    const code = new Map([...supportText, ...testText])
    const files = new Set(code.keys())
    const reaching = new Set([...code].filter(([, t]) => BUNDLE_NAMES.some((n) => t.includes(n))).map(([p]) => p))
    for (let grew = true; grew; ) {
      grew = false
      for (const [p, t] of code) {
        if (reaching.has(p)) continue
        const imports = relativeSpecifiers(t).map((spec) => resolveSpecifier(p, spec, files))
        if (imports.some((target) => target !== null && reaching.has(target))) {
          reaching.add(p)
          grew = true
        }
      }
    }
    const expected = testFiles.filter((p) => reaching.has(p))
    const reported = new Set(readerTiersForRepo(ROOT, [NO_NAMED_CHANGE], true).flat())
    const missing = expected.filter((p) => !reported.has(p))
    expect(missing).toEqual([])
  })

  it('tests/cli_epipe.test.ts spawns the bundle through a join() path, so a src change selects it as a bundle reader', () => {
    const [, readers, spawners] = readerTiersForRepo(ROOT, [NO_NAMED_CHANGE], true)
    expect([...readers, ...spawners]).toContain('tests/cli_epipe.test.ts')
  })

  it('tests/batch_serve_equivalence.test.ts reaches the bundle through helpers/batch-cli.js, which imports ./bundle.js, so a src change selects it as a bundle spawner', () => {
    const [, , spawners] = readerTiersForRepo(ROOT, [NO_NAMED_CHANGE], true)
    expect(spawners).toContain('tests/batch_serve_equivalence.test.ts')
  })

  it('every test that names a fixture reaches each src module that fixture imports, so a change to that module selects it', () => {
    const sources = readSources(ROOT)
    const graph = importerGraph(sources)
    const files = new Set(sources.keys())
    const missing: string[] = []
    for (const fixture of fixtures) {
      const base = path.posix.basename(fixture)
      // The same boundary rule as the scanner's fixture naming pass, so a name that is the tail of a longer one is not a naming test.
      const named = new RegExp(`(?<![\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`)
      const namers = testFiles.filter((t) => named.test(testText.get(t) ?? ''))
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
