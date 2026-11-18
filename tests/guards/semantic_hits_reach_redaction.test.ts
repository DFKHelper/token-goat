/** Structural guard on the dense-search read path: every file in src that calls `searchSemantic` (the stored chunks of the semantic index, cut text of indexed files) must reach a redactor before it prints or returns a hit's text, because a chunk can hold half a private-key block that the pattern needing both markers never matches. The one that handles the cut is `mergeNearbyHits` (src/semantic_merge.ts, via `redactCutSecrets`); the redactors in src/fence_cap.ts (`redactReadText` and the rest) also count. Callers are found by what imports the module that exports `searchSemantic`, not by a helper name: a named import (aliased or not), a namespace import, a dynamic import and an `export ... from` re-export of that module all make a file a caller, so a new reader that renames the function or reaches it through a namespace is still scanned. Callers checked today: src/read_semantic.ts (the `semantic` command) and src/search/parallel_search.ts (the semantic channel of `search`). Limits, stated once: the check is file level (a redactor call anywhere in the caller's code, comments stripped, satisfies it), so it catches a new caller that redacts nothing and a caller that drops its last redactor, not a single new print path in a file that redacts elsewhere; and a caller that forwards hits to another module unredacted is not followed into that module. Fixture provenance: HAND-DERIVED. The sabotage sources are written to bypass the check by each spelling of the import, not read off src. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The dense-search entry point whose hits carry stored chunk text. */
const SEARCH_FN = 'searchSemantic'

/** Calls that put a hit's text through a redactor: `mergeNearbyHits` redacts each hit as a cut, and the rest are the read-output redactors of src/fence_cap.ts and src/secret_redact.ts. */
const REDACTOR_CALLS: readonly { readonly file: string; readonly name: string }[] = [
  { file: 'semantic_merge.ts', name: 'mergeNearbyHits' },
  { file: 'secret_redact.ts', name: 'redactCutSecrets' },
  { file: 'secret_redact.ts', name: 'redactSecrets' },
  { file: 'fence_cap.ts', name: 'redactReadText' },
  { file: 'fence_cap.ts', name: 'redactReadLines' },
  { file: 'fence_cap.ts', name: 'redactReadJson' },
  { file: 'fence_cap.ts', name: 'redactReadTree' },
  { file: 'fence_cap.ts', name: 'redactKeyedValue' },
  { file: 'fence_cap.ts', name: 'guardRedactAndFence' },
  { file: 'fence_cap.ts', name: 'guardAndFenceFileText' },
]

