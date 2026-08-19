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
import { isEmbeddableDocument, extractEmbeddableDocumentText } from './doc_embed_extract.js'
import { fingerprintContent } from './fingerprint.js'
import { pathEqClause } from './sql_path.js'
import { eachUnfencedLine } from './markdown_lines.js'
import { detectLanguage } from './parser_types.js'
import type { Language, RefEntry, SymbolEntry } from './parser_types.js'
import { precedingDocComment } from './doc_comment.js'
import type { DocCommentStyle } from './doc_comment.js'
import { querySymbols } from './index_reader.js'
import { extractMarkdownHeadings } from './hints/markdown_hints.js'
import { extractCsharp } from './languages/csharp.js'
import { extractPhp } from './languages/php.js'
import { extractHtml } from './languages/html.js'
import { extractLiquid } from './languages/liquid.js'
import { extractKotlin } from './languages/kotlin.js'
import { extractSwift } from './languages/swift.js'
import { extractScala } from './languages/scala.js'
import { extractLua } from './languages/lua.js'
import { extractElixir } from './languages/elixir.js'
import { extractDart } from './languages/dart.js'
import { extractZig } from './languages/zig.js'
import { extractR } from './languages/r.js'
import { extractGraphql } from './languages/graphql_idx.js'
import { extractSql } from './languages/sql_idx.js'
import { stripCstyleComments, stripStringLiterals } from './languages/common.js'
import { extractIni, extractEnv } from './languages/ini_idx.js'
import { extractBash } from './languages/bash_idx.js'
import { extractMakefile } from './languages/makefile_idx.js'
import { extractProto } from './languages/proto_idx.js'
import { extractTerraform } from './languages/terraform_idx.js'

import { extractPowershell } from './languages/powershell_idx.js'
import { extractApex } from './languages/apex.js'
import { extractSalesforceMetadata } from './languages/salesforce_metadata.js'
import {
  extractLwcJavaScript,
  extractLwcTemplate,
  extractSalesforceMarkup,
} from './languages/salesforce_frontend.js'
import { extractVue, extractSvelte, extractAstro } from './languages/sfc_idx.js'
import { ipynbToVirtualSource } from './languages/ipynb_idx.js'
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
  readonly previousNamedSibling: TsNode | null
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

/**
 * Return the offset one past the end of the JSON value starting at `start`.
 *
 * Handles the three value shapes separately: a quoted string (walk to the
 * matching close quote, honoring backslash escapes), a container (`{`/`[` —
 * walk to the matching close brace/bracket, skipping over string contents so a
 * brace inside a string cannot unbalance the count), and a primitive (number /
 * `true` / `false` / `null` — ends at the first delimiter). Each walk is linear
 * in the length of the value it scans, so scanning every top-level value of a
 * document costs O(document), not O(keys × document).
 *
 * An unterminated value (malformed/truncated JSON) yields `content.length`
 * rather than throwing; the caller already treats extraction as best-effort.
 */
function scanJsonValueEnd(content: string, start: number): number {
  const first = content[start]
  if (first === undefined) return content.length

  if (first === '"') {
    let escaping = false
    for (let j = start + 1; j < content.length; j++) {
      const c = content[j]
      if (escaping) {
        escaping = false
        continue
      }
      if (c === '\\') {
        escaping = true
        continue
      }
      if (c === '"') return j + 1
    }
    return content.length
  }

  if (first === '{' || first === '[') {
    // Track the open delimiters themselves, not just a depth counter: matching `}` against `[`
    // lets malformed input (`{"a":[1}`) close a container it never opened, which would hand the
    // caller a body running past the value's real end. On a mismatch, stop at the offending
    // character rather than consuming forward to EOF.
    const stack: string[] = []
    let inStr = false
    let escaping = false
    for (let j = start; j < content.length; j++) {
      const c = content[j]
      if (inStr) {
        if (escaping) {
          escaping = false
          continue
        }
        if (c === '\\') {
          escaping = true
          continue
        }
        if (c === '"') inStr = false
        continue
      }
      if (c === '"') {
        inStr = true
        continue
      }
      if (c === '{' || c === '[') stack.push(c)
      else if (c === '}' || c === ']') {
        const open = stack.pop()
        if (open !== (c === '}' ? '{' : '[')) return j
        if (stack.length === 0) return j + 1
      }
    }
    return content.length
  }

  for (let j = start; j < content.length; j++) {
    const c = content[j]
    if (c === ',' || c === '}' || c === ']' || c === '\n' || c === '\r') return j
  }
  return content.length
}

/** Count `\n` occurrences in `s` (used to derive a span's end line from its start line). */
function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
  return n
}

// `tree-sitter-typescript` ships two distinct grammars from one package: `typescript` (plain .ts/.mts/.cts — rejects JSX syntax) and `tsx` (a superset that also parses JSX). Both share the `Language` value 'typescript', so the caller's file path — not the Language — is what distinguishes them. Parsing a .tsx file with the `typescript` grammar still "succeeds" (tree-sitter's error recovery doesn't throw) but produces ERROR nodes around JSX, silently dropping or mis-scoping symbols/refs.
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
  // Interface members (`method_signature`, `property_signature`) and an abstract class member
  // (`abstract_method_signature`) are distinct tree-sitter node types from `method_definition` (a
  // concrete method with a body) -- without their own entries here, every interface method,
  // interface property, and abstract method signature was invisible to the index, even though
  // `visit` already descends into `interface_body`/class bodies to find them.
  ['method_signature', 'method'],
  ['property_signature', 'var'],
  ['abstract_method_signature', 'method'],
  // `namespace Foo { ... }` (and the legacy `module Foo { ... }` synonym) parses as
  // `internal_module`; `declare module "some-string" { ... }` (an ambient module declaration,
  // common in .d.ts files) parses as `module` -- a distinct node type from either. Neither had a
  // kind-map entry, so the namespace/module declaration itself was silently invisible to
  // `symbol`/`outline`/`skeleton`/`read`, even though everything nested inside it still indexed
  // fine (the walk recurses into every node's children regardless of the parent's kind-map
  // membership) -- the same container-drop shape already fixed for C++ `namespace_definition`
  // and Rust `mod_item`. Both node types expose their name on the standard `name` field
  // (an identifier, nested_identifier, or string), so `nodeName` resolves it without special-casing.
  ['internal_module', 'namespace'],
  ['module', 'namespace'],
])

// TS/JS class-member decorators (`@Override`, `@Input()`, ...) are wrapped as a `decorator` field
// on `public_field_definition`/`field_definition` itself, but tree-sitter-typescript parses a
// decorator on a `method_definition` as a standalone `decorator` sibling immediately preceding it
// inside `class_body`, not as a field of the method node -- the same sibling-not-wrapper gap fixed
// for Rust `attribute_item`s and Python's `decorated_definition`. Left unhandled, a decorated
// method's tree-sitter range starts at its modifiers/name, silently dropping the `@decorator`
// line(s) above it from `read`/`skeleton` output. Walk backward through contiguous leading
// `decorator` siblings (stacked decorators are legal, e.g. `@Log() @Cache method() {}`) so the
// emitted range includes them.
function leadingTsDecorators(node: TsNode): TsNode[] {
  const decorators: TsNode[] = []
  let cur = node.previousNamedSibling
  while (cur !== null && cur.type === 'decorator') {
    decorators.unshift(cur)
    cur = cur.previousNamedSibling
  }
  return decorators
}

function nodeName(node: TsNode): string | null {
  const named = node.childForFieldName('name')
  if (named !== null) return named.text
  return null
}

// `lines`/`style` are optional so a future extractor with no doc-comment support wired yet can
// keep calling makeSymbol exactly as before and get `docstring: ''`, matching every extractor's
// behavior prior to this change.
function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  node: TsNode,
  lines?: readonly string[],
  style?: DocCommentStyle,
): SymbolEntry {
  const lineStart = node.startPosition.row + 1
  return {
    filePath,
    name,
    kind,
    lineStart,
    lineEnd: node.endPosition.row + 1,
    body: node.text,
    docstring:
      lines !== undefined && style !== undefined ? precedingDocComment(lines, lineStart, style) : '',
      parent: '',
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

/** Node types whose bodies introduce a new function scope — declarations
 * nested inside these are locals, excluded from the document-symbol index. */
const TSJS_FN_SCOPE_TYPES: ReadonlySet<string> = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function', 'generator_function_declaration',
])

