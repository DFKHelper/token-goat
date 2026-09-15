/**
 * Tree-sitter source indexer (Layer 7).
 *
 * Parses a source file into {@link SymbolEntry} / {@link RefEntry} rows and
 * upserts them into the SQLite index that `index_reader.ts` and the CLI read
 * back. Tree-sitter grammars (TypeScript / JavaScript / Python) are optional
 * native dependencies: when a grammar fails to load — a build without the
 * native binding, or an unsupported language — extraction degrades to a
 * regex pass that still recovers top-level functions and classes.
 *
 * The Python port (`parser.py`) keeps a richer model (imports/exports,
 * sections, per-file SHA gating). This TS port targets the symbol/ref subset
 * that the read commands surface, matching the simplified `db.ts` schema whose
 * `symbols`/`refs` rows are keyed by absolute `file_path`.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { globalDbPath, SYMBOL_BODY_CHAR_CAP } from './constants.js'
import { getDb } from './db.js'
import { loadConfig } from './config.js'
import type { IndexingConfig } from './config.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { deleteFileEmbeddings, indexFile as embedIndexFile } from './embeddings.js'
import type { ChunkBoundary } from './embeddings.js'
import { isEmbeddableDocument, extractEmbeddableDocumentText, isDocumentRefusal, isTransientDocumentRefusal } from './doc_embed_extract.js'
import { MAX_DOCUMENT_WORK_MILLIS } from './document_refusal.js'
import { fingerprintContent } from './fingerprint.js'
import { PARSER_FINGERPRINT } from './parser_fingerprint.js'
import { pathEqClause } from './sql_path.js'
import { detectLanguage, refineLanguageByContent, TREE_SITTER_LANGUAGES } from './parser_types.js'
import type { Language, RefEntry, SymbolEntry } from './parser_types.js'
import type { RegexLanguage } from './language_specs.js'
import { querySymbols } from './index_reader.js'
import { extractMarkdownHeadings } from './hints/markdown_hints.js'
import type * as RegexAdapters from './languages/registry.js'
import {
  extractLwcJavaScript,
  extractLwcTemplate,
  extractSalesforceMarkup,
} from './languages/salesforce_frontend.js'
import { ipynbToVirtualSource } from './languages/ipynb_idx.js'
import { decodeSource, foldPath, isCaseInsensitiveFs } from './util.js'
import { normalizePath } from './paths.js'
const _require = createRequire(import.meta.url)

/** Result of parsing one file: extracted symbols, refs, language, timing. */
export interface ParseResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
  readonly language: Language
  readonly duration: number
}

/**
 * Ref names that are never hand-written user code, so a ref bearing one carries no retrieval
 * value under any query and is dropped before it reaches the `refs` table (see the insert loop
 * in {@link writeParseResult}). This is deliberately a very small, unambiguous set, not a general
 * "assertion noise" stoplist -- see the S3 finding this closes for the fuller reasoning:
 *
 * `__name` is esbuild's own compiler-injected helper (it rewrites `function foo(){}` into
 * `foo = __name(function(){...}, "foo")` for `Function.prototype.name` support in its bundle
 * output). Confirmed against a real indexed corpus: every `__name` ref traced back to a
 * `*.snapshot/asset.*.bundle/index.js` file -- a vendored, pre-bundled build artifact, not source
 * a developer wrote. No language grammar this indexer parses ever produces `__name` as a
 * user-authored call site, so excluding it carries no risk of dropping a real caller.
 *
 * Deliberately NOT included here: generic test-framework globals (`expect`, `it`, `describe`,
 * `toBe`, ...), even though they dominate refs-table row count in a JS/TS-heavy index. A project
 * can legitimately define its own same-named export (a custom `describe`/`it`-shaped DSL is not
 * far-fetched), and silently dropping those refs at index time would make `callers describe`
 * permanently return zero for such a project with no error -- the "silently-emptied enumeration
 * passes forever" failure class this codebase has shipped and fixed before. That risk, plus the
 * relatively narrow benefit (each of those names is opt-in: nobody queries `callers expect` by
 * accident), is why S3 did not add a stoplist for them.
 */
const COMPILER_ARTIFACT_REF_NAMES: ReadonlySet<string> = new Set(['__name'])

// --- Tree-sitter grammar loading (optional, cached) -------------------------

// Minimal structural typings for the node-tree-sitter API surface we touch. The packages ship no first-class .d.ts under this resolution, so we model only the members used here rather than pulling `any` through the module.
import type { Grammar, TsParserCtor } from './parser_ts_types.js'
export type { Grammar, TsNode, TsParser, TsParserCtor, TsPoint, TsTree } from './parser_ts_types.js'

import {
  extractCppSymbols,
  extractGoSymbols,
  extractJavaSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractTsJsSymbols,
} from './parser_treesitter.js'
export {
  extractCppSymbols,
  extractGoSymbols,
  extractJavaSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractTsJsSymbols,
  stripPythonStringQuotes,
} from './parser_treesitter.js'

import { extractRefs } from './parser_refs.js'
export { extractRefs } from './parser_refs.js'

export const REF_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'ruby',
])

import {
  extractCssSymbols,
  extractDockerfileSymbols,
  extractJsonSymbols,
  extractMarkdownSymbols,
  extractTomlSymbols,
  extractWithRegex,
  extractYamlSymbols,
} from './parser_structured.js'
export {
  extractCssSymbols,
  extractDockerfileSymbols,
  extractJsonSymbols,
  extractMarkdownSymbols,
  extractTomlSymbols,
  extractWithRegex,
  extractYamlSymbols,
  lineOpenDelimiterAfter,
  stripTomlComment,
  tomlBracketDelta,
  yamlLineClosesQuote,
  yamlOpenQuoteAfter,
} from './parser_structured.js'
// Cache the Parser constructor and each resolved grammar across calls so the native binding is loaded at most once per process. `null` means "tried and unavailable"; `undefined` means "not yet attempted". Keyed by string, not just `Language`, because TypeScript has two grammar variants (plain `.ts` vs JSX-aware `.tsx`) sharing one `Language` value.
let _parserCtor: TsParserCtor | null | undefined
// Last error from loading the core `tree-sitter` binding, kept for `token-goat doctor` diagnostics.
let _parserCtorError: Error | null = null
// Test-only override for the core binding: `undefined` means "use the real lazy-loaded module", `null` or a constructor forces that value instead.
let _parserCtorOverride: TsParserCtor | null | undefined = undefined
// Test-only load error reported alongside a forced binding, so doctor's classification runs on a real captured error.
let _parserCtorErrorOverride: Error | null | undefined = undefined
const _grammarCache = new Map<string, Grammar | null>()

function loadParserCtor(): TsParserCtor | null {
  if (_parserCtorOverride !== undefined) return _parserCtorOverride
  if (_parserCtor !== undefined) return _parserCtor
  try {
    _parserCtor = _require('tree-sitter') as TsParserCtor
  } catch (e) {
    _parserCtor = null
    _parserCtorError = e instanceof Error ? e : new Error(String(e))
  }
  return _parserCtor
}

/** True when the core `tree-sitter` native binding is installed and requires cleanly. Independent of any single grammar (see `isTreeSitterAvailable`), since a missing core binding disables every language at once. */
export function treeSitterCoreAvailable(): boolean {
  return loadParserCtor() !== null
}

/** Last error from loading the core `tree-sitter` binding, for diagnostics (`token-goat doctor` style callers). `null` when never attempted, attempted successfully, or overridden for testing. */
export function treeSitterCoreLoadError(): Error | null {
  return _parserCtorErrorOverride !== undefined ? _parserCtorErrorOverride : _parserCtorError
}

/** Test-only: force `loadParserCtor()` (and therefore `treeSitterCoreAvailable()`/`isTreeSitterAvailable()`) to use `mod` instead of the real lazy-loaded binding. Pass `undefined` to restore the real resolution. */
export function setTreeSitterCoreForTesting(mod: TsParserCtor | null | undefined, loadError: Error | null = null): void {
  _parserCtorOverride = mod
  _parserCtorErrorOverride = mod === undefined ? undefined : loadError
}

