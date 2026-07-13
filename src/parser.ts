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

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { loadConfig } from './config.js'
import type { IndexingConfig } from './config.js'
import { deleteFileEmbeddings, indexFile as embedIndexFile } from './embeddings.js'
import type { ChunkBoundary } from './embeddings.js'
import { fingerprintContent, fingerprintFile } from './fingerprint.js'
import { pathEqClause } from './sql_path.js'
import { eachUnfencedLine } from './markdown_lines.js'
import { detectLanguage } from './parser_types.js'
import type { Language, RefEntry, SymbolEntry } from './parser_types.js'
import { querySymbols } from './index_reader.js'
import { extractMarkdownHeadings } from './hints/markdown_hints.js'
import { extractCsharp } from './languages/csharp.js'
import { extractPhp } from './languages/php.js'
import { extractHtml } from './languages/html.js'
import { extractLiquid } from './languages/liquid.js'
import { extractKotlin } from './languages/kotlin.js'
import { extractGraphql } from './languages/graphql_idx.js'
import { extractSql } from './languages/sql_idx.js'
import { stripCstyleComments, stripStringLiterals } from './languages/common.js'
import { extractIni, extractEnv } from './languages/ini_idx.js'
import { extractMakefile } from './languages/makefile_idx.js'
import { extractProto } from './languages/proto_idx.js'

import { extractPowershell } from './languages/powershell_idx.js'
import { extractApex } from './languages/apex.js'
import { extractSalesforceMetadata } from './languages/salesforce_metadata.js'
import {
  extractLwcJavaScript,
  extractLwcTemplate,
  extractSalesforceMarkup,
} from './languages/salesforce_frontend.js'
import { foldPath } from './util.js'
const _require = createRequire(import.meta.url)

/** Result of parsing one file: extracted symbols, refs, language, timing. */
export interface ParseResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
  readonly language: Language
  readonly duration: number
}

// --- Tree-sitter grammar loading (optional, cached) -------------------------

// Minimal structural typings for the node-tree-sitter API surface we touch. The packages ship no first-class .d.ts under this resolution, so we model only the members used here rather than pulling `any` through the module.
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
  readonly parent: TsNode | null
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

// Cache the Parser constructor and each resolved grammar across calls so the native binding is loaded at most once per process. `null` means "tried and unavailable"; `undefined` means "not yet attempted". Keyed by string, not just `Language`, because TypeScript has two grammar variants (plain `.ts` vs JSX-aware `.tsx`) sharing one `Language` value.
let _parserCtor: TsParserCtor | null | undefined
const _grammarCache = new Map<string, Grammar | null>()

function loadParserCtor(): TsParserCtor | null {
  if (_parserCtor !== undefined) return _parserCtor
  try {
    _parserCtor = _require('tree-sitter') as TsParserCtor
  } catch {
    _parserCtor = null
  }
  return _parserCtor
}

// `tree-sitter-typescript` ships two distinct grammars from one package: `typescript` (plain
// .ts/.mts/.cts — rejects JSX syntax) and `tsx` (a superset that also parses JSX). Both share
// the `Language` value 'typescript', so the caller's file path — not the Language — is what
// distinguishes them. Parsing a .tsx file with the `typescript` grammar still "succeeds" (tree-sitter's
// error recovery doesn't throw) but produces ERROR nodes around JSX, silently dropping or
// mis-scoping symbols/refs.
function loadGrammar(lang: Language, filePath?: string): Grammar | null {
  const useTsx = lang === 'typescript' && filePath !== undefined && path.extname(filePath).toLowerCase() === '.tsx'
  const cacheKey = useTsx ? 'typescript:tsx' : lang
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
      grammar = _require('tree-sitter-c') as Grammar
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
  if (
    lang !== 'typescript' &&
    lang !== 'javascript' &&
    lang !== 'python' &&
    lang !== 'go' &&
    lang !== 'rust' &&
    lang !== 'ruby' &&
    lang !== 'java' &&
    lang !== 'c' &&
    lang !== 'cpp'
  ) {
    return false
  }
  return loadParserCtor() !== null && loadGrammar(lang) !== null
}

// --- Symbol extraction via tree-sitter --------------------------------------

// TS/JS node types that name a top-level or nested definition, mapped to the `kind` stored in the index.
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

// Collect the bound local identifiers from a destructuring pattern node (object_pattern / array_pattern, including nested patterns, rest elements, defaults, and renames). A renamed key (`{ a: b }`) binds the value `b`; the key `a` is a property_identifier and is intentionally skipped.
function collectPatternBindings(node: TsNode): string[] {
  const names: string[] = []
  const walk = (n: TsNode): void => {
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
      if (n.text !== '') names.push(n.text)
      return
    }
    for (const child of n.namedChildren) walk(child)
  }
  walk(node)
  return names
}

/**
 * Walk a TS/JS tree collecting symbols. Descends into export statements (so
 * `export function f` is captured) and class bodies (for methods), and unwraps
 * `const`/`let`/`var` declarators whose initializer is a function/arrow.
 */
/** Node types whose bodies introduce a new function scope — declarations
 * nested inside these are locals, excluded from the document-symbol index. */
const TSJS_FN_SCOPE_TYPES: ReadonlySet<string> = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function', 'generator_function_declaration',
])

function extractTsJsSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = TSJS_KIND_BY_TYPE.get(node.type)
    // A local `function` declaration nested inside a function body is a local, exactly like a
    // local const/let/var below -- exclude it from the top-level index the same way.
    if (kind !== undefined && !(insideFunction && node.type === 'function_declaration')) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
      // Methods live inside class bodies; descend to find nested classes too.
    }

    // Variable/const declarations bound to a function or arrow → 'function'. Only at module/class scope: a declaration inside a function/method/arrow body is a local (loop counter, temporary) and must NOT be indexed — locals pollute outline/skeleton and global `symbol` search and bloat the index. (Mirrors extractPythonSymbols threading scope through the walk.)
    if (
      !insideFunction &&
      (node.type === 'lexical_declaration' ||
        node.type === 'variable_declaration')
    ) {
      for (const child of node.namedChildren) {
        if (child.type !== 'variable_declarator') continue
        const name = child.childForFieldName('name')
        const value = child.childForFieldName('value')
        if (name === null) continue
        if (name.type === 'identifier') {
          // Simple binding: `const f = () => {}` is a function, otherwise a variable.
          const isFn =
            value !== null &&
            (value.type === 'arrow_function' ||
              value.type === 'function_expression' ||
              value.type === 'function')
          out.push(makeSymbol(filePath, name.text, isFn ? 'function' : 'variable', child))
        } else {
          // Destructuring pattern: emit one variable symbol per bound identifier (not a single junk symbol named after the whole `{ ... }` / `[ ... ]`).
          for (const bound of collectPatternBindings(name)) {
            out.push(makeSymbol(filePath, bound, 'variable', child))
          }
        }
      }
    }
    // Class fields bound to a function/arrow are method-equivalent members (auto-bound handlers); index them as 'method'. Data fields are skipped, matching the no-member-indexing convention. TS exposes the field name on `name`, JS on `property`.
    if (node.type === 'public_field_definition' || node.type === 'field_definition') {
      const fieldName = node.childForFieldName('name') ?? node.childForFieldName('property')
      const value = node.childForFieldName('value')
      if (
        fieldName !== null &&
        value !== null &&
        (value.type === 'arrow_function' ||
          value.type === 'function_expression' ||
          value.type === 'function')
      ) {
        out.push(makeSymbol(filePath, fieldName.text, 'method', node))
      }
    }

    const childInside = insideFunction || TSJS_FN_SCOPE_TYPES.has(node.type)
    for (const child of node.namedChildren) {
      visit(child, childInside)
    }
  }

  visit(root, false)
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
        // A decorated def's tree-sitter node starts at `def`/`class`, not its `@decorator`
        // line(s) above — decorated_definition has no PY_KIND_BY_TYPE entry, so it's never
        // the node a symbol is built from. Widen to the enclosing decorated_definition's own
        // range (decorators through end of the def) when present, so `read`/`skeleton`
        // include the decorator lines; name/kind/docstring still come from the inner def
        // node so method-vs-function and class-scope detection are unaffected.
        const rangeNode = node.parent?.type === 'decorated_definition' ? node.parent : node
        out.push({
          ...makeSymbol(filePath, name, kind, rangeNode),
          docstring: pythonDocstring(node),
        })
      }
    }

    for (const child of node.namedChildren) {
      // A def's method-ness is set by its nearest enclosing *definition*: a class body makes children class-scoped; entering a function body resets it; any other node (block, if/try/for/while/with) inherits the current scope, so a method defined inside a control-flow block in a class body is still a method.
      const childInsideClass =
        node.type === 'class_definition'
          ? true
          : node.type === 'function_definition'
            ? false
            : insideClass
      visit(child, childInsideClass)
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

export function stripPythonStringQuotes(raw: string): string {
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

// --- Tree-sitter extractors for Go, Rust, Ruby, Java, C++ ---

const GO_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['function_declaration', 'function'],
  ['method_declaration', 'method'],
  // Go type/const/var names live on the nested *_spec node, not the *_declaration wrapper (which exposes no `name` field). A grouped `type (...)` / `const (...)` / `var (...)` block holds several specs, each reached by the namedChildren recursion in extractGoSymbols, so keying on the spec node yields one symbol per declared name. `type X = Y` parses as type_alias, which also carries the name field.
  ['type_spec', 'type'],
  ['type_alias', 'type'],
  ['const_spec', 'const'],
  ['var_spec', 'variable'],
])

// Go scope nodes whose bodies hold function-local declarations. A var/const/type declared inside one of these (or any block nested in it, including closures) is a local and must not pollute the global symbol index - mirrors the insideFunction threading in extractTsJsSymbols.
const GO_FN_SCOPE_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'method_declaration',
  'func_literal',
])

// Go declaration kinds that are package-level symbols at top level but locals inside a function body; gated on scope. Functions and methods are never local (Go forbids nested declarations) so they emit unconditionally.
const GO_LOCAL_KINDS: ReadonlySet<string> = new Set([
  'var_spec',
  'const_spec',
  'type_spec',
  'type_alias',
])

function extractGoSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = GO_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined && !(insideFunction && GO_LOCAL_KINDS.has(node.type))) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
    }

    const childInside = insideFunction || GO_FN_SCOPE_TYPES.has(node.type)
    for (const child of node.namedChildren) {
      visit(child, childInside)
    }
  }

  visit(root, false)
  return out
}

const RUST_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['function_item', 'function'],
  ['struct_item', 'struct'],
  ['enum_item', 'enum'],
  ['impl_item', 'impl'],
  ['trait_item', 'trait'],
  ['type_item', 'type'],
  ['const_item', 'const'],
])

// Rust scope nodes whose bodies hold function-local declarations. A `const` declared inside one of these (or any block nested in it) is a local and must not pollute the global symbol index. An `impl` block is deliberately NOT here: associated consts inside `impl` are reachable as `Type::CONST`, so they stay indexed.
const RUST_FN_SCOPE_TYPES: ReadonlySet<string> = new Set(['function_item', 'closure_expression'])

// Rust declaration kinds that are package-level symbols at top level but locals inside a function body; gated on scope. Only value bindings are excluded - nested structs, enums, functions, traits, impls, and types stay indexed, mirroring how the TS/JS extractor keeps nested classes and functions while dropping local `const`/`let`/`var`.
const RUST_LOCAL_KINDS: ReadonlySet<string> = new Set(['const_item'])

function extractRustSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = RUST_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined && !(insideFunction && RUST_LOCAL_KINDS.has(node.type))) {
      // An `impl` block has no `name` field; the implemented type lives in a `type` field (e.g. `impl Widget` or `impl Trait for Widget`), so resolve it there. All other Rust items expose their name on the `name` field.
      const name =
        node.type === 'impl_item' ? (node.childForFieldName('type')?.text ?? null) : nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
    }

    const childInside = insideFunction || RUST_FN_SCOPE_TYPES.has(node.type)
    for (const child of node.namedChildren) {
      visit(child, childInside)
    }
  }

  visit(root, false)
  return out
}

const RUBY_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['method', 'method'],
  ['singleton_method', 'method'],
  ['class', 'class'],
  ['module', 'module'],
])

function extractRubySymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode): void => {
    const kind = RUBY_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
    }

    for (const child of node.namedChildren) {
      visit(child)
    }
  }

  visit(root)
  return out
}

const JAVA_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['method_declaration', 'method'],
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['enum_declaration', 'enum'],
  ['constructor_declaration', 'method'],
  ['record_declaration', 'class'],
  ['annotation_type_declaration', 'interface'],
])

function extractJavaSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode): void => {
    const kind = JAVA_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
    }

    for (const child of node.namedChildren) {
      visit(child)
    }
  }

  visit(root)
  return out
}

const CPP_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['function_definition', 'function'],
  ['class_specifier', 'class'],
  ['struct_specifier', 'struct'],
  ['enum_specifier', 'enum'],
])

function extractCppSymbols(root: TsNode, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode): void => {
    const kind = CPP_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined) {
      // C/C++ function names live in a nested `declarator` chain, not a `name` field, so reuse the refs helper that descends it; other specifiers (class/struct/enum) do expose a `name` field.
      const name = node.type === 'function_definition' ? cFunctionName(node) : nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node))
      }
    }

    for (const child of node.namedChildren) {
      visit(child)
    }
  }

  visit(root)
  return out
}

// --- Reference (call-site) extraction via tree-sitter ----------------------

// Languages whose tree-sitter grammar we walk for call-site references. Each reference row records the callee name, the line/column of the call, and the enclosing function/method/class symbol (stored in `context`) so that `refs --callers` can group usages by the symbol that contains them.
const REF_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
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

// Node types that introduce a named enclosing scope, per language. The walker pushes the node's `name` onto a stack while descending its children so each reference resolves to its innermost enclosing symbol.
const SCOPE_TYPES_BY_LANG: ReadonlyMap<Language, ReadonlySet<string>> = new Map([
  [
    'typescript',
    new Set([
      'function_declaration',
      'generator_function_declaration',
      'class_declaration',
      'abstract_class_declaration',
      'method_definition',
    ]),
  ],
  [
    'javascript',
    new Set([
      'function_declaration',
      'generator_function_declaration',
      'class_declaration',
      'method_definition',
    ]),
  ],
  ['python', new Set(['function_definition', 'class_definition'])],
  ['go', new Set(['function_declaration', 'method_declaration'])],
  ['rust', new Set(['function_item'])],
  [
    'java',
    new Set(['method_declaration', 'constructor_declaration', 'class_declaration']),
  ],
  ['c', new Set(['function_definition'])],
  ['cpp', new Set(['function_definition'])],
  ['ruby', new Set(['method', 'singleton_method', 'class', 'module'])],
])