/**
 * Walk a TS/JS tree collecting symbols. Descends into export statements (so
 * `export function f` is captured) and class bodies (for methods), and unwraps
 * `const`/`let`/`var` declarators whose initializer is a function/arrow.
 */
function extractTsJsSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = TSJS_KIND_BY_TYPE.get(node.type)
    // A local `function` declaration nested inside a function body is a local, exactly like a
    // local const/let/var below -- exclude it from the top-level index the same way.
    if (kind !== undefined && !(insideFunction && node.type === 'function_declaration')) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        const decorators = leadingTsDecorators(node)
        if (decorators.length === 0) {
          out.push(makeSymbol(filePath, name, kind, node, lines, 'c'))
        } else {
          // The doc comment (if any) sits above the leading decorator, not above the decorated
          // node itself -- look up from the same widened lineStart used for the range below.
          const lineStart = decorators[0]!.startPosition.row + 1
          out.push({
            filePath,
            name,
            kind,
            lineStart,
            lineEnd: node.endPosition.row + 1,
            body: [...decorators, node].map((n) => n.text).join('\n'),
            docstring: precedingDocComment(lines, lineStart, 'c'),
            parent: '',
          })
        }
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
          out.push(makeSymbol(filePath, name.text, isFn ? 'function' : 'variable', child, lines, 'c'))
        } else {
          // Destructuring pattern: emit one variable symbol per bound identifier (not a single junk symbol named after the whole `{ ... }` / `[ ... ]`).
          for (const bound of collectPatternBindings(name)) {
            out.push(makeSymbol(filePath, bound, 'variable', child, lines, 'c'))
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
        out.push(makeSymbol(filePath, fieldName.text, 'method', node, lines, 'c'))
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
  // PEP 695 (Python 3.12) `type X = ...` / `type X[T] = ...` statement. Its node carries no
  // `name` field (only `left`/`right`, both wrapping a `type` node — see
  // pythonTypeAliasName below), so nodeName() alone can never resolve it; without this entry
  // every PEP 695 type alias in a 3.12+ codebase was silently invisible to symbol/read/outline.
  ['type_alias_statement', 'type'],
])

// `type_alias_statement`'s `left` field is a `type` node wrapping either a bare `identifier`
// (`type IntList = list[int]`) or a `generic_type` whose own first named child is the
// identifier (`type ListOrSet[T] = list[T] | set[T]`) -- never the field name lookup nodeName()
// uses everywhere else, so this walks the `left` subtree for the first identifier instead.
function pythonTypeAliasName(node: TsNode): string | null {
  const left = node.childForFieldName('left')
  if (left === null) return null
  let cur: TsNode | null = left
  while (cur !== null) {
    if (cur.type === 'identifier') return cur.text
    cur = cur.namedChildren[0] ?? null
  }
  return null
}

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
      const name = node.type === 'type_alias_statement' ? pythonTypeAliasName(node) : nodeName(node)
      if (name !== null && name !== '') {
        const kind = node.type === 'function_definition' && insideClass ? 'method' : baseKind
        // A decorated def's tree-sitter node starts at `def`/`class`, not its `@decorator` line(s) above — decorated_definition has no PY_KIND_BY_TYPE entry, so it's never the node a symbol is built from. Widen to the enclosing decorated_definition's own range (decorators through end of the def) when present, so `read`/`skeleton` include the decorator lines; name/kind/docstring still come from the inner def node so method-vs-function and class-scope detection are unaffected.
        const rangeNode = node.parent?.type === 'decorated_definition' ? node.parent : node
        // pythonDocstring() reads a `body` field that only function_definition/class_definition
        // carry; type_alias_statement has none, so calling it unconditionally would be a
        // childForFieldName() no-op returning '' anyway, but skip explicitly for clarity.
        const docstring = node.type === 'type_alias_statement' ? '' : pythonDocstring(node)
        out.push({
          ...makeSymbol(filePath, name, kind, rangeNode),
          docstring,
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
  // An interface's declared method set (`type Reader interface { Read(...) (int, error) }`) is
  // parsed as `method_elem` -- a distinct node type from `method_declaration` (a concrete method
  // with a receiver and body). `method_elem` exposes its own `name` field (a `field_identifier`),
  // exactly like `method_declaration` does, but had no map entry: every method signature declared
  // inside a Go interface -- the entire point of the interface -- was silently invisible to
  // `symbol`/`outline`/`skeleton`/`read`, even though the interface type itself indexed fine via
  // `type_spec` below.
  ['method_elem', 'method'],
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
  // A local interface type (`type Reader interface { Read(...) }` declared inside a func body) is
  // itself excluded via `type_spec` above; its nested `method_elem` signatures must be excluded
  // the same way, or a function-local interface's methods would leak into the index even though
  // the interface type declaring them does not.
  'method_elem',
])

function extractGoSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = GO_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined && !(insideFunction && GO_LOCAL_KINDS.has(node.type))) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node, lines, 'c'))
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
  // `mod foo { ... }` / `mod foo;` — Rust modules are ubiquitous (submodule trees, `#[cfg(test)]
  // mod tests`) and parse as `mod_item`, which was absent here, so every module declaration was
  // silently dropped from the index. Reuses the 'module' kind already used by the Ruby extractor.
  // Not added to RUST_LOCAL_KINDS below: like a nested struct/fn, a mod declared inside a function
  // body stays indexed (only value bindings — `const` — are treated as function-local noise).
  ['mod_item', 'module'],
  // Unbodied `fn` signatures — trait required methods (`fn find(&self) -> u32;` inside a `trait`
  // block) and `extern "C" { ... }` foreign-function declarations — parse as `function_signature_item`,
  // NOT `function_item` (which requires a body). Absent here, so every trait interface method without
  // a default body and every FFI declaration was silently dropped from the index: `token-goat symbol`
  // / `read` returned nothing for them even though the trait/extern block itself indexed. Mapped to
  // 'function', matching bodied `function_item`, so a trait's methods index whether or not they carry
  // a default body. Not a value binding, so it never appears as a function-local — no RUST_LOCAL_KINDS
  // entry needed.
  ['function_signature_item', 'function'],
  // `extern "C" { ... }` / `extern "system" { ... }` foreign-module blocks -- unlike `trait_item`
  // (which IS indexed, so a trait method rendered standalone still has its enclosing `trait Foo`
  // symbol nearby for context), `foreign_mod_item` was entirely absent here, so an FFI declaration's
  // `function_signature_item` was the ONLY trace of the block in the index -- its ABI string
  // (`"C"` vs `"system"`, real calling-convention information) and any `#[link(name = "...")]`
  // attribute naming the linked library were both invisible with no other symbol to find them on.
  // Kept as its own entry (not folded into the child fn's body) to match how every other container
  // in this extractor works: the parent supplies context, the child stays standalone.
  ['foreign_mod_item', 'extern'],
  // `macro_rules! foo { ... }` declarative macros parse as `macro_definition`, which was absent
  // here, so every `macro_rules!` definition was silently dropped from the index. Macros are
  // uniquely painful to lose: an invocation site (`foo!(...)`) carries no path back to the
  // definition, so without a name index there is no cheap way to jump from a call to the
  // `macro_rules!` block. The name lives on the standard `name` field (an `identifier`), so
  // `nodeName` resolves it like any other item. Like `mod`/`fn`/`trait` — a definition, not a
  // value binding — so it is NOT added to RUST_LOCAL_KINDS: a macro nested in a function stays
  // indexed, matching how nested fns/structs are kept and only `const`/`static` value bindings
  // are treated as function-local noise.
  ['macro_definition', 'macro'],
  // `static FOO: T = ...;` / `pub static mut COUNTER: T = ...;` bindings parse as `static_item`,
  // which was absent here, so every `static` was silently dropped from the index — including the
  // ubiquitous top-level `static` tables and `static mut` globals real Rust code carries. Like
  // `const_item`, a `static` is a value binding, so it is ALSO added to RUST_LOCAL_KINDS below: a
  // `static` declared inside a function body is function-local noise (it has `'static` lifetime but
  // function scope) and must not pollute the global symbol index, matching how function-local
  // `const` is excluded. Its name lives on the standard `name` field, so `nodeName` resolves it.
  ['static_item', 'static'],
  // `union Foo { ... }` (C-style untagged unions, mostly FFI/unsafe code) parse as `union_item`,
  // which was absent here, so every union was silently dropped from the index. A union is a type
  // definition like `struct`/`enum` — NOT a value binding — so it stays indexed even when nested,
  // and gets no RUST_LOCAL_KINDS entry (mirroring how nested structs/enums stay indexed). Its name
  // lives on the standard `name` field.
  ['union_item', 'union'],
  // `type Item;` (unbodied) / `type Item = Foo;` (with a default) declared inside a `trait { ... }`
  // block — an associated type, the mechanism behind `Iterator::Item`, `Deref::Target`, and every
  // other trait with a type member — parses as its OWN node type, `associated_type`, which is
  // distinct from the free-standing `type_item` already mapped above (`type Alias = Foo;` at module
  // scope). `associated_type` was absent here, so every trait associated-type declaration was
  // silently dropped from the index, same failure shape as the `function_signature_item` gap fixed
  // above for unbodied trait methods. Its name lives on the standard `name` field, so `nodeName`
  // resolves it. Mapped to 'type', matching free-standing `type_item`, so both forms of "this is a
  // type declaration" land under one kind. Not a value binding, so no RUST_LOCAL_KINDS entry —
  // though in practice `associated_type` only ever appears inside a `trait`/`impl` body, never a fn.
  ['associated_type', 'type'],
])

