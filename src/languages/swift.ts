/**
 * Swift symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, structs, enums, protocols, extensions, top-level
 * functions, methods (including init/deinit/subscript), properties, and
 * `import` directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripBlockCommentSpan,
  stripLineComment,
  stripMultilineStringSpan,
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

// `@testable import Foo` (test targets) and submodule imports (`import class UIKit.UIView`)
// are both common real-world forms; the optional submodule-kind prefix is skipped so the
// captured target is always the module/submodule path itself.
const IMPORT_RE =
  /^(?:@testable\s+)?import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/

// Swift idiomatically places attributes on their own line above a declaration, but also allows
// them inline (`@objc func foo() {}`, `@available(iOS 13, *) public struct Foo {}`,
// `@MainActor class Foo {}`) -- the same shape kotlin.ts's stripLeadingAnnotations and
// csharp.ts's stripLeadingAttributes strip for their own languages. Without stripping this
// first, every regex below (all `^`-anchored against the modifier alternation or declaration
// keyword directly) would silently drop the whole attributed declaration.
const LEADING_ATTRIBUTE_RE =
  /^\s*(?:@[A-Za-z_][A-Za-z0-9_.]*(?:\([^()]*\))?\s+)+/
function stripLeadingAttributes(s: string): string {
  return s.replace(LEADING_ATTRIBUTE_RE, '')
}

// Shared modifier alternation for func/init/subscript/property declarations. `(?:set)`-suffixed
// access modifiers (`private(set) var x`) are real Swift syntax restricting the setter's
// visibility independently of the getter's, so `(?:\(set\))?` is folded into the access-level
// alternative rather than left to desync the match entirely.
const MODIFIER_ALT =
  '(?:(?:public|private|fileprivate|internal|open)(?:\\(set\\))?|static|final|class|override|' +
  'required|convenience|mutating|nonmutating|dynamic|nonisolated|async|lazy|weak|unowned|indirect)'

// Function name is either a plain identifier or an operator-overload symbol (`func ==(...)`,
// `func +(...)`) -- Swift's operator functions are real top-level and member declarations, not
// an edge case a language extractor can ignore. Generics come after the name in Swift
// (`func foo<T: Comparable>(x: T) -> T`), unlike Kotlin's `fun <T> foo(...)`.
const FUNC_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  'func\\s+([A-Za-z_][A-Za-z0-9_]*|[+\\-*/%=!<>&|^~]+)\\s*(?:<[^>]*>)?\\s*\\(',
)

// `init`/`init?`/`init!` (failable initializers) and `deinit` (no parameters, no modifiers).
const INIT_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  '(init[?!]?)\\s*(?:<[^>]*>)?\\s*\\(',
)
const DEINIT_RE = /^\s*deinit\s*\{/

const SUBSCRIPT_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  '(subscript)\\s*(?:<[^>]*>)?\\s*\\(',
)

// `var`/`let` property declaration -- matches a stored property (`var x: Int = 0`), a
// type-annotated-only property (`let y: String`), and a computed property's header line
// (`var z: Int { get { ... } }` / `var z: Int { get set }`), since all three share the same
// `var|let name` prefix and this regex never looks past the name.
const PROPERTY_RE = new RegExp(
  '^\\s*(?:' + MODIFIER_ALT + '\\s+)*' +
  '(?:var|let)\\s+([A-Za-z_][A-Za-z0-9_]*)',
)

// The keyword itself is captured (group 1) so the caller can map it to the right symbol kind --
// class/struct/enum/protocol/extension all share this one header shape, differing only in
// keyword and in what an "extension" conceptually is (adds members to an existing type rather
// than declaring a new one, mirroring how kotlin.ts's companion-object handling folds members
// into their enclosing frame's name). The name may be dotted (`extension Array.Index`,
// `extension Foo.Bar`) for nested-type extension targets.
const TYPE_HEADER_RE = new RegExp(
  '^(?:(?:public|private|fileprivate|internal|open|final|indirect)\\s+)*' +
  '(class|struct|enum|protocol|extension)\\s+' +
  '([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)',
)

