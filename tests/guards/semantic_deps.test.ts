// Guard against the "required-but-undeclared semantic-stack dependency" class. db.ts and embeddings.ts each load an optional native package via `_require('<pkg>')` inside a try/catch, so a package missing from package.json fails silently: the require throws, the catch swallows it, and the feature is dead in a clean install. `sqlite-vec` (the vec0 vector store behind semantic search) was required by db.ts but never declared, so semantic search returned nothing on every install since the TS port. grammar_deps.test.ts guards the same class for the tree-sitter grammars; this guards the remaining non-grammar runtime requires, deriving the list from the src sources so every present and future optional native dependency must be declared.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const SRC = path.join(ROOT, 'src')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * The one package allowed to be required at runtime without being installed.
 *
 * Every other entry in this guard exists because an undeclared require fails silently: the require
 * throws, the catch swallows it, and the feature is simply dead. `onnxruntime-node` is now
 * deliberately in that position -- it is a 34 MB native addon for a feature most installs never
 * invoke, so it is opt-in.
 *
 * The exemption is conditional rather than a hole, because "silently dead" is exactly what must not
 * happen. Three things have to hold, and the assertions below check all three: it is still a
 * devDependency, so the repository's own tests exercise the real package rather than a stand-in;
 * `doctor` has a check that names it, so the absence is reported instead of merely happening; and
 * that check prints the command that installs it. Take any of the three away and this fails.
 */
const OPT_IN_AT_RUNTIME = 'onnxruntime-node'

/** Concatenated text of every .ts file under src/, recursively. */
function allSrcText(): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'))
    }
  }
  walk(SRC)
  // Pinned: this returns concatenated text, and an empty walk yields an empty string in which no
  // `_require('pkg')` is ever found -- reported as "no undeclared optional deps", the same verdict
  // a genuinely clean tree produces. The count of files that fed it is the independent check.
  pinnedPopulation({ what: 'src/**/*.ts files concatenated for dependency scanning', items: out, floor: 150 })
  return out.join('\n')
}

/** Every non-grammar package name loaded via `_require('<pkg>')` in src; tree-sitter* grammars are owned by grammar_deps.test.ts. */
function requiredOptionalPackages(): string[] {
  const re = /_require\('([^']+)'\)/g
  const out = new Set<string>()
  const text = allSrcText()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const pkg = m[1]
    // A `node:` specifier is a builtin, not something npm can install, so it is neither missing nor
    // declarable. sqlite_driver.ts requires `node:sqlite` through this same helper (it cannot use a
    // static import without hoisting the load above its warning filter), which is what put a builtin
    // in front of this scan for the first time.
    if (pkg !== undefined && !pkg.startsWith('tree-sitter') && !pkg.startsWith('node:')) out.add(pkg)
  }
  return [...out]
}

/** Union of declared runtime + optional dependency names. */
function declaredDeps(): Set<string> {
  return new Set([
    ...Object.keys(PKG.dependencies ?? {}),
    ...Object.keys(PKG.optionalDependencies ?? {}),
  ])
}

describe('semantic-stack dependency declarations', () => {
  it('every optional native package the runtime requires is declared in package.json', () => {
    const required = requiredOptionalPackages()
    // Sanity: the scan found the known semantic-stack requires (the vec0 vector store and the embedding model), so a future rename that breaks the regex fails loudly here instead of silently asserting against an empty set.
    expect(required).toContain('sqlite-vec')
    expect(required).toContain(OPT_IN_AT_RUNTIME)
    const declared = declaredDeps()
    const missing = required.filter((pkg) => !declared.has(pkg) && pkg !== OPT_IN_AT_RUNTIME)
    expect(missing).toEqual([])
    // The exemption is for that one package and no other: anything else that stops being declared
    // still fails above, and this pins that the exemption was not quietly widened into the rule.
    expect(declared).toContain('sqlite-vec')
  })

  it('the one exempt package is opt-in on purpose, not undeclared by accident', () => {
    // An undeclared require and a deliberate opt-in look identical in package.json. What tells them
    // apart is whether anything tells the user, so the exemption is held to its mitigation here.
    expect(Object.keys(PKG.devDependencies ?? {}), 'the tests still embed with the real package').toContain(
      OPT_IN_AT_RUNTIME,
    )
    expect(declaredDeps(), 'a consumer must not be installing it').not.toContain(OPT_IN_AT_RUNTIME)

    const doctor = fs.readFileSync(path.join(SRC, 'cli_doctor.ts'), 'utf8')
    const check = doctor.slice(doctor.indexOf('export function checkEmbeddings'))
    expect(check, 'doctor must name the package that is missing').toContain(OPT_IN_AT_RUNTIME)
    expect(check, 'and print the command that installs it').toContain(`npm install -g ${OPT_IN_AT_RUNTIME}`)
    // Anchors the slice: an empty or truncated read would satisfy `toContain` on nothing at all.
    expect(check.length).toBeGreaterThan(200)
  })
})