// Rust scope nodes whose bodies hold function-local declarations. A `const` declared inside one of these (or any block nested in it) is a local and must not pollute the global symbol index. An `impl` block is deliberately NOT here: associated consts inside `impl` are reachable as `Type::CONST`, so they stay indexed.
const RUST_FN_SCOPE_TYPES: ReadonlySet<string> = new Set(['function_item', 'closure_expression'])

// Rust declaration kinds that are package-level symbols at top level but locals inside a function body; gated on scope. Only value bindings (`const`, `static`) are excluded - nested structs, enums, unions, functions, traits, impls, and types stay indexed, mirroring how the TS/JS extractor keeps nested classes and functions while dropping local `const`/`let`/`var`.
const RUST_LOCAL_KINDS: ReadonlySet<string> = new Set(['const_item', 'static_item'])

// Rust `#[...]` attributes (`#[derive(Debug)]`, `#[test]`, `#[async_trait]`, ...) parse as
// standalone `attribute_item` siblings immediately preceding the item they annotate, not as a
// wrapping parent node the way Python's `decorated_definition` wraps a decorated def/class. Left
// unhandled, an item's own tree-sitter range starts at its keyword (`fn`/`struct`/`enum`/...),
// silently dropping every attribute line above it from `read`/`skeleton` output and from
// `lineStart`. Walk backward through contiguous leading `attribute_item` siblings (there can be
// more than one stacked, e.g. `#[derive(Debug)]` then `#[allow(dead_code)]`) so the emitted range
// includes them, mirroring the Python decorator-folding fix for the same underlying gap.
function leadingRustAttributes(node: TsNode): TsNode[] {
  const attrs: TsNode[] = []
  let cur = node.previousNamedSibling
  while (cur !== null && cur.type === 'attribute_item') {
    attrs.unshift(cur)
    cur = cur.previousNamedSibling
  }
  return attrs
}

function extractRustSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = RUST_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined && !(insideFunction && RUST_LOCAL_KINDS.has(node.type))) {
      // An `impl` block has no `name` field; the implemented type lives in a `type` field (e.g. `impl Widget` or `impl Trait for Widget`), so resolve it there. A `foreign_mod_item` (`extern "C" { ... }`) has no name field either -- there is no type/trait to name it after, so its own `extern_modifier` child's text ("extern \"C\"") stands in as the symbol name, giving the ABI string a place to be visible. All other Rust items expose their name on the `name` field.
      const name =
        node.type === 'impl_item'
          ? (node.childForFieldName('type')?.text ?? null)
          : node.type === 'foreign_mod_item'
            ? (node.namedChildren.find((c) => c.type === 'extern_modifier')?.text ?? 'extern')
            : nodeName(node)
      if (name !== null && name !== '') {
        const attrs = leadingRustAttributes(node)
        if (attrs.length === 0) {
          out.push(makeSymbol(filePath, name, kind, node, lines, 'c'))
        } else {
          // The doc comment (if any) sits above the leading attribute, not above the annotated
          // item itself -- look up from the same widened lineStart used for the range below.
          const lineStart = attrs[0]!.startPosition.row + 1
          out.push({
            filePath,
            name,
            kind,
            lineStart,
            lineEnd: node.endPosition.row + 1,
            body: [...attrs, node].map((n) => n.text).join('\n'),
            docstring: precedingDocComment(lines, lineStart, 'c'),
            parent: '',
          })
        }
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

// Shared walk for languages whose symbol extraction needs no function-local-scope tracking (unlike Go/Rust, which thread `insideFunction` to exclude locals). `nameFor` defaults to the common `name`-field lookup; callers with an irregular name location (e.g. C/C++ function declarators) override it. `style` is threaded through to `makeSymbol` rather than hardcoded here because callers disagree on comment syntax (Ruby's `#` vs Java/C/C++'s `//`/`/** */`).
function extractSimpleSymbols(
  root: TsNode,
  filePath: string,
  kindByType: ReadonlyMap<string, string>,
  lines: readonly string[],
  style: DocCommentStyle,
  nameFor: (node: TsNode) => string | null = nodeName,
): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode): void => {
    const kind = kindByType.get(node.type)
    if (kind !== undefined) {
      const name = nameFor(node)
      if (name !== null && name !== '') {
        out.push(makeSymbol(filePath, name, kind, node, lines, style))
      }
    }

    for (const child of node.namedChildren) {
      visit(child)
    }
  }

  visit(root)
  return out
}

function extractRubySymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  return extractSimpleSymbols(root, filePath, RUBY_KIND_BY_TYPE, lines, 'hash')
}

const JAVA_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['method_declaration', 'method'],
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['enum_declaration', 'enum'],
  ['constructor_declaration', 'method'],
  ['record_declaration', 'class'],
  ['annotation_type_declaration', 'interface'],
  // An annotation type's members (`String value() default "";`, `int count();` inside an
  // `@interface` body) parse as `annotation_type_element_declaration` -- a distinct node type
  // from `method_declaration`, even though it is the exact same "signature-shaped declaration"
  // as an interface method. It exposes its own `name` field (an `identifier`), same shape as
  // `method_declaration`, but had no map entry here: every annotation member was silently
  // invisible to `symbol`/`outline`/`skeleton`/`read`, even though the annotation type itself
  // indexed fine via `annotation_type_declaration` above. Mapped to 'method' to match how a
  // Go interface's `method_elem` and a Rust trait's `function_signature_item` are folded into
  // the same kind as their bodied counterparts.
  ['annotation_type_element_declaration', 'method'],
])

function extractJavaSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  return extractSimpleSymbols(root, filePath, JAVA_KIND_BY_TYPE, lines, 'c')
}

