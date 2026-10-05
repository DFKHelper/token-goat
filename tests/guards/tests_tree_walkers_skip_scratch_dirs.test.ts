/** Every guard that walks the tests/ tree skips dot-prefixed entries. Two tests make their scratch directories under tests/ on purpose (tests/.tg-embed-backlog-*, tests/.tg-worker-project-config-*: the worker's idle sweep ignores anything under the OS temp dir, so those have to live elsewhere), and they remove them when they finish. A guard walking tests/ in another vitest worker at the same moment lists the directory, then reads a file that has since gone, and fails with ENOENT on a file nobody committed. PROVENANCE: CAPTURE. A full `npm test` run on win32 failed three data_dir_env_pinning tests with `ENOENT: no such file or directory, open '...\tests\.tg-worker-project-config-...\...'`; each passed alone, and the directory named was one tests/worker_project_config.test.ts creates and deletes. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const TESTS = path.resolve('tests')

/** A root the walker reaches tests/ from, in each of the spellings the guards use today. */
const TESTS_ROOT = /'\.\.', '\.\.', 'tests'|, 'tests'\)|resolve\('tests'\)|resolve\((?:__dirname|HERE), '\.\.'\)/
const RECURSIVE_READDIR = /readdirSync\([^)]*withFileTypes|readdirIfPresent\(/
const DOT_SKIP = /\.name\.startsWith\('\.'\)/

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // This walk is itself one of the walkers it checks, so it follows the rule it enforces.
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'fixtures') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourcesUnder(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function testsTreeWalkers(): readonly string[] {
  const walkers = sourcesUnder(TESTS).filter((file) => {
    const src = fs.readFileSync(file, 'utf8')
    return RECURSIVE_READDIR.test(src) && src.includes('isDirectory()') && TESTS_ROOT.test(src)
  })
  return pinnedPopulation({
    what: 'files that walk the tests/ tree recursively',
    items: walkers.map((f) => path.relative(TESTS, f).split(path.sep).join('/')),
    floor: 9,
    mustInclude: ['guards/data_dir_env_pinning.test.ts', 'guards/windows_path_fixture_normalization.test.ts', 'guards/tests_tree_walkers_skip_scratch_dirs.test.ts'],
  })
}

describe('a walk over tests/ never reaches another test\'s scratch directory', () => {
  it('skips dot-prefixed entries in every walker rooted at tests/', () => {
    const missing = testsTreeWalkers().filter((rel) => !DOT_SKIP.test(fs.readFileSync(path.join(TESTS, rel), 'utf8')))
    expect(missing).toEqual([])
  })
})