// `.h` is inherently ambiguous between C and C++ (unlike `.hpp`, which is unambiguous cpp) -- the
// same extension is used for both languages. None of `class`, `namespace`, `template<`, `::`, or an
// access-specifier label (`public:`/`private:`/`protected:`) are valid C syntax, so any match is a
// strong, low-false-positive signal that a `.h` file is genuinely a C++ header. Used to route such
// files to the cpp grammar instead of the c grammar -- parsing C++-only syntax with tree-sitter-c
// still "succeeds" (error recovery doesn't throw) but produces ERROR nodes around it, silently
// dropping or mis-scoping symbols/refs, exactly the same failure mode `useTsx` below guards against.
const CPP_HEADER_SNIFF_RE = /\bclass\s+\w|\bnamespace\s+\w|\btemplate\s*<|::\s*\w|\b(?:public|private|protected)\s*:/

/**
 * Hard ceiling on the source text stored in `symbols.body`, in characters.
 *
 * `symbols.body` is written once per symbol and mirrored again into the
 * `symbols_fts` full-text index, so an extractor that emits an oversized body
 * costs roughly double on disk and is tokenized by FTS on every reindex. Any
 * extractor bug that makes body size scale with *file* size rather than with
 * *symbol* size therefore inflates the index quadratically, which is what
 * {@link extractJsonSymbols} used to do for minified JSON (see the comment
 * there). A DB bloated that way makes a reindex of the affected file long
 * enough to hold SQLite's single writer lock past db.ts's 15s `busy_timeout`,
 * which surfaces to a concurrent writer (worker daemon vs. CLI/hook) as
 * "database is locked", and stalls `token-goat index` while FTS re-tokenizes
 * gigabytes of duplicated text.
 *
 * This cap is enforced at the single write path ({@link writeParseResult})
 * rather than in each extractor, so it bounds every current and future
 * language extractor, not just the one that regressed. 128 KB is far above any
 * realistic single function/class body (~32k tokens) while still bounding the
 * pathological case.
 */
export const MAX_SYMBOL_BODY_CHARS = SYMBOL_BODY_CHAR_CAP

/**
 * Bound what gets *stored* for a symbol body, without losing what gets *read*.
 *
 * An over-cap body is stored as the empty string rather than as a truncated
 * copy. That distinction is the whole point: read_commands.ts's `resolveBody`
 * — the shared accessor behind `read`, `symbol`, `brief`, and frame resolution
 * — already re-slices an empty body from the source file using the symbol's
 * line range, so an elided body is served back complete and correct from disk.
 * Storing a *truncated* body instead would defeat that fallback and make every
 * one of those commands silently return partial source while presenting it as
 * the full symbol, with `line_end` still advertising the complete range.
 *
 * The cost of eliding is confined to what genuinely needs the text resident in
 * the DB: FTS body matching for that one oversized symbol. Losing full-text
 * hits on a >128 KB body is a fair trade against unbounded index growth, and
 * against `read` lying about what it returned.
 */
export function boundSymbolBody(body: string): string {
  return body.length > MAX_SYMBOL_BODY_CHARS ? '' : body
}

/**
 * Ceiling on a stored `symbols.docstring`. Smaller than the body cap because a docstring is a
 * summary: past a few KB it has stopped being one, and nothing displays it in full.
 */
export const MAX_SYMBOL_DOCSTRING_CHARS = 16 * 1024

/** Marker appended to a docstring cut at {@link MAX_SYMBOL_DOCSTRING_CHARS}. */
const DOCSTRING_TRUNCATION_MARKER = '\n[... docstring truncated by token-goat ...]'

/**
 * Bound a stored docstring, **truncating** rather than eliding it.
 *
 * This is deliberately the opposite of {@link boundSymbolBody}, for a reason specific to the
 * column. An over-cap *body* is stored empty because read_commands.ts's resolveBody can rebuild
 * it exactly from `[line_start, line_end]` -- eliding costs nothing. No such range is recorded
 * for a docstring, so eliding one destroys it: `outline`'s documented/undocumented flag would
 * flip to "undocumented" for the most heavily documented symbols in a file, which is worse than
 * a visibly-cut docstring. Nothing treats this column as complete source the way `read` treats
 * `body` -- consumers display its first line (read_commands.ts), test it for emptiness, or split
 * it into words (graph_commands.ts) -- so a marked truncation is honest and lossless enough.
 *
 * Python's extractor (`pythonDocstring`) and {@link precedingDocComment}'s callers (TS/JS, Rust,
 * Go, Ruby, Java, C/C++, and the regex fallback) are the only ones that populate `docstring` --
 * every other extractor still sets `''`. The column is derived from a *region near* a symbol, which is precisely the
 * shared-region shape that made `body` grow quadratically: a file-level doc comment attributed to
 * every symbol in the file reproduces that bug exactly. Bounding it at the same choke point closes
 * the hole before a future extractor opens it.
 */
export function boundSymbolDocstring(docstring: string): string {
  if (docstring.length <= MAX_SYMBOL_DOCSTRING_CHARS) return docstring
  // Budget the marker inside the cap, not on top of it: appending it to a full-length slice
  // would make the stored value exceed the very bound this constant declares, which quietly
  // turns a hard storage limit into an approximate one.
  let end = MAX_SYMBOL_DOCSTRING_CHARS - DOCSTRING_TRUNCATION_MARKER.length
  // Never cut between the halves of a surrogate pair -- that stores a lone surrogate, which is
  // not valid text and can surface as a replacement character or upset consumers downstream.
  const cutsSurrogatePair =
    end > 0 && docstring.charCodeAt(end - 1) >= 0xd800 && docstring.charCodeAt(end - 1) <= 0xdbff
  if (cutsSurrogatePair) end -= 1
  return docstring.slice(0, Math.max(0, end)) + DOCSTRING_TRUNCATION_MARKER
}

// precedingDocComment / DocCommentStyle live in doc_comment.ts (shared with languages/common.ts,
// which parser.ts itself imports from -- defining them here would create an import cycle). See
// that module's doc comment. Re-exported here so existing importers of `parser.js` keep working.
export { precedingDocComment, type DocCommentStyle } from './doc_comment.js'

function loadGrammar(lang: Language, filePath?: string, content?: string): Grammar | null {
  const useTsx = lang === 'typescript' && filePath !== undefined && path.extname(filePath).toLowerCase() === '.tsx'
  const useCppHeader =
    lang === 'c' &&
    filePath !== undefined &&
    path.extname(filePath).toLowerCase() === '.h' &&
    content !== undefined &&
    CPP_HEADER_SNIFF_RE.test(content)
  const cacheKey = useTsx ? 'typescript:tsx' : useCppHeader ? 'c:cpp-header' : lang
  const cached = _grammarCache.get(cacheKey)
  if (cached !== undefined) return cached

  let grammar: Grammar | null = null
  try {
    if (lang === 'typescript') {
      const mod = _require('tree-sitter-typescript') as { typescript: Grammar; tsx: Grammar }
      grammar = useTsx ? mod.tsx : mod.typescript
    } else if (lang === 'javascript') {
      grammar = _require('tree-sitter-javascript') as Grammar
    } else if (lang === 'python') {
      grammar = _require('tree-sitter-python') as Grammar
    } else if (lang === 'go') {
      grammar = _require('tree-sitter-go') as Grammar
    } else if (lang === 'rust') {
      grammar = _require('tree-sitter-rust') as Grammar
    } else if (lang === 'ruby') {
      grammar = _require('tree-sitter-ruby') as Grammar
    } else if (lang === 'java') {
      grammar = _require('tree-sitter-java') as Grammar
    } else if (lang === 'c') {
      grammar = useCppHeader ? (_require('tree-sitter-cpp') as Grammar) : (_require('tree-sitter-c') as Grammar)
    } else if (lang === 'cpp') {
      grammar = _require('tree-sitter-cpp') as Grammar
    }
  } catch {
    grammar = null
  }

  _grammarCache.set(cacheKey, grammar)
  return grammar
}

/**
 * Is tree-sitter (binding + grammar) available for `lang`?
 *
 * Returns `false` rather than throwing when the native binding or a grammar
 * package is missing, so callers can branch to the regex fallback. Languages
 * without a bundled grammar (markdown, json, yaml, toml, css, dockerfile,
 * bash, unknown) are always `false`.
 */
export function isTreeSitterAvailable(lang: Language): boolean {
  if (!TREE_SITTER_LANGUAGES.includes(lang)) return false
  return loadParserCtor() !== null && loadGrammar(lang) !== null
}