const CPP_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['function_definition', 'function'],
  ['class_specifier', 'class'],
  ['struct_specifier', 'struct'],
  ['enum_specifier', 'enum'],
  // `union_specifier` exposes the same `name` field (a `type_identifier`) as struct/enum in both
  // the C and C++ grammars, so a named union indexes as kind 'union' and is visible to `types`.
  ['union_specifier', 'union'],
  // A `typedef ... Alias;` parses as `type_definition`; its aliased name lives on the nested
  // `declarator` chain, not a `name` field. The dominant real-world form `typedef struct { ... }
  // Alias;` (anonymous tag) otherwise indexes nothing at all: the inner struct/enum/union
  // specifier has no `name`, and the alias itself was never reached. Kind 'type' matches how the
  // TS/Go/Rust type aliases are indexed and is in `types`' TYPE_KINDS.
  ['type_definition', 'type'],
  // `using Alias = Type;` (the C++11 alias-declaration form) parses as `alias_declaration`, a
  // distinct node type from `type_definition` above -- it had no entry here, so every C++11-style
  // type alias was silently invisible to symbol/outline/skeleton/types even though its `name`
  // field (a `type_identifier`) resolves fine via the default nodeName() lookup, unlike typedef's
  // declarator-chain descent (cTypedefAliasName). Kind 'type' matches type_definition's convention.
  ['alias_declaration', 'type'],
  // `namespace Foo { ... }` (including the C++17 nested `namespace A::B { ... }` shorthand) parses
  // as `namespace_definition`, which had no entry here, so the namespace itself was silently
  // dropped from the index -- `symbol`/`outline`/`skeleton` never showed the declaration line,
  // even though everything nested inside it still indexed (extractSimpleSymbols always recurses
  // into children regardless of the parent's kind-map membership). The default `nodeName` lookup
  // (childForFieldName('name')) resolves both the simple `namespace_identifier` case and the
  // nested `nested_namespace_specifier` case (whose `.text` is the full `A::B` path) without any
  // special-casing. An anonymous `namespace { ... }` has no `name` field, so `nodeName` returns
  // null and it is correctly skipped -- matching how an anonymous struct/enum/union tag is only
  // ever indexed via its typedef alias, never as a bare symbol of its own. Kind 'namespace', not
  // 'module' (already used for Rust `mod`/Ruby `module`), since C++ namespaces are reopenable and
  // additive rather than a single owning declaration -- and NOT added to graph_commands.ts's
  // TYPE_KINDS, since a namespace is a container, not a type declaration (mirrors 'module' being
  // absent from TYPE_KINDS for the same reason).
  ['namespace_definition', 'namespace'],
  // A bodiless function prototype (`int add(int a, int b);`) parses as a plain `declaration`, NOT
  // `function_definition` (which requires a `{ ... }` body) -- the dominant content of any C/C++
  // header file, which is almost entirely prototypes forward-declaring functions defined
  // elsewhere. Pre-fix, every one of these was silently dropped: `symbol`/`read`/`outline` on a
  // header returned nothing for its declared API surface. `declaration` is also the node type for
  // every plain variable/extern declaration (`int x;`, `extern int y;`) and for a function-pointer
  // *variable* (`int (*fp)(int);`, whose declarator, confusingly, ALSO nests a `function_declarator`
  // around a `parenthesized_declarator`), so this can't be a blanket kind-map entry the way
  // struct/enum/union are -- `cFunctionPrototypeName` below does the real filtering by inspecting
  // the declarator shape, and returns null (silently skipped, matching how an unnamed struct/enum
  // tag is skipped) for anything that isn't a genuine function prototype.
  ['declaration', 'function'],
])

function extractCppSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  // C/C++ function and typedef-alias names live in a nested `declarator` chain, not a `name` field, so descend it; other specifiers (class/struct/enum/union) do expose a `name` field.
  return extractSimpleSymbols(
    root,
    filePath,
    CPP_KIND_BY_TYPE,
    lines,
    'c',
    (node) =>
      node.type === 'function_definition'
        ? cFunctionName(node)
        : node.type === 'type_definition'
          ? cTypedefAliasName(node)
          : node.type === 'declaration'
            ? cFunctionPrototypeName(node)
            : nodeName(node),
  )
}

/**
 * Resolve a bodiless C/C++ `declaration` node to a function name IFF its declarator chain is
 * shaped like a genuine function prototype, not a plain variable or a function-pointer variable.
 * Descends through any wrapping `pointer_declarator`/`reference_declarator` (covers a
 * pointer/reference *return type*, e.g. `int *foo(int x);`) to the first `function_declarator`.
 * That node's own `declarator` field is the discriminator: a real prototype's is a bare
 * identifier (the function's name); a function-pointer *variable*'s is a `parenthesized_declarator`
 * wrapping the pointer (`int (*fp)(int);` -- the parens group "pointer to function", not a call).
 * Anything else (no `function_declarator` reached at all, e.g. `int x;`) isn't a function and
 * returns null so the declaration is skipped, same as an anonymous struct/enum/union tag.
 */
function cFunctionPrototypeName(node: TsNode): string | null {
  let cur: TsNode | null = node.childForFieldName('declarator')
  // Bound the walk so a malformed/unexpected tree can never loop forever.
  for (let i = 0; cur !== null && i < 16; i++) {
    if (cur.type === 'function_declarator') {
      const inner = cur.childForFieldName('declarator')
      if (inner === null) return null
      if (inner.type === 'identifier' || inner.type === 'field_identifier') return inner.text
      if (inner.type === 'qualified_identifier') return lastSegment(inner.text)
      return null // e.g. parenthesized_declarator -- a function-pointer *variable*, not a prototype
    }
    if (cur.type === 'pointer_declarator' || cur.type === 'reference_declarator') {
      cur = cur.childForFieldName('declarator')
      continue
    }
    return null // not a function-shaped declarator (plain variable, extern, etc.)
  }
  return null
}