export function extractSwift(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const typeStack: TypeFrame[] = []
  let braceDepth = 0
  let inComment = false
  let mlState: MultilineStringState | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line Swift `"""..."""` string spans first, state carried across lines, so
    // braces inside one of those can never desync braceDepth. Skipped on lines that start
    // already inside a block comment (mlState null) to avoid misreading comment prose that
    // happens to contain opener-shaped text.
    let mlLine = rawLine
    if (mlState !== null || !inComment) {
      const masked = stripMultilineStringSpan(rawLine, mlState, 'swift')
      mlLine = masked.code
      mlState = masked.state
    }

    // Strip /* */ block-comment spans (state carried across lines via inComment) so braces
    // inside commented-out code are not counted toward braceDepth. Swift block comments can
    // nest, but stripBlockCommentSpan (shared with kotlin.ts/csharp.ts) does not model nesting
    // either -- same accepted imprecision as those adapters.
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(mlLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment (quote-aware) so braces/text after it are ignored.
    const line = stripLineComment(blockStripped).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      const braceLine = stripStringLiterals(line)
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // import
    const importM = IMPORT_RE.exec(stripped)
    if (importM) {
      imports.push({ kind: 'import', target: importM[1] ?? '', line: lineNum })
    }

    // class/struct/enum/protocol/extension. Recognized at column 0 (top-level), or indented
    // while genuinely one brace level inside another type's body (a real nested type/extension
    // member) -- matches kotlin.ts's classDetectionGateOk gate, so a type declared local to a
    // function body is never mistaken for a member of the enclosing type.
    const outerFrame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    const outerDepthInType = outerFrame !== null ? braceDepth - outerFrame.startDepth : 0
    const typeDetectionGateOk = typeStack.length === 0 || outerDepthInType === 1
    const strippedNoAttr = stripLeadingAttributes(stripped)
    const tm = typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? TYPE_HEADER_RE.exec(strippedNoAttr) : null
    if (tm) {
      const keyword = tm[1] ?? 'class'
      const tname = tm[2] ?? ''
      const kind = keyword === 'struct' ? 'struct'
        : keyword === 'enum' ? 'enum'
        : keyword === 'protocol' ? 'protocol'
        : keyword === 'extension' ? 'extension'
        : 'class'
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, tname, kind, lineNum, stripped.slice(0, 200), parent))
      typeStack.push({ name: tname, startDepth: braceDepth, bodyEntered: false })
    }

    const frame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    if (frame !== null) {
      const depthInType = braceDepth - frame.startDepth
      // === 1, not >= 1: a local var/func declared inside a method body sits at depthInType 2+
      // (matches kotlin.ts/csharp.ts, which gate the same way) -- an ungated >= 1 check would
      // index locals declared inside a method as if they were members of the enclosing type.
      if (depthInType === 1) {
        const lineNoAttr = stripLeadingAttributes(line)
        const initM = INIT_RE.exec(lineNoAttr)
        const deinitM = DEINIT_RE.exec(lineNoAttr)
        const subscriptM = SUBSCRIPT_RE.exec(lineNoAttr)
        const fm = FUNC_RE.exec(lineNoAttr)
        if (initM) {
          symbols.push(makeLineSymbol(filePath, initM[1] ?? 'init', 'method', lineNum, stripped.slice(0, 200), frame.name))
        } else if (deinitM) {
          symbols.push(makeLineSymbol(filePath, 'deinit', 'method', lineNum, stripped.slice(0, 200), frame.name))
        } else if (subscriptM) {
          symbols.push(makeLineSymbol(filePath, subscriptM[1] ?? 'subscript', 'method', lineNum, stripped.slice(0, 200), frame.name))
        } else if (fm) {
          symbols.push(makeLineSymbol(filePath, fm[1] ?? '', 'method', lineNum, stripped.slice(0, 200), frame.name))
        } else {
          const propM = PROPERTY_RE.exec(lineNoAttr)
          if (propM) {
            symbols.push(makeLineSymbol(filePath, propM[1] ?? '', 'var', lineNum, stripped.slice(0, 200), frame.name))
          }
        }
      }
    } else if (!isIndented) {
      // `init`/`deinit`/`subscript` are only ever type members in Swift, never legal at
      // top level, so only FUNC_RE is checked here (unlike the in-type branch above).
      const lineNoAttr = stripLeadingAttributes(line)
      const fm = FUNC_RE.exec(lineNoAttr)
      if (fm) {
        symbols.push(makeLineSymbol(filePath, fm[1] ?? '', 'function', lineNum, stripped.slice(0, 200)))
      }
    }

    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal is never counted as real nesting. Walk char-by-char (rather than a single
    // open-count minus close-count) so a same-line open+close (`struct Empty {}`) still marks
    // bodyEntered -- the net delta for that line is zero, but depth genuinely peaked one above
    // the frame's start in between the two braces, which a batched delta can never observe.
    const braceLine = stripStringLiterals(line)
    for (const ch of braceLine) {
      if (ch === '{') {
        braceDepth++
        if (frame !== null && braceDepth > frame.startDepth) {
          frame.bodyEntered = true
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
