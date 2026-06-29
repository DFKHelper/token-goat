/**
 * Guard against the "required-but-undeclared grammar" class.
 *
 * parser.ts loads each tree-sitter grammar via `_require('tree-sitter-<lang>')`
 * inside a try/catch, so a grammar missing from package.json fails silently:
 * the require throws, the catch swallows it, and that language is silently
 * unparsed in a clean install. `tree-sitter-cpp` was once required but never
 * declared. This test derives the required package list from the parser source
 * itself, so every present and future grammar must be declared as a dependency.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const PARSER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'parser.ts'), 'utf8')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Every `tree-sitter[...]` package name the parser loads via _require(). */
function requiredGrammarPackages(): string[] {
  const re = /_require\('(tree-sitter[\w-]*)'\)/g
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(PARSER_SRC)) !== null) {
    if (m[1] !== undefined) out.add(m[1])
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

describe('grammar dependency declarations', () => {
  it('every tree-sitter grammar the parser requires is declared in package.json', () => {
    const declared = declaredDeps()
    const required = requiredGrammarPackages()
    // Sanity: the regex actually found the grammar requires.
    expect(required).toContain('tree-sitter-cpp')
    expect(required.length).toBeGreaterThanOrEqual(9)
    const missing = required.filter((pkg) => !declared.has(pkg))
    expect(missing).toEqual([])
  })
})