// Node types that represent a call site, per language.
const CALL_TYPES_BY_LANG: ReadonlyMap<Language, ReadonlySet<string>> = new Map([
  ['typescript', new Set(['call_expression', 'new_expression'])],
  ['javascript', new Set(['call_expression', 'new_expression'])],
  ['python', new Set(['call'])],
  ['go', new Set(['call_expression'])],
  ['rust', new Set(['call_expression', 'macro_invocation'])],
  ['java', new Set(['method_invocation', 'object_creation_expression'])],
  ['c', new Set(['call_expression'])],
  ['cpp', new Set(['call_expression'])],
  ['ruby', new Set(['call'])],
])

// Builtins / globals that carry no useful "who calls X" signal. Filtered out of the refs index to keep `refs --callers` focused on project symbols. Method calls (`obj.foo()`) are captured by their property name (`foo`), so these only suppress bare-identifier calls to language builtins.
const REF_NOISE_BY_LANG: ReadonlyMap<Language, ReadonlySet<string>> = new Map([
  [
    'typescript',
    new Set([
      'require',
      'Boolean',
      'Number',
      'String',
      'Array',
      'Object',
      'Symbol',
      'BigInt',
      'parseInt',
      'parseFloat',
      'isNaN',
      'isFinite',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
    ]),
  ],
  [
    'python',
    new Set([
      'print',
      'len',
      'range',
      'str',
      'int',
      'float',
      'bool',
      'list',
      'dict',
      'set',
      'tuple',
      'type',
      'isinstance',
      'issubclass',
      'hasattr',
      'getattr',
      'setattr',
      'enumerate',
      'zip',
      'sorted',
      'reversed',
      'min',
      'max',
      'sum',
      'abs',
      'open',
      'repr',
      'super',
    ]),
  ],
])

// JavaScript reuses the TypeScript noise set.
const JS_NOISE = REF_NOISE_BY_LANG.get('typescript') ?? new Set<string>()
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()

/** Last `::`- or `.`-separated segment of a path expression text. */
function lastSegment(text: string): string {
  const parts = text.split(/::|\./)
  return parts[parts.length - 1] ?? text
}

/**
 * Resolve the name of the enclosing symbol a `node` introduces, or `null` if it
 * does not introduce a named scope. Handles TS/JS `const f = () => {}` arrow and
 * function-expression bindings as named scopes in addition to the declaration
 * node types in {@link SCOPE_TYPES_BY_LANG}.
 */
function scopeName(node: TsNode, language: Language): string | null {
  if (
    (language === 'typescript' || language === 'javascript') &&
    node.type === 'variable_declarator'
  ) {
    const value = node.childForFieldName('value')
    if (
      value !== null &&
      (value.type === 'arrow_function' ||
        value.type === 'function_expression' ||
        value.type === 'function')
    ) {
      return node.childForFieldName('name')?.text ?? null
    }
    return null
  }
  const scopeTypes = SCOPE_TYPES_BY_LANG.get(language)
  if (scopeTypes !== undefined && scopeTypes.has(node.type)) {
    // C/C++ name a function via a nested `declarator` chain rather than a `name` field (e.g. `int* f()` wraps a pointer_declarator around the identifier).
    if ((language === 'c' || language === 'cpp') && node.type === 'function_definition') {
      return cFunctionName(node)
    }
    return node.childForFieldName('name')?.text ?? null
  }
  return null
}

/** Descend a C/C++ function_definition's `declarator` chain to its identifier. */
function cFunctionName(node: TsNode): string | null {
  let cur: TsNode | null = node.childForFieldName('declarator')
  // Bound the walk so a malformed/unexpected tree can never loop forever.
  for (let i = 0; cur !== null && i < 16; i++) {
    if (cur.type === 'identifier' || cur.type === 'field_identifier') return cur.text
    if (cur.type === 'qualified_identifier') return lastSegment(cur.text)
    cur = cur.childForFieldName('declarator')
  }
  return null
}

/**
 * Resolve the callee name of a call-site `node` for `language`.
 *
 * Returns the bare identifier for plain calls (`foo()`), the property/field for
 * member or selector calls (`obj.foo()` → `foo`, `pkg.Fn()` → `Fn`), the macro
 * name for Rust macro invocations, and the constructor name for `new` / object
 * creation expressions. Returns `null` for shapes with no resolvable name.
 */
function calleeName(call: TsNode, language: Language): string | null {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      if (call.type === 'new_expression') {
        const c = call.childForFieldName('constructor')
        if (c === null) return null
        if (c.type === 'identifier') return c.text
        if (c.type === 'member_expression') return c.childForFieldName('property')?.text ?? null
        return null
      }
      const fn = call.childForFieldName('function')
      if (fn === null) return null
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'member_expression') return fn.childForFieldName('property')?.text ?? null
      return null
    }
    case 'python': {
      const fn = call.childForFieldName('function')
      if (fn === null) return null
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'attribute') return fn.childForFieldName('attribute')?.text ?? null
      return null
    }
    case 'go': {
      const fn = call.childForFieldName('function')
      if (fn === null) return null
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'selector_expression') return fn.childForFieldName('field')?.text ?? null
      return null
    }
    case 'rust': {
      if (call.type === 'macro_invocation') {
        const m = call.childForFieldName('macro')
        return m !== null ? lastSegment(m.text) : null
      }
      const fn = call.childForFieldName('function')
      if (fn === null) return null
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'field_expression') return fn.childForFieldName('field')?.text ?? null
      if (fn.type === 'scoped_identifier') {
        return fn.childForFieldName('name')?.text ?? lastSegment(fn.text)
      }
      return null
    }
    case 'java': {
      // method_invocation and object_creation_expression both expose `name`/`type`.
      const n = call.childForFieldName('name') ?? call.childForFieldName('type')
      return n !== null ? lastSegment(n.text) : null
    }
    case 'c':
    case 'cpp': {
      const fn = call.childForFieldName('function')
      if (fn === null) return null
      if (fn.type === 'identifier') return fn.text
      if (fn.type === 'field_expression') return fn.childForFieldName('field')?.text ?? null
      if (fn.type === 'qualified_identifier') return lastSegment(fn.text)
      return null
    }
    case 'ruby': {
      const m = call.childForFieldName('method')
      return m?.text ?? null
    }
    default:
      return null
  }
}

/**
 * Bare-identifier "value position" usages of a name, scoped to `node` itself (not recursive --
 * the caller's own tree walk already visits every descendant, so this only needs to recognise
 * the specific container shapes below whenever `node` happens to be one of them).
 *
 * A call-site walk alone (see extractRefs) misses a symbol that is used without being invoked
 * directly -- passed as a callback (`arr.map(myHelperFunction)`), assigned to a binding (`const
 * x = myHelperFunction`), or stored as an object-literal value (`{ onClick: myHelperFunction
 * }`). Those reads are real usages: `dead` should not flag the symbol as unreferenced, and
 * `refs`/`callers` should surface them. Scoped to TypeScript/JavaScript/Python (the languages in
 * REF_LANGUAGES with directly analogous grammar shapes for these three patterns);
 * Go/Rust/Java/C/C++/Ruby keep call-site-only extraction for now.
 *
 * Deliberately narrow: only a bare `identifier` sitting directly in one of these three field
 * positions counts. A nested expression (`a.b`, `a + b`, a call result, a string/comment) never
 * matches, since tree-sitter already gives those their own distinct node types -- this needs no
 * separate string/comment-stripping pass the way a regex-based extractor would.
 */
