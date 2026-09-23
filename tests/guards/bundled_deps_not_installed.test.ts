import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { distSources, expectMatcherStillWorks, resolvesSpecifier } from './bundle_specifiers.js'

/**
 * A package that esbuild inlines into the bundle is never loaded from `node_modules` at run time, so listing it in `dependencies` makes every consumer download code the shipped artifact already carries. `html-to-text` and `exceljs` were moved out for exactly that reason; five more were missed at the time, and this guard is what stops any of the seven drifting back.
 *
 * The manifest half alone would be a test that mirrors the manifest, which proves nothing about behaviour. The half that matters reads the built bundle: if a future change marks one of these external, or reaches it through `createRequire` instead of a static import, the bundle starts resolving a package that is only a devDependency and every consumer install breaks at run time. That is the regression this file exists to catch, and it can only be seen in `dist/`.
 *
 * The converse is guarded too. `jsonc-parser` (reached via `createRequire`) really is resolved at run time, so demoting it ships a broken install.
 *
 * `better-sqlite3` is the third case and needs its own list. It used to be the largest thing a consumer installed; `src/sqlite_driver.ts` replaced it with Node's built-in `node:sqlite`, and it is now a devDependency kept only so `tests/sqlite_driver.test.ts` can diff the driver against it. So it must be in neither of the lists above: not inlined into the bundle, and not resolved from node_modules either. A static import of it anywhere in `src/` would break every consumer install while every test here still passed, because the repository's own tree has it.
 *
 * This asks "is this specific package resolved" of a list someone wrote. `bundle_runtime_imports_are_reviewed.test.ts` asks the same artifact the opposite question -- what is resolved, whoever thought to ask -- over the matcher both share in `bundle_specifiers.ts`.
 */

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest

/** Packages esbuild inlines: their code is in the bundle, but the bundle never resolves them. */
const INLINED = ['commander', 'csv-parse', 'js-yaml', 'smol-toml', 'zod'] as const

/** Packages the bundle genuinely resolves at run time, so they must stay installable. */
const RESOLVED_AT_RUNTIME = ['jsonc-parser'] as const

/** Packages that must appear in the shipped bundle in no form at all: not inlined, not resolved. */
const ABSENT_FROM_THE_BUNDLE = ['better-sqlite3'] as const

describe('packages the bundle inlines are not shipped to consumers', () => {
  it('finds a built bundle to read (so the checks below cannot pass by finding nothing)', () => {
    const sources = distSources()
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.join('').length).toBeGreaterThan(100_000)
  })

  it.each(INLINED)('keeps %s out of the packages a consumer installs', (name) => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(name)
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain(name)
    expect(Object.keys(pkg.devDependencies ?? {}), 'the build and tests still need it').toContain(name)
  })

  it.each(INLINED)('never resolves %s from node_modules in the built bundle', (name) => {
    const offenders = distSources().filter((s) => resolvesSpecifier(s, name))
    expect(offenders, `${name} is a devDependency, so a consumer install has no copy to resolve`).toHaveLength(0)
  })

  it.each(RESOLVED_AT_RUNTIME)('keeps %s installable, because the bundle really does resolve it', (name) => {
    expect(Object.keys(pkg.dependencies ?? {}), 'the bundle resolves this at run time').toContain(name)
  })

  it.each(ABSENT_FROM_THE_BUNDLE)('never ships %s to a consumer in any form', (name) => {
    expect(Object.keys(pkg.dependencies ?? {}), 'nothing in src/ imports it any more').not.toContain(name)
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain(name)
    expect(Object.keys(pkg.devDependencies ?? {}), 'the driver test diffs against it').toContain(name)
    const offenders = distSources().filter((s) => resolvesSpecifier(s, name))
    expect(offenders, `${name} is a devDependency; a consumer install has no copy to resolve`).toHaveLength(0)
  })

  // The positive control for the matcher above: if `resolvesSpecifier` silently stopped matching anything -- or `insideComment` started rejecting everything -- every "never resolves" case would pass for the wrong reason.
  it.each(RESOLVED_AT_RUNTIME)('still detects %s as resolved, proving the matcher works', (name) => {
    expectMatcherStillWorks(distSources(), name)
  })

  // And the comment check must be narrow rather than blanket: a specifier in real code that merely happens to sit after some earlier comment in the file is still a resolution.
  it('treats a specifier as resolved when only an earlier, closed comment precedes it', () => {
    expect(resolvesSpecifier("/* a note */\nimport x from 'commander'\n", 'commander')).toBe(true)
    expect(resolvesSpecifier("/* import x from 'commander' */\n", 'commander')).toBe(false)
    expect(resolvesSpecifier("// import x from 'commander'\n", 'commander')).toBe(false)
  })
})
