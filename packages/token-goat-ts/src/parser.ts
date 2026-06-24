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

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { fingerprintFile } from './fingerprint.js'
import { detectLanguage } from './parser_types.js'
import type { Language, RefEntry, SymbolEntry } from './parser_types.js'

const _require = createRequire(import.meta.url)

/** Result of parsing one file: extracted symbols, refs, language, timing. */
export interface ParseResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
  readonly language: Language
  readonly duration: number
}

// --- Tree-sitter grammar loading (optional, cached) -------------------------

// Minimal structural typings for the node-tree-sitter API surface we touch.
// The packages ship no first-class .d.ts under this resolution, so we model
// only the members used here rather than pulling `any` through the module.
interface TsPoint {
  readonly row: number
  readonly column: number
}
interface TsNode {
  readonly type: string
  readonly text: string
  readonly startPosition: TsPoint
  readonly endPosition: TsPoint
  readonly namedChildren: TsNode[]
  childForFieldName(field: string): TsNode | null
}
interface TsTree {
  readonly rootNode: TsNode
}
interface TsParser {
  setLanguage(lang: unknown): void
  parse(input: string): TsTree
}
interface TsParserCtor {
  new (): TsParser
}

/** Grammar object handed to `parser.setLanguage`. Opaque to us. */
type Grammar = unknown

// Cache the Parser constructor and each resolved grammar across calls so the
// native binding is loaded at most once per process. `null` means "tried and
// unavailable"; `undefined` means "not yet attempted".
let _parserCtor: TsParserCtor | null | undefined
const _grammarCache = new Map<Language, Grammar | null>()

function loadParserCtor(): TsParserCtor | null {
  if (_parserCtor !== undefined) return _parserCtor
  try {
    _parserCtor = _require('tree-sitter') as TsParserCtor
  } catch {
    _parserCtor = null
  }
  return _parserCtor
}

function loadGrammar(lang: Language): Grammar | null {
  const cached = _grammarCache.get(lang)
  if (cached !== undefined) return cached

  let grammar: Grammar | null = null
  try {
    if (lang === 'typescript') {
      const mod = _require('tree-sitter-typescript') as { typescript: Grammar }
      grammar = mod.typescript
    } else if (lang === 'javascript') {
      grammar = _require('tree-sitter-javascript') as Grammar
    } else if (lang === 'python') {
      grammar = _require('tree-sitter-python') as Grammar
    }
  } catch {
    grammar = null
  }

  _grammarCache.set(lang, grammar)
  return grammar
}

/**
 * Is tree-sitter (binding + grammar) available for `lang`?
 *
 * Returns `false` rather than throwing when the native binding or a grammar
 * package is missing, so callers can branch to the regex fallback. Languages
 * without a bundled grammar (everything but ts/js/python) are always `false`.
 */
export function isTreeSitterAvailable(lang: Language): boolean {
  if (lang !== 'typescript' && lang !== 'javascript' && lang !== 'python') {
    return false
  }
  return loadParserCtor() !== null && loadGrammar(lang) !== null
}

// --- Symbol extraction via tree-sitter --------------------------------------

// TS/JS node types that name a top-level or nested definition, mapped to the
// `kind` stored in the index.
const TSJS_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['method_definition', 'method'],
  ['interface_declaration', 'interface'],
  ['type_alias_declaration', 'type'],
  ['enum_declaration', 'enum'],
])

function nodeName(node: TsNode): string | null {
  const named = node.childForFieldName('name')
  if (named !== null) return named.text
  return null
}

function makeSymbol(filePath: string, name: string, kind: string, node: TsNode): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    body: node.text,
    docstring: '',
  }
}

/**
 * Walk a TS/JS tree collecting symbols. Descends into export statements (so
 * `export function f` is captured) and class bodies (for methods), and unwraps
 * `const`/`let`/`var` declarators whose initializer is a function/arrow.
 */
function extractTsJsSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode): void => {
    const kind = TSJS_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
      // Methods live inside class bodies; descend to find nested classes too.
    }

    // Variable/const declarations bound to a function or arrow → 'function'.
    if (
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declaration'
    ) {
      for (const child of node.namedChildren) {
        if (child.type !== 'variable_declarator') continue
        const name = child.childForFieldName('name')
        const value = child.childForFieldName('value')
        if (name === null) continue
        const isFn =
          value !== null &&
          (value.type === 'arrow_function' ||
            value.type === 'function_expression' ||
            value.type === 'function')
        out.push(makeSymbol(filePath, name.text, isFn ? 'function' : 'variable', node))
      }
    }

    for (const child of node.namedChildren) {
      visit(child)
    }
  }

  visit(root)
  return out
}

// Python node types → kind.
const PY_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['function_definition', 'function'],
  ['class_definition', 'class'],
])

/**
 * Walk a Python tree collecting defs and classes. A `function_definition`
 * nested inside a `class_definition` block is recorded as a `method`; the
 * leading docstring of a def/class (first string expression in its block) is
 * captured into {@link SymbolEntry.docstring}.
 */
function extractPythonSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideClass: boolean): void => {
    const baseKind = PY_KIND_BY_TYPE.get(node.type)
    if (baseKind !== undefined) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        const kind = node.type === 'function_definition' && insideClass ? 'method' : baseKind
        out.push({
          ...makeSymbol(filePath, name, kind, node),
          docstring: pythonDocstring(node),
        })
      }
    }

    const nowInsideClass = node.type === 'class_definition'
    for (const child of node.namedChildren) {
      // The block of a class body marks its children as class-scoped.
      visit(child, nowInsideClass || (insideClass && node.type === 'block'))
    }
  }

  visit(root, false)
  return out
}

