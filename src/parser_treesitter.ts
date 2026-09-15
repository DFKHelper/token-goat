/**
 * Tree-sitter symbol extractors for typed and compiled languages (TS/JS, Python, Go, Rust, Ruby, Java, C/C++).
 */

import { SYMBOL_BODY_CHAR_CAP as MAX_SYMBOL_BODY_CHARS } from './constants.js'
import { precedingDocComment, type DocCommentStyle } from './doc_comment.js'
import type { TsNode } from './parser_ts_types.js'
import type { SymbolEntry } from './parser_types.js'
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
  // Interface members and abstract methods are distinct node types from concrete method_definition.
  ['method_signature', 'method'],
  ['property_signature', 'var'],
  ['abstract_method_signature', 'method'],
  // Ambient function declarations in .d.ts files parse as function_signature.
  ['function_signature', 'function'],
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

/**
 * TS/JS node types that name a member of a type rather than a value. tree-sitter uses the same node
 * types for an interface's members and for the members of an anonymous type literal written inline,
 * so {@link isNamedTypeMember} decides which of the two a given node is.
 */
const TSJS_TYPE_MEMBER_TYPES: ReadonlySet<string> = new Set(['property_signature', 'method_signature'])

/**
 * Type nodes that wrap a type without changing whose type it is. A literal inside any chain of
 * these still belongs to whatever declaration the chain ends at, so {@link isNamedTypeMember}
 * climbs through them: `type A = ({ x } | { y })[]` declares `x` and `y` just as `type A = { x }`
 * declares `x`. Anything not listed stops the climb, so an unfamiliar wrapper denies rather than
 * silently admitting a literal from an annotation or expression position.
 */
const TSJS_TYPE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'parenthesized_type',
  'union_type',
  'intersection_type',
  'array_type',
  'readonly_type',
  'tuple_type',
  'optional_type',
  'rest_type',
  'generic_type',
  'type_arguments',
])

/**
 * Is this type member declared by something -- an `interface` body, a class body, or a
 * `type X = ...` alias -- rather than by an anonymous type literal written inline?
 *
 * The `property_signature`/`method_signature` kind-map entries above exist so interface members are
 * visible to the index, which is right: `I.field` is a definition someone looks up. But tree-sitter
 * emits those same node types for every inline object type -- a return annotation
 * `function f(): { q: string }`, a parameter type, a cast `x as { g: string }[]`, a typed const --
 * and each member was indexed as a top-level `var`. Those are not definitions. Nothing declares
 * them, `symbol` resolves them to a spot inside someone else's signature, and because the doc
 * comment lookup walks up from the member's own line they inherit the enclosing function's
 * docstring, so the entry shows another symbol's documentation. In this repository that was 1438
 * phantom symbols against 1755 real ones, 431 of them from `cli.ts` alone.
 *
 * `class_body` is a keep: an overload signature (`foo(x: string): void` above its implementation)
 * and a method on a `declare class` both parse as `method_signature`, and both are declared members.
 * A class *property* never reaches here -- it parses as `public_field_definition`, not a signature.
 */
function isNamedTypeMember(node: TsNode): boolean {
  const parent = node.parent
  if (parent === null) return false
  if (parent.type === 'interface_body' || parent.type === 'class_body') return true
  if (parent.type !== 'object_type') return false
  let owner = parent.parent
  while (owner !== null && TSJS_TYPE_WRAPPER_TYPES.has(owner.type)) owner = owner.parent
  return owner !== null && owner.type === 'type_alias_declaration'
}

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
// Declaration nodes whose single spec/declarator child is the node a symbol is built from.
// Widening from the spec to its declaration is what puts `const`, `let`, `var` and Go's
// `var`/`const`/`type` back on the front of a stored body.
const SPEC_DECLARATION_OWNER = new Map<string, ReadonlySet<string>>([
  ['variable_declarator', new Set(['lexical_declaration', 'variable_declaration'])],
  ['var_spec', new Set(['var_declaration'])],
  ['const_spec', new Set(['const_declaration'])],
  ['type_spec', new Set(['type_declaration'])],
])

// Nodes that wrap exactly one declaration and contribute only a keyword prefix to it.
const PREFIX_WRAPPER_TYPES: ReadonlySet<string> = new Set(['export_statement', 'ambient_declaration'])

