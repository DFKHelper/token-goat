import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

// The bin entry (dist/token-goat.mjs) is deliberately a tiny launcher whose only job is to call
// module.enableCompileCache() BEFORE importing the ~3.5MB core bundle. V8 compiles a module in
// full before executing any of it, so the same call inside the core bundle's own banner runs too
// late to cache that bundle -- measured as no change, versus ~22ms off a bare CLI call and ~33ms
// off a spawned hook once it precedes the import.
//
// Nothing about that win is observable from behaviour: point `bin` back at the core bundle, or let
// the launcher grow, and every functional test still passes while the saving quietly disappears.
// These assertions are the only thing that fails.
import { BUNDLE, readCoreBundleText } from '../helpers/bundle.js'

describe('bin launcher', () => {
  it('stays small enough that compiling it is not itself a startup cost', () => {
    const launcher = fs.readFileSync(BUNDLE, 'utf8')
    // Generous next to a real bundle (megabytes) but far below anything with product code in it.
    expect(launcher.length).toBeLessThan(4096)
  })

  it('enables the compile cache before importing the core bundle, not after', () => {
    const launcher = fs.readFileSync(BUNDLE, 'utf8')
    const enableAt = launcher.indexOf('enableCompileCache')
    const importAt = launcher.indexOf('./token-goat.core.mjs')
    expect(enableAt).toBeGreaterThanOrEqual(0)
    expect(importAt).toBeGreaterThanOrEqual(0)
    // Ordering is the whole point: after the import, the core bundle is already compiled.
    expect(enableAt).toBeLessThan(importAt)
  })

  it('keeps the shebang on the launcher, since that is the file bin points at', () => {
    expect(fs.readFileSync(BUNDLE, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('reaches node:module by namespace, so Node 22.0 can still link the file', () => {
    // enableCompileCache landed in Node 22.1 and package.json engines still allows 22.0. A named
    // import of a missing export fails during ESM linking, before any statement runs, so the
    // try/catch guarding the call cannot catch it: every CLI call and every hook would die.
    const launcher = fs.readFileSync(BUNDLE, 'utf8')
    expect(launcher).not.toMatch(/import\s*\{[^}]*enableCompileCache/)
    expect(launcher).toContain("import * as nodeModule from 'node:module'")
  })

  it('never puts a top-level await in the package main entry', () => {
    // This file is `main`, and a top-level await makes the whole graph async, which turns a
    // plain require('token-goat') into ERR_REQUIRE_ASYNC_MODULE -- confirmed against the built file.
    const launcher = fs.readFileSync(BUNDLE, 'utf8')
    expect(launcher).not.toMatch(/^\s*await\s/m)
    expect(launcher).toContain('.catch(')
  })

  it('ships the core bundle alongside it, holding the actual product code', () => {
    // The entry is a few hundred bytes under the split build, so the size assertion is on the
    // whole emitted set: entry plus chunks. What it guards is unchanged -- that the launcher is
    // shipped next to real product code and not on its own.
    expect(readCoreBundleText().length).toBeGreaterThan(1_000_000)
  })
})