/** First string literal in a def/class block, stripped of quotes. */
function pythonDocstring(node: TsNode): string {
  const block = node.childForFieldName('body')
  if (block === null) return ''
  const first = block.namedChildren[0]
  if (first === undefined || first.type !== 'expression_statement') return ''
  const str = first.namedChildren[0]
  if (str === undefined || str.type !== 'string') return ''
  return stripPythonStringQuotes(str.text)
}

function stripPythonStringQuotes(raw: string): string {
  let s = raw.trim()
  // Strip optional string prefix (r, b, f, u and combinations).
  s = s.replace(/^[A-Za-z]+/, '')
  for (const q of ['"""', "'''", '"', "'"]) {
    if (s.startsWith(q) && s.endsWith(q) && s.length >= q.length * 2) {
      return s.slice(q.length, s.length - q.length).trim()
    }
  }
  return s.trim()
}

// --- Regex fallback ---------------------------------------------------------

// Top-level function/class patterns for the languages we lack a grammar for
// (and as a safety net when a native grammar fails to load mid-run).
const FALLBACK_PATTERNS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  // Python
  { re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^[ \t]*class\s+([A-Za-z_]\w*)/, kind: 'class' },
  // TS/JS function & class declarations (optionally exported/async)
  {
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: 'function',
  },
  {
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
  },
  { re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
  // const/let/var bound to an arrow or function expression
  {
    re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    kind: 'function',
  },
  // Rust / Go function & struct/type patterns
  { re: /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^[ \t]*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { re: /^[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
]

/**
 * Line-oriented regex extraction used when tree-sitter is unavailable.
 *
 * Captures the symbol name and a single-line body (the matched line). Line
 * numbers are 1-based. This is intentionally shallow: it recovers names for
 * `symbol`/`skeleton` lookups without full-body spans.
 */
function extractWithRegex(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const { re, kind } of FALLBACK_PATTERNS) {
      const m = re.exec(line)
      if (m !== null && m[1] !== undefined) {
        out.push({
          filePath,
          name: m[1],
          kind,
          lineStart: i + 1,
          lineEnd: i + 1,
          body: line.trim(),
          docstring: '',
        })
        break // one symbol per line
      }
    }
  }
  return out
}

// --- Public parse / index API -----------------------------------------------

/**
 * Parse one file and return its extracted symbols + refs.
 *
 * Dispatches to the tree-sitter extractor when a grammar is available for the
 * detected language, otherwise falls back to regex. Unknown languages and
 * unreadable files yield an empty symbol list (never throws). Refs are not
 * extracted in this port — the field is present for parity and always `[]`.
 */
export async function parseFile(filePath: string): Promise<ParseResult> {
  const start = Date.now()
  const language = detectLanguage(filePath)

  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { symbols: [], refs: [], language, duration: Date.now() - start }
  }

  const symbols = parseContent(content, filePath, language)
  return { symbols, refs: [], language, duration: Date.now() - start }
}

/** Shared sync core: pick an extractor for `language` and run it on `content`. */
function parseContent(content: string, filePath: string, language: Language): SymbolEntry[] {
  if (isTreeSitterAvailable(language)) {
    try {
      const Ctor = loadParserCtor()
      const grammar = loadGrammar(language)
      if (Ctor !== null && grammar !== null) {
        const parser = new Ctor()
        parser.setLanguage(grammar)
        const tree = parser.parse(content)
        if (language === 'python') {
          return extractPythonSymbols(tree.rootNode, filePath)
        }
        return extractTsJsSymbols(tree.rootNode, filePath)
      }
    } catch {
      // Parser threw on this input — fall through to the regex pass below.
    }
  }

  if (language === 'unknown') return []
  return extractWithRegex(content, filePath)
}

/**
 * Index one file into the SQLite DB: parse it, then replace its rows.
 *
 * Old `symbols`/`refs`/`files` rows for the path are deleted and re-inserted in
 * a single transaction (DELETE + INSERT, matching the Python bulk-replace
 * strategy) so a re-index never leaves stale symbols behind.
 */
export async function indexFile(filePath: string, dbPath: string = globalDbPath()): Promise<void> {
  const result = await parseFile(filePath)
  const db = getDb(dbPath)

  const sha = safeSha(filePath)
  const mtime = safeMtime(filePath)
  const now = Date.now() / 1000

  const writeAll = db.transaction(() => {
    db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath)
    db.prepare('DELETE FROM refs WHERE file_path = ?').run(filePath)
    db.prepare('DELETE FROM files WHERE path = ?').run(filePath)

    db.prepare(
      'INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(filePath, sha, mtime, result.language, now)

    const insSym = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const s of result.symbols) {
      if (s.name === '' || s.kind === '') continue
      insSym.run(s.filePath, s.name, s.kind, s.lineStart, s.lineEnd, s.body, s.docstring)
    }

    const insRef = db.prepare(
      'INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)',
    )
    for (const r of result.refs) {
      if (r.name === '') continue
      insRef.run(r.filePath, r.name, r.line, r.col, r.context)
    }
  })

  writeAll()
}

/**
 * Index multiple files sequentially. Called by the worker drain loop.
 *
 * A failure on one file (parse error, transient read race) is swallowed so the
 * rest of the batch still indexes — the worker should never crash on a single
 * bad file.
 */
export async function indexFiles(
  filePaths: string[],
  dbPath: string = globalDbPath(),
): Promise<void> {
  for (const filePath of filePaths) {
    try {
      await indexFile(filePath, dbPath)
    } catch {
      // Skip this file; continue draining the batch.
    }
  }
}

function safeSha(filePath: string): string {
  try {
    return fingerprintFile(filePath) ?? ''
  } catch {
    return ''
  }
}

function safeMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs / 1000
  } catch {
    return 0
  }
}
