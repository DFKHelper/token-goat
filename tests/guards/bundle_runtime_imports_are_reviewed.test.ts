import { builtinModules } from 'node:module'

import { describe, expect, it } from 'vitest'

import { distSources, expectMatcherStillWorks, packageOf, resolvedSpecifiers } from './bundle_specifiers.js'

/**
 * Every package the shipped bundle can resolve at run time, reviewed by name.
 *
 * `runtime_dependency_set_is_locked.test.ts` locks the other end of this: the packages a consumer's `npm install` puts on disk. That list is necessary and it is not sufficient, because the lockfile is not the only thing that decides what gets loaded. The bundle can reach a package the manifest never declares -- a module the *host application* provides, a devDependency behind a guarded require -- and none of that moves a single byte in `package-lock.json`. A dependency review that reads only the lockfile passes while the bundle grows a new import.
 *
 * So this reads the artifact instead. Every bare specifier `dist/*.mjs` resolves must be named below, which makes "the bundle started loading something new" a build failure that prints the specifier rather than a change nobody sees. Four of the entries are exactly the ones the lockfile guard cannot see, which is the argument for having both.
 *
 * Provenance: CAPTURE. The list was read out of the built bundle by running the enumerator over a real `npm run build` output, not transcribed from `src/` imports or from the manifest. The guard recomputes it from `dist/` on every run, so it compares the artifact as built against the artifact as reviewed.
 *
 * Known limit, stated rather than papered over: a specifier assembled at run time from a variable is invisible here, because there is no literal to read. `tesseract.js` is the live example -- it is an optionalDependency the bundle really does load, and it does not appear in this list. That makes the guard a floor on the import surface, never a ceiling, and it is why the lockfile guard is the other half rather than a duplicate.
 */

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/**
 * Packages the bundle is allowed to resolve by name at run time.
 *
 * Adding one here is the review. Answer what loads it, whether a consumer install actually has it, and what happens on the install that does not -- a resolution that throws where nothing catches is a crash on someone else's machine.
 */
const REVIEWED_RUNTIME_IMPORTS: ReadonlyMap<string, string> = new Map([
  ['jsonc-parser', 'the one required dependency; bundled, and reached through createRequire'],
  ['fflate', 'optionalDependency: decompresses document containers'],
  ['pdfjs-dist', 'optionalDependency: the PDF commands'],
  ['puppeteer-core', 'optionalDependency: page capture'],
  ['sqlite-vec', 'optionalDependency: the vec0 virtual table semantic search queries'],
  ['tree-sitter', 'optionalDependency: the native parser the language adapters drive'],
  ['tree-sitter-c', 'optionalDependency: language grammar'],
  ['tree-sitter-cpp', 'optionalDependency: language grammar'],
  ['tree-sitter-go', 'optionalDependency: language grammar'],
  ['tree-sitter-java', 'optionalDependency: language grammar'],
  ['tree-sitter-javascript', 'optionalDependency: language grammar'],
  ['tree-sitter-python', 'optionalDependency: language grammar'],
  ['tree-sitter-ruby', 'optionalDependency: language grammar'],
  ['tree-sitter-rust', 'optionalDependency: language grammar'],
  ['tree-sitter-typescript', 'optionalDependency: language grammar'],
  // The four below are why reading the lockfile alone is not enough.
  ['typescript', 'optionalDependency that the lockfile flags plain `dev`, because it is also a devDependency'],
  ['onnxruntime-node', 'devDependency only: the embedding backend, behind a guarded require. A consumer install has no copy, so the failure to resolve is the supported path and must stay caught'],
  ['@earendil-works/pi-coding-agent', 'provided by the host agent, never by us: resolved out of the host process and absent from our tree entirely'],
  ['openclaw', 'provided by the host agent, same as above'],
])

/** Every bare package specifier the built bundle resolves, excluding Node builtins and relative and absolute paths. */
function bundleRuntimePackages(): string[] {
  const found = new Set<string>()
  for (const source of distSources()) {
    for (const specifier of resolvedSpecifiers(source)) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || BUILTIN.has(specifier)) continue
      // A Windows drive letter: an absolute path, not a package.
      if (/^[a-z]:/i.test(specifier)) continue
      found.add(packageOf(specifier))
    }
  }
  return [...found].sort()
}

describe('the packages the shipped bundle can load', () => {
  const sources = distSources()

  it('reads a bundle with imports in it, so the checks below cannot pass by finding nothing', () => {
    expect(sources.join('').length).toBeGreaterThan(100_000)
    // The enumerator, not just the file reader: a regex that stopped matching would return an empty set and agree with any expectation at all.
    expect(bundleRuntimePackages().length, 'no bare package specifiers found -- the enumerator has stopped matching').toBeGreaterThan(10)
    expectMatcherStillWorks(sources, 'jsonc-parser')
  })

  it('resolves nothing that has not been reviewed', () => {
    const unreviewed = bundleRuntimePackages().filter((p) => !REVIEWED_RUNTIME_IMPORTS.has(p))
    expect(
      unreviewed,
      'the bundle gained a run-time import nobody reviewed. The lockfile does not have to change for this to happen, which is why it is checked here: decide what loads it and whether a consumer install has it, then add it.',
    ).toEqual([])
  })

  it('does not keep names the bundle no longer resolves', () => {
    const live = new Set(bundleRuntimePackages())
    expect(
      [...REVIEWED_RUNTIME_IMPORTS.keys()].filter((p) => !live.has(p)),
      'reviewed names the bundle no longer imports; drop them so the list keeps meaning what it says',
    ).toEqual([])
  })

  it('gives every reviewed package a reason a reader can check', () => {
    const unexplained = [...REVIEWED_RUNTIME_IMPORTS].filter(([, why]) => why.trim().length < 20).map(([p]) => p)
    // A bare name in an allowlist records that someone typed it, not that anyone decided anything. The reason is the review; without it the next reader has to re-derive the call from scratch.
    expect(unexplained, 'these are allowlisted with no reason given').toEqual([])
  })
})