/** The grammar packages `loadGrammar` requires. */
const TREE_SITTER_GRAMMAR_PACKAGES: readonly string[] = [
  'tree-sitter-typescript',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-ruby',
  'tree-sitter-java',
  'tree-sitter-c',
  'tree-sitter-cpp',
]

/** Grammar packages that do not resolve from the bundle's location; resolution only, so it answers even when the core binding cannot load. */
export function missingTreeSitterGrammarPackages(): string[] {
  return TREE_SITTER_GRAMMAR_PACKAGES.filter((pkg) => {
    try {
      _require.resolve(pkg)
      return false
    } catch {
      return true
    }
  })
}


// --- Public parse / index API -----------------------------------------------

/**
 * Parse one file and return its extracted symbols + refs.
 *
 * Dispatches to the tree-sitter extractor when a grammar is available for the
 * detected language, otherwise falls back to regex. Unknown languages and
 * unreadable files yield empty symbol/ref lists (never throws). Call-site refs
 * are extracted for the tree-sitter languages in {@link REF_LANGUAGES}; the
 * regex-fallback and structured-config languages yield no refs.
 */
export async function parseFile(filePath: string): Promise<ParseResult> {
  await loadRegexExtractors()
  const start = Date.now()
  const pathLanguage = detectLanguage(filePath)

  let content: string
  try {
    content = decodeSource(await fs.promises.readFile(filePath))
  } catch {
    return { symbols: [], refs: [], language: pathLanguage, duration: Date.now() - start }
  }

  const language = refineLanguageByContent(filePath, pathLanguage, content)
  const { symbols, refs } = parseContent(content, filePath, language)
  return { symbols, refs, language, duration: Date.now() - start }
}

/** Symbols + refs extracted from one file's content. */
interface ParseContentResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
}

function isLwcFile(filePath: string, extension: '.js' | '.html'): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return /\/lwc\/[^/]+\/[^/]+$/i.test(normalized) && normalized.toLowerCase().endsWith(extension)
}

function mergeParseResults(...results: readonly ParseContentResult[]): ParseContentResult {
  const symbols: SymbolEntry[] = []
  const refs: RefEntry[] = []
  const seenSymbols = new Set<string>()
  const seenRefs = new Set<string>()
  for (const result of results) {
    for (const entry of result.symbols) {
      const key = `${entry.filePath}\0${entry.name}\0${entry.kind}\0${entry.lineStart}`
      if (seenSymbols.has(key)) continue
      seenSymbols.add(key)
      symbols.push(entry)
    }
    for (const entry of result.refs) {
      const key = `${entry.filePath}\0${entry.name}\0${entry.line}\0${entry.col}`
      if (seenRefs.has(key)) continue
      seenRefs.add(key)
      refs.push(entry)
    }
  }
  return { symbols, refs }
}

/** Shared sync core: pick an extractor for `language` and run it on `content`. */
function parseContent(content: string, filePath: string, language: Language): ParseContentResult {
  // Strip UTF-8 BOM if present (U+FEFF); some editors save files with this prefix. Both entry points (parseFile, indexFileSync) funnel through here, so this is the single place BOM stripping needs to happen. Sha/hash computation elsewhere stays on the raw original bytes — only this decoded copy is affected.
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  }

  // A notebook is JSON, not source -- flatten its code/markdown cells into a virtual Python-like document and recurse with language forced to 'python' so it gets the real tree-sitter Python extraction path; a non-Python-kernel or unparseable notebook yields no symbols/refs (never throws).
  if (language === 'ipynb') {
    const virtual = ipynbToVirtualSource(content)
    if (virtual.cellLanguage === null) return { symbols: [], refs: [] }
    return parseContent(virtual.content, filePath, 'python')
  }

  const viaTreeSitter = parseWithTreeSitter(content, filePath, language)
  if (viaTreeSitter !== null) return viaTreeSitter

  // Regex-based extractors for languages without tree-sitter
  return extractNoTreeSitter(content, filePath, language)
}

/**
 * The tree-sitter half of {@link parseContent}, split out so a caller that must never be handed the regex fallback can ask for tree-sitter alone.
 *
 * `null` means tree-sitter did not produce this file's symbols: no grammar or no parser constructor for the language, or the parse threw. It never means "this file has no symbols", which is the empty array. {@link parseSourceSymbolsTreeSitterOnly} is the caller that needs that distinction, while {@link parseContent} itself reads null as "fall through to the regex pass", exactly as it did when this block was inline.
 */
function parseWithTreeSitter(content: string, filePath: string, language: Language): ParseContentResult | null {
  if (!isTreeSitterAvailable(language)) return null
  try {
    const Ctor = loadParserCtor()
    const grammar = loadGrammar(language, filePath, content)
    if (Ctor === null || grammar === null) return null
    const parser = new Ctor()
    parser.setLanguage(grammar)
    const tree = parser.parse(content)
    const root = tree.rootNode
    let symbols: SymbolEntry[]
    if (language === 'python') {
      symbols = extractPythonSymbols(root, filePath)
    } else if (language === 'go') {
      symbols = extractGoSymbols(root, filePath, content.split(/\r?\n/))
    } else if (language === 'rust') {
      symbols = extractRustSymbols(root, filePath, content.split(/\r?\n/))
    } else if (language === 'ruby') {
      symbols = extractRubySymbols(root, filePath, content.split(/\r?\n/))
    } else if (language === 'java') {
      symbols = extractJavaSymbols(root, filePath, content.split(/\r?\n/))
    } else if (language === 'cpp' || language === 'c') {
      symbols = extractCppSymbols(root, filePath, content.split(/\r?\n/))
    } else {
      symbols = extractTsJsSymbols(root, filePath, content.split(/\r?\n/))
    }
    const refs = REF_LANGUAGES.has(language) ? extractRefs(root, filePath, language) : []
    const parsed = { symbols, refs }
    return language === 'javascript' && isLwcFile(filePath, '.js')
      ? mergeParseResults(parsed, extractLwcJavaScript(content, filePath))
      : parsed
  } catch {
    // Parser threw on this input: the caller decides whether a regex pass is an acceptable substitute for what it could not produce.
    return null
  }
}

/**
 * Symbols for one file's content from tree-sitter and nothing else, or `null` when tree-sitter could not supply them.
 *
 * This exists for the post-read source-skeleton fold in hooks_read.ts, which composes what the model reads out of the symbols returned here. A regex fallback would be wrong there in a way it is not wrong for the index: `extractWithRegex` finds 40-57% of what tree-sitter finds on the same files (measured: 9 against 21, 33 against 82, 48 against 85), and a skeleton built from a partial symbol list omits declarations with nothing in the output to signal the omission. An incomplete map is worse than no map, so that caller delivers the file whole on `null`.
 *
 * Takes content rather than a path on purpose: the fold runs on the FIRST read of a file the indexer may never have touched, and the bytes it has to describe are the ones the harness just delivered, not whatever is on disk now.
 */
export function parseSourceSymbolsTreeSitterOnly(content: string, filePath: string, language: Language): SymbolEntry[] | null {
  // The same BOM strip parseContent does, for the same reason: the delivered text of a file an editor saved with U+FEFF would otherwise shift every tree-sitter offset by one.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const parsed = parseWithTreeSitter(text, filePath, language)
  return parsed === null ? null : parsed.symbols
}

type SymbolExtractor = (content: string, filePath: string) => SymbolEntry[]

// In the global symbol registry so a module reset (vi.resetModules) or a second copy of this module in one process still finds the adapters loaded.
const REGEX_ADAPTERS_SLOT = Symbol.for('token-goat.regex-adapters')
const adapterSlot = globalThis as unknown as Record<symbol, typeof RegexAdapters | undefined>

/**
 * Load the regex language adapters (src/languages/registry.ts), once per process.
 *
 * They sit behind a dynamic import because parser.ts is on the hook path, where none of them is ever called: imported statically, every adapter was compiled on every hook invocation. Each entry point that parses awaits this first (the CLI's run(), runWorkerLoop, parseFile); a sync parse without it throws rather than quietly indexing a file to nothing.
 */
export async function loadRegexExtractors(): Promise<void> {
  adapterSlot[REGEX_ADAPTERS_SLOT] ??= await import('./languages/registry.js')
}

