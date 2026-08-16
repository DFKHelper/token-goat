/**
 * Swift symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, structs, enums, protocols, extensions, actors, top-level
 * functions, methods (including init/deinit/subscript), properties, and
 * `import` directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripLineComment,
  stripMultilineStringSpan,
  stripNestedBlockCommentSpan,
  stripStringLiterals,
  type MultilineStringState,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

interface TypeFrame {
  name: string
  startDepth: number
  bodyEntered: boolean
}

// Swift identifiers are Unicode, and any keyword becomes a legal declaration name when wrapped in
// backticks (`var `default` = 0`, common in generated and interop code). An ASCII-only class does
// not merely skip those declarations: it matches the ASCII prefix and stops, so `struct Café` was
// indexed under the truncated name `Caf` and every member in its body was parented to that name.
// The ranges start at U+00C0 rather than using the `u` flag, because these patterns are assembled
// as strings and `u` mode would reject the identity escape in the operator class of FUNC_RE.
const IDENT_START = 'A-Za-z_\\u00C0-\\uFFFF'
const IDENT_CONT = 'A-Za-z0-9_\\u00C0-\\uFFFF'
const IDENT = `(?:\`[^\`]+\`|[${IDENT_START}][${IDENT_CONT}]*)`

/** Declaration names keep their backticks in source; the index stores the bare name. */
function unquoteIdent(name: string): string {
  return name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name
}

// A generic clause with one level of nesting. Swift 5.7's primary associated types put a generic
// inside a generic constraint routinely (`func f<C: Collection<Int>>(...)`), and a flat `<[^>]*>`
// stops at the inner `>` and then fails to reach the parameter list, dropping the declaration.
const GENERIC = '(?:<(?:[^<>]|<[^<>]*>)*>)?'

// Attributes may appear inline before a declaration. The argument list gets one level of nesting
// for the same reason as GENERIC: `@available(*, deprecated, renamed: "replacement()")` is ordinary
// deprecation markup, and a flat `\([^()]*\)` cannot span the parentheses inside the message.
const LEADING_ATTRIBUTE_RE =
  /^\s*(?:@[A-Za-z_][A-Za-z0-9_.]*(?:\((?:[^()]|\([^()]*\))*\))?\s+)+/
export function stripLeadingAttributes(s: string): string {
  return s.replace(LEADING_ATTRIBUTE_RE, '')
}

// `import` may carry an access level in Swift 6 (`public import Foundation`, `internal import X`),
// and attributes such as `@preconcurrency` / `@_exported` are stripped before this runs.
// Exported because read_commands.ts's `imports` command matched Swift imports with its own copy of
// this pattern: the two drifted apart the moment one was extended, so `token-goat imports` reported
// none of the imports the index itself held for the same file.
export const IMPORT_RE = new RegExp(
  '^(?:(?:public|package|internal|fileprivate|private)\\s+)?' +
  'import\\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\\s+)?' +
  `(${IDENT}(?:\\.${IDENT})*)`,
)

// Shared modifier alternation for func/init/subscript/property declarations. `(?:set)`-suffixed
// access modifiers (`private(set) var x`, `package(set) var x`) are real Swift syntax restricting
// the setter's visibility independently of the getter's, so `(?:\(set\))?` is folded into the
// access-level alternative rather than left to desync the match entirely. `package` is Swift
// 5.9's module-group access level, a peer of public/internal that applies to every declaration
// kind -- omitting it dropped every `package`-scoped member from the index. `distributed` is
// SE-0336's modifier marking a distributed actor's remotely-callable methods (`distributed func
// greet() -> String`) -- without it here, every method inside a distributed actor (which itself
// requires the `distributed` keyword) failed to match FUNC_RE at all.
//
// `nonisolated` and `unowned` are split out because both take a legal parenthesized argument
// (`nonisolated(unsafe) var cache`, Swift 5.10's escape hatch for global state; `unowned(unsafe)
// var delegate`, the long-standing ObjC-interop form). Listed as bare words they matched the
// keyword and then demanded whitespace, so the declaration was dropped on exactly the lines where
// the modifier is load-bearing. `prefix`/`postfix`/`infix` introduce operator functions,
// `optional` marks an `@objc protocol` requirement, and `consuming`/`borrowing`/`isolated` are the
// SE-0377 / SE-0313 ownership and isolation modifiers -- each one is the first word on its line,
// so its absence here dropped the whole declaration rather than just the modifier.
const MODIFIER_ALT =
  '(?:(?:public|private|fileprivate|internal|open|package)(?:\\(set\\))?|' +
  '(?:nonisolated|unowned)(?:\\([A-Za-z]+\\))?|' +
  'static|final|class|override|required|convenience|mutating|nonmutating|dynamic|async|lazy|weak|' +
  'indirect|distributed|prefix|postfix|infix|optional|consuming|borrowing|isolated)'

