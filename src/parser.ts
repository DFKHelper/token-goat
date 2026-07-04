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
import { indexFile as embedIndexFile } from './embeddings.js'
import { fingerprintContent, fingerprintFile } from './fingerprint.js'
import { pathEqClause } from './sql_path.js'
import { eachUnfencedLine } from './markdown_lines.js'
import { detectLanguage } from './parser_types.js'
import type { Language, RefEntry, SymbolEntry } from './parser_types.js'
import { extractCsharp } from './languages/csharp.js'
import { extractPhp } from './languages/php.js'
import { extractHtml } from './languages/html.js'
import { extractLiquid } from './languages/liquid.js'
import { extractKotlin } from './languages/kotlin.js'
import { extractGraphql } from './languages/graphql_idx.js'
import { extractSql } from './languages/sql_idx.js'
import { extractIni, extractEnv } from './languages/ini_idx.js'
import { extractMakefile } from './languages/makefile_idx.js'
import { extractProto } from './languages/proto_idx.js'

import { extractPowershell } from './languages/powershell_idx.js'
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

  _grammarCache.set(lang, grammar)
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
 * Walk a tree-sitter tree collecting call-site references.
 *
 * Maintains a stack of enclosing scope names (functions / methods / classes) so
 * each reference records its innermost enclosing symbol in `context` — the data
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

  const visit = (node: TsNode): void => {
    const enclosing = scopeName(node, language)
    if (enclosing !== null && enclosing !== '') stack.push(enclosing)

    if (callTypes.has(node.type)) {
      const callee = calleeName(node, language)
      if (callee !== null && callee.length > 1 && !noise.has(callee)) {
        const line = node.startPosition.row + 1
        const key = `${callee}\0${line}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            filePath,
            name: callee,
            line,
            col: node.startPosition.column,
            context: stack.length > 0 ? (stack[stack.length - 1] ?? '') : '',
          })
        }
      }
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
    const atxMatch = /^(#{1,6})\s+(.+?)(?:\s*#+\s*)?$/.exec(line)
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
          while (k < content.length && /\s/.test(content[k] ?? '')) k++
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
              let valueLine = line + gapNewlines
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

function extractYamlSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

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
    }
  }

  return out
}

function extractTomlSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // `\[?` matches the optional second bracket of a TOML array-of-tables header (`[[bin]]`) so the name captures as `bin`, not `[bin`.
    const sectionMatch = /^\s*\[\[?\s*([^\]]+)\s*\]/.exec(line)
    if (sectionMatch !== null && sectionMatch[1] !== undefined) {
      out.push({
        filePath,
        name: sectionMatch[1].trim(),
        kind: 'section',
        lineStart: i + 1,
        lineEnd: i + 1,
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
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
      })
    }
  }

  return out
}

function extractCssSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    const selectorMatch = /^([.#][\w-]+)[,\s{]/.exec(line)
    if (selectorMatch !== null && selectorMatch[1] !== undefined) {
      out.push({
        filePath,
        name: selectorMatch[1],
        kind: 'selector',
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
      })
    }
  }

  return out
}

function extractDockerfileSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    const match = /^\s*(FROM|RUN|COPY|ADD|EXPOSE|ENV|WORKDIR|CMD|ENTRYPOINT)\s+(.+)/i.exec(
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

  // Strip UTF-8 BOM if present (U+FEFF); some editors save files with this prefix
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  }

  const { symbols, refs } = parseContent(content, filePath, language)
  return { symbols, refs, language, duration: Date.now() - start }
}

/** Symbols + refs extracted from one file's content. */
interface ParseContentResult {
  readonly symbols: SymbolEntry[]
  readonly refs: RefEntry[]
}

/** Shared sync core: pick an extractor for `language` and run it on `content`. */
function parseContent(content: string, filePath: string, language: Language): ParseContentResult {
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
        return { symbols, refs }
      }
    } catch {
      // Parser threw on this input — fall through to the regex pass below.
    }
  }

  // Regex-based extractors for languages without tree-sitter
  return { symbols: extractSymbolsNoTreeSitter(content, filePath, language), refs: [] }
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
  if (language === 'markdown') return extractMarkdownSymbols(content, filePath)
  if (language === 'json') return extractJsonSymbols(content, filePath)
  if (language === 'yaml') return extractYamlSymbols(content, filePath)
  if (language === 'toml') return extractTomlSymbols(content, filePath)
  if (language === 'css') return extractCssSymbols(content, filePath)
  if (language === 'dockerfile') return extractDockerfileSymbols(content, filePath)

  // New language adapters from ./languages/
  if (language === 'csharp') return extractCsharp(content, filePath).symbols
  if (language === 'php') return extractPhp(content, filePath).symbols
  if (language === 'html') return extractHtml(content, filePath).symbols
  if (language === 'liquid') return extractLiquid(content, filePath).symbols
  if (language === 'kotlin') return extractKotlin(content, filePath).symbols
  if (language === 'graphql') return extractGraphql(content, filePath).symbols
  if (language === 'sql') return extractSql(content, filePath)
  if (language === 'ini') return extractIni(content, filePath)
  if (language === 'makefile') return extractMakefile(content, filePath)
  if (language === 'proto') return extractProto(content, filePath).symbols
  if (language === 'powershell') return extractPowershell(content, filePath).symbols
  if (language === 'env_file') return extractEnv(content, filePath)

  if (language === 'unknown') return []
  return extractWithRegex(content, filePath)
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
  db.prepare(`DELETE FROM symbols WHERE ${pathEqClause('file_path')}`).run(filePath)
  db.prepare(`DELETE FROM refs WHERE ${pathEqClause('file_path')}`).run(filePath)
  db.prepare(`DELETE FROM files WHERE ${pathEqClause('path')}`).run(filePath)
}

function writeParseResult(
  filePath: string,
  content: string | null,
  result: ParseResult,
  dbPath: string,
): void {
  const db = getDb(dbPath)

  // Hash the SAME content buffer that was actually parsed, not a fresh disk re-read: if the
  // file changes between the parse read and this write, a re-read here would record a SHA
  // that does not match the symbols/refs actually written below, and the worker's SHA-gated
  // incremental drain would skip reindexing a file whose stored SHA happens to match a later
  // version, leaving it permanently stuck with stale symbols. content is null only when the
  // file could not be read at all, in which case there is nothing to fingerprint from memory.
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
  const language = detectLanguage(filePath)
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const { symbols, refs } = parseContent(content, filePath, language)
  writeParseResult(filePath, content, { symbols, refs, language, duration: 0 }, dbPath)
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
export async function indexFileEmbeddings(filePath: string, dbPath: string = globalDbPath()): Promise<void> {
  if (!loadConfig().indexing.embeddings_enabled) return
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return
  }
  try {
    const db = getDb(dbPath)
    await embedIndexFile(db, filePath, content)
  } catch {
    // Best-effort: never fail the overall index over an embeddings-only error.
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