function regexAdapters(): typeof RegexAdapters {
  const loaded = adapterSlot[REGEX_ADAPTERS_SLOT]
  if (loaded === undefined) throw new Error('token-goat: the regex language adapters are not loaded; await loadRegexExtractors() before parsing')
  return loaded
}

let noTreeSitterTable: Record<RegexLanguage, SymbolExtractor> | undefined

// One entry per `regex` row of src/language_specs.ts, required by the type: the adapter rows come from registry.ts's ADAPTER_EXTRACTORS, whose own type fails on a row without an extractor.
function noTreeSitterExtractors(): Record<RegexLanguage, SymbolExtractor> {
  noTreeSitterTable ??= {
    markdown: extractMarkdownSymbols,
    json: extractJsonSymbols,
    yaml: extractYamlSymbols,
    toml: extractTomlSymbols,
    css: extractCssSymbols,
    dockerfile: extractDockerfileSymbols,
    ...regexAdapters().ADAPTER_EXTRACTORS,
  }
  return noTreeSitterTable
}

function extractNoTreeSitter(
  content: string,
  filePath: string,
  language: Language,
): ParseContentResult {
  const adapters = regexAdapters()
  if (language === 'salesforce_metadata') return adapters.extractSalesforceMetadata(content, filePath)
  if (language === 'salesforce_markup') return extractSalesforceMarkup(content, filePath)
  if (language === 'html' && isLwcFile(filePath, '.html')) {
    const base: ParseContentResult = { symbols: adapters.ADAPTER_EXTRACTORS.html(content, filePath), refs: [] }
    return mergeParseResults(base, extractLwcTemplate(content, filePath))
  }
  // Vue/Svelte/Astro adapters emit both symbols and refs (template component-tag references),
  // same shape as extractSalesforceMarkup above -- returned directly rather than forced through
  // the symbols-only noTreeSitterExtractors table.
  if (language === 'vue') return adapters.extractVue(content, filePath)
  if (language === 'svelte') return adapters.extractSvelte(content, filePath)
  if (language === 'astro') return adapters.extractAstro(content, filePath)
  // COBOL and Natural also emit refs (PERFORM, GO TO, CALL/CALLNAT/FETCH literals); they stay outside REF_LANGUAGES because paragraphs are reached by fall-through and programs by name, so an empty ref set is no evidence of dead code.
  if (language === 'cobol') {
    const r = adapters.extractCobol(content, filePath)
    return { symbols: r.symbols, refs: r.refs }
  }
  if (language === 'natural') {
    const r = adapters.extractNatural(content, filePath)
    return { symbols: r.symbols, refs: r.refs }
  }

  const parsed: ParseContentResult = {
    symbols: extractSymbolsNoTreeSitter(content, filePath, language),
    refs: [],
  }
  return language === 'javascript' && isLwcFile(filePath, '.js')
    ? mergeParseResults(parsed, extractLwcJavaScript(content, filePath))
    : parsed
}

/**
 * Symbol extraction for languages with no tree-sitter grammar: the regex and
 * structured-config adapters. Returns an empty list for `unknown`.
 */
function extractSymbolsNoTreeSitter(
  content: string,
  filePath: string,
  language: Language,
): SymbolEntry[] {
  if (language === 'unknown') return []
  // A tree-sitter language whose grammar did not load has no entry and falls back to the coarse regex scan.
  return ((noTreeSitterExtractors() as Partial<Record<Language, SymbolExtractor>>)[language] ?? extractWithRegex)(content, filePath)
}

/**
 * Delete every index row (symbols, refs, files) for one file. On a
 * case-insensitive filesystem the path match folds case — mirroring
 * index_reader's pathEq — so rows written under a different path casing by a
 * prior reindex are removed rather than orphaned as case-variant duplicates.
 */
export function deleteFileRows(db: ReturnType<typeof getDb>, filePath: string): void {
  const folded = foldPath(filePath)
  db.prepare(`DELETE FROM symbols WHERE ${pathEqClause('file_path')}`).run(folded)
  db.prepare(`DELETE FROM refs WHERE ${pathEqClause('file_path')}`).run(folded)
  db.prepare(`DELETE FROM files WHERE ${pathEqClause('path')}`).run(folded)
}

/**
 * True when any directory segment of `filePath` matches a basename in `skipDirs` -- the
 * `indexing.skip_dirs` config knob. Splits on either separator since callers pass both
 * forward-slash-normalized keys (resolveIndexPath) and raw absolute paths.
 */
export function isUnderSkipDir(filePath: string, skipDirs: readonly string[]): boolean {
  if (skipDirs.length === 0) return false
  const segments = filePath.split(/[/\\]/)
  return segments.slice(0, -1).some((seg) => skipDirs.includes(seg))
}

/**
 * True when `filePath` is excluded from the syntactic parse entirely by `indexing.skip_dirs`,
 * a generated-report basename configured via `indexing.skip_files` (defaults to
 * coverage.json / coverage-final.json -- single-line minified JSON blobs whose indexed
 * "property" symbols bloat the index and trip the oversized-symbol doctor check for zero
 * benefit), or `indexing.large_file_skip_kb`. Must be evaluated UNCONDITIONALLY (independent of
 * any sha/parseUnchanged gate) because a file that becomes skip-eligible via a config change
 * alone must still have its stale rows purged. A stat failure is treated as "not skip-eligible".
 */
export function isParseSkipEligible(filePath: string, cfg: IndexingConfig): boolean {
  if (isUnderSkipDir(filePath, cfg.skip_dirs)) return true
  if (cfg.skip_files.includes(path.basename(filePath))) return true
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > cfg.large_file_skip_kb * 1024) return true
  } catch {
    // let the caller's own read/stat attempt handle/report the failure
  }
  return false
}

/**
 * Write a parsed result's rows into the index DB, replacing any prior rows for
 * the file in a single transaction (DELETE + INSERT, matching the Python
 * bulk-replace strategy) so a re-index never leaves stale symbols behind.
 *
 * Called by {@link indexFileSync}, the worker drain loop's synchronous entry
 * point.
 */
