/**
 * An optional dependency that is imported statically is not optional. SECURITY.md tells an
 * evaluator to install with `--omit=optional` to avoid the advisories that live in the native
 * packages, and that install produced a CLI that could not run a single command: `token-goat
 * --version` exited with ERR_MODULE_NOT_FOUND for `fflate`, because src/archive_query.ts imported
 * it at module scope. fflate is an esbuild external, so the static import survived into the built
 * bundle as a top-level `import ... from "fflate"`, which Node resolves before any code runs --
 * long before reaching the zip command that actually wanted it.
 *
 * tests/guards/startup_lazy_deps.test.ts is the sibling and not a duplicate: it measures what an
 * invocation costs, against a hand-written list of five heavy packages, and two of those are
 * required dependencies that are perfectly allowed to be there. This one asks whether the program
 * runs at all when an optional package is absent, and takes its list from `optionalDependencies`
 * so a new one is covered the day it is added rather than the day somebody remembers.
 *
 * The check is on the built output rather than on source, because that is where the failure
 * lived: a lazy `await import()` compiles to a runtime call that only resolves when reached,
 * while a static import compiles to a top-level import statement that always resolves. Every
 * other optional-dependency reader already uses createLazyModuleLoader; this keeps the next one
 * from quietly regressing.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const distDir = path.join(repoRoot, 'dist')

const OPTIONAL = Object.keys(
  (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>
  }).optionalDependencies ?? {},
)

function distFiles(): string[] {
  return fs.readdirSync(distDir).filter((f) => f.endsWith('.mjs'))
}

/** Bare-specifier top-level imports only. A relative import is another chunk of our own bundle. */
function topLevelImportSpecifiers(text: string): { line: number; specifier: string }[] {
  const found: { line: number; specifier: string }[] = []
  text.split('\n').forEach((line, index) => {
    const match = /^import\s[^'"]*from\s*["']([^"']+)["']/.exec(line) ?? /^import\s*["']([^"']+)["']/.exec(line)
    const specifier = match?.[1]
    if (specifier !== undefined && !specifier.startsWith('.')) found.push({ line: index + 1, specifier })
  })
  return found
}

describe('optional dependencies stay off the startup path', () => {
  it('reads a built bundle at all, so an empty sweep cannot pass as a clean one', () => {
    expect(fs.existsSync(distDir), 'run `npm run build` first').toBe(true)
    expect(distFiles().length).toBeGreaterThan(1)
    expect(OPTIONAL).toContain('fflate')
  })

  it('finds top-level imports in the output, so the matcher is known to match something', () => {
    const all = distFiles().flatMap((f) => topLevelImportSpecifiers(fs.readFileSync(path.join(distDir, f), 'utf8')))

    expect(all.some((i) => i.specifier.startsWith('node:'))).toBe(true)
  })

  it('never imports an optional dependency at the top level of any bundle chunk', () => {
    const offenders: string[] = []
    for (const file of distFiles()) {
      const text = fs.readFileSync(path.join(distDir, file), 'utf8')
      for (const { line, specifier } of topLevelImportSpecifiers(text)) {
        const pkg = OPTIONAL.find((name) => specifier === name || specifier.startsWith(`${name}/`))
        if (pkg !== undefined) offenders.push(`${file}:${line} imports ${specifier}`)
      }
    }

    expect(offenders, 'Node resolves these before any command runs; --omit=optional cannot start').toEqual([])
  })

  // The counterpart claim: the check above passes because optional deps are lazy, not because the
  // matcher is incapable of reporting one. This used to be shown by pointing at better-sqlite3,
  // which was a required dependency imported statically -- true until the move to node:sqlite left
  // `jsonc-parser` as the only runtime dependency, and that one is reached through createRequire,
  // so no npm package is statically imported anywhere in the output today. The mechanism is proven
  // directly instead: the test above establishes that the matcher matches real dist lines, and this
  // one establishes that an optional package sitting in one is what it reports.
  it('reports an optional dependency when a chunk does import it statically', () => {
    const synthetic = 'import { unzipSync } from "fflate"\nimport * as own from "./chunk-ABC.mjs"\nconst late = await import("sharp")\n'

    expect(topLevelImportSpecifiers(synthetic).map((i) => i.specifier)).toEqual(['fflate'])
  })
})