/** Descend a C/C++ `type_definition`'s `declarator` chain to the aliased `type_identifier`. */
function cTypedefAliasName(node: TsNode): string | null {
  let cur: TsNode | null = node.childForFieldName('declarator')
  // Bound the walk so a malformed/unexpected tree can never loop forever.
  for (let i = 0; cur !== null && i < 16; i++) {
    if (cur.type === 'type_identifier') return cur.text
    const next = cur.childForFieldName('declarator')
    // A function-pointer typedef `typedef R (*Fn)(...)` wraps the alias in a
    // `parenthesized_declarator` that holds its inner declarator as an unnamed child.
    cur = next ?? (cur.type === 'parenthesized_declarator' ? (cur.namedChildren[0] ?? null) : null)
  }
  return null
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
  // go/rust/c/cpp/ruby below cover only genuinely bare-identifier builtins (Go's predeclared functions, Rust macros, C/POSIX libc, Ruby's Kernel methods) -- the same restriction the comment above REF_NOISE_BY_LANG already documents for every language. java is deliberately left unpopulated: Java has no unqualified global builtin equivalent to these (stdout access always goes through System.out.*, a member call captured by its property name, not a bare identifier), so a bare `name` field from method_invocation is far more likely to be a real same-class helper call than a builtin -- adding entries here would risk false-negative "unreferenced" callers reports for real user methods that happen to share a common name.
  [
    'go',
    new Set([
      'len',
      'cap',
      'make',
      'new',
      'append',
      'copy',
      'delete',
      'panic',
      'recover',
      'print',
      'println',
    ]),
  ],
  [
    'rust',
    new Set([
      'println',
      'print',
      'eprintln',
      'eprint',
      'format',
      'vec',
      'write',
      'writeln',
      'assert',
      'assert_eq',
      'assert_ne',
      'debug_assert',
      'panic',
      'todo',
      'unimplemented',
      'dbg',
    ]),
  ],
  [
    'c',
    new Set([
      'printf',
      'sprintf',
      'snprintf',
      'scanf',
      'malloc',
      'calloc',
      'realloc',
      'free',
      'memcpy',
      'memset',
      'memmove',
      'strlen',
      'strcpy',
      'strcmp',
      'exit',
      'abort',
      'assert',
    ]),
  ],
  [
    'cpp',
    new Set([
      'printf',
      'sprintf',
      'snprintf',
      'scanf',
      'malloc',
      'calloc',
      'realloc',
      'free',
      'memcpy',
      'memset',
      'memmove',
      'strlen',
      'strcpy',
      'strcmp',
      'exit',
      'abort',
      'assert',
    ]),
  ],
  [
    'ruby',
    new Set([
      'puts',
      'print',
      'p',
      'pp',
      'gets',
      'require',
      'require_relative',
      'raise',
      'loop',
      'lambda',
      'proc',
      'sleep',
      'exit',
      'freeze',
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
// Wrappers that change a value's type or grouping without changing which binding it names, so `const a = h as X` still references h. Every branch below matched a bare `identifier` child only, which meant one of these in between silently dropped the reference and left the symbol looking unused.
const VALUE_WRAPPER_TYPES = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'type_assertion',
  'instantiation_expression',
  'await_expression',
  'unary_expression',
  // Python spells this as a bare `await` rather than with an `_expression` suffix.
  'await',
])

/** The bare identifier a value position names, peeling any type-only or grouping wrappers around it, or null when the value is anything else (a call, a literal, an arrow function). */
function unwrapValueIdentifier(node: TsNode | null | undefined): TsNode | null {
  if (node === null || node === undefined) return null
  if (node.type === 'identifier') return node
  // Recursing only through wrapper types is what keeps this from wandering into unrelated subtrees: a type_assertion's own type_arguments child is not a wrapper, so it yields null rather than offering up a type name as if it were a value.
  if (!VALUE_WRAPPER_TYPES.has(node.type)) return null
  for (const child of node.namedChildren) {
    const inner = unwrapValueIdentifier(child)
    if (inner !== null) return inner
  }
  return null
}

/** Records `node` as a reference when it resolves to a bare identifier, wrappers included. */
function pushValueIdentifier(result: TsNode[], node: TsNode | null | undefined): void {
  const identifier = unwrapValueIdentifier(node)
  if (identifier !== null) result.push(identifier)
}

function valueRefIdentifiers(node: TsNode, language: Language): TsNode[] {
  const isJs = language === 'typescript' || language === 'javascript'
  const isPy = language === 'python'
  if (!isJs && !isPy) return []

  const result: TsNode[] = []

  // Direct call/constructor argument passed by bare name: arr.map(myHelperFunction).
  if ((isJs && node.type === 'arguments') || (isPy && node.type === 'argument_list')) {
    for (const child of node.namedChildren) {
      pushValueIdentifier(result, child)
    }
  }

  // Python keyword argument bound to an existing name: foo(on_first_page=myHelperFunction).
  // argument_list's namedChildren case above only matches a bare `identifier` child, so a
  // keyword argument's nested value (a keyword_argument node's `value` field) is otherwise
  // never walked.
  if (isPy && node.type === 'keyword_argument') {
    const value = node.childForFieldName('value')
    pushValueIdentifier(result, value)
  }

  // Logical/nullish fallback operand bound to an existing name: const fn = override ?? myHelperFunction,
  // or a fallback called directly: (override ?? myHelperFunction)(x). Restricted to ??/||/&& --
  // the "pick one of two possible values" idiom this mirrors the ternary/ assignment cases above --
  // rather than every binary operator, to avoid pulling in unrelated comparison/arithmetic operands.
  if (isJs && node.type === 'binary_expression') {
    const operator = node.childForFieldName('operator')?.text
    if (operator === '??' || operator === '||' || operator === '&&') {
      const left = node.childForFieldName('left')
      const right = node.childForFieldName('right')
      pushValueIdentifier(result, left)
      pushValueIdentifier(result, right)
    }
  }

  // Assignment of an existing binding to a variable: const x = myHelperFunction / x = myHelperFunction. Arrow/function-expression values are handled separately by scopeName() as a new scope, not a reference to an existing one, so they're excluded here by only matching a plain `identifier` value.
  if (isJs && (node.type === 'variable_declarator' || node.type === 'assignment_expression')) {
    const value = node.childForFieldName(node.type === 'variable_declarator' ? 'value' : 'right')
    pushValueIdentifier(result, value)
  }
  if (isPy && node.type === 'assignment') {
    const value = node.childForFieldName('right')
    pushValueIdentifier(result, value)
  }

  // Object-literal value bound to an existing name: { onClick: myHelperFunction }.
  if (isJs && node.type === 'pair') {
    const value = node.childForFieldName('value')
    pushValueIdentifier(result, value)
  }

  // Default parameter value bound to an existing name: function f(cb = myHelperFunction) {},
  // or with a type annotation: function f(cb: () => void = myHelperFunction) {}. Both parse to
  // a required_parameter/optional_parameter node with a `value` field, independent of whether a
  // `type` field is also present.
  if (isJs && (node.type === 'required_parameter' || node.type === 'optional_parameter')) {
    const value = node.childForFieldName('value')
    pushValueIdentifier(result, value)
  }

  // Array-literal element bound to an existing name: const handlers = [myHelperFunction, other].
  // JS `array` and Python `list` both expose their elements as plain namedChildren, no field name.
  // Python tuples and sets expose elements the same way as a list. Their assignment-target lookalikes are distinct node types (pattern_list, tuple_pattern), so a name being written rather than read is not picked up here.
  if ((isJs && node.type === 'array') || (isPy && (node.type === 'list' || node.type === 'tuple' || node.type === 'set'))) {
    for (const child of node.namedChildren) {
      pushValueIdentifier(result, child)
    }
  }

  // Ternary/conditional branch bound to an existing name: const fn = cond ? myHelperFunction : other,
  // or Python's `myHelperFunction if cond else other`. Only the two chosen-value branches are value
  // positions -- the condition itself is a predicate, not a candidate value, so it's excluded.
  if (isJs && node.type === 'ternary_expression') {
    const consequence = node.childForFieldName('consequence')
    const alternative = node.childForFieldName('alternative')
    pushValueIdentifier(result, consequence)
    pushValueIdentifier(result, alternative)
  }
  if (isPy && node.type === 'conditional_expression' && node.namedChildren.length === 3) {
    const consequence = node.namedChildren[0]
    const alternative = node.namedChildren[2]
    pushValueIdentifier(result, consequence)
    pushValueIdentifier(result, alternative)
  }

  // Class field initializer bound to an existing name: class C { handler = myHelperFunction }.
  // Python's equivalent (a class-body assignment) is already covered by the `assignment` case above.
  // TypeScript spells this node public_field_definition and JavaScript spells it field_definition; loadGrammar loads two separate grammar modules, so matching only the TypeScript name skipped every .js file outright.
  if (isJs && (node.type === 'public_field_definition' || node.type === 'field_definition')) {
    const value = node.childForFieldName('value')
    pushValueIdentifier(result, value)
  }

  // Bare-identifier return: return myHelperFunction. Neither grammar names this a field, so it's
  // only walked when the return statement has exactly one named child (avoids matching e.g. a
  // Python bare `return` with no value, which has zero).
  if (node.type === 'return_statement' && node.namedChildren.length === 1) {
    const value = node.namedChildren[0]
    pushValueIdentifier(result, value)
  }

  // Destructuring default bound to an existing name: const [cb = myHelperFunction] = arr, or
  // const { cb = myHelperFunction } = opts. Both array- and object-pattern defaults expose the
  // fallback value via a `right` field.
  if (isJs && (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern')) {
    const value = node.childForFieldName('right')
    pushValueIdentifier(result, value)
  }

  // Template-literal interpolation of an existing name: `value: ${myHelperFunction}`. The
  // substitution wraps its expression as a single namedChild with no field name.
  if (isJs && node.type === 'template_substitution' && node.namedChildren.length === 1) {
    const value = node.namedChildren[0]
    pushValueIdentifier(result, value)
  }

  // Base class named in an extends clause: class Impl extends Base {}, or a member-expression
  // base like class Impl extends ns.Base {} (captures the object, `ns`). Unlike Python, whose
  // base list is an `argument_list` already matched above, JS/TS wraps the extends target in its
  // own class_heritage/extends_clause nodes with no field name -- so it's otherwise never walked,
  // and every base class permanently false-positives as a zero-ref dead symbol.
  // The wrapper differs by grammar: TypeScript nests class_heritage > extends_clause > base, while JavaScript puts the base directly under class_heritage with no extends_clause at all. Matching both is safe rather than double-counting, because on the TypeScript side class_heritage's first named child is the extends_clause itself, which is neither an identifier nor a member_expression and so contributes nothing.
  // Shorthand object property: const handlers = { myHelperFunction }. The name is the whole node rather than an `identifier` child of a `pair`, so the pair branch above never sees it.
  if (isJs && node.type === 'object') {
    for (const child of node.namedChildren) {
      if (child.type === 'shorthand_property_identifier') result.push(child)
    }
  }

  // Decorator applied by bare name: @myDecorator above a class, method or def. A decorator called with arguments (@myDecorator(x)) is a call_expression and is already recorded as a call.
  if (node.type === 'decorator') pushValueIdentifier(result, node.namedChildren[0])

  // Python dictionary value: CALLBACKS = {'key': my_helper_function}. Python spells this `pair` too, but the pair branch above is JavaScript-only.
  if (isPy && node.type === 'pair') pushValueIdentifier(result, node.childForFieldName('value'))

  // Python f-string interpolation: f'{my_helper_function}', the counterpart of the JavaScript template_substitution case above.
  if (isPy && node.type === 'interpolation') pushValueIdentifier(result, node.childForFieldName('expression'))

  // Augmented assignment of an existing binding: cur ||= myHelperFunction, or Python's cur += my_helper_function. Only the right side is a value position; the left is the target being written.
  if (isJs && node.type === 'augmented_assignment_expression') pushValueIdentifier(result, node.childForFieldName('right'))
  if (isPy && node.type === 'augmented_assignment') pushValueIdentifier(result, node.childForFieldName('right'))

  // Comma expression: const b = (0, myHelperFunction). Handled as a container rather than as a wrapper because both operands are read, so unwrapping to a single value would record the first and drop the rest.
  if (isJs && node.type === 'sequence_expression') {
    for (const child of node.namedChildren) pushValueIdentifier(result, child)
  }

  // Spread of an existing binding: { ...myHelperFunction }, [ ...myHelperFunction ], and Python's [*xs] / {**kw}. The container branches above look at their direct children, and a spread wraps the name in a node of its own.
  if (isJs && node.type === 'spread_element') pushValueIdentifier(result, node.namedChildren[0])
  if (isPy && (node.type === 'list_splat' || node.type === 'dictionary_splat')) pushValueIdentifier(result, node.namedChildren[0])

  // Computed object key: { [myHelperFunction]: 1 }. The key half of a pair, which the pair branch above ignores in favour of the value.
  if (isJs && node.type === 'computed_property_name') pushValueIdentifier(result, node.namedChildren[0])

  // Comprehension body: [my_helper_function(x) for x in values] and its set and generator forms. A dictionary comprehension holds a `pair` instead, which the Python pair branch above already covers.
  if (isPy && (node.type === 'list_comprehension' || node.type === 'set_comprehension' || node.type === 'generator_expression')) {
    pushValueIdentifier(result, node.namedChildren[0])
  }

  // The thing a comprehension iterates over: [x for x in my_helper_function]. The loop variable on the left is a binding being introduced, not a reference, so only the right side counts.
  if (isPy && node.type === 'for_in_clause') pushValueIdentifier(result, node.childForFieldName('right'))

  // Lambda body bound to an existing name: cb = lambda: my_helper_function. The body field is present whether or not the lambda declares parameters.
  if (isPy && node.type === 'lambda') pushValueIdentifier(result, node.childForFieldName('body'))

  // Yielded by bare name: yield myHelperFunction. Needs a branch of its own rather than a place in the wrapper set above, because a yield is usually a statement in its own right and so sits in no value position for the unwrapping to be reached from.
  if (isJs && node.type === 'yield_expression') pushValueIdentifier(result, node.namedChildren[0])
  if (isPy && node.type === 'yield') pushValueIdentifier(result, node.namedChildren[0])

  // Raised by bare name: raise my_error_class. A statement rather than a value position, so no branch above reaches it.
  if (isPy && node.type === 'raise_statement') pushValueIdentifier(result, node.namedChildren[0])

  // Deliberately not handled: `export default myHelperFunction` and `export { myHelperFunction }`. Both are genuine mentions, but counting them would make every exported symbol look referenced by its own export statement, which is precisely the signal `dead` exists to report.
  if (isJs && (node.type === 'extends_clause' || node.type === 'class_heritage')) {
    const base = node.namedChildren[0]
    if (base !== undefined) {
      if (base.type === 'identifier') result.push(base)
      else if (base.type === 'member_expression') {
        const object = base.childForFieldName('object')
        if (object !== null && object.type === 'identifier') result.push(object)
      }
    }
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
          parent: '',
        })
      }
    }
  }

  return out
}

