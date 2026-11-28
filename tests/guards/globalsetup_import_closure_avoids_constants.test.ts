/** Guard: no vitest globalSetup file reaches src/constants.ts through a static import, because globalSetup runs before the worker-only isolate-home setup sets TOKEN_GOAT_HOME, and constants.ts resolves the data dir at load. Static edges only: a dynamic import() inside a function body is not walked, so it stays allowed. Provenance: HAND-DERIVED from the load order in vitest.config.ts and tests/setup/isolate-home.ts (the global setup is a separate module graph from the workers). Specifiers come from the TypeScript AST, so comments and strings are never read as imports; a relative specifier that does not resolve fails the guard rather than being skipped. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FORBIDDEN = 'src/constants.ts'

/** The globalSetup entries named in vitest.config.ts, as repo-relative paths; an unreadable config fails loudly. */
function globalSetupFiles(): string[] {
  const config = readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8')
  const array = /globalSetup:\s*\[([^\]]*)\]/.exec(config)
  if (array === null) throw new Error('vitest.config.ts names no globalSetup array this guard can read')
  return [...array[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => path.posix.normalize(m[1]))
}

/** The module specifiers of every static import, export-from and import-equals statement in one file. */
function staticSpecifiers(file: string): string[] {
  const text = readFileSync(path.join(ROOT, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** The repo-relative file a relative specifier names, trying the TypeScript source a `.js` specifier stands for; undefined when none exists. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = path.resolve(ROOT, path.dirname(from), specifier)
  const stem = base.replace(/\.js$/, '')
  const candidates = [base, `${stem}.ts`, `${stem}.mjs`, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts')]
  const hit = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  return hit === undefined ? undefined : path.relative(ROOT, hit).split(path.sep).join('/')
}

/** The import chain from an entry file to FORBIDDEN, entry first, or undefined when the static closure never reaches it. */
function chainTo(entry: string): string[] | undefined {
  const parent = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (next === FORBIDDEN) {
      const chain: string[] = []
      for (let at: string | null | undefined = next; at !== null && at !== undefined; at = parent.get(at)) chain.unshift(at)
      return chain
    }
    for (const specifier of staticSpecifiers(next)) {
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(next, specifier)
      if (target === undefined) throw new Error(`${next} imports ${specifier}, which resolves to no source file this guard can walk`)
      if (!parent.has(target)) {
        parent.set(target, next)
        queue.push(target)
      }
    }
  }
  return undefined
}

describe('vitest globalSetup static import closure', () => {
  it('walks at least one globalSetup file, and the forbidden module exists', () => {
    expect(globalSetupFiles().length, 'vitest.config.ts names globalSetup files').toBeGreaterThan(0)
    expect(existsSync(path.join(ROOT, FORBIDDEN)), `${FORBIDDEN} exists`).toBe(true)
  })

  it('never reaches src/constants.ts through a static import', () => {
    for (const entry of globalSetupFiles()) {
      const chain = chainTo(entry)
      expect(chain === undefined ? '' : chain.join(' -> '), `globalSetup ${entry} loads ${FORBIDDEN} at import time`).toBe('')
    }
  })
})