function writeParseResult(
  filePath: string,
  content: Buffer,
  result: ParseResult,
  dbPath: string,
): void {
  const db = getDb(dbPath)

  // Hash the SAME raw bytes that were actually parsed, not a fresh disk re-read: if the file changes between the parse read and this write, a re-read here would record a SHA that does not match the symbols/refs actually written below, and the worker's SHA-gated incremental drain would skip reindexing a file whose stored SHA happens to match a later version, leaving it permanently stuck with stale symbols. Takes the raw Buffer (not the utf8-decoded string used for parsing) so this SHA is computed over the same bytes worker.ts's gate hashes via fingerprintFile() -- a lossy utf8 decode/re-encode round-trip on invalid-UTF-8 content would otherwise produce a different digest than hashing the raw bytes directly, permanently defeating the gate for any such file. writeParseResult's only caller (indexFileSync) always has a successfully-read Buffer in hand by the time it calls this -- a read failure returns or throws before reaching this call -- so there is never a "content is unreadable" case to fall back to a disk re-read for.
  const sha = fingerprintContent(content)
  const mtime = safeMtime(filePath)
  const now = Date.now() / 1000

  // embed_sha is the OTHER freshness key this same row carries (see files.embed_sha / makeIndexer
  // in worker.ts): it answers "were the current chunks/vectors embedded from this exact content",
  // independent of files.parser_sha answering "did this extractor version write the symbol/ref
  // rows below". A parser-only reparse -- this write happening because parser_sha was stale while
  // the bytes on disk never moved -- must not silently reset that independent answer to unknown.
  // Read the prior row BEFORE deleteFileRows below removes it: once the DELETE runs there is
  // nothing left to read this from, and the whole point is to carry it across that delete.
  const priorRow = db
    .prepare(`SELECT sha, embed_sha FROM files WHERE ${pathEqClause('path')}`)
    .get(foldPath(filePath)) as { sha: string | null; embed_sha: string | null } | undefined
  // Preserve only when the CONTENT this row describes is unchanged (sha match): a content change
  // means the old embed_sha was computed from bytes that no longer exist, and carrying it forward
  // would make makeIndexer's `isEmbedFresh` check believe stale vectors are still valid for the
  // new content. When sha matches, the chunks embeddings.ts wrote for it are untouched by this
  // reparse (deleteFileRows never touches chunks/chunk_vectors), so the stamp describing them is
  // still true and re-embedding identical content for a parser-only bump would be pure waste.
  const embedShaToCarry = priorRow !== undefined && priorRow.sha === sha ? priorRow.embed_sha : null

  const writeAll = db.transaction(() => {
    deleteFileRows(db, filePath)

    // parser_sha records WHICH extraction logic produced the symbol and ref rows written just below, so a later parser change can tell that these rows are stale even though the content sha still matches. Without it, files.sha was the only freshness key and answered only "has the content changed", which left an unedited file pinned to the symbol set an older parser gave it for as long as nobody touched it. Stamped here rather than in the gates so it is written by exactly the transaction that writes the rows it describes.
    db.prepare(
      'INSERT INTO files (path, sha, mtime, language, indexed_at, parser_sha, embed_sha) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(filePath, sha, mtime, result.language, now, PARSER_FINGERPRINT, embedShaToCarry)

    const insSym = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring, parent) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const s of result.symbols) {
      if (s.name === '' || s.kind === '') continue
      // Bound every stored body regardless of which extractor produced it -- see
      // MAX_SYMBOL_BODY_CHARS / boundSymbolBody. This is the single choke point through which
      // all parsed symbols reach the DB, so capping here makes an unbounded-body bug in any one
      // language extractor incapable of bloating global.db. An over-cap body is stored empty,
      // not truncated, so resolveBody still serves the complete symbol from source on read.
      insSym.run(
        s.filePath,
        s.name,
        s.kind,
        s.lineStart,
        s.lineEnd,
        boundSymbolBody(s.body),
        boundSymbolDocstring(s.docstring),
        s.parent,
      )
    }

    const insRef = db.prepare(
      'INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)',
    )
    for (const r of result.refs) {
      if (r.name === '' || COMPILER_ARTIFACT_REF_NAMES.has(r.name)) continue
      insRef.run(r.filePath, r.name, r.line, r.col, r.context)
    }
  })

  // `.immediate()` -- BEGIN IMMEDIATE -- rather than a plain call, which the driver issues as a
  // deferred BEGIN. A deferred transaction takes its read snapshot first and only asks for the
  // write lock when it reaches a writing statement, and SQLite refuses that upgrade with
  // SQLITE_BUSY straight away instead of consulting the busy handler, so `busy_timeout` does
  // nothing for it. Six `index` runs starting together against a database that did not exist yet
  // reproduced it every time: one of them failed on its very first file with "database is locked",
  // dropped that file from the index, and still exited 0. Raising busy_timeout to 60s in a run
  // lasting one second changed nothing, which is what proved the handler was never being asked.
  // BEGIN IMMEDIATE takes the write lock up front, where the busy handler does apply.
  writeAll.immediate()
}

/**
 * Synchronous index: read, parse, and write one file's rows in a single call.
 *
 * The worker drain loop runs synchronously — it clears the dirty queue only
 * after the batch has been written — so it needs a synchronous entry point.
 * Reads with `readFileSync`, runs the
 * same `parseContent` extractor, and shares {@link writeParseResult}. A file
 * genuinely gone (ENOENT — deleted in the race window between being
 * fingerprinted and this read) is skipped silently, never throws. Any other
 * read failure (EBUSY/EPERM/EACCES from an AV or editor file lock, EIO, ...)
 * is rethrown, so it reaches {@link makeIndexer}'s catch in worker.ts, which
 * logs it and returns the `INDEX_FAILED` sentinel instead of letting
 * `processDirtyBatch` silently count this file as indexed.
 */
