/**
 * Call-site reference extraction via tree-sitter AST traversal.
 */

import type { TsNode } from './parser_ts_types.js'
import type { Language, RefEntry } from './parser_types.js'

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
  ['cpp', new Set(['call_expression', 'new_expression'])],
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
/** Bare callee identifier of a C/C++ call's `function` child, or null when the position names no identifier. Walks the wrappers structurally rather than slicing text: a templated call site nests its name in a `template_function`/`template_method` node whose own text carries the argument list (`make_unique<Foo>`), so reading that text records a name no lookup of the real callee can match, and a bare `tmpl<int>(x)` is dropped entirely. */
function cppCalleeName(node: TsNode): string | null {
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
      return node.text
    // An overloaded operator's name is its own node type, and it is the spelling the extractor gives the operator's definition too, so returning the text here is what makes the two match. Measured: `r.template operator()<int>(3)` parses as `dependent_name(template, template_method(operator_name "operator()", template_argument_list "<int>"))`, so without this case the name resolved to null and the field_expression fallback below recorded `template operator()<int>` -- a spelling no symbol row ever holds, leaving the call permanently unresolvable.
    case 'operator_name':
      return node.text
    case 'template_function':
    case 'template_method':
    case 'template_type': {
      const name = node.childForFieldName('name')
      return name !== null ? cppCalleeName(name) : null
    }
    case 'qualified_identifier': {
      const name = node.childForFieldName('name')
      return name !== null ? cppCalleeName(name) : lastSegment(node.text)
    }
    case 'dependent_name': {
      // `r.template meth<int>(3)` parses as `dependent_name(template, template_method)`; the keyword is the first child, the name the last. Without this case the field_expression fallback below recorded the whole spelling, `template meth<int>`, which matches no symbol the indexer ever writes.
      const last = node.namedChildren[node.namedChildren.length - 1]
      return last !== undefined ? cppCalleeName(last) : null
    }
    case 'field_expression': {
      const field = node.childForFieldName('field')
      if (field === null) return null
      // Any other field shape keeps the plain text it resolved to before templated calls were unwrapped. Measured, not assumed: `o->~Foo()` reaches this fallback as a destructor_name whose text is `~Foo`, and `~Foo` is exactly the name the extractor gives the destructor's own definition, so the ref matches.
      return cppCalleeName(field) ?? field.text
    }
    default:
      return null
  }
}

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
      // A `new` carries the constructed type on `type` rather than a callee on `function`, and it is a call in every sense the refs index cares about: TypeScript and Java have always recorded theirs.
      const fn = call.type === 'new_expression' ? call.childForFieldName('type') : call.childForFieldName('function')
      if (fn === null) return null
      return cppCalleeName(fn)
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
export function extractRefs(root: TsNode, filePath: string, language: Language): RefEntry[] {
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