function extractJsonSymbols(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []

  try {
    let depth = 0
    let inString = false
    let escaping = false
    let strChars: string[] = []
    let strStartLine = 1
    let strStartOffset = 0
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
          strStartOffset = i
          depthWhenStringOpened = depth
        } else {
          inString = false
          // A string is a top-level key iff it opened at object depth 1 and its next non-whitespace char is ':'. This rule is layout-independent, so it captures keys in single-line/minified JSON and keys that share a line with '{', which the previous line-oriented scan missed (it emitted zero symbols for minified JSON).
          let k = i + 1
          while (k < content.length && /\s/.test(content[k] ?? '')) {
            k++
          }
          if (content[k] === ':' && depthWhenStringOpened === 1) {
            // body/lineEnd are derived from the key's and value's own character offsets, never
            // from whole source lines.
            //
            // The previous implementation defaulted body to `lines[strStartLine - 1]` -- the
            // key's entire source line -- widening it only for string values with embedded
            // newlines. On minified JSON that default is catastrophic: every top-level key sits
            // on line 1, so every key stored a copy of the *whole file*. An N-key, S-byte
            // minified document wrote N x S bytes into `symbols.body`, mirrored again into
            // `symbols_fts`. One real 1.5 MB, 1142-key file grew global.db by 1.6 GB by itself,
            // which made each reindex transaction long enough to blow past db.ts's 15s
            // busy_timeout -- surfacing as "database is locked" and as long freezes during
            // `token-goat index`.
            //
            // Walking the value's true extent instead makes the stored bytes scale with the
            // value, so a whole document's bodies now sum to roughly the document's own size.
            // It also fixes a real correctness gap: an object/array value previously recorded
            // lineEnd as the key's line and a body of just `"key": {`, so `read file::key`
            // returned the opening brace rather than the value.
            let v = k + 1
            while (v < content.length && /\s/.test(content[v] ?? '')) {
              v++
            }
            const valueEnd = scanJsonValueEnd(content, v)
            const body = content.slice(strStartOffset, valueEnd)
            const lineEnd = strStartLine + countNewlines(body)
            out.push({
              filePath,
              name: strChars.join(''),
              kind: 'property',
              lineStart: strStartLine,
              lineEnd,
              body,
              docstring: '',
              parent: '',
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

// Mirrors ini_idx.ts's _detectOpenQuote: a value only opens a (possibly multi-line) quoted scalar when its leading non-whitespace char is a quote. A quote appearing later in the value - an apostrophe in a plain scalar (`title: It's working`), or a stray quote inside a trailing `#` comment - is never a delimiter and must not be scanned for parity, or a plain scalar with an interior apostrophe silently swallows every key after it until a matching quote happens to appear somewhere downstream.
export function yamlOpenQuoteAfter(line: string, startIdx: number): '"' | "'" | null {
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

export function yamlLineClosesQuote(line: string, quote: '"' | "'"): boolean {
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

  // A top-level key's double/single-quoted value can wrap across multiple lines (YAML folds the embedded newline into a space). Without tracking that, a continuation line that happens to contain its own `word:` -shaped text (e.g. wrapped prose mentioning "ratio: 16:9", or any string content resembling a key) was read as a brand new top-level key.
  let openQuote: '"' | "'" | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (openQuote !== null) {
      if (yamlLineClosesQuote(line, openQuote)) openQuote = null
      continue
    }

    // A bare URL on its own line (e.g. `https://example.com`) must NOT match as a false `https` key - the colon there is a URL scheme separator immediately followed by `//`, not a key/value split. The key charset includes `.` so a flat/dotted top-level key (e.g. `server.host:`) is captured whole rather than silently dropped. Mirrors the same guard and charset the live section reader's KEYVALUE_HEADER_RE already applies (section_reader.ts).
    const match = /^([a-zA-Z_][\w.-]*)\s*:(?!\/\/)/.exec(line)
    if (match !== null && match[1] !== undefined) {
      out.push({
        filePath,
        name: match[1],
        kind: 'key',
        lineStart: i + 1,
        lineEnd: i + 1,
        body: line.trim(),
        docstring: '',
        parent: '',
      })
      openQuote = yamlOpenQuoteAfter(line, match[0].length)
    }
  }

  return out
}

// Multi-line TOML strings (`"""..."""` or `'''...'''`) can span many lines; text inside them (e.g. a description field quoting example TOML) must never be scanned for key/section syntax. Track whether a triple-quote span opened on an earlier line is still open across the loop, keyed by which delimiter opened it. The two delimiter styles' run counts cannot be tallied independently per line (e.g. via separate regex-match counts) -- only ONE style can be "open" at a time, so a """ string whose body happens to contain a ''' sequence (e.g. a description quoting example TOML syntax) must treat that ''' as inert text, not as its own independent open/close toggle. Counting each style's occurrences separately loses that positional relationship: an ODD number of ''' sequences sitting inertly inside an already-closed """..." span was wrongly read as opening a real multi-line literal string, desyncing every line after it until an unrelated ''' happened to appear later in the file. Scan the line once, left to right, tracking a single open-delimiter slot instead. Exported so the live section reader's TOML table finder (section_reader.ts) can share this exact state machine instead of re-implementing it and drifting out of sync with the indexer.
export function lineOpenDelimiterAfter(line: string, startIdx: number): string | null {
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

// TOML arrays may legally span multiple physical lines (e.g. a matrix as an array of arrays, one row per line). A continuation row of such an array - especially a nested array-of-arrays row like `[1, 0, 0],` - starts with `[` and would otherwise be misread by the section regex as a new table header. Track the net bracket depth opened by an unclosed array so continuation lines are skipped from key/section matching entirely until the array actually closes. Brackets inside string literals are ignored (a quoted value like "a[b]" must never affect array depth). Exported for the same reason as lineOpenDelimiterAfter above.
export function tomlBracketDelta(line: string): number {
  const stripped = stripStringLiterals(line)
  let delta = 0
  for (const ch of stripped) {
    if (ch === '[') delta++
    else if (ch === ']') delta--
  }
  return delta
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
        parent: '',
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
        parent: '',
      })
    }
  }

  let openDelim: string | null = null
  let arrayDepth = 0

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
      arrayDepth = Math.max(0, arrayDepth + tomlBracketDelta(line))
      continue
    }

    matchLine(line, i)
    openDelim = lineOpenDelimiterAfter(line, 0)
    if (openDelim === null) arrayDepth = Math.max(0, tomlBracketDelta(line))
  }

  return out
}