// Function name is either a plain identifier or an operator-overload symbol (`func ==(...)`,
// `func +(...)`) -- Swift's operator functions are real top-level and member declarations, not
// an edge case a language extractor can ignore. Generics come after the name in Swift
// (`func foo<T: Comparable>(x: T) -> T`), unlike Kotlin's `fun <T> foo(...)`. The parameter list
// may legally begin on the next physical line, so `(` is optional when the name ends the line.
const FUNC_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  `func\\s+(${IDENT}|[+\\-*/%=!<>&|^~]+)\\s*` + GENERIC + '\\s*(?:\\(|$)',
)

// `init`/`init?`/`init!` (failable initializers) and `deinit` (no parameters, no modifiers).
const INIT_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  '(init)[?!]?\\s*' + GENERIC + '\\s*(?:\\(|$)',
)
const DEINIT_RE = /^\s*deinit\s*\{/

const SUBSCRIPT_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  '(subscript)\\s*' + GENERIC + '\\s*(?:\\(|$)',
)

// `var`/`let` property declaration -- matches a stored property (`var x: Int = 0`), a
// type-annotated-only property (`let y: String`), and a computed property's header line
// (`var z: Int { get { ... } }` / `var z: Int { get set }`), since all three share the same
// `var|let name` prefix. The whole declarator list is captured rather than one name, because a
// single `var` may declare several (`var a = 0, b = 1`); splitNames pulls the individual names out.
const PROPERTY_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  '(?:var|let)\\s+(' + `${IDENT}` + '[^\\n]*)',
)

/**
 * Names declared by one `var`/`let` declarator list.
 *
 * Only commas at bracket depth zero separate declarators: a comma inside a generic argument
 * (`var m: Dictionary<String, Int>`) or a call (`var a = f(1, 2), b = 3`) belongs to the
 * declarator it sits in. `>` is not counted as a closer when it is the tail of `->`, so a function
 * type in the annotation cannot drive the depth negative.
 */
function splitDeclaratorNames(tail: string): string[] {
  const names: string[] = []
  let depth = 0
  let start = 0
  const parts: string[] = []
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i]!
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (c === '>' && tail[i - 1] !== '-') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0) {
      parts.push(tail.slice(start, i))
      start = i + 1
    }
  }
  parts.push(tail.slice(start))
  const leadRe = new RegExp(`^\\s*(${IDENT})`)
  for (const part of parts) {
    const m = leadRe.exec(part)
    if (m) names.push(unquoteIdent(m[1] ?? ''))
  }
  return names
}

// The keyword itself is captured (group 1) so the caller can map it to the right symbol kind --
// class/struct/enum/protocol/extension/actor all share this one header shape, differing only in
// keyword and in what an "extension" conceptually is (adds members to an existing type rather
// than declaring a new one, mirroring how kotlin.ts's companion-object handling folds members
// into their enclosing frame's name). `actor` is Swift 5.5's concurrency-safe reference type,
// declared with a `{ }` body exactly like a class; omitting it dropped the actor AND every
// member nested in its body from the index entirely. `distributed` is SE-0336's modifier for a
// distributed actor (location-transparent, usable across process/network boundaries) -- without
// it in the modifier alternation, `distributed actor Foo { ... }` never matched at all (the
// modifier list is anchored immediately before the class/struct/.../actor keyword), dropping the
// actor and every member nested in its body from the index the same way a plain `actor` did
// before that keyword was added. The name may be dotted (`extension Array.Index`, `extension
// Foo.Bar`) for nested-type extension targets.
const TYPE_HEADER_RE = new RegExp(
  '^(?:(?:public|private|fileprivate|internal|open|package|final|indirect|distributed)\\s+)*' +
  '(class|struct|enum|protocol|extension|actor)\\s+' +
  `(${IDENT}(?:\\.${IDENT})*)`,
)