function valueRefIdentifiers(node: TsNode, language: Language): TsNode[] {
  const isJs = language === 'typescript' || language === 'javascript'
  const isPy = language === 'python'
  if (!isJs && !isPy) return []

  const result: TsNode[] = []

  // Direct call/constructor argument passed by bare name: arr.map(myHelperFunction).
  if ((isJs && node.type === 'arguments') || (isPy && node.type === 'argument_list')) {
    for (const child of node.namedChildren) {
      if (child.type === 'identifier') result.push(child)
    }
  }

  // Assignment of an existing binding to a variable: const x = myHelperFunction /
  // x = myHelperFunction. Arrow/function-expression values are handled separately by
  // scopeName() as a new scope, not a reference to an existing one, so they're excluded here
  // by only matching a plain `identifier` value.
  if (isJs && (node.type === 'variable_declarator' || node.type === 'assignment_expression')) {
    const value = node.childForFieldName(node.type === 'variable_declarator' ? 'value' : 'right')
    if (value !== null && value.type === 'identifier') result.push(value)
  }
  if (isPy && node.type === 'assignment') {
    const value = node.childForFieldName('right')
    if (value !== null && value.type === 'identifier') result.push(value)
  }

  // Object-literal value bound to an existing name: { onClick: myHelperFunction }.
  if (isJs && node.type === 'pair') {
    const value = node.childForFieldName('value')
    if (value !== null && value.type === 'identifier') result.push(value)
  }

  return result
}

/**
 * Walk a tree-sitter tree collecting call-site and value-position references.
 *
 * Maintains a stack of enclosing scope names (functions / methods / classes) so
 * each reference records its innermost enclosing symbol in `context` -- the data
 * `refs --callers` groups on. References are deduplicated per (name, line) and
 * single-character / builtin callees are dropped to keep the index focused.
 */
function extractRefs(root: TsNode, filePath: string, language: Language): RefEntry[] {
  const out: RefEntry[] = []
  const seen = new Set<string>()
  const callTypes = CALL_TYPES_BY_LANG.get(language) ?? EMPTY_STRING_SET
  const noise =
    language === 'javascript'
      ? JS_NOISE
      : (REF_NOISE_BY_LANG.get(language) ?? EMPTY_STRING_SET)
  const stack: string[] = []

  const record = (name: string, node: TsNode): void => {
    if (name.length <= 1 || noise.has(name)) return
    const line = node.startPosition.row + 1
    const key = `${name}\0${line}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      filePath,
      name,
      line,
      col: node.startPosition.column,
      context: stack.length > 0 ? (stack[stack.length - 1] ?? '') : '',
    })
  }

  const visit = (node: TsNode): void => {
    const enclosing = scopeName(node, language)
    if (enclosing !== null && enclosing !== '') stack.push(enclosing)

    if (callTypes.has(node.type)) {
      const callee = calleeName(node, language)
      if (callee !== null) record(callee, node)
    }

    for (const idNode of valueRefIdentifiers(node, language)) {
      record(idNode.text, idNode)
    }

    for (const child of node.namedChildren) visit(child)

    if (enclosing !== null && enclosing !== '') stack.pop()
  }

  visit(root)
  return out
}

// --- Regex extractors for languages without tree-sitter ---

function extractMarkdownSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  for (const [i, line] of eachUnfencedLine(lines)) {
    const atxMatch = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line)
    if (atxMatch !== null && atxMatch[2] !== undefined) {
      const name = atxMatch[2].trim()
      if (name !== '') {
        out.push({
          filePath,
          name,
          kind: 'heading',
          lineStart: i + 1,
          lineEnd: i + 1,
          body: line.trim(),
          docstring: '',
        })
      }
    }
  }

  return out
}

function extractJsonSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  try {
    const lines = content.split(/\r?\n/)
    let depth = 0
    let inString = false
    let escaping = false
    let strChars: string[] = []
    let strStartLine = 1
    let depthWhenStringOpened = 0
    let line = 1

    for (let i = 0; i < content.length; i++) {
      const ch = content[i]
      if (ch === undefined) continue
      if (ch === '\n') line++
      if (escaping) {
        escaping = false
        if (inString) strChars.push(ch)
        continue
      }
      if (ch === '\\' && inString) {
        escaping = true
        continue
      }
      if (ch === '"') {
        if (!inString) {
          inString = true
          strChars = []
          strStartLine = line
          depthWhenStringOpened = depth
        } else {
          inString = false
          // A string is a top-level key iff it opened at object depth 1 and its next non-whitespace char is ':'. This rule is layout-independent, so it captures keys in single-line/minified JSON and keys that share a line with '{', which the previous line-oriented scan missed (it emitted zero symbols for minified JSON).
          let k = i + 1
          let keyToColonNewlines = 0
          while (k < content.length && /\s/.test(content[k] ?? '')) {
            if (content[k] === '\n') keyToColonNewlines++
            k++
          }
          if (content[k] === ':' && depthWhenStringOpened === 1) {
            // lineEnd/body defaulted to the key's own line for every value kind. When the value is itself a string that contains an embedded literal newline, that undersells the span: scan forward past the colon and, if the value opens with a quote, walk to its matching closing quote (respecting escapes) to find the value's real end line, then widen body to cover every line in between. Non-string values (numbers, booleans, objects, arrays) keep the original single-line behavior.
            let v = k + 1
            let gapNewlines = 0
            while (v < content.length && /\s/.test(content[v] ?? '')) {
              if (content[v] === '\n') gapNewlines++
              v++
            }
            let lineEnd = strStartLine
            let body = (lines[strStartLine - 1] ?? '').trim()
            if (content[v] === '"') {
              let valueLine = line + keyToColonNewlines + gapNewlines
              let valueEscaping = false
              for (let j = v + 1; j < content.length; j++) {
                const vch = content[j]
                if (vch === '\n') valueLine++
                if (valueEscaping) {
                  valueEscaping = false
                  continue
                }
                if (vch === '\\') {
                  valueEscaping = true
                  continue
                }
                if (vch === '"') break
              }
              lineEnd = valueLine
              if (lineEnd > strStartLine) {
                body = lines.slice(strStartLine - 1, lineEnd).join('\n').trim()
              }
            }
            out.push({
              filePath,
              name: strChars.join(''),
              kind: 'property',
              lineStart: strStartLine,
              lineEnd,
              body,
              docstring: '',
            })
          }
        }
        continue
      }
      if (inString) {
        strChars.push(ch)
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') depth--
    }
  } catch {
    // Silently fall through
  }

  return out
}

// Mirrors ini_idx.ts's _detectOpenQuote: a value only opens a (possibly multi-line) quoted
// scalar when its leading non-whitespace char is a quote. A quote appearing later in the value
// - an apostrophe in a plain scalar (`title: It's working`), or a stray quote inside a trailing
// `#` comment - is never a delimiter and must not be scanned for parity, or a plain scalar with
// an interior apostrophe silently swallows every key after it until a matching quote happens to
// appear somewhere downstream.
function yamlOpenQuoteAfter(line: string, startIdx: number): '"' | "'" | null {
  const value = line.slice(startIdx)
  const trimmed = value.replace(/^\s+/, '')
  const q = trimmed[0]
  if (q !== '"' && q !== "'") return null
  if (q === '"') {
    let j = 1
    while (j < trimmed.length) {
      if (trimmed[j] === '\\') { j += 2; continue }
      if (trimmed[j] === '"') return null
      j++
    }
    return '"'
  }
  let j = 1
  while (j < trimmed.length) {
    if (trimmed[j] === "'" && trimmed[j + 1] === "'") { j += 2; continue }
    if (trimmed[j] === "'") return null
    j++
  }
  return "'"
}

function yamlLineClosesQuote(line: string, quote: '"' | "'"): boolean {
  let i = 0
  while (i < line.length) {
    if (quote === '"') {
      if (line[i] === '\\') { i += 2; continue }
      if (line[i] === '"') return true
    } else {
      if (line[i] === "'" && line[i + 1] === "'") { i += 2; continue }
      if (line[i] === "'") return true
    }
    i++
  }
  return false
}

function extractYamlSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  // A top-level key's double/single-quoted value can wrap across multiple lines (YAML folds
  // the embedded newline into a space). Without tracking that, a continuation line that
  // happens to contain its own `word:` -shaped text (e.g. wrapped prose mentioning "ratio:
  // 16:9", or any string content resembling a key) was read as a brand new top-level key.
  let openQuote: '"' | "'" | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openQuote !== null) {
      if (yamlLineClosesQuote(line, openQuote)) openQuote = null
      continue
    }

    const match = /^([a-zA-Z_][\w-]*)\s*:/.exec(line)
    if (match !== null && match[1] !== undefined) {
      out.push({
        filePath,
        name: match[1],
        kind: 'key',
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
      })
      openQuote = yamlOpenQuoteAfter(line, match[0].length)
    }
  }

  return out
}

function extractTomlSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  function matchLine(line: string, lineNum: number): void {
    // `\[?` matches the optional second bracket of a TOML array-of-tables header (`[[bin]]`) so the name captures as `bin`, not `[bin`.
    const sectionMatch = /^\s*\[\[?\s*([^\]]+)\s*\]/.exec(line)
    if (sectionMatch !== null && sectionMatch[1] !== undefined) {
      out.push({
        filePath,
        name: sectionMatch[1].trim(),
        kind: 'section',
        lineStart: lineNum + 1,
        lineEnd: lineNum + 1,
        body: line.trim(),
        docstring: '',
      })
    }

    const keyMatch = /^\s*([a-zA-Z_][\w-]*)\s*=/.exec(line)
    if (keyMatch !== null && keyMatch[1] !== undefined) {
      out.push({
        filePath,
        name: keyMatch[1],
        kind: 'key',
        lineStart: lineNum + 1,
        lineEnd: lineNum + 1,
        body: line.trim(),
        docstring: '',
      })
    }
  }

  // Multi-line TOML strings (`"""..."""` or `'''...'''`) can span many lines; text inside
  // them (e.g. a description field quoting example TOML) must never be scanned for
  // key/section syntax. Track whether a triple-quote span opened on an earlier line is still
  // open across the loop, keyed by which delimiter opened it.
  //
  // The two delimiter styles' run counts cannot be tallied independently per line (e.g. via
  // separate regex-match counts) -- only ONE style can be "open" at a time, so a """ string
  // whose body happens to contain a ''' sequence (e.g. a description quoting example TOML
  // syntax) must treat that ''' as inert text, not as its own independent open/close toggle.
  // Counting each style's occurrences separately loses that positional relationship: an ODD
  // number of ''' sequences sitting inertly inside an already-closed """..." span was wrongly
  // read as opening a real multi-line literal string, desyncing every line after it until an
  // unrelated ''' happened to appear later in the file. Scan the line once, left to right,
  // tracking a single open-delimiter slot instead.
  function lineOpenDelimiterAfter(line: string, startIdx: number): string | null {
    let pos = startIdx
    let open: string | null = null
    for (;;) {
      if (open === null) {
        const dIdx = line.indexOf('"""', pos)
        const sIdx = line.indexOf("'''", pos)
        if (dIdx === -1 && sIdx === -1) return null
        if (dIdx !== -1 && (sIdx === -1 || dIdx <= sIdx)) {
          open = '"""'
          pos = dIdx + 3
        } else {
          open = "'''"
          pos = sIdx + 3
        }
      } else {
        const closeIdx = line.indexOf(open, pos)
        if (closeIdx === -1) return open
        open = null
        pos = closeIdx + 3
      }
    }
  }

  let openDelim: string | null = null

  // TOML arrays may legally span multiple physical lines (e.g. a matrix as an array of
  // arrays, one row per line). A continuation row of such an array - especially a nested
  // array-of-arrays row like `[1, 0, 0],` - starts with `[` and would otherwise be
  // misread by the section regex as a new table header. Track the net bracket depth opened
  // by an unclosed array so continuation lines are skipped from key/section matching
  // entirely until the array actually closes. Brackets inside string literals are ignored
  // (a quoted value like "a[b]" must never affect array depth).
  let arrayDepth = 0

  function bracketDelta(line: string): number {
    const stripped = stripStringLiterals(line)
    let delta = 0
    for (const ch of stripped) {
      if (ch === '[') delta++
      else if (ch === ']') delta--
    }
    return delta
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openDelim !== null) {
      const closeIdx = line.indexOf(openDelim)
      if (closeIdx === -1) continue // whole line is inside the open string body
      const restStart = closeIdx + openDelim.length
      matchLine(line.slice(restStart), i)
      openDelim = lineOpenDelimiterAfter(line, restStart)
      continue
    }

    if (arrayDepth > 0) {
      arrayDepth = Math.max(0, arrayDepth + bracketDelta(line))
      continue
    }

    matchLine(line, i)
    openDelim = lineOpenDelimiterAfter(line, 0)
    if (openDelim === null) arrayDepth = Math.max(0, bracketDelta(line))
  }

  return out
}

// Splits a CSS selector-list capture on top-level commas only, skipping commas nested inside
// parentheses (`:is(.foo, .bar)`, `:not()`, `:nth-child(An+B of S)`) or, thanks to the caller
// already passing a string-literal-stripped `strippedCapture`, commas inside a quoted attribute
// value (`[data-x="a,b"]`). A plain `rawCapture.split(',')` treats every comma as a selector-list
// separator, which shreds any selector containing one of those constructs into multiple bogus
// selector fragments. Scanning happens over `strippedCapture` (so string interiors can't skew
// paren-depth tracking), but each segment is sliced back out of `rawCapture` at the same offsets
// so the indexed selector text stays verbatim.
function splitTopLevelSelectors(rawCapture: string, strippedCapture: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < strippedCapture.length; i++) {
    const ch = strippedCapture[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(rawCapture.slice(start, i))
      start = i + 1
    }
  }
  parts.push(rawCapture.slice(start))
  return parts
}

// True when the next non-blank line after `i` opens a bare Allman-style rule brace (`{` alone on
// its own line, e.g. `body\n{\n...`). Used to start selector-fragment accumulation for the FIRST
// fragment of a rule, which - unlike every later fragment of a multi-line comma list - has no
// trailing comma of its own to signal "more of this selector is still coming".
function nextContentLineOpensBrace(lines: readonly string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const next = lines[j]?.trim() ?? ''
    if (next.length === 0) continue
    return next === '{'
  }
  return false
}

function extractCssSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  // Strip /* */ block comments (newlines preserved so line numbers stay correct) before
  // scanning -- otherwise a commented-out selector at column 0 (e.g. inside a disabled block)
  // is indexed as if it were live CSS.
  const lines = stripCstyleComments(content).split(/\r?\n/)
  // Raw (pre-strip) lines, kept only to distinguish "blanked by comment stripping" from
  // "genuinely blank in the source" below -- see the check at the top of the loop.
  const rawLines = content.split(/\r?\n/)

  // Selector fragments accumulated from preceding comma-continuation lines -- the common
  // multi-line selector-list idiom (`.btn,\n.btn-primary,\n.btn-secondary {`). Each entry keeps
  // its own line number/body so a fragment is indexed at the line it actually appears on, not
  // the brace line, matching how a same-line comma list is already indexed per-fragment below.
  let pending: Array<{ name: string; line: number; body: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()

    // A line that became empty ONLY because stripCstyleComments blanked a `/* ... */` comment
    // sitting on its own line (e.g. `/* primary button */` between selector fragments of a
    // multi-line comma-separated list) must be a no-op, not a break in accumulation -- treating
    // it like a genuinely blank line would silently drop every fragment gathered in `pending`
    // so far (see the discard fallback at the bottom of the loop). A line that was already
    // blank in the raw source still falls through to that discard below, unchanged.
    if (trimmed.length === 0 && (rawLines[i]?.trim().length ?? 0) > 0) {
      continue
    }

    // `^[.#][\w-]+[,\s{]` only matched a bare class/id selector immediately followed by a
    // comma/space/brace, so a compound selector (`.foo.bar`), a pseudo-class/element
    // (`.foo:hover`, `.foo::before`), a plain tag/attribute selector (`div`, `input[type]`),
    // or any selector indented under a nested @media/@supports block (leading whitespace
    // broke the `^` anchor) were all silently skipped. Match anything up to the opening
    // brace instead - excluding lines that start with `@` (an at-rule header like
    // `@media (...) {` is not itself a selector, though selectors nested inside its block
    // are separate lines matched independently) or `{`/`}` (a bare brace-only line) - and
    // split a same-line comma-separated selector list into one symbol per selector.
    // Match against a string-literal-stripped copy of the line so a `{` inside a quoted
    // declaration value (e.g. `content: "{";`, a common pseudo-element glyph pattern) is never
    // mistaken for a rule-opening brace. stripStringLiterals blanks string interiors to
    // same-length spaces, so the match's character offsets line up with the original `line` -
    // the actual (unblanked) selector text is then re-sliced from `line` at those offsets, so a
    // real selector that legitimately contains a quoted value (e.g. `input[type="text"]`) is
    // still captured verbatim rather than with its quoted portion blanked out.
    const strippedLine = stripStringLiterals(line)
    const selectorLineMatch = /^[ \t]*([^{}@][^{]*)\{/d.exec(strippedLine)
    if (selectorLineMatch !== null && selectorLineMatch[1] !== undefined) {
      for (const p of pending) {
        out.push({
          filePath,
          name: p.name,
          kind: 'selector',
          lineStart: p.line,
          lineEnd: p.line,
          body: p.body,
          docstring: '',
        })
      }
      pending = []
      const captureRange = (selectorLineMatch as RegExpExecArray & { indices?: Array<[number, number] | undefined> })
        .indices?.[1]
      const rawCapture = captureRange ? line.slice(captureRange[0], captureRange[1]) : selectorLineMatch[1]
      const strippedCapture = captureRange
        ? strippedLine.slice(captureRange[0], captureRange[1])
        : selectorLineMatch[1]
      for (const part of splitTopLevelSelectors(rawCapture, strippedCapture)) {
        const name = part.trim()
        if (name) {
          out.push({
            filePath,
            name,
            kind: 'selector',
            lineStart: i + 1,
            lineEnd: i + 1,
            body: line.trim(),
            docstring: '',
          })
        }
      }
      continue
    }

    // Brace-only line (nothing but `{`, possibly with surrounding whitespace) closing off a
    // multi-line selector list whose fragments were accumulated via `pending` below (the
    // idiom `.a,\n.b\n{\n...`). Flush those fragments as the selector list for this rule
    // instead of falling through to the discard case at the bottom of the loop, which would
    // otherwise silently drop every accumulated fragment because a bare `{` never matches
    // `selectorLineMatch` above (it requires a non-`{`/`}`/`@` character before the brace).
    if (trimmed === '{') {
      for (const p of pending) {
        out.push({
          filePath,
          name: p.name,
          kind: 'selector',
          lineStart: p.line,
          lineEnd: p.line,
          body: p.body,
          docstring: '',
        })
      }
      pending = []
      continue
    }

    // Continuation candidate: a bare selector-fragment line with no brace, not an at-rule
    // header, and not a declaration (no `;`). Three shapes are accepted: a line ending in a
    // trailing comma (starts or continues a comma list, e.g. `.a,`); once a comma-list is
    // already underway (`pending.length > 0`), a bare trailing-fragment line with no comma at
    // all (e.g. the final `.b` in `.a,\n.b\n{`); or a single Allman-brace selector whose `{`
    // sits alone on the very next content line (e.g. `body\n{`) - this last shape has no
    // trailing comma and starts with an empty `pending`, so without the forward-scan it fails
    // both of the other two conditions and the selector is silently dropped. Either way the
    // fragment is accumulated until the line that actually opens the brace (matched above) is
    // reached, instead of being dropped.
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith('@') &&
      !trimmed.includes('{') &&
      !trimmed.includes('}') &&
      !trimmed.includes(';')
    ) {
      const endsWithComma = trimmed.endsWith(',')
      if (endsWithComma || pending.length > 0 || nextContentLineOpensBrace(lines, i)) {
        const name = endsWithComma ? trimmed.slice(0, -1).trim() : trimmed
        if (name) pending.push({ name, line: i + 1, body: trimmed })
        continue
      }
    }

    // Anything else (blank line, declaration, closing brace, ...) breaks the accumulation --
    // the pending fragments weren't actually part of a selector list after all.
    pending = []
  }

  return out
}

function extractDockerfileSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  // Dockerfile instructions may span multiple physical lines via a trailing backslash
  // continuation (e.g. `RUN apt-get update && \`), and every non-first physical line of that
  // logical instruction is shell text, not a new directive. Without tracking this, a
  // continuation line that happens to start with a shell token colliding with a Dockerfile
  // keyword under the case-insensitive match below (most commonly the `env VAR=val cmd` shell
  // idiom, but also run/copy/add/user/label/arg/from) is misread as a standalone directive.
  let continuing = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (continuing) {
      continuing = line.trimEnd().endsWith('\\')
      continue
    }

    const match =
      /^\s*(FROM|RUN|COPY|ADD|EXPOSE|ENV|WORKDIR|CMD|ENTRYPOINT|ARG|LABEL|VOLUME|USER|HEALTHCHECK|ONBUILD|SHELL|STOPSIGNAL|MAINTAINER)\s+(.+)/i.exec(
        line,
      )
    if (match !== null && match[1] !== undefined) {
      const cmd = match[1]
      const arg = (match[2] ?? '').substring(0, 40)
      const name = `${cmd} ${arg}`.trim()
      out.push({
        filePath,
        name,
        kind: 'directive',
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
      })
    }

    continuing = line.trimEnd().endsWith('\\')
  }

  return out
}

