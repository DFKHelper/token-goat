// Parse a throwaway source file through the real `parseFile`, given only its name and content.
//
// Replaces the block that had been copy-pasted into all 49 tests of parser_languages.test.ts and
// a handful of its neighbours: mkdtempSync a dir, join a filename onto it, writeFileSync the
// content, await parseFile, assert, then rmSync the dir. Five lines of identical scaffolding per
// test, none of it the thing under test.
//
// Collapsing it also fixes a real leak the copies all shared: their `fs.rmSync(tmpDir, ...)` sat
// as the last statement of the test body, so a failing assertion threw straight past it and the
// directory survived the run. Cleanup here is not the caller's problem at all -- tempConfigPath
// hands out subdirectories of one per-process root that it removes on exit (and sweeps if a
// worker is killed first), so a fixture is cleaned up whether its test passed, failed, or threw.
//
// The FULL file name is the parameter, never just an extension: language detection keys off the
// whole basename for files like `package.json`, `Makefile`, and `CMakeLists.txt`, so a helper
// that synthesised its own name would quietly reroute those cases to a different parser.
import * as fs from 'node:fs'

import { parseFile } from '../../src/parser.js'
import type { ParseResult } from '../../src/parser.js'

import { tempConfigPath } from './temp-config.js'

/** Writes `content` to a fresh temp dir as `fileName` and returns the path, without parsing it. Use when a test needs the path itself; prefer {@link parseFixture} otherwise. */
export function fixtureFile(fileName: string, content: string): string {
  const filePath = tempConfigPath(fileName)
  fs.writeFileSync(filePath, content)
  return filePath
}

let parseCalls = 0

/** Writes `content` to a fresh temp dir as `fileName` and returns its {@link parseFile} result. Each call gets its own directory, so two calls in one test never collide. */
export async function parseFixture(fileName: string, content: string): Promise<ParseResult> {
  parseCalls++
  return parseFile(fixtureFile(fileName, content))
}

// The first `parseFile` call in a worker pays a one-time lazy initialisation of roughly a second
// (measured: 811-986ms cold, then 1-11ms for every later call, in any language -- the cost is
// generic module/runtime setup, not per-grammar, so warming with one language warms them all).
// Left unwarmed that cost lands on whichever test happens to run first, inside its testTimeout.
// Files with only a handful of tests have nothing to amortise it against, and under full-suite
// worker contention the one-second init stretched past the 60s timeout and failed the first test
// of the file -- always the first, never a later one. Paying it here at module evaluation moves it
// into the import phase, which no per-test timeout applies to, so no test is billed for it.
await parseFixture('warmup.md', '# warmup\n')

// Snapshot taken at module scope, immediately after the warm-up above and before any test body can
// run. Derived from real parseFile invocations rather than set as a literal, so deleting the warm-up
// call drives it to 0 -- a flag assigned unconditionally next to the call would stay true and assert
// nothing at all.
const warmupParses = parseCalls

/** How many parses the module-level warm-up performed. Tests assert this is non-zero rather than timing
 * a parse: a threshold tight enough to separate cold (811-986ms) from warm (1-11ms) would itself flake
 * under the very worker contention the warm-up exists to survive. */
export function parserWarmupParses(): number {
  return warmupParses
}