// A tree-sitter node often starts partway into its own first line. `export const x = 1`
// builds its symbol from the `variable_declarator`, which starts at `x`, while lineStart
// comes from that node's row and so names the whole line. The stored body and the stored
// span then disagree about where the symbol begins: `read "file::symbol"` prints a header
// taken from the span and text taken from the body, so it serves text the file does not
// contain at those lines, with `export`, `const`, `let` or `declare` missing from the
// front. Widening the node to the declaration that owns it puts the two back in step.
//
// Widening stops at a declaration holding more than one declarator. `const a = 1, b = 2`
// would otherwise give both symbols the whole declaration, and a minified bundle can put
// hundreds of them on a single line -- the quadratic blow-up tests/index_amplification_guard
// exists to catch. Those keep the narrow declarator body, which is the honest thing to
// store for a line that genuinely holds many symbols.
function widenToDeclaration(node: TsNode): TsNode {
  let widened = node
  const owner = SPEC_DECLARATION_OWNER.get(widened.type)
  if (owner !== undefined) {
    const decl = widened.parent
    if (decl === null || !owner.has(decl.type)) return widened
    // Only when this declaration holds exactly one spec, and holds it on its own opening
    // row. `const a = 1, b = 2` and Go's grouped `var ( p = 1\n q = 2 )` both put several
    // symbols in one declaration; giving each of them the whole thing is the quadratic
    // storage blow-up tests/index_amplification_guard.test.ts exists to catch.
    let specs = 0
    for (const c of decl.namedChildren) if (c.type === widened.type) specs++
    if (specs !== 1) return widened
    if (decl.startPosition.row !== widened.startPosition.row) return widened
    widened = decl
  }
  // Walk out through the wrappers that add only a keyword prefix. `declare const x` nests
  // the declaration inside an ambient_declaration, and `export declare const x` nests that
  // inside an export_statement in turn, so a single step would still leave `declare` (or
  // `export declare`) off the front. No row guard: `export default` may sit on its own
  // line above the function it exports, and that line belongs to the symbol. These
  // wrappers add no fan-out -- each holds exactly one declaration -- so widening through
  // them adds the prefix once per symbol and cannot amplify storage.
  for (;;) {
    const parent = widened.parent
    if (parent === null || !PREFIX_WRAPPER_TYPES.has(parent.type)) return widened
    widened = parent
  }
}

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  node: TsNode,
  lines?: readonly string[],
  style?: DocCommentStyle,
): SymbolEntry {
  const ranged = widenToDeclaration(node)
  const lineStart = ranged.startPosition.row + 1
  return {
    filePath,
    name,
    kind,
    lineStart,
    lineEnd: ranged.endPosition.row + 1,
    body: ranged.text,
    docstring:
      lines !== undefined && style !== undefined ? precedingDocComment(lines, lineStart, style) : '',
      parent: '',
  }
}

// One declaration node can name hundreds of symbols, and each of them would otherwise store the
// whole declaration's text. `const [v0, ..., v899] = source` turned a 4.4 KB line into 3.9 MB of
// stored bodies, roughly 900x, and Go's `var v0, ..., v599 = ...` does the same thing -- the same
// quadratic growth MAX_SYMBOL_BODY_CHARS bounds for a single oversized row, spread across many
// small rows instead so no individual row ever trips that cap. Elide the bodies once the
// declaration's total contribution would pass the same cap. Elided means the empty string, not a
// truncated copy, because resolveBody re-slices an empty body from the file at read time -- so
// `read` still serves the whole declaration.
function fanOutElidesBodies(nameCount: number, declarationChars: number): boolean {
  return nameCount > 1 && nameCount * declarationChars > MAX_SYMBOL_BODY_CHARS
}