// --- Regex fallback ---------------------------------------------------------

// Top-level function/class patterns for the languages we lack a grammar for (and as a safety net when a native grammar fails to load mid-run).
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
 * unreadable files yield empty symbol/ref lists (never throws). Call-site refs
 * are extracted for the tree-sitter languages in {@link REF_LANGUAGES}; the
 * regex-fallback and structured-config languages yield no refs.
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
  // Strip UTF-8 BOM if present (U+FEFF); some editors save files with this prefix.
  // Both entry points (parseFile, indexFileSync) funnel through here, so this is the
  // single place BOM stripping needs to happen. Sha/hash computation elsewhere stays
  // on the raw original bytes — only this decoded copy is affected.
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  }

  if (isTreeSitterAvailable(language)) {
    try {
      const Ctor = loadParserCtor()
      const grammar = loadGrammar(language, filePath)
      if (Ctor !== null && grammar !== null) {
        const parser = new Ctor()
        parser.setLanguage(grammar)
        const tree = parser.parse(content)
        const root = tree.rootNode
        let symbols: SymbolEntry[]
        if (language === 'python') {
          symbols = extractPythonSymbols(root, filePath)
        } else if (language === 'go') {
          symbols = extractGoSymbols(root, filePath)
        } else if (language === 'rust') {
          symbols = extractRustSymbols(root, filePath)
        } else if (language === 'ruby') {
          symbols = extractRubySymbols(root, filePath)
        } else if (language === 'java') {
          symbols = extractJavaSymbols(root, filePath)
        } else if (language === 'cpp' || language === 'c') {
          symbols = extractCppSymbols(root, filePath)
        } else {
          symbols = extractTsJsSymbols(root, filePath)
        }
        const refs = REF_LANGUAGES.has(language) ? extractRefs(root, filePath, language) : []
        const parsed = { symbols, refs }
        return language === 'javascript' && isLwcFile(filePath, '.js')
          ? mergeParseResults(parsed, extractLwcJavaScript(content, filePath))
          : parsed
      }
    } catch {
      // Parser threw on this input — fall through to the regex pass below.
    }
  }

  // Regex-based extractors for languages without tree-sitter
  return extractNoTreeSitter(content, filePath, language)
}

/**
 * Symbol extraction for languages with no tree-sitter grammar: the regex and
 * structured-config adapters. Returns an empty list for `unknown`.
 */
/**
 * Map an adapter's parsed `.sections` (heading, level, line, endLine) into indexable
 * SymbolEntry rows. HTML and Liquid compute headings into `.sections` for the section-outline
 * consumer but historically never surfaced them as symbols, so they never entered the index
 * and were unreachable via `symbol`/`skeleton`/`outline` -- unlike markdown/proto/graphql/sql,
 * which push headings into both symbols and sections via makeSymbolEmitter.
 */
function sectionsToHeadingSymbols(
  sections: ReadonlyArray<{ heading: string; level: number; line: number; endLine: number }>,
  filePath: string,
): SymbolEntry[] {
  return sections.map((s) => ({
    filePath,
    name: s.heading,
    kind: 'heading',
    lineStart: s.line,
    lineEnd: s.endLine,
    body: '',
    docstring: '',
  }))
}

type SymbolExtractor = (content: string, filePath: string) => SymbolEntry[]