// `preReadBytes`, when passed, is used verbatim instead of this function opening `filePath`
// itself. This exists so a confinement-pinned caller (read_commands.ts's healStaleIndex /
// force-refresh paths) can verify the file's identity against its MCP-validated pin BEFORE any
// bytes are read, then hand those already-verified bytes straight through -- closing the
// check-then-open race that a second, independent fs.readFileSync inside this function would
// reopen. A CLI caller (worker.ts, cli.ts) never has a pin to verify against and omits this
// parameter, so this function's own fs.readFileSync (below) still runs for every call site
// except the pinned ones, unchanged from before this parameter existed.
export function indexFileSync(rawPath: string, dbPath: string = globalDbPath(), preReadBytes?: Buffer): void {
  // Every symbols/refs/files row this call writes derives from this one spelling, so the whole
  // parse side of the index agrees on a single name for the file. See canonicalizeIndexPath.
  const filePath = canonicalizeIndexPath(rawPath)
  const ixCfg = loadConfig().indexing
  if (ixCfg !== undefined && isParseSkipEligible(filePath, ixCfg)) {
    // Purge stale rows AND the files row (sha) so the file settles into a stable not-indexed state instead of being re-selected as "changed" on every drain; also drop any embedding rows it held before becoming skip-eligible (indexFileSync is called directly from read_commands' --force-refresh path).
    const db = getDb(dbPath)
    deleteFileRows(db, filePath)
    deleteFileEmbeddings(db, filePath)
    return
  }
  const pathLanguage = detectLanguage(filePath)
  let raw: Buffer
  if (preReadBytes !== undefined) {
    raw = preReadBytes
  } else {
    try {
      raw = fs.readFileSync(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }
  const content = decodeSource(raw)
  const language = refineLanguageByContent(filePath, pathLanguage, content)
  const { symbols, refs } = parseContent(content, filePath, language)
  writeParseResult(filePath, raw, { symbols, refs, language, duration: 0 }, dbPath)
}

/**
 * Structural cut points for this file's embedding chunks, derived from the same
 * indexing pass rather than re-parsed from scratch: markdown/doc files get one
 * 'section' boundary per heading (extractMarkdownHeadings - cheap here since the
 * caller already holds the full content in memory); every other language gets one
 * 'symbol' boundary per row already committed to the `symbols` table moments earlier
 * by indexFileSync in the same cli.ts/worker.ts call sequence. Empty when the file
 * has no symbols/headings (unparsed language, plain text, or a file with genuinely
 * nothing extractable) - chunkFile's own `boundaries.length === 0` check falls back
 * to its plain sliding window in that case, so this never needs to signal "no boundaries"
 * any differently than an empty array.
 */
export function buildEmbeddingBoundaries(filePath: string, content: string, dbPath: string): ChunkBoundary[] {
  if (detectLanguage(filePath) === 'markdown') {
    // Extract all headings (no cap) for embedding boundaries so sections remain heading-aligned
    // even for docs with >40 headings (large API references, changelogs, multi-section docs).
    const headings = extractMarkdownHeadings(content, Infinity)
    return headings.map((h, i) => ({
      start: h.lineNumber,
      // Runs to just before the next heading, or to end-of-file for the last one. chunkFile clips end values to the file's actual line count, so this sentinel is safe without re-deriving the file's line count here.
      end: headings[i + 1] !== undefined ? headings[i + 1]!.lineNumber - 1 : Number.MAX_SAFE_INTEGER,
      kind: 'section' as const,
    }))
  }

  // No cap here either, matching the markdown branch above: this query is already scoped to one file_path, so its row count is bounded by that file's own symbol count (already paid for by indexFileSync's parse moments earlier), not by anything this call adds. A fixed cap here previously silently dropped every symbol past the file's 10,000th (ordered by line_start, so a contiguous tail) from getting its own chunk boundary - chunkFile's trailing-gap fallback still folded that tail into one generic 'window' chunk rather than losing its content outright, but it lost symbol-precise chunking for large generated files (API clients, protobuf/OpenAPI output, big constants/fixtures files) with no documented reason for the number or the asymmetry with the uncapped markdown branch.
  const symbols = querySymbols({ filePath, limit: Number.MAX_SAFE_INTEGER }, dbPath)
  return symbols.map((s) => ({ start: s.lineStart, end: s.lineEnd, kind: 'symbol' as const }))
}

/**
 * Prefix used to stamp `files.embed_sha` when {@link indexFileEmbeddings} early-returns
 * because `indexing.embeddings_enabled` is off, instead of the file's real content sha. Kept
 * distinct from a real embed_sha (see {@link indexFileEmbeddings}'s own doc comment) so
 * re-enabling embeddings later can't be mistaken for "already embedded, unchanged" by
 * makeIndexer's embedUnchanged gate in worker.ts, which checks the CURRENT
 * embeddings_enabled state and only treats this disabled-marker form as "unchanged" while
 * still disabled -- a bare sha match here would otherwise permanently skip re-embedding once
 * a user turns embeddings back on for content that was only ever marker-stamped, never
 * actually embedded.
 */
export const DISABLED_EMBED_SHA_PREFIX = 'disabled:'

/** The embed_sha value {@link indexFileEmbeddings} stamps for `sha` while embeddings are disabled. */
export function disabledEmbedSha(sha: string): string {
  return DISABLED_EMBED_SHA_PREFIX + sha
}

/**
 * Prefix used to stamp `files.embed_sha` when {@link indexFileEmbeddings} could not actually embed
 * a file because the optional embedding deps were absent (the inference runtime or the
 * sqlite-vec `chunk_vectors` table). Distinct from a real embed_sha so the freshness gate can
 * re-embed the file once the deps are installed -- otherwise a project indexed on a deps-less
 * install would stamp bare shas, and every previously-indexed unchanged file would look
 * "already embedded" the instant the model is added, leaving the semantic index permanently empty
 * for that content. Distinct from {@link DISABLED_EMBED_SHA_PREFIX} because the two cases clear on
 * different conditions: disabled clears when config re-enables embeddings, unavailable clears when
 * the deps become installable/usable (see {@link isEmbedFresh}).
 */
export const UNAVAILABLE_EMBED_SHA_PREFIX = 'unavailable:'

/** The embed_sha value {@link indexFileEmbeddings} stamps for `sha` when embedding deps are absent. */
export function unavailableEmbedSha(sha: string): string {
  return UNAVAILABLE_EMBED_SHA_PREFIX + sha
}

/**
 * Prefix used to stamp `files.embed_sha` when {@link indexFileEmbeddings} skipped a file only
 * because it is larger than `indexing.large_file_symbol_only_kb`. Third instance of the same shape
 * as {@link DISABLED_EMBED_SHA_PREFIX} and {@link UNAVAILABLE_EMBED_SHA_PREFIX}, and it clears on a
 * third condition: the threshold itself, which is a user-tunable config value rather than a
 * property of the content. A bare sha here reads as "really embedded, nothing left to do", so
 * raising the threshold left every previously-skipped file looking permanently fresh and the
 * background worker never re-embedded any of them -- `semantic` stayed blind to that content until
 * something edited it, while `symbol` and `read` worked normally. `token-goat doctor`'s embedding
 * coverage remediation tells users to raise exactly this value, so the case is reached by following
 * the product's own advice. The threshold in force at stamp time is encoded in the marker so a
 * later change to it no longer matches and the file is re-examined; see {@link isEmbedFresh}.
 */
export const OVERSIZE_EMBED_SHA_PREFIX = 'oversize:'

/** The embed_sha value {@link indexFileEmbeddings} stamps for `sha` when the file is over `symbolOnlyKb`. */
export function oversizeEmbedSha(sha: string, symbolOnlyKb: number): string {
  return `${OVERSIZE_EMBED_SHA_PREFIX}${symbolOnlyKb}:${sha}`
}

/**
 * Prefix used to stamp `files.embed_sha` when {@link indexFileEmbeddings} gave up on a document
 * because its extraction ran past {@link MAX_DOCUMENT_WORK_MILLIS}. Fourth instance of the shape
 * {@link OVERSIZE_EMBED_SHA_PREFIX} introduced, and it exists for the same reason: the skip was
 * conditional on a value that can change, so a bare sha would record it as terminal and the
 * document would never be embedded again. A clock refusal is the weakest of all these conditions,
 * because the value it is conditional on is not even a setting -- it is how busy this machine was
 * for one minute. Stamping a bare sha for it, which is what this branch used to do, is exactly the
 * "permanent verdict recorded from a temporary condition" the extraction-*failure* branch a few
 * lines below refuses to do, applied to a case that only looked settled because the error happened
 * to extend {@link DocumentRefusedError}. The bound in force is encoded so that raising the clock
 * in a later release re-examines every document a lower one refused; see {@link isEmbedFresh}.
 */
export const TIMEOUT_EMBED_SHA_PREFIX = 'timeout:'

/** The embed_sha value {@link indexFileEmbeddings} stamps for `sha` when extraction passed `workMillis`. */
export function timeoutEmbedSha(sha: string, workMillis: number): string {
  return `${TIMEOUT_EMBED_SHA_PREFIX}${workMillis}:${sha}`
}

/**
 * Return `absPath` with its final segment spelled the way the filesystem actually spells it.
 *
 * The companion of `indexedPathSpellingIsStale`. That guard notices when a stored row's spelling
 * has drifted from disk and forces a reparse -- but a reparse only helps if the reparse writes a
 * *different* spelling than the one already stored. Every writer used to hand its own caller's
 * path straight to `writeParseResult`, and no caller's spelling is authoritative: `git ls-files`
 * reports the name in git's index, which still says `MixedName.ts` after an unstaged case-only
 * rename on a case-insensitive filesystem, because git never sees such a rename at all. So the
 * bulk `index` command detected the drift, reparsed, wrote the same stale name back, and detected
 * the very same drift again on the next run -- reparsing and re-embedding an unchanged file on
 * every single run, forever, while every citation named a path with no directory entry behind it.
 * Canonicalizing here, at the one point every writer passes through, is what makes that converge.
 *
 * Only the last segment is taken from the filesystem. `fs.realpathSync.native` canonicalizes every
 * parent directory too, so adopting its whole answer would rewrite rows to an ambient prefix
 * spelling the caller never used (`C:/WINDOWS/TEMP/...` for a caller that said `C:/Windows/Temp`),
 * churning paths for a difference that is not the file's own. The directory prefix stays exactly
 * as the caller spelled it.
 *
 * Three rails keep this from ever *relocating* a path. `fs.realpathSync.native` also resolves
 * symlinks and Windows junctions, so it can answer with a completely different file: the new
 * segment is adopted only when it case-folds equal to the one it replaces, and only when the
 * resolved file's directory case-folds equal to the directory the caller named. And any failure
 * returns the caller's path untouched. `fs.realpathSync` (without `.native`) is useless for this:
 * on Windows it echoes the caller's own spelling back.
 */
export function canonicalizeIndexPath(absPath: string): string {
  if (!isCaseInsensitiveFs()) return absPath
  let real: string
  try {
    real = fs.realpathSync.native(absPath)
  } catch {
    // Unreadable or gone right now -- a git-tracked file deleted from the worktree reaches the
    // indexer on every run. Keep the name callers know it by rather than guess at a spelling.
    return absPath
  }
  // Split on the caller's own string, not a normalized copy: normalizePath lowercases a UNC
  // host and share, so rebuilding the prefix from it would rewrite `//SERVER/Share/...` to
  // `//server/share/...` on the runs that correct a name and leave it alone on the runs that do
  // not -- a second spelling difference introduced by the very function meant to remove one.
  const cut = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  const base = absPath.slice(cut + 1)
  const realNorm = normalizePath(real)
  const realBase = path.basename(realNorm)
  if (base === realBase) return absPath
  if (foldPath(base) !== foldPath(realBase)) return absPath
  // The resolved file must live in the directory the caller named. `fs.realpathSync.native` also
  // follows symlinks and Windows junctions, so `alias.ts` can resolve to `../elsewhere/Alias.ts`
  // -- fold-equal basenames, entirely different file. Adopting that spelling would name a
  // directory entry that does not exist where the row says it does.
  const callerDir = cut < 0 ? normalizePath(path.resolve('.')) : normalizePath(absPath.slice(0, cut))
  if (foldPath(callerDir) !== foldPath(path.dirname(realNorm))) return absPath
  return absPath.slice(0, cut + 1) + realBase
}

/**
 * True when the index's stored spelling of `absPath` no longer matches the file's real spelling
 * on disk.
 *
 * Only ever true on a case-insensitive filesystem, which is where the problem lives.
 * {@link getFileEntry} finds a row by folded path, so after `mv b.ts B.ts` the lookup still hits
 * and the content is byte-identical -- the sha gate skips the file, and the row goes on saying
 * `b.ts` forever. Nothing else corrects it: the file still exists, so the deletion sweep leaves
 * it alone, and only a later change to the file's *content* rewrites the row. Until then every
 * `symbol`, `read`, `refs` and `map` answer names the path with a spelling it no longer has,
 * which is the one thing this tool exists to get right.
 *
 * The real spelling is read from the filesystem rather than taken from the caller, because no
 * caller's spelling is authoritative: the walk reports the dirent's, git reports the one in its
 * own index (still the old one until the rename is staged), and the edit hook reports whatever
 * the editor passed. Trusting the caller would let two of them rewrite the row back and forth on
 * alternate runs.
 *
 * Deliberately narrowed to a pure case difference, by the fold comparison against the resolved
 * spelling on the last line. `realpathSync` also resolves symlinks and Windows junctions, so a
 * project reached through a link resolves to a structurally different path -- without that
 * comparison every file in such a project would read as stale on every run and the whole tree
 * would reindex forever. The identical fold check earlier is a cheap filter for a caller naming a
 * structurally different path, not a second correctness guard. This costs one realpath per file
 * per index run, which is noise beside the full-file read and hash `fingerprintFile` already
 * performs for the same file on the same pass. A file whose spelling has actually drifted pays
 * for two more, one in each writer (see canonicalizeIndexPath) -- three in total, on the one run
 * that corrects it and never again.
 */
export function indexedPathSpellingIsStale(storedPath: string, absPath: string): boolean {
  if (!isCaseInsensitiveFs()) return false
  // Both sides go through normalizePath, and the stored side is not exempt: the incremental
  // worker writes the dirty queue's own spelling straight through, so a row indexed by the
  // daemon can carry an upper-case drive letter (`C:/...`) where the bulk `index` command's rows
  // carry the lower-case one normalizePath produces. Comparing a raw stored value against a
  // normalized candidate makes that difference look like a stale spelling, and the file then
  // reindexes on every single drain, forever.
  const stored = normalizePath(storedPath)
  const candidate = normalizePath(path.resolve(absPath))
  // Cheap structural filter only. Deliberately NOT `storedPath === candidate`: the caller's own
  // spelling agreeing with the stored one proves nothing, because the caller may simply be
  // repeating the same stale spelling the row already holds -- git reports the name in its own
  // index, which still says `readme.md` until a case rename is staged, and an editor hook
  // reports whatever the editor passed. Short-circuiting on that agreement is how the row would
  // stay stale forever in exactly the cases that never reach a filesystem walk.
  if (foldPath(stored) !== foldPath(candidate)) return false
  let real: string
  try {
    real = normalizePath(fs.realpathSync.native(absPath))
  } catch {
    // Unreadable or gone right now: leave the row alone rather than guess at a spelling.
    return false
  }
  if (real === stored) return false
  if (foldPath(real) !== foldPath(stored)) return false

  // Both real and stored have the same folded path, but real was canonicalized from the filesystem
  // root by fs.realpathSync.native (expanding canonical case for all parent directories, e.g.
  // C:/Windows/Temp vs C:/WINDOWS/TEMP), whereas stored/candidate may share an ambient directory
  // prefix. Compare segments: if the filename (last segment) differs, the file was renamed.
  const storedSegments = stored.split('/')
  const realSegments = real.split('/')
  if (storedSegments.length !== realSegments.length) return real !== stored

  const storedBase = storedSegments[storedSegments.length - 1]
  const realBase = realSegments[realSegments.length - 1]
  if (storedBase !== realBase) return true

  for (let i = storedSegments.length - 2; i >= 0; i--) {
    if (storedSegments[i] !== realSegments[i]) {
      if (storedSegments.slice(0, i + 1).join('/') === candidate.split('/').slice(0, i + 1).join('/')) {
        continue
      }
      return true
    }
  }
  return false
}

/**
 * The shared read side of the embed-freshness gate used by both worker.ts::makeIndexer and
 * cli.ts's bulk index loop. Returns true when the file's stored `embed_sha` already represents the
 * correct terminal embedding state for the CURRENT environment, so re-running indexFileEmbeddings
 * would do no useful work and can be skipped:
 *
 *  - embeddings config-disabled: fresh only when stored is the `disabled:` marker for this sha.
 *  - enabled + a bare sha match: fresh (the file was really embedded, or was empty / policy-skipped
 *    with nothing to embed -- both are terminal regardless of deps).
 *  - enabled but deps currently unavailable: an `unavailable:` marker for this sha is also fresh,
 *    so an unchanged file is not re-entered on every worker drain while deps stay missing.
 *  - enabled + deps available: an `unavailable:` (or `disabled:`) marker is NOT fresh, forcing the
 *    real first embed now that it can finally succeed.
 *  - enabled + an `oversize:` marker: fresh only while `symbolOnlyKb` still matches the threshold
 *    the marker was stamped under, so raising `indexing.large_file_symbol_only_kb` re-examines the
 *    file instead of leaving it permanently skipped. See {@link OVERSIZE_EMBED_SHA_PREFIX}.
 *
 * `symbolOnlyKb` is the caller's current `indexing.large_file_symbol_only_kb`. Pass 0 when no
 * config is in hand: config validation floors that key at 1, so 0 matches no stamped marker and the
 * file is re-examined rather than assumed current, which is the safe direction.
 */
export function isEmbedFresh(
  storedEmbedSha: string | undefined,
  sha: string,
  embeddingsEnabled: boolean,
  depsAvailable: boolean,
  symbolOnlyKb: number,
): boolean {
  if (storedEmbedSha === undefined) return false
  if (!embeddingsEnabled) return storedEmbedSha === disabledEmbedSha(sha)
  if (storedEmbedSha === sha) return true
  if (!depsAvailable && storedEmbedSha === unavailableEmbedSha(sha)) return true
  if (storedEmbedSha === oversizeEmbedSha(sha, symbolOnlyKb)) return true
  // Not a parameter the way symbolOnlyKb is: the document work clock is a compiled-in constant, not a config value, so there is no caller who could know a different one. It is compared rather than ignored so that changing it in a later release invalidates every stamp taken under the old one.
  if (storedEmbedSha === timeoutEmbedSha(sha, MAX_DOCUMENT_WORK_MILLIS)) return true
  return false
}

/**
 * `sha`, when provided, is stamped into `files.embed_sha` after {@link embedIndexFile}
 * commits successfully -- tracked separately from `files.sha` (the parse-freshness gate) so
 * a crash or thrown error mid-embedding never gets masked by the parse-sha gate: the embed_sha
 * column is left at its previous (stale/empty) value on any early return or thrown error below,
 * so a later touch of byte-identical content still re-triggers embedding instead of being
 * permanently sha-gate-skipped. See makeIndexer in worker.ts for the read side of this gate.
 */
export async function indexFileEmbeddings(
  rawPath: string,
  dbPath: string = globalDbPath(),
  sha?: string,
  onError?: (err: unknown) => void,
): Promise<void> {
  // Same canonicalization as indexFileSync, for the same reason: chunk rows must be keyed by
  // the spelling the parse side wrote, not by whatever the caller happened to pass.
  const filePath = canonicalizeIndexPath(rawPath)
  const ixCfg = loadConfig().indexing
  if (!ixCfg.embeddings_enabled) {
    // Stamp a disabled-marker embed_sha even though no embedding actually ran, so makeIndexer's embedUnchanged gate (worker.ts) can hold for this content the next time it's touched while STILL disabled -- otherwise every re-touch of an unchanged file re-enters indexFileEmbeddings just to hit this same early-return again, on every drain, for as long as embeddings stay disabled. Deliberately NOT the real sha (see disabledEmbedSha's doc comment): re-enabling embeddings later must not be mistaken for "already embedded, unchanged".
    stampEmbedSha(getDb(dbPath), filePath, sha, disabledEmbedSha)
    return
  }
  if (filePath.toLowerCase().endsWith('.profile-meta.xml')) {
    // Profiles are frequently multi-megabyte, highly repetitive permission dumps. Embedding them creates thousands of low-signal vectors; exact symbol/read/grep access remains.
    const db = getDb(dbPath)
    deleteFileEmbeddings(db, filePath)
    // Deliberately-never-embed is a terminal state: stamp the real sha so the freshness gate (worker.ts/cli.ts) treats this file as done and does not re-read its multi-megabyte content into indexFileEmbeddings on every worker drain / index run.
    stampEmbedSha(db, filePath, sha, (s) => s)
    return
  }
  if (isEmbeddableDocument(filePath)) {
    // Binary document formats (PDF/DOCX/PPTX/XLSX) need format-specific extraction, not a raw
    // utf8 read of the file's bytes -- must run before the generic read below, which would
    // otherwise reinterpret binary content as garbage text. detectLanguage() returns 'unknown'
    // for these extensions (no Language union member, no code symbols), so none of the
    // ipynb/large-file/salesforce branches above or below apply to them.
    let extracted: string | null
    let refusedOnTheClock = false
    try {
      extracted = await extractEmbeddableDocumentText(filePath)
    } catch (err) {
      if (!isDocumentRefusal(err)) {
        // Left unstamped on purpose, the same way a thrown embedIndexFile is below: this file's
        // extraction failed rather than declined, and a stamp here would be a permanent verdict
        // recorded from a temporary condition -- pdfjs briefly missing, the file mid-write -- so
        // the document would never be embedded again even once the cause was gone.
        onError?.(err)
        return
      }
      refusedOnTheClock = isTransientDocumentRefusal(err)
      extracted = null
    }
    if (extracted === null || extracted.trim().length === 0) {
      // A refused document or one with no extractable text is a terminal deliberately-never-embed state, same shape as the .profile-meta.xml skip above: stamp the real sha so an unchanged file is not re-read into extraction on every worker drain / index run. Except when the refusal was the work clock, which is terminal in neither direction: re-reading it every drain would re-spend the whole minute the clock exists to cap, and a bare sha would bury the document forever over one busy minute. The clock-bearing marker is the middle: settled for as long as this clock is, re-examined the moment it moves.
      const db = getDb(dbPath)
      deleteFileEmbeddings(db, filePath)
      stampEmbedSha(db, filePath, sha, (s) => (refusedOnTheClock ? timeoutEmbedSha(s, MAX_DOCUMENT_WORK_MILLIS) : s))
      return
    }
    if (extracted.length > ixCfg.large_file_symbol_only_kb * 1024) {
      // Reuse the same large-file threshold as the generic content-length check below -- extracted document text is comparatively expensive to embed for comparatively little retrieval value once it's this large, not a case that needs its own config knob. Stamped with the threshold-bearing oversize marker, not a bare sha, for the reason given on OVERSIZE_EMBED_SHA_PREFIX: this skip is conditional on a user-tunable value, so it is not terminal the way the extraction-failure case above is.
      const db = getDb(dbPath)
      deleteFileEmbeddings(db, filePath)
      stampEmbedSha(db, filePath, sha, (s) => oversizeEmbedSha(s, ixCfg.large_file_symbol_only_kb))
      return
    }
    try {
      const db = getDb(dbPath)
      // No symbol table exists for these formats, so boundaries is empty -- the whole extracted
      // text goes through chunkFile's generic windowed chunking instead of symbol-aligned chunks.
      const outcome = await embedIndexFile(db, filePath, extracted, [])
      stampEmbedSha(db, filePath, sha, (s) => (outcome === 'unavailable' ? unavailableEmbedSha(s) : s))
    } catch (err) {
      onError?.(err)
    }
    return
  }
  let content: string
  try {
    content = decodeSource(await fs.promises.readFile(filePath))
  } catch {
    return
  }
  // A dotenv file's values are secret by the file's nature, and this is the one indexing path that
  // persists raw file text: the symbol table already stores env keys with empty bodies, but chunks
  // held the whole file, so `semantic` served the password. Redact before chunking, not at search
  // time, so nothing sensitive is written to disk in the first place. See dotenv_redact.ts.
  content = redactIfDotenv(filePath, content)
  if (detectLanguage(filePath) === 'ipynb') {
    // Embedding boundaries below are line ranges taken from the symbols table, which indexFileSync populated from the SAME virtual document -- must transform content identically here or chunk text would be sliced from the wrong (raw JSON) place. A non-Python-kernel/unparseable notebook is a deliberate terminal never-embed, same shape as the profile-meta.xml/oversized-metadata skips below.
    const virtual = ipynbToVirtualSource(content)
    if (virtual.cellLanguage === null) {
      const db = getDb(dbPath)
      deleteFileEmbeddings(db, filePath)
      stampEmbedSha(db, filePath, sha, (s) => s)
      return
    }
    content = virtual.content
  }
  if (content.length > ixCfg.large_file_symbol_only_kb * 1024) {
    // Between the symbol-only and full-skip thresholds: syntactic symbols/refs are already indexed by indexFileSync (only large_file_skip_kb gates that), but embedding a moderately-large file is comparatively expensive for comparatively little retrieval value -- skip embedding it. Unlike the profile-meta.xml / salesforce_metadata skips below, this one is conditional on a user-tunable config value rather than on the content, so it is stamped with the threshold-bearing oversize marker instead of a bare sha: see OVERSIZE_EMBED_SHA_PREFIX for what a bare sha cost here.
    const db = getDb(dbPath)
    deleteFileEmbeddings(db, filePath)
    stampEmbedSha(db, filePath, sha, (s) => oversizeEmbedSha(s, ixCfg.large_file_symbol_only_kb))
    return
  }
  if (detectLanguage(filePath) === 'salesforce_metadata' && content.length > 512 * 1024) {
    // Keep unusually large generated metadata from producing thousands of low-signal chunks.
    const db = getDb(dbPath)
    deleteFileEmbeddings(db, filePath)
    // As with the profile skip above, this is a terminal deliberately-never-embed state; stamp
    // the real sha so re-touching the (unchanged) file does not re-enter this path every drain.
    stampEmbedSha(db, filePath, sha, (s) => s)
    return
  }
  try {
    const db = getDb(dbPath)
    const boundaries = buildEmbeddingBoundaries(filePath, content, dbPath)
    const outcome = await embedIndexFile(db, filePath, content, boundaries)
    // When the optional embedding deps were absent, embedIndexFile reports 'unavailable' and no vectors were written -- stamp an unavailable-marker embed_sha (not the bare sha) so this file is re-embedded once the deps are installed, rather than masquerading as fresh forever.
    stampEmbedSha(db, filePath, sha, (s) => (outcome === 'unavailable' ? unavailableEmbedSha(s) : s))
  } catch (err) {
    // Best-effort: never fail the overall index over an embeddings-only error. embed_sha is deliberately left unstamped here (see doc comment above). `onError`, when provided, lets a caller (worker.ts's embedFileSerialized) record this failure somewhere discoverable -- this function itself never throws, matching its documented best-effort contract for callers like cli.ts's foreground bulk-index loop that await it directly with no try/catch.
    onError?.(err)
  }
}

/**
 * Stamp `files.embed_sha` for `filePath`, but only when a `sha` was actually provided (the
 * incremental worker/CLI paths always pass one; some callers do not). `makeValue` derives the
 * value to store from the (now-defined) sha -- identity for a real/terminal embed, or a
 * disabled:/unavailable: marker. Centralizes the UPDATE so every early-return in
 * {@link indexFileEmbeddings} records its terminal state identically.
 */
function stampEmbedSha(
  db: ReturnType<typeof getDb>,
  filePath: string,
  sha: string | undefined,
  makeValue: (sha: string) => string,
): void {
  if (sha === undefined) return
  // Optimistic-concurrency guard: also require files.sha to still equal the sha this embed run started from. inFlightEmbeddings (worker.ts) only serializes concurrent embed calls WITHIN a single process -- it cannot see a second process (e.g. a slow foreground `token-goat index` racing the background daemon) embedding the same file at the same time. Without this WHERE clause, a slow writer that started against an older `sha` can still commit its stamp AFTER a faster writer already reindexed and re-embedded a newer version, overwriting the fresher embed_sha with a stale one and leaving embeddings silently out of sync with no way to detect it. Requiring sha = ? makes a stale writer's stamp a no-op instead: the row's `sha` will have already moved on to the newer value by the time the stale writer's UPDATE runs.
  db.prepare(`UPDATE files SET embed_sha = ? WHERE ${pathEqClause('path')} AND sha = ?`).run(
    makeValue(sha),
    foldPath(filePath),
    sha,
  )
}

function safeMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs / 1000
  } catch {
    return 0
  }
}
