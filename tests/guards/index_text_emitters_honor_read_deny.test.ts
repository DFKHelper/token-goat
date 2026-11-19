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

const QUIET_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'read_deny_quiet_readers.json')
/** Files that read a file with no print shape: a generated list, not reviewed one by one; a change fails. */
const QUIET_READERS: readonly string[] = JSON.parse(fs.readFileSync(QUIET_JSON, 'utf8')) as string[]

/** Files that call an accessor but print no stored file text, one checked reason each. */
export const ALLOWLIST: Readonly<Record<string, string>> = {
  'answer_router.ts': 'routes a question to a command by symbol names; no stored text',
  'bash_range_savings.ts': 'counts symbol lines to estimate savings; prints numbers only',
  'embedding_boundaries.ts': 'line spans that cut a file into chunks; text is read elsewhere',
  'embeddings.ts': 'defines searchSemantic; callers that print a hit use dropDeniedRows',
  'fold_delivery.ts': 'line spans to fold delivered text; that text came from a guarded read',
  'graph_analysis.ts': 'prints names and locations; the body is only sized for a token estimate',
  'graph_traversal.ts': 'walks caller and callee names and locations; no stored text',
  'hint_target.ts': 'reads names and heading levels to name a hint target; no body printed',
  'hooks_read.ts': 'hook hint from names and line ranges only; a hook never throws',
  'inline_symbol_answer.ts': 'body comes through resolveBody, which asserts; a denial gives no answer',
  'index_reader.ts': 'defines the accessors; emitters that print rows are checked at their file',
  'notes.ts': 'the body is hashed into a staleness fingerprint and never printed',
  'read_inspect.ts': 'names and locations for lookups; a body is only tested for an export keyword',
  'read_outline_cache.ts': 'caches listings built after prepareSymbolListing asserted the read',
  'read_section.ts': 'html id span lookup; text is read through readFileText, which asserts',
  'read_suggest.ts': 'suggests symbol names for a typo; names and locations only',
  'search/symbol_fts.ts': 'defines the FTS accessors; emitters that print a hit use dropDeniedRows',
  'symbol_scan.ts': 'scanning helper returning rows to callers; emitters are checked at their file',
}

/**
 * What the shape scan sees: a call to a file-read API (`readFileSync`, `readFile`, `createReadStream`,
 * `readFileText`, `readFileBytes`) in a file with no deny call. It does NOT see a read made through an alias or
 * a wrapper with another name, a `fs.promises` handle, or text that reaches a printer in another file.
 */