// One entry per non-tree-sitter Language. Adding a new adapter is one map entry rather than
// a new `if` branch; html/liquid keep their extra sectionsToHeadingSymbols composition inline.
const NO_TREE_SITTER_EXTRACTORS: Partial<Record<Language, SymbolExtractor>> = {
  markdown: extractMarkdownSymbols,
  json: extractJsonSymbols,
  yaml: extractYamlSymbols,
  toml: extractTomlSymbols,
  css: extractCssSymbols,
  dockerfile: extractDockerfileSymbols,
  csharp: (content, filePath) => extractCsharp(content, filePath).symbols,
  php: (content, filePath) => extractPhp(content, filePath).symbols,
  html: (content, filePath) => {
    const r = extractHtml(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  liquid: (content, filePath) => {
    const r = extractLiquid(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  kotlin: (content, filePath) => extractKotlin(content, filePath).symbols,
  graphql: (content, filePath) => extractGraphql(content, filePath).symbols,
  sql: extractSql,
  ini: extractIni,
  makefile: extractMakefile,
  proto: (content, filePath) => extractProto(content, filePath).symbols,
  powershell: (content, filePath) => extractPowershell(content, filePath).symbols,
  apex: (content, filePath) => extractApex(content, filePath).symbols,
  salesforce_metadata: (content, filePath) => extractSalesforceMetadata(content, filePath).symbols,
  env_file: extractEnv,
}

function extractNoTreeSitter(
  content: string,
  filePath: string,
  language: Language,
): ParseContentResult {
  if (language === 'salesforce_metadata') return extractSalesforceMetadata(content, filePath)
  if (language === 'salesforce_markup') return extractSalesforceMarkup(content, filePath)
  if (language === 'html' && isLwcFile(filePath, '.html')) return extractLwcTemplate(content, filePath)

  const parsed: ParseContentResult = {
    symbols: extractSymbolsNoTreeSitter(content, filePath, language),
    refs: [],
  }
  return language === 'javascript' && isLwcFile(filePath, '.js')
    ? mergeParseResults(parsed, extractLwcJavaScript(content, filePath))
    : parsed
}

function extractSymbolsNoTreeSitter(
  content: string,
  filePath: string,
  language: Language,
): SymbolEntry[] {
  if (language === 'unknown') return []
  return (NO_TREE_SITTER_EXTRACTORS[language] ?? extractWithRegex)(content, filePath)
}

/**
 * Write a parsed result's rows into the index DB, replacing any prior rows for
 * the file in a single transaction (DELETE + INSERT, matching the Python
 * bulk-replace strategy) so a re-index never leaves stale symbols behind.
 *
 * Called by {@link indexFileSync}, the worker drain loop's synchronous entry
 * point.
 */
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
 * True when `filePath` is excluded from the syntactic parse entirely by `indexing.skip_dirs`
 * or `indexing.large_file_skip_kb`. Must be evaluated UNCONDITIONALLY (independent of any
 * sha/parseUnchanged gate) because a file that becomes skip-eligible via a config change alone
 * must still have its stale rows purged. A stat failure is treated as "not skip-eligible".
 */
export function isParseSkipEligible(filePath: string, cfg: IndexingConfig): boolean {
  if (isUnderSkipDir(filePath, cfg.skip_dirs)) return true
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > cfg.large_file_skip_kb * 1024) return true
  } catch {
    // let the caller's own read/stat attempt handle/report the failure
  }
  return false
}

function writeParseResult(
  filePath: string,
  content: Buffer | null,
  result: ParseResult,
  dbPath: string,
): void {
  const db = getDb(dbPath)

  // Hash the SAME raw bytes that were actually parsed, not a fresh disk re-read: if the file
  // changes between the parse read and this write, a re-read here would record a SHA that does
  // not match the symbols/refs actually written below, and the worker's SHA-gated incremental
  // drain would skip reindexing a file whose stored SHA happens to match a later version,
  // leaving it permanently stuck with stale symbols. Takes the raw Buffer (not the utf8-decoded
  // string used for parsing) so this SHA is computed over the same bytes worker.ts's gate
  // hashes via fingerprintFile() -- a lossy utf8 decode/re-encode round-trip on invalid-UTF-8
  // content would otherwise produce a different digest than hashing the raw bytes directly,
  // permanently defeating the gate for any such file. content is null only when the file could
  // not be read at all, in which case there is nothing to fingerprint from memory.
  const sha = content === null ? safeSha(filePath) : fingerprintContent(content)
  const mtime = safeMtime(filePath)
  const now = Date.now() / 1000

  const writeAll = db.transaction(() => {
    deleteFileRows(db, filePath)

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
export function indexFileSync(filePath: string, dbPath: string = globalDbPath()): void {
  const ixCfg = loadConfig().indexing
  if (ixCfg !== undefined && isParseSkipEligible(filePath, ixCfg)) {
    // Purge stale rows AND the files row (sha) so the file settles into a stable
    // not-indexed state instead of being re-selected as "changed" on every drain;
    // also drop any embedding rows it held before becoming skip-eligible
    // (indexFileSync is called directly from read_commands' --force-refresh path).
    const db = getDb(dbPath)
    deleteFileRows(db, filePath)
    deleteFileEmbeddings(db, filePath)
    return
  }
  const language = detectLanguage(filePath)
  let raw: Buffer
  try {
    raw = fs.readFileSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const content = raw.toString('utf8')
  const { symbols, refs } = parseContent(content, filePath, language)
  writeParseResult(filePath, raw, { symbols, refs, language, duration: 0 }, dbPath)
}

/**
 * Best-effort semantic-embeddings indexing for one file, run alongside (not instead of) the
 * syntactic parse in {@link indexFileSync}. Gated on `indexing.embeddings_enabled` (default
 * true); a no-op when disabled.
 *
 * Reads the file itself, independently of indexFileSync's own read, so callers never need to
 * thread file content through just for this optional step, then delegates to embeddings.ts's
 * `indexFile` (imported here as embedIndexFile), which chunks the content and upserts it into
 * `chunks`/`chunk_vectors`.
 *
 * Never throws: an unreadable file, a missing optional dependency (@xenova/transformers or
 * sqlite-vec — embeddings.ts's own isAvailable()/chunkVectorsTableExists() checks already
 * degrade gracefully for those), or a genuine embedding-pipeline error must never fail the
 * overall index — the syntactic symbols/refs indexFileSync already wrote stand on their own
 * regardless of what happens here.
 *
 * Callers that can afford to wait for embeddings (cmdIndex, a one-shot foreground command)
 * should await this. Callers on a latency-sensitive synchronous path (the worker's incremental
 * drain, which must return instantly per indexFileSync's own contract) should fire it and
 * forget instead of awaiting it.
 */
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
function buildEmbeddingBoundaries(filePath: string, content: string, dbPath: string): ChunkBoundary[] {
  if (detectLanguage(filePath) === 'markdown') {
    // Extract all headings (no cap) for embedding boundaries so sections remain heading-aligned
    // even for docs with >40 headings (large API references, changelogs, multi-section docs).
    const headings = extractMarkdownHeadings(content, Infinity)
    return headings.map((h, i) => ({
      start: h.lineNumber,
      // Runs to just before the next heading, or to end-of-file for the last one.
      // chunkFile clips end values to the file's actual line count, so this sentinel
      // is safe without re-deriving the file's line count here.
      end: headings[i + 1] !== undefined ? headings[i + 1]!.lineNumber - 1 : Number.MAX_SAFE_INTEGER,
      kind: 'section' as const,
    }))
  }

  const symbols = querySymbols({ filePath, limit: 10000 }, dbPath)
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
 * a file because the optional embedding deps were absent (the @xenova/transformers model or the
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
 */
export function isEmbedFresh(
  storedEmbedSha: string | undefined,
  sha: string,
  embeddingsEnabled: boolean,
  depsAvailable: boolean,
): boolean {
  if (storedEmbedSha === undefined) return false
  if (!embeddingsEnabled) return storedEmbedSha === disabledEmbedSha(sha)
  if (storedEmbedSha === sha) return true
  if (!depsAvailable && storedEmbedSha === unavailableEmbedSha(sha)) return true
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
  filePath: string,
  dbPath: string = globalDbPath(),
  sha?: string,
  onError?: (err: unknown) => void,
): Promise<void> {
  if (!loadConfig().indexing.embeddings_enabled) {
    // Stamp a disabled-marker embed_sha even though no embedding actually ran, so
    // makeIndexer's embedUnchanged gate (worker.ts) can hold for this content the next time
    // it's touched while STILL disabled -- otherwise every re-touch of an unchanged file
    // re-enters indexFileEmbeddings just to hit this same early-return again, on every drain,
    // for as long as embeddings stay disabled. Deliberately NOT the real sha (see
    // disabledEmbedSha's doc comment): re-enabling embeddings later must not be mistaken for
    // "already embedded, unchanged".
    stampEmbedSha(getDb(dbPath), filePath, sha, disabledEmbedSha)
    return
  }
  if (filePath.toLowerCase().endsWith('.profile-meta.xml')) {
    // Profiles are frequently multi-megabyte, highly repetitive permission dumps. Embedding them creates thousands of low-signal vectors; exact symbol/read/grep access remains.
    const db = getDb(dbPath)
    deleteFileEmbeddings(db, filePath)
    // Deliberately-never-embed is a terminal state: stamp the real sha so the freshness gate
    // (worker.ts/cli.ts) treats this file as done and does not re-read its multi-megabyte
    // content into indexFileEmbeddings on every worker drain / index run.
    stampEmbedSha(db, filePath, sha, (s) => s)
    return
  }
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
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
    // When the optional embedding deps were absent, embedIndexFile reports 'unavailable' and no
    // vectors were written -- stamp an unavailable-marker embed_sha (not the bare sha) so this
    // file is re-embedded once the deps are installed, rather than masquerading as fresh forever.
    stampEmbedSha(db, filePath, sha, (s) => (outcome === 'unavailable' ? unavailableEmbedSha(s) : s))
  } catch (err) {
    // Best-effort: never fail the overall index over an embeddings-only error. embed_sha is
    // deliberately left unstamped here (see doc comment above). `onError`, when provided, lets a
    // caller (worker.ts's embedFileSerialized) record this failure somewhere discoverable --
    // this function itself never throws, matching its documented best-effort contract for
    // callers like cli.ts's foreground bulk-index loop that await it directly with no try/catch.
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
  // Optimistic-concurrency guard: also require files.sha to still equal the sha this embed run
  // started from. inFlightEmbeddings (worker.ts) only serializes concurrent embed calls WITHIN a
  // single process -- it cannot see a second process (e.g. a slow foreground `token-goat index`
  // racing the background daemon) embedding the same file at the same time. Without this WHERE
  // clause, a slow writer that started against an older `sha` can still commit its stamp AFTER a
  // faster writer already reindexed and re-embedded a newer version, overwriting the fresher
  // embed_sha with a stale one and leaving embeddings silently out of sync with no way to detect
  // it. Requiring sha = ? makes a stale writer's stamp a no-op instead: the row's `sha` will have
  // already moved on to the newer value by the time the stale writer's UPDATE runs.
  db.prepare(`UPDATE files SET embed_sha = ? WHERE ${pathEqClause('path')} AND sha = ?`).run(
    makeValue(sha),
    foldPath(filePath),
    sha,
  )
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