/**
 * Strip Swift regex literals from a copy of the line used only for brace counting.
 *
 * `/\{/` is a legal Swift 5.7 regex literal, and the `{` inside it is not nesting: counted as
 * real, it leaves the enclosing type frame open for the rest of the file, so every later top-level
 * declaration is emitted as a method of a type it has nothing to do with. A literal is only
 * recognised after a delimiter that cannot end an expression, so `a / b` stays division. The
 * result feeds the brace counter alone, never name extraction, which bounds the cost of a false
 * positive to a stripped span that contained no braces anyway.
 */
function stripRegexLiterals(line: string): string {
  return line.replace(/([=(,[:]|^|\breturn\b)(\s*)\/(?![\s/*])(?:\\.|[^\\/\n])*\//g, '$1$2')
}

/** Kind for a type-header keyword. */
function typeKindFor(keyword: string): string {
  return keyword === 'struct' ? 'struct'
    : keyword === 'enum' ? 'enum'
    : keyword === 'protocol' ? 'protocol'
    : keyword === 'extension' ? 'extension'
    : keyword === 'actor' ? 'actor'
    : 'class'
}

export function extractSwift(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const typeStack: TypeFrame[] = []
  let braceDepth = 0
  let commentDepth = 0
  let mlState: MultilineStringState | null = null

  /**
   * Emit whichever member declaration `text` holds, if any.
   *
   * Shared by the in-body branch and the single-line-type-body tail below, so `struct S { var x = 0 }`
   * and the same member written over three lines resolve identically instead of the one-line form
   * silently indexing only its type.
   */
  function pushMembers(text: string, parent: string | undefined, lineNum: number, sig: string): boolean {
    const noAttr = stripLeadingAttributes(text)
    const kind = parent === undefined ? 'function' : 'method'
    const initM = INIT_RE.exec(noAttr)
    if (initM) {
      symbols.push(makeLineSymbol(filePath, initM[1] ?? 'init', 'method', lineNum, sig, parent, lines, 'c'))
      return true
    }
    if (DEINIT_RE.exec(noAttr)) {
      symbols.push(makeLineSymbol(filePath, 'deinit', 'method', lineNum, sig, parent, lines, 'c'))
      return true
    }
    const subscriptM = SUBSCRIPT_RE.exec(noAttr)
    if (subscriptM) {
      symbols.push(makeLineSymbol(filePath, subscriptM[1] ?? 'subscript', 'method', lineNum, sig, parent, lines, 'c'))
      return true
    }
    const fm = FUNC_RE.exec(noAttr)
    if (fm) {
      symbols.push(makeLineSymbol(filePath, unquoteIdent(fm[1] ?? ''), kind, lineNum, sig, parent, lines, 'c'))
      return true
    }
    const propM = PROPERTY_RE.exec(noAttr)
    if (propM) {
      const names = splitDeclaratorNames(propM[1] ?? '')
      for (const name of names) {
        symbols.push(makeLineSymbol(filePath, name, 'var', lineNum, sig, parent, lines, 'c'))
      }
      return names.length > 0
    }
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line Swift `"""..."""` string spans first, state carried across lines, so
    // braces inside one of those can never desync braceDepth. Skipped on lines that start
    // already inside a block comment (mlState null) to avoid misreading comment prose that
    // happens to contain opener-shaped text.
    let mlLine = rawLine
    if (mlState !== null || commentDepth === 0) {
      const masked = stripMultilineStringSpan(rawLine, mlState, 'swift')
      mlLine = masked.code
      mlState = masked.state
    }

    // Strip /* */ block-comment spans (depth carried across lines) so braces inside commented-out
    // code are not counted toward braceDepth. Swift block comments nest, so this uses the
    // depth-aware helper rather than the boolean one the non-nesting languages share.
    const { code: blockStripped, depth: nextCommentDepth } = stripNestedBlockCommentSpan(mlLine, commentDepth)
    commentDepth = nextCommentDepth

    // Strip a trailing `//` line comment (quote-aware) so braces/text after it are ignored.
    const line = stripLineComment(blockStripped).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      const braceLine = stripRegexLiterals(stripStringLiterals(line))
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    const strippedNoAttr = stripLeadingAttributes(stripped)

    // import
    const importM = IMPORT_RE.exec(strippedNoAttr)
    if (importM) {
      imports.push({ kind: 'import', target: unquoteIdent(importM[1] ?? ''), line: lineNum })
    }

    // class/struct/enum/protocol/extension. Recognized at file scope (brace depth 0), or while
    // genuinely one brace level inside another type's body (a real nested type/extension member)
    // -- matches kotlin.ts's classDetectionGateOk gate, so a type declared local to a function
    // body is never mistaken for a member of the enclosing type. Depth is the gate rather than
    // leading whitespace, which carries no meaning in Swift: a file-scope declaration indented
    // inside a `#if os(iOS)` region is still file-scope.
    const outerFrame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    const outerDepthInType = outerFrame !== null ? braceDepth - outerFrame.startDepth : 0
    const typeDetectionGateOk = typeStack.length === 0 || outerDepthInType === 1
    const tm = typeDetectionGateOk && (braceDepth === 0 || typeStack.length > 0)
      ? TYPE_HEADER_RE.exec(strippedNoAttr)
      : null
    if (tm) {
      const tname = unquoteIdent(tm[2] ?? '')
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, tname, typeKindFor(tm[1] ?? 'class'), lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      typeStack.push({ name: tname, startDepth: braceDepth, bodyEntered: false })
      // A type whose whole body is on its own line (`struct S { var value = 0 }`) reaches the
      // member branch below at depthInType 0, so its members were dropped. Scan the tail here.
      const open = strippedNoAttr.indexOf('{')
      if (open !== -1) {
        const tail = strippedNoAttr.slice(open + 1).replace(/\}\s*$/, '').trim()
        if (tail) pushMembers(tail, tname, lineNum, tail.slice(0, 200))
      }
    }

    const frame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    if (frame !== null && tm === null) {
      const depthInType = braceDepth - frame.startDepth
      // === 1, not >= 1: a local var/func declared inside a method body sits at depthInType 2+
      // (matches kotlin.ts/csharp.ts, which gate the same way) -- an ungated >= 1 check would
      // index locals declared inside a method as if they were members of the enclosing type.
      if (depthInType === 1) {
        pushMembers(line, frame.name, lineNum, stripped.slice(0, 200))
      }
    } else if (frame === null && braceDepth === 0) {
      // `init`/`deinit`/`subscript` are only ever type members in Swift, never legal at top
      // level, so pushMembers' parent-less form covers the two shapes that are: a function and
      // a file-scope `let`/`var`, which is how Swift spells a global constant.
      pushMembers(line, undefined, lineNum, stripped.slice(0, 200))
    }

    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal is never counted as real nesting. Walk char-by-char (rather than a single
    // open-count minus close-count) so a same-line open+close (`struct Empty {}`) still marks
    // bodyEntered -- the net delta for that line is zero, but depth genuinely peaked one above
    // the frame's start in between the two braces, which a batched delta can never observe.
    const braceLine = stripRegexLiterals(stripStringLiterals(line))
    for (const ch of braceLine) {
      if (ch === '{') {
        braceDepth++
        const top = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
        if (top !== null && braceDepth > top.startDepth) {
          top.bodyEntered = true
        }
      } else if (ch === '}') {
        braceDepth--
      }
    }
    // Pop finished type frames. A frame only pops once its own opening brace has actually been
    // entered (bodyEntered) -- this guards a type whose header spans multiple lines (Allman-
    // style `struct Foo` / `{`, or a multi-line `where` clause), where braceDepth still equals
    // the frame's start depth on the header line itself. Every Swift type declaration requires
    // a `{ }` body (unlike Kotlin's brace-less primary-constructor-only data class), so no
    // separate "pending pop" tracking is needed here.
    while (typeStack.length > 0) {
      const top = typeStack[typeStack.length - 1]!
      if (top.bodyEntered && braceDepth <= top.startDepth) {
        typeStack.pop()
      } else {
        break
      }
    }
  }

  return { symbols, imports }
}