const READ_CALL = /\b(?:readFileSync|readFile|createReadStream|readFileText|readFileBytes)\(/
/** A print shape in the same file: `emit`, `emitErr`, `process.stdout.write`, `console.log`. */
const PRINT_CALL = /\b(?:emit|emitErr)\(|process\.std(?:out|err)\.write\(|console\.(?:log|error)\(/

/** Files that read a file and print, and read only their own state, config, stdin, binaries or checked text. */
export const PRINTING_READERS: Readonly<Record<string, string>> = {
  'bridges/claudecode.ts': 'reads the hook payload from stdin (fd 0), not a project file',
  'bridges/codex.ts': 'reads the hook payload from stdin (fd 0), not a project file',
  'bridges/grok.ts': 'reads the hook payload from stdin (fd 0), not a project file',
  'bridges/kimi.ts': 'reads the hook payload from stdin (fd 0), not a project file',
  'bridges/copilot_cli_install.ts': 'reads the Copilot CLI config and instructions files in the user home',
  'bridges/shim_fail_open.ts': 'reads token-goat own pointer file',
  'cli_bootstrap_audit.ts': 'reads frontmatter of token-goat own agent files',
  'cli_context_stats.ts': 'reads token-goat own memory report path',
  'cli_doctor.ts': 'reads token-goat own config, scripts and pregenerated name list',
  'cli_file_ops.ts': 'edit commands read the target to modify it; output is a status (first two reads checked)',
  'cli_mcp_audit.ts': 'reads MCP config files (claude.json and the project mcp config), prints server names',
  'cli_memory.ts': 'reads token-goat own memory report',
  'cli_payloads.ts': 'reads token-goat own payload cache files',
  'cli_stats.ts': 'reads token-goat own stats files',
  'cli_upgrade.ts': 'reads token-goat own update cache and its own install package.json',
  'graph_analysis.ts': 'importsFile reads a file to answer a boolean; the text is never printed',
  'hook_selftest.ts': 'reads its own marker and fixture files',
  'image_ocr.ts': 'hashes the OCR model asset files; prints nothing from them',
  'install.ts': 'reads the user CLAUDE.md, skill and settings files it installs into (first reads checked)',
  'native_hook.ts': 'compares its own hook binary with the installed copy',
  'purge.ts': 'reads token-goat own state file before deleting it',
  'read_inspect.ts': 'reads through readFileText and readFileBytes, which assert the Read rules',
  'read_structured_data.ts': 'reads through readFileText, which asserts the Read rules; stdin is fd 0',
  'worker_lifecycle.ts': 'reads token-goat own worker pid, heartbeat and stamp files',
}

const NO_CHECK = 'calls an index accessor with no deny check and is not on the allowlist'
const NO_READ_CHECK = 'reads a file for output without a deny check'
const NO_PRINTER_ENTRY = 'reads a file and prints, with no deny check and no PRINTING_READERS entry'
const NO_QUIET_ENTRY = 'reads a file with no deny check or print shape and is not in read_deny_quiet_readers.json'

/** The comments of a source text cut out, so a mention of a helper in a comment is not a call. */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function usesAccessor(text: string): boolean {
  return DB_ACCESSOR.test(text) || DEFINES_ACCESSOR.test(text)
}

/** The source files that break the rule, as `file: reason`. */
export function violations(
  files: ReadonlyMap<string, string>,
  allow: Readonly<Record<string, string>>,
  readers: { printing: Readonly<Record<string, string>>; quiet: readonly string[] } = {
    printing: PRINTING_READERS,
    quiet: QUIET_READERS,
  },
): string[] {
  const found: string[] = []
  for (const [file, raw] of files) {
    const code = withoutComments(raw)
    if (READ_CALL.test(code) && !DENY_CALL.test(code)) {
      if (PRINT_CALL.test(code)) {
        if (!(file in readers.printing)) found.push(`${file}: ${NO_PRINTER_ENTRY}`)
      } else if (!readers.quiet.includes(file)) found.push(`${file}: ${NO_QUIET_ENTRY}`)
    }
  }
  for (const file of [...Object.keys(readers.printing), ...readers.quiet]) {
    const code = files.has(file) ? withoutComments(files.get(file) ?? '') : null
    if (code === null) found.push(`${file}: reader entry but the file does not exist`)
    else if (!READ_CALL.test(code)) found.push(`${file}: reader entry but it no longer reads a file`)
    else if (DENY_CALL.test(code)) found.push(`${file}: reader entry but it now calls a deny check`)
    else if (file in readers.printing && !PRINT_CALL.test(code)) {
      found.push(`${file}: printing entry but no print shape`)
    } else if (!(file in readers.printing) && PRINT_CALL.test(code)) {
      found.push(`${file}: quiet entry but it prints`)
    }
  }
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

  it('fails by name on a planted printer that reads a file with no deny check', () => {
    const planted = new Map(files)
    planted.set('planted_printer.ts', "export const f = (p: string) => emit(fs.readFileSync(p, 'utf8'))\n")
    expect(violations(planted, ALLOWLIST)).toEqual([`planted_printer.ts: ${NO_PRINTER_ENTRY}`])
  })

  it('fails by name on a planted reader with no print shape that is not on the quiet list', () => {
    const planted = new Map(files)
    planted.set('planted_reader.ts', "export const f = (p: string) => fs.readFileSync(p, 'utf8')\n")
    expect(violations(planted, ALLOWLIST)).toEqual([`planted_reader.ts: ${NO_QUIET_ENTRY}`])
  })

  it('does not count a read named only in a comment, and names a stale reader entry', () => {
    const planted = new Map(files)
    planted.set('planted_comment.ts', '// readFileSync( is not called here\nexport const f = 1\n')
    expect(violations(planted, ALLOWLIST)).toEqual([])
    const stale = { printing: { ...PRINTING_READERS, 'gone.ts': 'no such file' }, quiet: QUIET_READERS }
    expect(violations(files, ALLOWLIST, stale)).toEqual(['gone.ts: reader entry but the file does not exist'])
  })

  it('names a stale allowlist entry', () => {
    const stale = { ...ALLOWLIST, 'gone.ts': 'no such file' }
    expect(violations(files, stale)).toEqual(['gone.ts: allowlisted but the file does not exist'])
  })
})