// Splits a CSS selector-list capture on top-level commas only, skipping commas nested inside parentheses (`:is(.foo, .bar)`, `:not()`, `:nth-child(An+B of S)`) or, thanks to the caller already passing a string-literal-stripped `strippedCapture`, commas inside a quoted attribute value (`[data-x="a,b"]`). A plain `rawCapture.split(',')` treats every comma as a selector-list separator, which shreds any selector containing one of those constructs into multiple bogus selector fragments. Scanning happens over `strippedCapture` (so string interiors can't skew paren-depth tracking), but each segment is sliced back out of `rawCapture` at the same offsets so the indexed selector text stays verbatim.
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

// True when the next non-blank line after `i` opens a bare Allman-style rule brace (`{` alone on its own line, e.g. `body\n{\n...`). Used to start selector-fragment accumulation for the FIRST fragment of a rule, which - unlike every later fragment of a multi-line comma list - has no trailing comma of its own to signal "more of this selector is still coming".
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
  // Strip /* */ block comments (newlines preserved so line numbers stay correct) before scanning -- otherwise a commented-out selector at column 0 (e.g. inside a disabled block) is indexed as if it were live CSS.
  const lines = stripCstyleComments(content).split(/\r?\n/)
  // Raw (pre-strip) lines, kept only to distinguish "blanked by comment stripping" from
  // "genuinely blank in the source" below -- see the check at the top of the loop.
  const rawLines = content.split(/\r?\n/)

  // Selector fragments accumulated from preceding comma-continuation lines -- the common multi-line selector-list idiom (`.btn,\n.btn-primary,\n.btn-secondary {`). Each entry keeps its own line number/body so a fragment is indexed at the line it actually appears on, not the brace line, matching how a same-line comma list is already indexed per-fragment below.
  let pending: Array<{ name: string; line: number; body: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()

    // A line that became empty ONLY because stripCstyleComments blanked a `/* ... */` comment sitting on its own line (e.g. `/* primary button */` between selector fragments of a multi-line comma-separated list) must be a no-op, not a break in accumulation -- treating it like a genuinely blank line would silently drop every fragment gathered in `pending` so far (see the discard fallback at the bottom of the loop). A line that was already blank in the raw source still falls through to that discard below, unchanged.
    if (trimmed.length === 0 && (rawLines[i]?.trim().length ?? 0) > 0) {
      continue
    }

    // `^[.#][\w-]+[,\s{]` only matched a bare class/id selector immediately followed by a comma/space/brace, so a compound selector (`.foo.bar`), a pseudo-class/element (`.foo:hover`, `.foo::before`), a plain tag/attribute selector (`div`, `input[type]`), or any selector indented under a nested @media/@supports block (leading whitespace broke the `^` anchor) were all silently skipped. Match anything up to the opening brace instead - excluding lines that start with `@` (an at-rule header like `@media (...) {` is not itself a selector, though selectors nested inside its block are separate lines matched independently) or `{`/`}` (a bare brace-only line) - and split a same-line comma-separated selector list into one symbol per selector. Match against a string-literal-stripped copy of the line so a `{` inside a quoted declaration value (e.g. `content: "{";`, a common pseudo-element glyph pattern) is never mistaken for a rule-opening brace. stripStringLiterals blanks string interiors to same-length spaces, so the match's character offsets line up with the original `line` - the actual (unblanked) selector text is then re-sliced from `line` at those offsets, so a real selector that legitimately contains a quoted value (e.g. `input[type="text"]`) is still captured verbatim rather than with its quoted portion blanked out.
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
          parent: '',
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
            parent: '',
          })
        }
      }
      continue
    }

    // Brace-only line (nothing but `{`, possibly with surrounding whitespace) closing off a multi-line selector list whose fragments were accumulated via `pending` below (the idiom `.a,\n.b\n{\n...`). Flush those fragments as the selector list for this rule instead of falling through to the discard case at the bottom of the loop, which would otherwise silently drop every accumulated fragment because a bare `{` never matches `selectorLineMatch` above (it requires a non-`{`/`}`/`@` character before the brace).
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
          parent: '',
        })
      }
      pending = []
      continue
    }

    // Continuation candidate: a bare selector-fragment line with no brace, not an at-rule header, and not a declaration (no `;`). Three shapes are accepted: a line ending in a trailing comma (starts or continues a comma list, e.g. `.a,`); once a comma-list is already underway (`pending.length > 0`), a bare trailing-fragment line with no comma at all (e.g. the final `.b` in `.a,\n.b\n{`); or a single Allman-brace selector whose `{` sits alone on the very next content line (e.g. `body\n{`) - this last shape has no trailing comma and starts with an empty `pending`, so without the forward-scan it fails both of the other two conditions and the selector is silently dropped. Either way the fragment is accumulated until the line that actually opens the brace (matched above) is reached, instead of being dropped.
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

  // Dockerfile instructions may span multiple physical lines via a trailing backslash continuation (e.g. `RUN apt-get update && \`), and every non-first physical line of that logical instruction is shell text, not a new directive. Without tracking this, a continuation line that happens to start with a shell token colliding with a Dockerfile keyword under the case-insensitive match below (most commonly the `env VAR=val cmd` shell idiom, but also run/copy/add/user/label/arg/from) is misread as a standalone directive.
  let continuing = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (continuing) {
      continuing = line.trimEnd().endsWith('\\')
      continue
    }

    // A whole-line `#` comment never starts or continues a directive: Docker does not extend comments across lines via continuation, so a trailing backslash on a comment is just part of the comment text, not a real line-continuation marker.
    const isComment = line.trim().startsWith('#')
    const match = isComment
      ? null
      : /^\s*(FROM|RUN|COPY|ADD|EXPOSE|ENV|WORKDIR|CMD|ENTRYPOINT|ARG|LABEL|VOLUME|USER|HEALTHCHECK|ONBUILD|SHELL|STOPSIGNAL|MAINTAINER)\s+(.+)/i.exec(
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
        parent: '',
      })
    }

    continuing = !isComment && line.trimEnd().endsWith('\\')
  }

  return out
}

// --- Regex fallback ---------------------------------------------------------

