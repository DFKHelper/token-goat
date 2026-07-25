/**
 * Zig symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: `fn` (functions), `struct`, `pub fn` (public functions),
 * `const` and `var` (declarations).
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripBlockCommentSpan,
  stripLineComment,
  stripStringLiterals,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

interface ScopeFrame {
  name: string
  startDepth: number
  bodyEntered: boolean
}

// `struct Foo`, `struct`, anonymous structs are named `struct_<number>` by convention but we skip them
const STRUCT_RE = /^pub\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)|^struct\s+([A-Za-z_][A-Za-z0-9_]*)/

// `fn foo()`, `fn foo() type`, `pub fn bar()`, `fn name() return_type`
// Generics in Zig are complex; we keep it simple and just match the name.
const FUNC_RE = /(?:^|[\s(])(pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/

// `const foo = ...`, `var bar: i32 = ...`
const CONST_RE = /^const\s+([A-Za-z_][A-Za-z0-9_]*)/
const VAR_RE = /^var\s+([A-Za-z_][A-Za-z0-9_]*)/

export function extractZig(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const scopeStack: ScopeFrame[] = []
  let braceDepth = 0
  let inComment = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip /* */ block-comment spans
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(rawLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment
    const line = stripLineComment(blockStripped).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      const braceLine = stripStringLiterals(line)
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // `matched` tracks classification without an early `continue`, so a same-line opening
    // `{` (e.g. `struct Foo {`, `fn foo() {`) still falls through to the brace-counting block
    // below and can flip `bodyEntered` -- an early `continue` here would silently drop that
    // brace, leave `bodyEntered` false forever, and corrupt scope-frame popping for the rest
    // of the file (same bug class fixed in scala.ts/dart.ts).
    let matched = false

    // struct — top-level or nested
    if (!isIndented || scopeStack.length > 0) {
      const sm = STRUCT_RE.exec(stripped)
      if (sm) {
        const sname = sm[1] ?? sm[2] ?? ''
        if (sname) {
          const parent = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1]!.name : undefined
          symbols.push(makeLineSymbol(filePath, sname, 'struct', lineNum, stripped.slice(0, 200), parent))
          scopeStack.push({ name: sname, startDepth: braceDepth, bodyEntered: false })
          matched = true
        }
      }
    }

    // fn / pub fn — functions
    if (!matched && !isIndented) {
      const fm = FUNC_RE.exec(stripped)
      if (fm) {
        const fname = fm[2] ?? ''
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
        matched = true
      }
    } else if (!matched && scopeStack.length > 0) {
      // Method-like functions inside a struct
      const fm = FUNC_RE.exec(stripped)
      if (fm) {
        const fname = fm[2] ?? ''
        const parent = scopeStack[scopeStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
        matched = true
      }
    }

    // const/var declarations — top-level only
    if (!matched && !isIndented) {
      const cm = CONST_RE.exec(stripped)
      if (cm) {
        symbols.push(makeLineSymbol(filePath, cm[1] ?? '', 'const', lineNum, stripped.slice(0, 200)))
        matched = true
      }

      if (!matched) {
        const vm = VAR_RE.exec(stripped)
        if (vm) {
          symbols.push(makeLineSymbol(filePath, vm[1] ?? '', 'var', lineNum, stripped.slice(0, 200)))
        }
      }
    }

    // Brace-count on a string-stripped copy
    const braceLine = stripStringLiterals(line)
    for (const ch of braceLine) {
      if (ch === '{') {
        braceDepth++
        if (scopeStack.length > 0) {
          const frame = scopeStack[scopeStack.length - 1]!
          if (braceDepth > frame.startDepth) {
            frame.bodyEntered = true
          }
        }
      } else if (ch === '}') {
        braceDepth--
      }
    }

    // Pop finished scope frames
    while (scopeStack.length > 0) {
      const top = scopeStack[scopeStack.length - 1]!
      if (top.bodyEntered && braceDepth <= top.startDepth) {
        scopeStack.pop()
      } else {
        break
      }
    }
  }

  return { symbols, imports }
}