// Collect the bound local identifiers from a destructuring pattern node (object_pattern / array_pattern, including nested patterns, rest elements, defaults, and renames). A renamed key (`{ a: b }`) binds the value `b`; the key `a` is a property_identifier and is intentionally skipped.
function collectPatternBindings(node: TsNode): string[] {
  const names: string[] = []
  const walk = (n: TsNode): void => {
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
      if (n.text !== '') names.push(n.text)
      return
    }
    // A default binds only its left side. The right side (`{ a = fallback }`, `[a = mk()]`) is an
    // ordinary expression, so every identifier in it is a reference to something declared
    // elsewhere, not a new binding.
    if (n.type === 'assignment_pattern' || n.type === 'object_assignment_pattern') {
      const left = n.childForFieldName('left')
      if (left !== null) walk(left)
      return
    }
    // `{ key: value }` binds only the value; a computed key (`{ [k]: v }`) reads `k`.
    if (n.type === 'pair_pattern') {
      const value = n.childForFieldName('value')
      if (value !== null) walk(value)
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
export function extractTsJsSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = TSJS_KIND_BY_TYPE.get(node.type)
    // A local `function` declaration nested inside a function body is a local, exactly like a
    // local const/let/var below -- exclude it from the top-level index the same way.
    const isLocalFunction = insideFunction && (node.type === 'function_declaration' || node.type === 'generator_function_declaration')
    // A member of an inline type literal is not a definition either -- see isNamedTypeMember.
    const isAnonymousTypeMember = TSJS_TYPE_MEMBER_TYPES.has(node.type) && !isNamedTypeMember(node)
    if (kind !== undefined && !isLocalFunction && !isAnonymousTypeMember) {
      const name = nodeName(node)
      if (name !== null && name !== '') {
        const decorators = leadingTsDecorators(node)
        if (decorators.length === 0) {
          out.push(makeSymbol(filePath, name, kind, node, lines, 'c'))
        } else {
          // The doc comment (if any) sits above the leading decorator, not above the decorated
          // node itself -- look up from the same widened lineStart used for the range below.
          const lineStart = decorators[0]!.startPosition.row + 1
          // The decorated node may itself sit inside `export`/`declare`, whose keywords
          // fall between the decorator and the node.
          const decoratedEnd = widenToDeclaration(node).endPosition.row + 1
          out.push({
            filePath,
            name,
            kind,
            lineStart,
            lineEnd: decoratedEnd,
            // Read the body off the file rather than gluing the decorator and the node
            // together with a newline: `@dec export class X {}` has no newline between
            // them, and the glued form both invents one and drops the `export` that sits
            // between the two nodes. A decorated declaration yields one symbol, so taking
            // its whole span cannot fan out.
            // The trailing replace keeps a convention the rest of the index follows: a
            // tree-sitter node never carries the indentation of its own first line,
            // because it starts at the first real character. Reading the span off the
            // file would otherwise make decorated symbols the one shape that does.
            body: lines
              .slice(lineStart - 1, decoratedEnd)
              .join('\n')
              .replace(/^[ \t]+/, ''),
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
          const bindings = collectPatternBindings(name)
          const elideBodies = fanOutElidesBodies(bindings.length, child.text.length)
          for (const bound of bindings) {
            const sym = makeSymbol(filePath, bound, 'variable', child, lines, 'c')
            out.push(elideBodies ? { ...sym, body: '' } : sym)
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
export function extractPythonSymbols(root: TsNode, filePath: string): SymbolEntry[] {
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

// Go spec nodes that can declare several names at once: `var a, b = 1, 2`, `const x, y = 3, 4`.
// tree-sitter-go repeats the `name` field on one spec node, and childForFieldName returns only the
// first, so every name after the first was absent from the index -- `symbol b` found nothing for a
// package-level variable that plainly exists. The declared names are exactly the direct
// `identifier` children: a declared type is a `type_identifier` (or a pointer/qualified node) and
// the assigned values live under an `expression_list`, so neither can be mistaken for a name.
const GO_MULTI_NAME_SPECS: ReadonlySet<string> = new Set(['var_spec', 'const_spec'])

export function extractGoSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
  const out: SymbolEntry[] = []

  const visit = (node: TsNode, insideFunction: boolean): void => {
    const kind = GO_KIND_BY_TYPE.get(node.type)
    if (kind !== undefined && !(insideFunction && GO_LOCAL_KINDS.has(node.type))) {
      if (GO_MULTI_NAME_SPECS.has(node.type)) {
        // The blank identifier declares nothing nameable; indexing it would put a `_` row in
        // every file that discards one half of a multi-value declaration.
        const declared = node.namedChildren.filter(
          (c) => c.type === 'identifier' && c.text !== '' && c.text !== '_',
        )
        const elideBodies = fanOutElidesBodies(declared.length, node.text.length)
        for (const child of declared) {
          const sym = makeSymbol(filePath, child.text, kind, node, lines, 'c')
          out.push(elideBodies ? { ...sym, body: '' } : sym)
        }
      } else {
        const name = nodeName(node)
        if (name !== null && name !== '') {
          out.push(makeSymbol(filePath, name, kind, node, lines, 'c'))
        }
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

export function extractRustSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
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

export function extractRubySymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
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

export function extractJavaSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
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

export function extractCppSymbols(root: TsNode, filePath: string, lines: readonly string[]): SymbolEntry[] {
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

/** Last `::`- or `.`-separated segment of a path expression text. */
function lastSegment(text: string): string {
  const parts = text.split(/::|\./)
  return parts[parts.length - 1] ?? text
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
