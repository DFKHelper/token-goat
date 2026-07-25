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
  // true for a non-function control-flow frame (if/for/while/do) pushed only to keep the
  // stack balanced against its own `end` -- it must never be reported as a parent, so
  // parent lookup walks past these to the nearest real function frame.
  isBlock: boolean
}

/** Nearest enclosing real function name, skipping past control-flow block frames. */
function nearestFunctionName(stack: readonly FunctionFrame[]): string | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]!
    if (!frame.isBlock) return frame.name
  }
  return undefined
}

// `function foo(...)`, `function M.foo(...)`, `function M.N:foo(...)`
// Captures the full name (including any dot/colon paths).
const FUNC_RE = /^function\s+([A-Za-z_][A-Za-z0-9_.]*(?::[A-Za-z_][A-Za-z0-9_]*)?)/

// `local function foo(...)` — local keyword followed by function declaration.
const LOCAL_FUNC_RE = /^local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/

// `local x`, `local x, y, z = ...` — extract only the first variable name.
const LOCAL_VAR_RE = /^local\s+([A-Za-z_][A-Za-z0-9_]*)/

// Non-function control-flow blocks that also close with `end` (`if ... then`, `for ... do`,
// `while ... do`, bare `do ... end`). elseif/else don't open their own block (they share the
// enclosing if's `end`) and so are deliberately excluded by the leading `^if\s`/`^for\s`/etc
// anchors. `repeat ... until` closes with `until`, not `end`, so it needs no frame at all.
const BLOCK_OPEN_RE = /^(?:if\s.*\bthen|for\s.*\bdo|while\s.*\bdo|do)\s*$/

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
      const parent = nearestFunctionName(funcStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200)))
      }
      funcStack.push({ name: baseName, endKeywordNeeded: true, isBlock: false })
      continue
    }

    // `local function foo(...)`
    const lfm = LOCAL_FUNC_RE.exec(stripped)
    if (lfm) {
      const fname = lfm[1] ?? ''
      const parent = nearestFunctionName(funcStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
      funcStack.push({ name: fname, endKeywordNeeded: true, isBlock: false })
      continue
    }

    // `local variable` — only at top-level (a local inside a function is not indexed).
    if (!isIndented) {
      const lvm = LOCAL_VAR_RE.exec(stripped)
      if (lvm) {
        symbols.push(makeLineSymbol(filePath, lvm[1] ?? '', 'variable', lineNum, stripped.slice(0, 200)))
      }
    }

    // Non-function block openers (`if ... then`, `for ... do`, `while ... do`, bare `do`)
    // also close with `end` -- push a placeholder frame so that `end` pops the block instead
    // of prematurely popping the enclosing function's frame (which would corrupt parent
    // attribution for any function declared after the block, or any function genuinely
    // nested inside it).
    if (BLOCK_OPEN_RE.test(stripped)) {
      funcStack.push({ name: '', endKeywordNeeded: true, isBlock: true })
      continue
    }

    // Pop finished function/block frames when we see `end` keyword.
    if (stripped === 'end' || /^end\s/.test(stripped) || /^end$/.test(stripped)) {
      if (funcStack.length > 0) {
        funcStack.pop()
      }
    }
  }

  return { symbols, imports }
}
