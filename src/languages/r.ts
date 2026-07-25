/**
 * R symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: function definitions assigned to variables (`foo <- function(...)`,
 * `bar = function(...)`, and R 4.1's `baz <- \(...)` lambda shorthand), and S4
 * class definitions via `setClass`.
 *
 * R's symbol surface is thin compared to other languages — most "definitions"
 * are just variable assignments, so we focus on the most salient patterns:
 * function assignments and S4 classes.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripLineComment,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

// `foo <- function(...)`, `bar = function(...)` (R uses both <- and = for assignment),
// and R 4.1's (2021) native backslash-lambda shorthand `baz <- \(...)`. The `\` form is now
// idiomatic; requiring the literal `function` keyword dropped every named lambda defined with
// it. A bare `\` is only ever the lambda shorthand in R, so `<name> <- \(` is unambiguous.
// Captures the variable name before the assignment operator.
const FUNC_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:<-|=)\s*(?:function|\\)\s*\(/

// `setClass("MyClass", ...)` — S4 class definition (first arg is the class name as a string)
const SETCLASS_RE = /setClass\s*\(\s*["']([A-Za-z_][A-Za-z0-9_.]*)/

// `setMethod("methodName", ...)` — S4 method definition
const SETMETHOD_RE = /setMethod\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]+)/

export function extractR(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip a trailing `#` line comment (R uses `#` for line comments).
    const line = stripLineComment(rawLine, ['#']).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // Function assignment — top-level only
    if (!isIndented) {
      const fm = FUNC_ASSIGN_RE.exec(stripped)
      if (fm) {
        symbols.push(makeLineSymbol(filePath, fm[1] ?? '', 'function', lineNum, stripped.slice(0, 200)))
        continue
      }

      // S4 class definition
      const cm = SETCLASS_RE.exec(stripped)
      if (cm) {
        symbols.push(makeLineSymbol(filePath, cm[1] ?? '', 'class', lineNum, stripped.slice(0, 200)))
        continue
      }

      // S4 method definition (less common, but worth capturing)
      const mm = SETMETHOD_RE.exec(stripped)
      if (mm) {
        symbols.push(makeLineSymbol(filePath, mm[1] ?? '', 'function', lineNum, stripped.slice(0, 200)))
      }
    }
  }

  return { symbols, imports }
}
