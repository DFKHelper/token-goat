// Guard against the "required-but-undeclared semantic-stack dependency" class. db.ts and embeddings.ts each load an optional native package via `_require('<pkg>')` inside a try/catch, so a package missing from package.json fails silently: the require throws, the catch swallows it, and the feature is dead in a clean install. `sqlite-vec` (the vec0 vector store behind semantic search) was required by db.ts but never declared, so semantic search returned nothing on every install since the TS port. grammar_deps.test.ts guards the same class for the tree-sitter grammars; this guards the remaining non-grammar runtime requires, deriving the list from the src sources so every present and future optional native dependency must be declared.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const SRC = path.join(ROOT, 'src')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

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
    if (pkg !== undefined && !pkg.startsWith('tree-sitter')) out.add(pkg)
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
    expect(required).toContain('@xenova/transformers')
    const declared = declaredDeps()
    const missing = required.filter((pkg) => !declared.has(pkg))
    expect(missing).toEqual([])
  })
})
