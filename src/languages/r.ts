/**
 * R symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: function definitions assigned to variables (`foo <- function(...)`,
 * `bar = function(...)`, `qux <<- function(...)`, and R 4.1's `baz <- \(...)`
 * lambda shorthand), S4 and Reference classes via `setClass`/`setRefClass`, R6
 * classes bound by assignment, and S4 generics and methods via
 * `setGeneric`/`setMethod`.
 *
 * R's symbol surface is thin compared to other languages — most "definitions"
 * are just variable assignments, so we focus on the most salient patterns:
 * function assignments and S4 classes.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  buildLineIndex,
  findMatchingBraceEndLine,
  matchRRawOpener,
  offsetToLine,
  stripLineComment,
  stripMultilineStringSpan,
  type AdapterImport,
  type MultilineStringState,
  makeSpanSymbol,
} from './common.js'
import { countContentLines } from '../util.js'

// `foo <- function(...)`, `bar = function(...)` (R uses both <- and = for assignment),
// and R 4.1's (2021) native backslash-lambda shorthand `baz <- \(...)`. The `\` form is now
// idiomatic; requiring the literal `function` keyword dropped every named lambda defined with
// it. A bare `\` is only ever the lambda shorthand in R, so `<name> <- \(` is unambiguous.
// Captures the variable name before the assignment operator, in either of R's two spellings.
// A backtick-quoted name is how R defines an infix operator (`` `%+%` <- function(a, b) ``, the
// form magrittr's `%>%` itself uses) and every S3 method on an operator or extractor generic
// (`` `[.myclass` <- ``, `` `+.difftime` <- ``, `` `myattr<-` <- ``); a plain-name-only pattern
// dropped all of them from the index. A leading dot is likewise a legal R name start, and it is
// what every package's own load hooks are called (`.onLoad`, `.onAttach`, `.onUnload`), so those
// went unindexed too.
// `<<-` is the third leftward spelling (R Language Definition, "Assignment": `<-`, `=` and the superassignment `<<-`), used at top level to define into the global environment; it was not accepted, so such a definition was absent from the index.
const FUNC_ASSIGN_RE = /^(?:`([^`]+)`|([A-Za-z._][A-Za-z0-9_.]*))\s*(?:<<?-|=)\s*(?:function|\\)\s*\(/

// `Account <- R6Class(...)` / `Account <- R6::R6Class("Account", ...)` (R6 package docs, R6Class): the class is the object bound by the assignment, since R6Class's own `classname` argument is optional and code calls `Account$new()`, so the bound name is the one indexed.
const R6CLASS_RE = /^(?:`([^`]+)`|([A-Za-z._][A-Za-z0-9_.]*))\s*(?:<<?-|=)\s*(?:R6::)?R6Class\s*\(/

// A definition is the whole statement, so both patterns are anchored to the start of the line,
// optionally through an assignment (`Point <- setClass("Point", ...)` is idiomatic). Unanchored,
// any line that merely mentioned the call inside a string -- `msg <- 'see setClass("Bogus")'` --
// produced a symbol for a class that does not exist.

// `setClass("MyClass", ...)` — S4 class definition (first arg is the class name as a string)
// `setRefClass("Name", ...)` (methods package, ReferenceClasses) takes the class name in the same first-argument slot and is matched by the same pattern.
const SETCLASS_RE = /^(?:[A-Za-z_][A-Za-z0-9_.]*\s*(?:<-|=)\s*)?set(?:Ref)?Class\s*\(\s*["']([A-Za-z_][A-Za-z0-9_.]*)/

// `setMethod("methodName", ...)` — S4 method definition; `setGeneric("name", ...)` (methods package, setGeneric) declares the generic those methods attach to, and had no pattern, so a file defining only generics indexed nothing.
const SETMETHOD_RE = /^(?:[A-Za-z_][A-Za-z0-9_.]*\s*(?:<-|=)\s*)?set(?:Method|Generic)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_.]*)/

/**
 * Offset of the `)` closing the parenthesis that opens at `openIndex`, or null if it never closes.
 *
 * Quote-aware for the same reason `findMatchingBraceEndLine` is: R default arguments routinely
 * carry a bracket inside a string (`sep = ")"`), and counting that one desynchronises the walk for
 * the whole rest of the file.
 */
