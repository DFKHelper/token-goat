// Guard: the two project-root caches must be cleared by clearModuleCaches().
//
// batch_serve.ts runs many CLI requests inside one long-lived process, chdir'ing per request, and
// calls clearModuleCaches() after each one so that batch mode stays byte-identical to running the
// same command as its own process -- that equivalence is the whole contract of the mode. Both root
// caches were memoized without registering a reset, so they outlived a request that a real process
// exit would have dropped. The justification written above getDisplayRoot ("this is a one-shot CLI
// process, cwd does not change within its lifetime") is true of the CLI and false of batch_serve,
// which is neither one-shot nor fixed-cwd.
//
// Keying on cwd hides most of it, since a request at a different directory misses the cache anyway.
// What it does not cover is the project root at a FIXED path changing shape between requests, which
// is exactly what these tests do.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveConfigProjectRoot } from '../../src/config.js'
import { getDisplayRoot } from '../../src/project.js'
import { clearModuleCaches } from '../../src/reset.js'
import { tempDir } from '../helpers/temp-config.js'

describe('project-root caches are cleared by clearModuleCaches', () => {
  const cwdBefore = process.cwd()
  afterEach(() => {
    process.chdir(cwdBefore)
    clearModuleCaches()
  })

  it('getDisplayRoot picks up a project marker created after the first lookup', () => {
    const dir = tempDir()
    process.chdir(dir)
    clearModuleCaches()

    expect(getDisplayRoot()).toBeUndefined()

    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8')
    clearModuleCaches()

    expect(getDisplayRoot()).toBeDefined()
  })

  it('resolveConfigProjectRoot picks up a project marker created after the first lookup', () => {
    // The baseline marker MUST live in the parent dir, not be absent. resolveConfigProjectRoot falls
    // back to cwd when findProject finds nothing, and findProject stops walking at the os.tmpdir()
    // boundary -- so with no ancestor marker, `before` resolves to `nested` itself, which is exactly
    // the value the post-marker lookup returns too. The assertion then can't fire regardless of
    // whether the cache was cleared: it only "passed" on Windows/macOS by an incidental path-spelling
    // difference between the cwd fallback and findProject's canonicalized root, and was deterministically
    // red on Linux. Seeding a parent marker makes `before` a genuinely distinct, marker-backed path so
    // the guard measures cache-clearing on every platform: without the reset, the post-marker lookup
    // returns the cached parent root instead of the closer `nested` marker.
    const dir = tempDir()
    const nested = path.join(dir, 'nested')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8')
    process.chdir(nested)
    clearModuleCaches()

    const before = resolveConfigProjectRoot()
    // `before` must have resolved to the parent marker, not the cwd fallback -- otherwise the baseline
    // is meaningless and the divergence below could be incidental.
    expect(path.basename(before)).not.toBe('nested')

    fs.writeFileSync(path.join(nested, 'package.json'), '{}', 'utf8')
    clearModuleCaches()

    const after = resolveConfigProjectRoot()
    expect(after).not.toBe(before)
    expect(path.basename(after)).toBe('nested')
  })

})
