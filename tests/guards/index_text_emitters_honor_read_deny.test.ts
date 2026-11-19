// Guard: index and file-for-output readers call the host Read-deny check or are allowlisted with a reason.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

const ACCESSORS = [
  'querySymbols',
  'queryFileSymbolsWithIds',
  'queryRefs',
  'queryRefsByContext',
  'searchSymbolsFts',
  'searchSymbolsFtsByKind',
  'searchSemantic',
].join('|')
/** The index accessors that return rows carrying stored text (body, docstring, signature, snippet). */
const DB_ACCESSOR = new RegExp(`\\b(?:${ACCESSORS})\\(`)
const DEFINES_ACCESSOR = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+(?:${ACCESSORS})\\b`)
/** A file counts as checked when it calls a deny helper (a bare mention in a comment does not count). */
const DENY_CALL = /\b(?:dropDeniedRows|readDenial|assertReadAllowed)\(/

/** Files that read a file directly and print part of it; each must call the deny check itself. */
const DIRECT_READERS = [
  'cli_cached_output.ts',
  'inline_grep_scan.ts',
  'dep_docs.ts',
  'text_trace.ts',
]

/** Files that call an accessor but print no stored file text, one checked reason each. */
export const ALLOWLIST: Readonly<Record<string, string>> = {
  'answer_router.ts': 'routes a question to a command by symbol names; no stored text',
  'bash_range_savings.ts': 'counts symbol lines to estimate savings; prints numbers only',
  'embedding_boundaries.ts': 'line spans that cut a file into chunks; text is read elsewhere',
  'embeddings.ts': 'defines searchSemantic; callers that print a hit use dropDeniedRows',
  'fold_delivery.ts': 'line spans to fold delivered text; that text came from a guarded read',
  'graph_analysis.ts': 'prints names and locations; the body is only sized for a token estimate',
  'graph_inspection.ts': 'prints names and locations; the body is only classified',
  'graph_traversal.ts': 'walks caller and callee names and locations; no stored text',
  'hint_target.ts': 'reads names and heading levels to name a hint target; no body printed',
  'hooks_read.ts': 'hook hint from names and line ranges only; a hook never throws',
  'inline_symbol_answer.ts': 'body comes through resolveBody, which asserts; a denial gives no answer',
  'index_reader.ts': 'defines the accessors; emitters that print rows are checked at their file',
  'notes.ts': 'the body is hashed into a staleness fingerprint and never printed',
  'read_git.ts': 'prints symbol names and line ranges for a diff; no stored text',
  'read_inspect.ts': 'names and locations for lookups; a body is only tested for an export keyword',
  'read_outline_cache.ts': 'caches listings built after prepareSymbolListing asserted the read',
  'read_section.ts': 'html id span lookup; text is read through readFileText, which asserts',
  'read_spec.ts': 'resolves a spec to rows; a docstring is used only as a bare parent identifier',
  'read_suggest.ts': 'suggests symbol names for a typo; names and locations only',
  'search/symbol_fts.ts': 'defines the FTS accessors; emitters that print a hit use dropDeniedRows',
  'symbol_scan.ts': 'scanning helper returning rows to callers; emitters are checked at their file',
}

const NO_CHECK = 'calls an index accessor with no deny check and is not on the allowlist'
const NO_READ_CHECK = 'reads a file for output without a deny check'

function usesAccessor(text: string): boolean {
  return DB_ACCESSOR.test(text) || DEFINES_ACCESSOR.test(text)
}

/** The source files that break the rule, as `file: reason`. */
export function violations(
  files: ReadonlyMap<string, string>,
  allow: Readonly<Record<string, string>>,
): string[] {
  const found: string[] = []
  for (const [file, text] of files) {
    if (DIRECT_READERS.includes(file) && !DENY_CALL.test(text)) found.push(`${file}: ${NO_READ_CHECK}`)
    if (!usesAccessor(text)) continue
    if (DENY_CALL.test(text) || file in allow) continue
    found.push(`${file}: ${NO_CHECK}`)
  }
  for (const file of Object.keys(allow)) {
    const text = files.get(file)
    if (text === undefined) found.push(`${file}: allowlisted but the file does not exist`)
    else if (DENY_CALL.test(text)) found.push(`${file}: allowlisted but it now calls a deny check`)
    else if (!usesAccessor(text)) found.push(`${file}: allowlisted but it no longer calls an accessor`)
  }
  return found
}

function walk(dir: string, out: Map<string, string>, base = dir): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out, base)
    else if (e.name.endsWith('.ts')) {
      out.set(path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'))
    }
  }
}

describe('index text emitters honor the host Read deny rules', () => {
  const files = new Map<string, string>()
  walk(SRC, files)
  pinnedPopulation({
    what: 'TypeScript files under src/',
    items: [...files.keys()],
    floor: 400,
    mustInclude: ['read_deny.ts', 'read_symbol.ts', 'search/parallel_search.ts'],
  })

  it('every source file that reads index rows or a file for output is checked or allowlisted', () => {
    expect(violations(files, ALLOWLIST)).toEqual([])
  })

  it('fails by name on a planted emitter that prints stored text with no deny check', () => {
    const planted = new Map(files)
    planted.set('planted_emitter.ts', "export const f = () => querySymbols({ name: 'x' })[0]!.body\n")
    expect(violations(planted, ALLOWLIST)).toEqual([`planted_emitter.ts: ${NO_CHECK}`])
  })

  it('fails by name on a direct reader that lost its deny check', () => {
    const stripped = new Map(files)
    stripped.set('text_trace.ts', "export const r = (p: string) => fs.readFileSync(p, 'utf8')\n")
    expect(violations(stripped, ALLOWLIST)).toContain(`text_trace.ts: ${NO_READ_CHECK}`)
  })

  it('does not count a comment that merely mentions the helper as a check', () => {
    const commented = new Map(files)
    const source = '// dropDeniedRows is not called\nexport const f = () => querySymbols({})\n'
    commented.set('planted_emitter.ts', source)
    expect(violations(commented, ALLOWLIST)).toContain(`planted_emitter.ts: ${NO_CHECK}`)
  })

  it('names a stale allowlist entry', () => {
    const stale = { ...ALLOWLIST, 'gone.ts': 'no such file' }
    expect(violations(files, stale)).toEqual(['gone.ts: allowlisted but the file does not exist'])
  })
})