// Top-level function/class patterns for the languages we lack a grammar for (and as a safety net
// when a native grammar fails to load mid-run). Each pattern also carries the comment `style` of
// the language it targets -- unlike the tree-sitter extractors, this fallback has no reliably
// detected `Language` to key off (it commonly runs against an 'unknown' extension), but the
// *pattern that matched* always knows its own source language, so the style travels with it.
const FALLBACK_PATTERNS: ReadonlyArray<{ re: RegExp; kind: string; style: DocCommentStyle }> = [
  // Python
  { re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', style: 'hash' },
  { re: /^[ \t]*class\s+([A-Za-z_]\w*)/, kind: 'class', style: 'hash' },
  // TS/JS function & class declarations (optionally exported/async)
  {
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: 'function',
    style: 'c',
  },
  {
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
    style: 'c',
  },
  { re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', style: 'c' },
  { re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type', style: 'c' },
  // const/let/var bound to an arrow or function expression
  {
    re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    kind: 'function',
    style: 'c',
  },
  // Rust / Go function & struct/type patterns
  { re: /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', style: 'c' },
  { re: /^[ \t]*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', style: 'c' },
  { re: /^[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', style: 'c' },
]

/**
 * Line-oriented regex extraction used when tree-sitter is unavailable.
 *
 * Captures the symbol name and a single-line body (the matched line). Line
 * numbers are 1-based. This is intentionally shallow: it recovers names for
 * `symbol`/`skeleton` lookups without full-body spans.
 */
// Exported for tests only. This fires in production for an unrecognized filename/extension (the
// `language === 'unknown'` early return upstream never actually reaches it for that case -- see
// extractSymbolsNoTreeSitter) and, more meaningfully, as the mid-parse safety net when a
// tree-sitter grammar throws on real source for a language that HAS one (still routed through
// `extractNoTreeSitter` -> `extractSymbolsNoTreeSitter` with that language's own real filePath
// extension). Neither path is practical to reach deterministically via `parseFile` in a unit
// test, so tests call this directly rather than asserting on unreachable-in-practice behavior.
export function extractWithRegex(content: string, filePath: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const { re, kind, style } of FALLBACK_PATTERNS) {
      const m = re.exec(line)
      if (m !== null && m[1] !== undefined) {
        out.push({
          filePath,
          name: m[1],
          kind,
          lineStart: i + 1,
          lineEnd: i + 1,
          body: line.trim(),
          docstring: precedingDocComment(lines, i + 1, style),
          parent: '',
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

  if (isTreeSitterAvailable(language)) {
    try {
      const Ctor = loadParserCtor()
      const grammar = loadGrammar(language, filePath, content)
      if (Ctor !== null && grammar !== null) {
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
      }
    } catch {
      // Parser threw on this input — fall through to the regex pass below.
    }
  }

  // Regex-based extractors for languages without tree-sitter
  return extractNoTreeSitter(content, filePath, language)
}

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
    parent: '',
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
  swift: (content, filePath) => extractSwift(content, filePath).symbols,
  scala: (content, filePath) => extractScala(content, filePath).symbols,
  lua: (content, filePath) => extractLua(content, filePath).symbols,
  elixir: (content, filePath) => extractElixir(content, filePath).symbols,
  dart: (content, filePath) => extractDart(content, filePath).symbols,
  zig: (content, filePath) => extractZig(content, filePath).symbols,
  r: (content, filePath) => extractR(content, filePath).symbols,
  graphql: (content, filePath) => extractGraphql(content, filePath).symbols,
  sql: extractSql,
  ini: extractIni,
  makefile: extractMakefile,
  proto: (content, filePath) => extractProto(content, filePath).symbols,
  terraform: extractTerraform,
  powershell: (content, filePath) => extractPowershell(content, filePath).symbols,
  apex: (content, filePath) => extractApex(content, filePath).symbols,
  salesforce_metadata: (content, filePath) => extractSalesforceMetadata(content, filePath).symbols,
  env_file: extractEnv,
  bash: extractBash,
}

function extractNoTreeSitter(
  content: string,
  filePath: string,
  language: Language,
): ParseContentResult {
  if (language === 'salesforce_metadata') return extractSalesforceMetadata(content, filePath)
  if (language === 'salesforce_markup') return extractSalesforceMarkup(content, filePath)
  if (language === 'html' && isLwcFile(filePath, '.html')) {
    const base: ParseContentResult = { symbols: NO_TREE_SITTER_EXTRACTORS.html!(content, filePath), refs: [] }
    return mergeParseResults(base, extractLwcTemplate(content, filePath))
  }
  // Vue/Svelte/Astro adapters emit both symbols and refs (template component-tag references),
  // same shape as extractSalesforceMarkup above -- returned directly rather than forced through
  // the symbols-only NO_TREE_SITTER_EXTRACTORS map.
  if (language === 'vue') return extractVue(content, filePath)
  if (language === 'svelte') return extractSvelte(content, filePath)
  if (language === 'astro') return extractAstro(content, filePath)

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
  return (NO_TREE_SITTER_EXTRACTORS[language] ?? extractWithRegex)(content, filePath)
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

  const writeAll = db.transaction(() => {
    deleteFileRows(db, filePath)

    db.prepare(
      'INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(filePath, sha, mtime, result.language, now)

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
// `preReadBytes`, when passed, is used verbatim instead of this function opening `filePath`
// itself. This exists so a confinement-pinned caller (read_commands.ts's healStaleIndex /
// force-refresh paths) can verify the file's identity against its MCP-validated pin BEFORE any
// bytes are read, then hand those already-verified bytes straight through -- closing the
// check-then-open race that a second, independent fs.readFileSync inside this function would
// reopen. A CLI caller (worker.ts, cli.ts) never has a pin to verify against and omits this
// parameter, so this function's own fs.readFileSync (below) still runs for every call site
// except the pinned ones, unchanged from before this parameter existed.
export function indexFileSync(filePath: string, dbPath: string = globalDbPath(), preReadBytes?: Buffer): void {
  const ixCfg = loadConfig().indexing
  if (ixCfg !== undefined && isParseSkipEligible(filePath, ixCfg)) {
    // Purge stale rows AND the files row (sha) so the file settles into a stable not-indexed state instead of being re-selected as "changed" on every drain; also drop any embedding rows it held before becoming skip-eligible (indexFileSync is called directly from read_commands' --force-refresh path).
    const db = getDb(dbPath)
    deleteFileRows(db, filePath)
    deleteFileEmbeddings(db, filePath)
    return
  }
  const language = detectLanguage(filePath)
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
  const content = raw.toString('utf8')
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
function buildEmbeddingBoundaries(filePath: string, content: string, dbPath: string): ChunkBoundary[] {
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
    const extracted = await extractEmbeddableDocumentText(filePath)
    if (extracted === null || extracted.trim().length === 0) {
      // A failed extraction or a document with no extractable text is a terminal deliberately-
      // never-embed state, same shape as the .profile-meta.xml skip above: stamp the real sha so
      // an unchanged file is not re-read into extraction on every worker drain / index run.
      const db = getDb(dbPath)
      deleteFileEmbeddings(db, filePath)
      stampEmbedSha(db, filePath, sha, (s) => s)
      return
    }
    if (extracted.length > ixCfg.large_file_symbol_only_kb * 1024) {
      // Reuse the same large-file threshold as the generic content-length check below --
      // extracted document text is comparatively expensive to embed for comparatively little
      // retrieval value once it's this large, not a case that needs its own config knob.
      const db = getDb(dbPath)
      deleteFileEmbeddings(db, filePath)
      stampEmbedSha(db, filePath, sha, (s) => s)
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
    content = await fs.promises.readFile(filePath, 'utf8')
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
    // Between the symbol-only and full-skip thresholds: syntactic symbols/refs are already indexed by indexFileSync (only large_file_skip_kb gates that), but embedding a moderately-large file is comparatively expensive for comparatively little retrieval value -- deliberately never embed it, mirroring the profile-meta.xml / salesforce_metadata terminal-skip pattern below.
    const db = getDb(dbPath)
    deleteFileEmbeddings(db, filePath)
    stampEmbedSha(db, filePath, sha, (s) => s)
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
