/**
 * Lua symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: `function` declarations (top-level and nested), local functions,
 * function-value assignments (`local cb = function()`, `M.foo = function()`),
 * and `local` variable declarations. Lua's table-based class patterns are
 * not extracted (no distinct OOP syntax, just conventions).
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripLineComment,
  stripStringLiterals,
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

// Function-value assignment: `local cb = function(...)`, `handler = function(...)`,
// `M.foo = function(...)`, `Obj:method = function(...)`. This is a pervasive Lua idiom (module
// tables, callbacks) that the keyword-first FUNC_RE/LOCAL_FUNC_RE never matched: the `local`
// form was misfiled as a plain `variable` and the bare/dotted form was dropped entirely. Worse,
// neither pushed a scope frame, so the anonymous function body's own `end` prematurely popped
// the enclosing function -- the exact scope desync the rest of this file guards against.
// Captures the assigned name (dotted/colon path allowed); must be tested before LOCAL_VAR_RE.
const ASSIGN_FUNC_RE = /^(?:local\s+)?([A-Za-z_][A-Za-z0-9_.]*(?::[A-Za-z_][A-Za-z0-9_]*)?)\s*=\s*function\s*\(/

// `local x`, `local x, y, z = ...` — extract only the first variable name.
const LOCAL_VAR_RE = /^local\s+([A-Za-z_][A-Za-z0-9_]*)/

// Non-function control-flow blocks that also close with `end` (`if ... then`, `for ... do`,
// `while ... do`, bare `do ... end`). elseif/else don't open their own block (they share the
// enclosing if's `end`) and so are deliberately excluded by the leading `^if\s`/`^for\s`/etc
// anchors. `repeat ... until` closes with `until`, not `end`, so it needs no frame at all.
const BLOCK_OPEN_RE = /^(?:if\s.*\bthen|for\s.*\bdo|while\s.*\bdo|do)\s*$/

// Whether a single line already closes every block it opens (a one-liner like
// `function foo() return 1 end` or `function foo() if x then y end end`). Counts
// `function`/`do`/`if` as opens (one `end` each; `if` rather than `then` so a multi-branch
// `if ... elseif ... then ... end` -- one `end` for multiple `then`s -- doesn't false-negative)
// against `end` as closes. If a function's own opening line is already balanced, it must NOT
// push a scope frame -- doing so unconditionally left the frame permanently unpopped (no
// later bare `end` line exists to close it), corrupting parent attribution for every
// subsequent top-level function in the file.
function lineClosesItself(strippedLine: string): boolean {
  const noStrings = stripStringLiterals(strippedLine)
  const opens =
    (noStrings.match(/\bfunction\b/g) ?? []).length +
    (noStrings.match(/\bdo\b/g) ?? []).length +
    (noStrings.match(/\bif\b/g) ?? []).length
  const closes = (noStrings.match(/\bend\b/g) ?? []).length
  return closes >= opens
}

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
      if (!lineClosesItself(stripped)) {
        funcStack.push({ name: baseName, endKeywordNeeded: true, isBlock: false })
      }
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
      if (!lineClosesItself(stripped)) {
        funcStack.push({ name: fname, endKeywordNeeded: true, isBlock: false })
      }
      continue
    }

    // Function-value assignment (`local cb = function()`, `M.foo = function()`) -- index the
    // assigned name as a function (not a plain variable / dropped) and push a frame for the
    // anonymous body when it spans multiple lines, so its `end` pops the body rather than the
    // enclosing function. Checked before LOCAL_VAR_RE so `local cb = function()` classifies as a
    // function; a genuine `local x = 5` has no `= function(` and falls through to LOCAL_VAR_RE.
    const afm = ASSIGN_FUNC_RE.exec(stripped)
    if (afm) {
      const fname = afm[1] ?? ''
      // Extract just the final name after any dot/colon path, matching FUNC_RE's convention.
      const baseName = fname.split(/[.:]/).pop() ?? fname
      const parent = nearestFunctionName(funcStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200)))
      }
      if (!lineClosesItself(stripped)) {
        funcStack.push({ name: baseName, endKeywordNeeded: true, isBlock: false })
      }
      continue
    }

    // Anonymous function expression -- a callback argument (`foo(function() ... end)`) or a
    // closure used as a value (`return function() ... end`) -- matches none of
    // FUNC_RE/LOCAL_FUNC_RE/ASSIGN_FUNC_RE above (no name, no `= function(`), so without this
    // check no frame was pushed for it. Its own `end` line (when the body spans multiple
    // lines) would then pop whatever real frame happened to be on top of the stack instead,
    // corrupting parent attribution for every symbol declared afterward in the same scope --
    // the same class of desync the if/for/while block frames below already guard against, and
    // fixed the same way: push an unnamed placeholder frame so its `end` is accounted for
    // without ever being reported as a parent (isBlock, skipped by nearestFunctionName). A
    // one-liner (`foo(function() return 1 end)`) is already self-balanced and must not push a
    // frame at all, matching the same lineClosesItself gate used by the named cases above.
    if (/\bfunction\s*\(/.test(stripped) && !lineClosesItself(stripped)) {
      funcStack.push({ name: '', endKeywordNeeded: true, isBlock: true })
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
