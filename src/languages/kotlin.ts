/**
 * Kotlin symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: classes, interfaces, objects, data classes, sealed classes,
 * companion objects, top-level functions, methods, and SCREAMING_SNAKE const vals.
 * Import directives are returned as import entries.
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

interface ClassFrame {
  name: string
  braceDepth: number
  bodyEntered: boolean
  // Running open-minus-close count of the primary constructor's (and any same-line supertype
  // call's) parentheses, tracked only until bodyEntered flips true. A body-less class/interface/
  // object header (e.g. `data class Point(val x: Int, val y: Int)`, no trailing `{`) balances
  // this back to 0 with no body ever opening -- see the pendingPop resolution below.
  parenBalance: number
  // Set once a line leaves the frame body-less with balanced parens AND that line does not end
  // in `:`/`,` (a Kotlin wrapped-supertype-list continuation marker). Popping does not happen
  // immediately: a header can still legally continue onto the next line via a *leading* `:`/`,`
  // (e.g. `class Foo(val x: Int)` / `    : Bar(x) {`), so the pop is deferred to the start of the
  // next line, once that line's leading character rules out a continuation too.
  pendingPop: boolean
}

const IMPORT_RE = /^import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)/

// Kotlin idiomatically places annotations on the same line as the declaration they annotate
// (`@Composable fun Foo() {}`, `@Test fun bar() {}`, `@Serializable data class Foo(...)`),
// but FUN_RE/CONST_RE/CLASS_HEADER_RE/COMPANION_RE/TOP_FUN_RE are all `^`-anchored against
// their modifier alternation or declaration keyword directly, with no room for a leading
// annotation token. Stripping it before matching (never before slicing the signature/docstring,
// which still use the original line) fixes the whole family at once.
const LEADING_ANNOTATION_RE =
  /^\s*(?:@[A-Za-z_][A-Za-z0-9_.]*(?::[A-Za-z_][A-Za-z0-9_]*)?(?:\([^()]*\))?\s+)+/
function stripLeadingAnnotations(s: string): string {
  return s.replace(LEADING_ANNOTATION_RE, '')
}

// Kotlin extension functions (`fun String.reverse(): String {}`, `fun <T> List<T>.second(): T {}`) prefix the function name with a receiver type followed by a dot -- without this optional non-capturing receiver group, the capture group landed on the receiver's leading identifier (or the whole match failed once a generic `<...>` receiver like `List<T>` was involved), so every extension function/method in a Kotlin file was silently dropped from the index. RECEIVER_RE allows identifiers, generic brackets, `?` (nullable types), commas (multi-param generics), and dots (qualified receiver types) up to the final dot before the actual function name.
const RECEIVER_RE = '(?:[A-Za-z_][A-Za-z0-9_<>?.,\\s]*\\.)?'

const FUN_RE = new RegExp(
  '^\\s*(?:(?:public|internal|protected|private|open|override|abstract|' +
  'suspend|inline|infix|operator|external|actual|expect|final|sealed|tailrec)\\s+)*' +
  'fun\\s+(?:<[^>]*>\\s*)?' + RECEIVER_RE + '([A-Za-z_][A-Za-z0-9_]*)\\s*[(<]',
)

const CONST_RE = new RegExp(
  '^\\s*(?:(?:public|internal|protected|private|open|override|abstract|' +
  'final|actual|expect|const|lateinit|companion)\\s+)*' +
  '(?:const\\s+)?val\\s+([A-Z_][A-Z0-9_]*)\\s*(?::|=)',
)

// The keyword itself is captured (group 1) alongside the name (group 2) so the caller can tell
// `class`/`interface`/`object`/`enum class` apart -- without it, every declaration this matches
// was hardcoded to kind 'class' regardless of which keyword actually introduced it, silently
// mislabeling every Kotlin `interface Foo { ... }` and singleton `object Foo { ... }` (both very
// common idioms - dependency-inversion interfaces and Kotlin's idiomatic singleton/utility
// pattern) as a plain class in the index.
const CLASS_HEADER_RE = new RegExp(
  '^(?:(?:public|internal|protected|private|open|abstract|sealed|data|' +
  'inner|expect|actual|value|annotation|fun)\\s+)*' +
  '(class|interface|object|enum\\s+class)\\s+([A-Za-z_][A-Za-z0-9_]*)',
)

// A companion object precedes `object` with the `companion` keyword, which is not a member of
// CLASS_HEADER_RE's modifier list, so `companion object { ... }` never matches CLASS_HEADER_RE --
// no frame gets pushed for it, yet its brace still increments braceDepth, silently dropping every
// member declared inside it from the index (depthInClass never comes back to 1 relative to the
// enclosing class). A companion object may optionally carry a name (`companion object Named { }`);
// when unnamed, Kotlin's own implicit name for it is `Companion`, used here as the fallback so
// members still resolve to a stable, real, referenceable parent name.
const COMPANION_RE = new RegExp(
  '^(?:(?:public|internal|protected|private)\\s+)*' +
  'companion\\s+object(?:\\s+([A-Za-z_][A-Za-z0-9_]*))?\\b',
)

const TOP_FUN_RE = new RegExp(
  '^(?:(?:public|internal|private|suspend|inline|infix|operator|' +
  'external|actual|expect|tailrec)\\s+)*' +
  'fun\\s+(?:<[^>]*>\\s*)?' + RECEIVER_RE + '([A-Za-z_][A-Za-z0-9_]*)\\s*[(<]',
)

export function extractKotlin(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const classStack: ClassFrame[] = []
  let braceDepth = 0
  let inComment = false
  let mlState: MultilineStringState | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line Kotlin `"""..."""` raw string spans first, state carried across lines, so
    // braces inside one of those can never desync braceDepth. Skipped on lines that start
    // already inside a block comment (mlState null) to avoid misreading comment prose that
    // happens to contain opener-shaped text.
    let mlLine = rawLine
    if (mlState !== null || !inComment) {
      const masked = stripMultilineStringSpan(rawLine, mlState, 'kotlin')
      mlLine = masked.code
      mlState = masked.state
    }

    // Strip /* */ block-comment spans (state carried across lines via inComment) so braces
    // inside commented-out code are not counted toward braceDepth. A `/*` inside an open quote
    // is not treated as a comment opener.
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(mlLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment (quote-aware) so braces/text after it are ignored.
    const line = stripLineComment(blockStripped)
    const stripped = line.trim()

    if (!stripped) {
      // Brace-count on a string-stripped copy of the line, matching the depth call site below.
      const braceLine = stripStringLiterals(line)
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    // Resolve a body-less pop deferred from a prior line. A Kotlin class header can legally
    // continue onto this new line several ways: a wrapped supertype list via a *leading* `:` or
    // `,` (`class Foo(val x: Int)` / `    : Bar(x) {`), an Allman-style body brace on its own
    // line (`class Foo` / `{`), or a multi-line `where` type-constraint clause (`class Foo<T>` /
    // `    where T : Comparable<T> {`). A pending pop only fires once this line's leading
    // character rules out all of those too. Must run before class/companion/member detection
    // below so a genuinely finished body-less header's stack frame is gone before this new line
    // is evaluated as its own (possibly top-level) declaration.
    if (classStack.length > 0) {
      const pendingTop = classStack[classStack.length - 1]!
      if (pendingTop.pendingPop) {
        if (
          stripped.startsWith(':') ||
          stripped.startsWith(',') ||
          stripped.startsWith('{') ||
          /^where\b/.test(stripped)
        ) {
          pendingTop.pendingPop = false
        } else {
          classStack.pop()
        }
      }
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // import
    const importM = IMPORT_RE.exec(stripped)
    if (importM) {
      imports.push({ kind: 'import', target: importM[1] ?? '', line: lineNum })
    }

    // Class/interface/object declaration. Recognized at column 0 (top-level), or indented while
    // genuinely inside another class's body (classStack non-empty) - this captures a real
    // nested/inner class (companion object member, sealed subclass, nested data class) without
    // also matching arbitrarily indented top-level code that has no enclosing class.
    // Match against the trimmed line: CLASS_HEADER_RE is column-0-anchored (`^`), so an
    // indented nested class header would never match against the raw, still-indented line.
    // Companion objects only occur nested inside a class/object body (classStack non-empty), and
    // are checked ahead of CLASS_HEADER_RE since the `companion` keyword would otherwise prevent
    // CLASS_HEADER_RE from matching at all (see COMPANION_RE comment above).
    // Function-local classes/companion objects (declared inside a method body) must not be
    // indexed as members of the enclosing class -- matches the depthInClass === 1 gate already
    // applied correctly to the method/const branch below (and to csharp.ts/powershell_idx.ts).
    // classStack.length === 0 covers the top-level case (no enclosing class at all); otherwise
    // the current position must be exactly one brace level inside the innermost class/companion
    // frame's body (depthInClass === 1) -- a class/companion header nested two or more levels
    // in (e.g. inside a method body) is function-local, not a real class member.
    const outerFrame = classStack.length > 0 ? classStack[classStack.length - 1]! : null
    const outerDepthInClass = outerFrame !== null ? braceDepth - outerFrame.braceDepth : 0
    const classDetectionGateOk = classStack.length === 0 || outerDepthInClass === 1
    const strippedNoAnn = stripLeadingAnnotations(stripped)
    const companionM = classStack.length > 0 && classDetectionGateOk ? COMPANION_RE.exec(strippedNoAnn) : null
    const cm = companionM === null && classDetectionGateOk && (!isIndented || classStack.length > 0) ? CLASS_HEADER_RE.exec(strippedNoAnn) : null
    if (companionM) {
      const cname = companionM[1] ?? 'Companion'
      const parent = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, cname, 'object', lineNum, line.trimEnd().slice(0, 200), parent, lines, 'c'))
      classStack.push({ name: cname, braceDepth, bodyEntered: false, parenBalance: 0, pendingPop: false })
    } else if (cm) {
      const ckeyword = cm[1] ?? 'class'
      const cname = cm[2] ?? ''
      // `enum class` collapses to the `class` branch (matches csharp.ts's precedent of no
      // distinct 'enum' kind for a class-flavored declaration); `object` maps to 'object'
      // (matching the companion-object branch above's own kind) rather than 'class', since a
      // top-level `object Foo { ... }` singleton is not a class in the index's kind vocabulary.
      const ckind = ckeyword === 'interface' ? 'interface' : ckeyword === 'object' ? 'object' : 'class'
      const parent = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, cname, ckind, lineNum, line.trimEnd().slice(0, 200), parent, lines, 'c'))
      classStack.push({ name: cname, braceDepth, bodyEntered: false, parenBalance: 0, pendingPop: false })
    }

    const frame = classStack.length > 0 ? classStack[classStack.length - 1]! : null
    if (frame !== null) {
      const depthInClass = braceDepth - frame.braceDepth
      // === 1, not >= 1: a bare statement/local declaration inside a method body sits at
      // depthInClass 2+ (matches csharp.ts / powershell_idx.ts, which gate the same way) --
      // an ungated >= 1 check indexed local functions and local SCREAMING_SNAKE vals declared
      // inside a method as if they were members of the enclosing class.
      if (depthInClass === 1) {
        const lineNoAnn = stripLeadingAnnotations(line)
        const fm = FUN_RE.exec(lineNoAnn)
        if (fm) {
          const fname = fm[1] ?? ''
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trim() : line.trimEnd()
          symbols.push(makeLineSymbol(filePath, fname, 'method', lineNum, sig.slice(0, 200), frame.name, lines, 'c'))
        }
        const constM = CONST_RE.exec(lineNoAnn)
        if (constM) {
          symbols.push(makeLineSymbol(filePath, constM[1] ?? '', 'const', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
        }
      }
    } else if (!isIndented) {
      const lineNoAnn = stripLeadingAnnotations(line)
      const tfm = TOP_FUN_RE.exec(lineNoAnn)
      if (tfm) {
        const fname = tfm[1] ?? ''
        const sigEnd = line.indexOf('{')
        const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trim() : line.trimEnd()
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, sig.slice(0, 200), undefined, lines, 'c'))
      }
      // Top-level SCREAMING_SNAKE const/val declarations (no parent class).
      const topConstM = CONST_RE.exec(lineNoAnn)
      if (topConstM) {
        symbols.push(makeLineSymbol(filePath, topConstM[1] ?? '', 'const', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
      }
    }

    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal is never counted as real nesting. Walk char-by-char (rather than a single
    // open-count minus close-count) so a same-line open+close (`class Empty {}`) still marks
    // bodyEntered - the net delta for that line is zero, but depth genuinely peaked one above
    // the frame's start in between the two braces, which a batched delta can never observe.
    const braceLine = stripStringLiterals(line)
    for (const ch of braceLine) {
      if (ch === '{') {
        braceDepth++
        if (frame !== null && braceDepth > frame.braceDepth) {
          frame.bodyEntered = true
        }
      } else if (ch === '}') {
        braceDepth--
      } else if (frame !== null && !frame.bodyEntered && ch === '(') {
        frame.parenBalance++
      } else if (frame !== null && !frame.bodyEntered && ch === ')') {
        frame.parenBalance--
      }
    }
    // A body-less class/interface/object header (`data class Point(val x: Int, val y: Int)`,
    // no trailing `{`) never flips bodyEntered, so the bodyEntered-gated pop below would leave
    // it on the stack forever, silently misattributing every later top-level declaration as one
    // of its members. Once this frame's own constructor parens (if any) are back in balance and
    // no body brace opened on this same line, its header *might* be complete -- but a wrapped
    // supertype list can still continue onto a later line (trailing `:`/`,` on this line, or a
    // leading `:`/`,` on the next), so this only arms a pending pop; the top-of-loop check above
    // resolves it once a following line proves no continuation follows.
    if (frame !== null && !frame.bodyEntered && frame.parenBalance <= 0) {
      frame.pendingPop = !(stripped.endsWith(':') || stripped.endsWith(','))
    }
    // Pop finished class frames. A frame only pops once its own opening brace has actually been
    // entered (bodyEntered) - this guards a class whose primary-constructor header spans
    // multiple lines (`class Foo(\n  val x: Int\n) {`), where braceDepth still equals the
    // frame's start depth on the header line itself, so an ungated pop would discard the class
    // context before its body is ever seen.
    while (classStack.length > 0) {
      const top = classStack[classStack.length - 1]!
      if (top.bodyEntered && braceDepth <= top.braceDepth) {
        classStack.pop()
      } else {
        break
      }
    }
  }

  return { symbols, imports }
}
