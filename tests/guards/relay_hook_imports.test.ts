/**
 * Guard against the "hook handler registered but never wired into the shipping
 * bundle" class.
 *
 * Hook handlers register via a top-level `registerHook(...)` call in files
 * like src/hooks_read.ts, src/hooks_bash.ts, src/hooks_edit.ts, src/hooks_index.ts,
 * src/hooks_mcp.ts, .... They only actually run in the shipped bundle because
 * src/relay.ts has a hand-maintained list of `import './hooks_*.js'`
 * side-effect imports -- relay.ts is the sole entry point every harness's
 * `token-goat hook <event>` invocation goes through (see relay.ts's own module
 * docstring: "Importing this module pulls in every hook-registering module for
 * its side-effects, so the registry is populated by the time relay runs").
 *
 * A new hooks_foo.ts file with a real top-level registerHook() call but no
 * matching `import './hooks_foo.js'` in relay.ts compiles fine, lints clean,
 * and passes its own unit tests (which import the module directly, exercising
 * the injected seam) -- but in the shipped bundle the hook silently never
 * fires, because relay.ts never pulled the module in. This test scans src/ for
 * every hooks_*.ts file with a top-level registerHook() call and asserts
 * relay.ts's import list is complete, plus the mirror-image check (no stale
 * import of a module that no longer registers anything).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')
const RELAY_SRC = fs.readFileSync(path.join(SRC_DIR, 'relay.ts'), 'utf8')

/**
 * Every `hooks_*.ts` file directly under src/ (hooks live at the top level of
 * src/, not in subdirectories like src/bridges/ or src/languages/ -- verified
 * by listing src/ directly rather than assuming this).
 */
function hooksFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^hooks_.*\.ts$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/**
 * True when `file` has a module-top-level `registerHook(` call.
 *
 * Every current registerHook() call site in this codebase starts at column 0
 * (no leading indentation) across hooks_read.ts, hooks_edit.ts, hooks_bash.ts,
 * hooks_mcp.ts, hooks_skill.ts, hooks_fetch.ts, hooks_screenshot.ts,
 * hooks_session.ts, hooks_index.ts, and hooks_compact.ts -- module-scope calls
 * are simply never indented in this codebase's style, while every
 * registerHook-adjacent helper/handler function body that might mention the
 * name in a comment is. A simple anchored-to-line-start regex is therefore
 * sufficient to distinguish a real module-scope registration from one nested
 * inside a function body, matching the plain text/regex scanning style
 * tests/guards/cli_registration.test.ts already establishes for this class of
 * guard test (no AST parse needed).
 */
function hasTopLevelRegisterHook(file: string): boolean {
  const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
  return /^registerHook\(/m.test(src)
}

/** The exact `import './<name>.js'` side-effect import line relay.ts must contain for `file` (a `hooks_*.ts` filename) to be wired into the shipping bundle. */
function expectedImportLine(file: string): string {
  const stem = file.replace(/\.ts$/, '')
  return `import './${stem}.js'`
}

/** Every `hooks_*` module name relay.ts actually imports via a side-effect import. */
function relayImportedHooksModules(): string[] {
  return [...RELAY_SRC.matchAll(/^import '\.\/(\w+)\.js'$/gm)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined && /^hooks_/.test(name))
}

describe('relay.ts hook module imports', () => {
  const registering = hooksFiles().filter(hasTopLevelRegisterHook)

  it('found at least one hook module with a top-level registerHook() call (sanity check that the scan itself is not silently matching nothing)', () => {
    expect(registering.length).toBeGreaterThan(0)
  })

  it("relay.ts imports every hooks_*.ts module that has a top-level registerHook() call", () => {
    const missing = registering.filter((file) => !RELAY_SRC.includes(expectedImportLine(file)))
    expect(missing, 'hooks_*.ts file(s) with a registerHook() call missing from relay.ts\'s import list').toEqual([])
  })

  // The stale-import check below reads a different population from the two checks above: they
  // search RELAY_SRC for a substring, it parses whole anchored lines. That gap can open silently.
  // A style change adding trailing semicolons to relay.ts leaves the substring searches matching
  // and stops the anchored parse matching anything, so the check would report no stale imports
  // because it found no imports at all. The count above pins the hooks_*.ts side, not this one.
  it('still parses relay.ts own import lines, so the stale-import check cannot pass by finding nothing', () => {
    expect(
      relayImportedHooksModules().length,
      'no hooks_* side-effect import was parsed out of relay.ts, so the stale-import check below ' +
        'examines an empty list and always passes. Check whether relay.ts still writes them as a ' +
        'bare anchored import line.',
    ).toBeGreaterThan(0)
  })

  it('relay.ts does not import a hooks_*.ts module that no longer registers anything (stale import)', () => {
    const registeringStems = new Set(registering.map((f) => f.replace(/\.ts$/, '')))
    const stale = relayImportedHooksModules().filter((name) => !registeringStems.has(name))
    expect(stale, 'relay.ts import(s) for hooks_*.ts module(s) with no top-level registerHook() call').toEqual([])
  })
})