/** `source` with block comments and whole-line or trailing `//` comments removed, so a redactor named only in prose does not count and neither does a mention of the search function. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function srcFiles(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) Object.assign(out, srcFiles(dir, relPath))
    else if (entry.name.endsWith('.ts')) out[relPath] = fs.readFileSync(path.join(dir, relPath), 'utf8')
  }
  return out
}

/** The src-relative path (`.ts`) a module specifier written in `from` names, or null for a package. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.(?:js|ts)$/, '.ts')
}

/** Every module a file imports, re-exports or dynamically imports. `alias` is the name a namespace import binds; `forwards` marks an `export * from`, which hands the whole module on to the file's own importers. */
function moduleReferences(code: string): { specifier: string; alias?: string; forwards?: true }[] {
  const refs: { specifier: string; alias?: string; forwards?: true }[] = []
  for (const m of code.matchAll(/(?:import|export)\s+(\*\s+as\s+(\w+)|\*)?[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
    const specifier = m[3] ?? ''
    if (m[1] === undefined) refs.push({ specifier })
    else if (m[0].startsWith('export')) refs.push({ specifier, forwards: true })
    else refs.push({ specifier, ...(m[2] === undefined ? {} : { alias: m[2] }) })
  }
  for (const m of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.push({ specifier: m[1] ?? '' })
  return refs
}

/** Whether `code` uses the namespace `alias` for the search function or in a way that can reach it: `alias.searchSemantic`, `alias[...]`, or the namespace passed on as a value. A namespace used only for other members of the module (`alias.embedTexts`) is no caller. */
function usesNamespaceForSearch(code: string, alias: string): boolean {
  const uses = code.replace(new RegExp(`import\\s+\\*\\s+as\\s+${alias}\\b`, 'g'), '')
  return new RegExp(`\\b${alias}\\s*\\[|\\b${alias}\\.${SEARCH_FN}\\b|\\b${alias}\\b(?!\\s*\\.)`).test(uses)
}

/** The src-relative files that call the dense search: those that reference the module exporting it and either name the function, take the module whole and use it for the function, or forward it. */
export function semanticCallers(files: Record<string, string>): string[] {
  const exporters = Object.keys(files).filter((f) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${SEARCH_FN}\\b`).test(files[f] ?? ''))
  const callers: string[] = []
  for (const [file, source] of Object.entries(files)) {
    if (exporters.includes(file)) continue
    const code = stripComments(source)
    const reachesExporter = moduleReferences(code).filter((r) => exporters.includes(resolveSpecifier(file, r.specifier) ?? ''))
    if (reachesExporter.length === 0) continue
    const named = new RegExp(`\\b${SEARCH_FN}\\b`).test(code)
    if (named || reachesExporter.some((r) => r.forwards === true || (r.alias !== undefined && usesNamespaceForSearch(code, r.alias)))) callers.push(file)
  }
  return callers.sort()
}

/** Whether the code of `source` calls one of the redactors. */
function callsRedactor(source: string): boolean {
  const code = stripComments(source)
  return REDACTOR_CALLS.some(({ name }) => new RegExp(`\\b${name}\\s*\\(`).test(code))
}

/** The callers in `files` that reach no redactor. */
export function unredactedSemanticCallers(files: Record<string, string>): string[] {
  return semanticCallers(files).filter((f) => !callsRedactor(files[f] ?? ''))
}

describe('every caller of searchSemantic reaches a redactor before it prints or returns a hit', () => {
  const files = srcFiles(SRC_DIR)

  it('finds the callers that exist today rather than passing on an empty list', () => {
    pinnedPopulation({
      what: 'src files that call searchSemantic',
      items: semanticCallers(files),
      floor: 2,
      mustIncludeExact: ['read_semantic.ts', 'search/parallel_search.ts'],
    })
  })

  it('names redactors that still exist where this guard says they are', () => {
    const missing = REDACTOR_CALLS.filter(({ file, name }) => !new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(files[file] ?? ''))
    expect(missing, 'REDACTOR_CALLS names an export that is gone or moved').toEqual([])
  })

  it('has no caller in src that redacts nothing', () => {
    expect(
      unredactedSemanticCallers(files),
      `These files call ${SEARCH_FN} but reach no redactor. A hit's text is a stored chunk, a cut of a file that can hold half a private-key block; route it through mergeNearbyHits (src/semantic_merge.ts) or a redactor from src/fence_cap.ts before it is printed or returned.`,
    ).toEqual([])
  })

  describe('sabotage: a caller that bypasses the redactors fails the guard', () => {
    const EXPORTER = { 'embeddings.ts': `export async function ${SEARCH_FN}(q: string): Promise<{ text: string }[]> { return [] }\n` }
    const PRINTS = 'for (const h of hits) process.stdout.write(h.text)'

    it('flags a named import', () => {
      const files = { ...EXPORTER, 'cmd.ts': `import { ${SEARCH_FN} } from './embeddings.js'\nconst hits = await ${SEARCH_FN}('q')\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['cmd.ts'])
    })

    it('flags an aliased import', () => {
      const files = { ...EXPORTER, 'cmd.ts': `import { ${SEARCH_FN} as dense } from './embeddings.js'\nconst hits = await dense('q')\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['cmd.ts'])
    })

    it('flags a namespace import even where the call is computed', () => {
      const files = { ...EXPORTER, 'cmd.ts': `import * as emb from './embeddings.js'\nconst hits = await emb['search' + 'Semantic']('q')\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['cmd.ts'])
    })

    it('flags a dynamic import', () => {
      const files = { ...EXPORTER, 'cmd.ts': `const { ${SEARCH_FN}: dense } = await import('./embeddings.js')\nconst hits = await dense('q')\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['cmd.ts'])
    })

    it('flags a re-export of the module', () => {
      const files = { ...EXPORTER, 'barrel.ts': `export * from './embeddings.js'\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['barrel.ts'])
    })

    it('flags a caller in a subdirectory importing by a relative path', () => {
      const files = { ...EXPORTER, 'search/cmd.ts': `import { ${SEARCH_FN} } from '../embeddings.js'\nconst hits = await ${SEARCH_FN}('q')\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['search/cmd.ts'])
    })

    it('does not count a redactor named only in a comment', () => {
      const files = { ...EXPORTER, 'cmd.ts': `import { ${SEARCH_FN} } from './embeddings.js'\n// mergeNearbyHits(hits) would redact these\n/* redactReadText(h.text) */\nconst hits = await ${SEARCH_FN}('q')\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['cmd.ts'])
    })

    it('passes a caller that redacts, so the guard is not flagging every caller', () => {
      const merged = { ...EXPORTER, 'cmd.ts': `import { ${SEARCH_FN} } from './embeddings.js'\nconst hits = mergeNearbyHits(await ${SEARCH_FN}('q'))\n${PRINTS}\n` }
      expect(unredactedSemanticCallers(merged)).toEqual([])
      const fenced = { ...EXPORTER, 'cmd.ts': `import { ${SEARCH_FN} } from './embeddings.js'\nconst hits = await ${SEARCH_FN}('q')\nfor (const h of hits) process.stdout.write(redactReadText(h.text))\n` }
      expect(unredactedSemanticCallers(fenced)).toEqual([])
    })

    it('does not flag a namespace import used only for other members of the module', () => {
      const files = { ...EXPORTER, 'prune.ts': `import * as emb from './embeddings.js'\nconst vecs = await emb.embedTexts(['a'])\nvoid vecs\n` }
      expect(semanticCallers(files)).toEqual([])
    })

    it('flags a namespace passed on as a value', () => {
      const files = { ...EXPORTER, 'cmd.ts': `import * as emb from './embeddings.js'\nrun(emb)\n` }
      expect(unredactedSemanticCallers(files)).toEqual(['cmd.ts'])
    })

    it('does not treat a same-named module in another directory as the exporter', () => {
      const files = { ...EXPORTER, 'other/embeddings.ts': 'export const x = 1\n', 'other/cmd.ts': `import { x } from './embeddings.js'\nvoid x\n` }
      expect(semanticCallers(files)).toEqual([])
    })
  })
})