function matchingParenIndex(content: string, openIndex: number): number | null {
  let depth = 0
  let quote: string | null = null
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    // R comments run to end of line, and a `)` inside one is not a delimiter. Backticks quote a
    // name rather than a value in R, but they hide a `)` from the walk just as quotes do.
    if (ch === '#') {
      while (i < content.length && content[i] !== '\n') i++
      continue
    }
    // A raw character constant takes no escapes and may hold an unpaired quote, so it is skipped whole by the shared rule rather than read as an ordinary string: `f <- function(x = r"(a"b)")` re-pairs into code otherwise, and the `)` of the constant's own closer then reads as the end of the parameter list.
    const rOpen = matchRRawOpener(content, i)
    if (rOpen !== null) {
      const end = content.indexOf(rOpen.closer, rOpen.openerEnd)
      if (end === -1) return null
      i = end + rOpen.closer.length - 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

/**
 * Last line of a definition whose parameter list opens at `parenIndex`, or `fallback` when there is
 * no braced body to span.
 *
 * R does not require braces: `square <- function(x) x * x` is a complete definition and genuinely
 * one line. That is why the step from the closing parenthesis to the body crosses whitespace only.
 * Anything else there means this function has no block, and a scan that kept looking for a `{`
 * would hand it the next unrelated block in the file and swallow everything in between.
 */
function bracedBodyEndLine(
  content: string,
  lineIndex: readonly number[],
  parenIndex: number,
  totalLines: number,
  fallback: number,
): number {
  const close = matchingParenIndex(content, parenIndex)
  if (close === null) return fallback
  let j = close + 1
  while (j < content.length) {
    const ch = content[j]
    if (ch === '#') {
      // R treats a comment as whitespace, so one sitting between the signature and the body must
      // not decide that this function has no body at all.
      while (j < content.length && content[j] !== '\n') j++
      continue
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') break
    j++
  }
  if (content[j] !== '{') return fallback
  // backtickQuote: R quotes identifiers with backticks and such a name may contain `{`, `}`, or `#`
  // (e.g. `` `a}b` <- 1 `` in a body); without it the `}` ends the span early. matchingParenIndex
  // already handles backticks in the signature for the same reason.
  // rRawStrings: a `}` or a stray `"` inside an `r"(...)"` constant in the body is text, not code, and the shared scan needs the same rule the parameter-list walk above uses.
  return findMatchingBraceEndLine(content, j, totalLines, lineIndex, '#', { backtickQuote: true, rRawStrings: true })
}

/**
 * Last line of an S4 `setClass`/`setMethod` call: the line its own argument list closes on.
 *
 * The body of an S4 method is an argument of the call, so the call's closing parenthesis is the end
 * of the definition -- there is no separate block to find.
 */
function callEndLine(
  content: string,
  lineIndex: readonly number[],
  parenIndex: number,
  fallback: number,
): number {
  const close = matchingParenIndex(content, parenIndex)
  return close === null ? fallback : offsetToLine(lineIndex, close)
}

export function extractR(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)
  // Offsets into the raw `content`, not into any per-line copy: a body span is the one thing here
  // that cannot be decided from a single line.
  const lineIndex = buildLineIndex(content)
  const totalLines = countContentLines(content)
  // The stored body is what `read` prints, so it has to be the whole span rather than the
  // signature line: a span that says four lines and a body that holds one is worse than either.
  const spanBody = (startLine: number, endLine: number): string =>
    lines.slice(startLine - 1, endLine).join('\n')

  // R character constants span lines, both the ordinary `"..."`/`'...'` form and the raw `r"(...)"` form, so a line inside one is string content and not code. Without this state a declaration-shaped line in a string body became a symbol for a function that does not exist.
  let stringState: MultilineStringState | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    const masked = stripMultilineStringSpan(rawLine, stringState, 'r')
    stringState = masked.state

    // Strip a trailing `#` line comment (R uses `#` for line comments; R has no block comment).
    const line = stripLineComment(masked.code, ['#']).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // Function assignment — top-level only
    if (!isIndented) {
      const fm = FUNC_ASSIGN_RE.exec(stripped)
      if (fm) {
        // The line is unindented, so `stripped` starts where the raw line does and the match's own
        // offsets carry straight over to `content`. The match ends on the `(` of the parameter list.
        const parenIndex = (lineIndex[i] ?? 0) + fm[0].length - 1
        const endLine = bracedBodyEndLine(content, lineIndex, parenIndex, totalLines, lineNum)
        // Group 1 is the backtick-quoted spelling, group 2 the plain one; only one ever matches. The stored name drops the backticks so `token-goat symbol '%+%'` resolves it by the name R code actually calls it by.
        symbols.push(makeSpanSymbol(filePath, fm[1] ?? fm[2] ?? '', 'function', { startLine: lineNum, endLine, body: spanBody(lineNum, endLine) }, undefined, lines, 'hash'))
        continue
      }

      // R6 class bound to a name
      const r6 = R6CLASS_RE.exec(stripped)
      if (r6) {
        const endLine = callEndLine(content, lineIndex, (lineIndex[i] ?? 0) + r6[0].length - 1, lineNum)
        symbols.push(makeSpanSymbol(filePath, r6[1] ?? r6[2] ?? '', 'class', { startLine: lineNum, endLine, body: spanBody(lineNum, endLine) }, undefined, lines, 'hash'))
        continue
      }

      // S4 class definition
      const cm = SETCLASS_RE.exec(stripped)
      if (cm) {
        const endLine = callEndLine(content, lineIndex, (lineIndex[i] ?? 0) + (cm.index + cm[0].indexOf('(')), lineNum)
        symbols.push(makeSpanSymbol(filePath, cm[1] ?? '', 'class', { startLine: lineNum, endLine, body: spanBody(lineNum, endLine) }, undefined, lines, 'hash'))
        continue
      }

      // S4 method definition (less common, but worth capturing)
      const mm = SETMETHOD_RE.exec(stripped)
      if (mm) {
        const endLine = callEndLine(content, lineIndex, (lineIndex[i] ?? 0) + (mm.index + mm[0].indexOf('(')), lineNum)
        symbols.push(makeSpanSymbol(filePath, mm[1] ?? '', 'function', { startLine: lineNum, endLine, body: spanBody(lineNum, endLine) }, undefined, lines, 'hash'))
      }
    }
  }

  return { symbols, imports }
}
