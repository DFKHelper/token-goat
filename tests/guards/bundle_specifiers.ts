import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'

/** Reading module specifiers out of the built bundle. Two guards ask questions of the same artifact from opposite directions: `bundled_deps_not_installed.test.ts` names packages that must *not* be resolved, and `bundle_runtime_imports_are_reviewed.test.ts` requires every package that *is* resolved to have been reviewed. Both need the same three things -- the emitted sources, a comment classifier, and a matcher that understands esbuild's output shapes -- so they live here rather than in either caller. */

const distDir = path.join(ROOT, 'dist')

/** Every emitted `.mjs` in `dist/`, and the one `.cjs` (the hook client every shim loads first; see esbuild.config.mjs), as source text. Both ship, so a package either one resolves is one the installed tool can load. */
export function distSources(): string[] {
  // Pinned on the filenames rather than the contents this returns: the contents are what the guards search, so anchoring on them would be circular. Counting the files that produced them is the independent check -- an empty dist yields an empty source list and a vacuous pass.
  const files = pinnedPopulation({
    what: 'dist/*.mjs and *.cjs bundle files',
    items: fs.readdirSync(distDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.cjs')),
    floor: 8,
    mustInclude: ['token-goat.mjs', 'token-goat-hook-client.cjs'],
  })
  return files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf8'))
}

/** Is `index` inside a comment? Checked locally rather than by stripping the whole file first: esbuild preserves the JSDoc of the code it inlines, and `js-yaml`'s own docs carry an `@example` block whose body is the line `import { CORE_SCHEMA } from 'js-yaml'`. Read as code, that one comment makes `js-yaml` look resolved when nothing resolves it. Whole-file comment stripping is the wrong tool here -- `pack.ts`'s stripper tracks quote state from the start of the file, which a 600 kB bundle full of regexes and template literals desynchronises -- while "is there an unclosed block comment before this point, or a line comment earlier on this line" is a local question with a local answer. */
export function insideComment(source: string, index: number): boolean {
  const before = source.slice(0, index)
  const openBlock = before.lastIndexOf('/*')
  if (openBlock !== -1 && before.indexOf('*/', openBlock) === -1) {
    return true
  }
  const lineStart = before.lastIndexOf('\n') + 1
  return before.indexOf('//', lineStart) !== -1
}

/** The syntactic positions a module specifier can occupy in esbuild's output, as regex source with `SPEC` standing in for the specifier pattern the caller wants. The last entry covers the `createRequire(import.meta.url)('jsonc-parser')` shape, where the specifier follows a call rather than the `require` keyword. It is anchored on `createRequire` rather than on a bare `)(`, which in a bundle full of IIFEs would match almost anything. */
const FORMS = [
  '\\bfrom\\s*SPEC',
  '\\bimport\\s*\\(\\s*SPEC',
  '\\b__?require\\w*\\s*\\(\\s*SPEC',
  '\\brequire\\s*\\(\\s*SPEC',
  '\\bcreateRequire\\s*\\([^)]*\\)\\s*\\(\\s*SPEC\\s*\\)',
] as const

function forms(spec: string): RegExp[] {
  return FORMS.map((f) => new RegExp(f.replace('SPEC', spec), 'g'))
}

/** Does the bundle resolve `name` as a module specifier in real code? Matches import/require *syntax* rather than the bare name, because the bundle also contains the string `vendor: "zod"` inside inlined code, which is data and not a resolution. */
export function resolvesSpecifier(source: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const re of forms(`["']${n}(?:/[^"']*)?["']`)) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      if (!insideComment(source, m.index)) return true
    }
  }
  return false
}

/** Every specifier the bundle resolves, whatever it names -- the same match, read forwards. `resolvesSpecifier` answers "is this one package resolved", which can only ever check names someone already thought to list. This returns the set, so a package nobody thought of is still seen. */
export function resolvedSpecifiers(source: string): Set<string> {
  const found = new Set<string>()
  for (const re of forms(`["']([^"'\\s]+)["']`)) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      if (!insideComment(source, m.index)) found.add(m[1]!)
    }
  }
  return found
}

/** A specifier's package name: `foo/bar` is the package `foo`, `@scope/pkg/sub` is `@scope/pkg`. */
export function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** Assert the matcher still matches, using a specifier the bundle is known to resolve. Without this every "is not resolved" assertion in either guard passes the moment the matcher stops matching anything, which is the failure mode that leaves a supply-chain guard green over an unguarded bundle. */
export function expectMatcherStillWorks(sources: string[], knownResolved: string): void {
  expect(
    sources.some((s) => resolvesSpecifier(s, knownResolved)),
    `the bundle no longer resolves ${knownResolved}, so nothing here proves the matcher can still find anything`,
  ).toBe(true)
}
