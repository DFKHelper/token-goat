/**
 * A test that asserts on which model files get downloaded has to control the shared model cache,
 * because a cache hit is precisely the absence of a download.
 *
 * `TOKEN_GOAT_MODEL_CACHE_DIR` lets `ensureModelFiles` satisfy a file from a directory that
 * outlives the data root, which is what stops CI refetching the 32 MB weights once per worker.
 * The cost of that is a new way for the environment to change what a test observes:
 * tests/embed_model.test.ts checks the exact URL list `ensureModelFiles` requests, and with the
 * variable exported it saw one fewer request and failed all ten of its cases. It failed only
 * where the variable is set, which is CI and not a developer machine, so the suite was green
 * locally and red on the very platform the change existed to speed up.
 *
 * Neither `tests/setup/isolate-home.ts` nor a blanket delete can fix this: CI has to keep the
 * variable live during the run or the sharing does nothing. So the obligation belongs to each
 * test that reasons about downloads, and this guard is what makes the obligation visible when
 * somebody adds the next one.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const TESTS = path.resolve('tests')
const VAR = 'TOKEN_GOAT_MODEL_CACHE_DIR'

/** Every test file that drives the download path, found by the call rather than by a name list. */
function filesDrivingEnsureModelFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures' && entry.name !== 'node_modules') walk(full)
        continue
      }
      if (!entry.name.endsWith('.test.ts')) continue
      const source = fs.readFileSync(full, 'utf8')
      // The import is what proves the file drives the real function rather than merely naming it in prose.
      if (/^import[^;]*\bensureModelFiles\b/m.test(source)) {
        out.push(path.relative(TESTS, full).split(path.sep).join('/'))
      }
    }
  }
  walk(TESTS)
  return out.sort()
}

describe('tests that observe model downloads control the shared model cache', () => {
  it('has every such test either clear the variable or set it deliberately', () => {
    const drivers = pinnedPopulation({
      what: `test files importing ensureModelFiles, which is what makes ${VAR} able to change their result`,
      items: filesDrivingEnsureModelFiles(),
      floor: 2,
      mustInclude: ['embed_model.test.ts', 'embed_model_shared_cache.test.ts'],
    })

    const unguarded = drivers.filter((rel) => {
      const source = fs.readFileSync(path.join(TESTS, rel), 'utf8')
      // Either shape counts: clearing it makes downloads observable, setting it makes the cache the subject.
      const clears = new RegExp(`delete\\s+process\\.env\\[['"]${VAR}['"]\\]`).test(source)
      const sets = new RegExp(`process\\.env\\[['"]${VAR}['"]\\]\\s*=`).test(source)
      return !clears && !sets
    })

    expect(
      unguarded,
      `${unguarded.join(', ')} drive ensureModelFiles without deciding what ${VAR} should be. Whatever ` +
        `the surrounding environment exports then decides it, and CI exports it while a developer machine ` +
        `usually does not, so a wrong assumption here fails only in CI. Clear it in beforeEach if the test ` +
        `is about what gets downloaded, or set it explicitly if the cache is the thing under test.`,
    ).toEqual([])
  })
})
