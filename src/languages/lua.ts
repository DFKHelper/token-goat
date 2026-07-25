/**
 * Lua symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: `function` declarations (top-level and nested), local functions,
 * and `local` variable declarations. Lua's table-based class patterns are
 * not extracted (no distinct OOP syntax, just conventions).
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripLineComment,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

interface FunctionFrame {
  name: string
  endKeywordNeeded: boolean
}

// `function foo(...)`, `function M.foo(...)`, `function M.N:foo(...)`
// Captures the full name (including any dot/colon paths).
const FUNC_RE = /^function\s+([A-Za-z_][A-Za-z0-9_.]*(?::[A-Za-z_][A-Za-z0-9_]*)?)/

// `local function foo(...)` — local keyword followed by function declaration.
const LOCAL_FUNC_RE = /^local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/

// `local x`, `local x, y, z = ...` — extract only the first variable name.
const LOCAL_VAR_RE = /^local\s+([A-Za-z_][A-Za-z0-9_]*)/

export function extractLua(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const funcStack: FunctionFrame[] = []

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip a trailing `--` line comment (Lua uses `--` for line comments, not `//`).
    const line = stripLineComment(rawLine, ['--']).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // `function` — both top-level and nested
    const fm = FUNC_RE.exec(stripped)
    if (fm) {
      const fname = fm[1] ?? ''
      // Extract just the final name (after any dots) for symbol indexing.
      const baseName = fname.split('.').pop() ?? fname
      if (funcStack.length > 0) {
        // Nested function (inside another function).
        const parent = funcStack[funcStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        // Top-level function.
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200)))
      }
      funcStack.push({ name: baseName, endKeywordNeeded: true })
      continue
    }

    // `local function foo(...)`
    const lfm = LOCAL_FUNC_RE.exec(stripped)
    if (lfm) {
      const fname = lfm[1] ?? ''
      if (funcStack.length > 0) {
        // Local function inside another function — treat as nested.
        const parent = funcStack[funcStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        // Top-level local function.
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
      funcStack.push({ name: fname, endKeywordNeeded: true })
      continue
    }

    // `local variable` — only at top-level (a local inside a function is not indexed).
    if (!isIndented) {
      const lvm = LOCAL_VAR_RE.exec(stripped)
      if (lvm) {
        symbols.push(makeLineSymbol(filePath, lvm[1] ?? '', 'variable', lineNum, stripped.slice(0, 200)))
      }
    }

    // Pop finished function frames when we see `end` keyword.
    if (stripped === 'end' || /^end\s/.test(stripped) || /^end$/.test(stripped)) {
      if (funcStack.length > 0) {
        funcStack.pop()
      }
    }
  }

  return { symbols, imports }
}
