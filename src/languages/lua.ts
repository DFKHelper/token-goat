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
  // Index in `symbols` of the function this frame opened, so its one-line placeholder span can
  // be widened to the real body when the matching `end` pops the frame. Undefined for block
  // frames and for a function that hit MAX_SYMBOLS and so has no row to widen.
  symbolIndex?: number
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

// `local x`, `local x <const>`, `local x, y, z = ...`. Lua's `local` statement is `local namelist ['=' explist]` with `namelist ::= Name {',' Name}` (Lua 5.4 reference manual, section 3.3.7 "Local Declarations"), and Lua 5.4 allows an attribute `<const>`/`<close>` after any name. The old pattern captured only the FIRST name, so `local ok, err = pcall(f)` and the module-header form `local sqrt, floor = math.sqrt, math.floor` silently dropped every name but the first from the index -- the same "one binding indexed per multi-name declaration" data loss already fixed for Go var/const specs. Group 1 is the whole name list; split it on commas and strip attributes.
const LOCAL_VAR_RE = /^local\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<\s*[A-Za-z_][A-Za-z0-9_]*\s*>)?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*<\s*[A-Za-z_][A-Za-z0-9_]*\s*>)?)*)/

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

/**
 * Strips Lua comments and long-bracket strings, carrying the open long-bracket level across
 * lines. Lua writes both block comments and multi-line strings with level-N long brackets
 * (`[[`, `[==[` ... `]]`, `]==]`, the `=` count being the level), and a block comment is just a
 * long bracket behind `--`. Only the opening line of such a span looks like a comment to a
 * line-based stripper, so the body used to be read as code: a commented-out or documented
 * `function` was indexed as a real one, and its `end` popped a live scope frame.
 * Short quoted strings are copied through untouched so that a `[[` or `--` inside one is not
 * mistaken for an opener.
 */
function stripLuaSpans(line: string, level: number | null): { code: string; level: number | null } {
  let out = ''
  let lvl = level
  let i = 0
  while (i < line.length) {
    if (lvl !== null) {
      const close = `]${'='.repeat(lvl)}]`
      const at = line.indexOf(close, i)
      if (at < 0) return { code: out, level: lvl }
      i = at + close.length
      lvl = null
      continue
    }
    const ch = line[i]!
    if (ch === '"' || ch === "'") {
      out += ch
      i += 1
      while (i < line.length && line[i] !== ch) {
        // A backslash escapes the next character, including the closing quote itself.
        if (line[i] === '\\' && i + 1 < line.length) { out += line[i]! + line[i + 1]!; i += 2; continue }
        out += line[i]!
        i += 1
      }
      if (i < line.length) { out += line[i]!; i += 1 }
      continue
    }
    if (ch === '-' && line[i + 1] === '-') {
      const block = /^--\[(=*)\[/.exec(line.slice(i))
      if (block) { lvl = block[1]!.length; i += block[0].length; continue }
      // An ordinary `--` line comment runs to end of line.
      return { code: out, level: null }
    }
    const open = /^\[(=*)\[/.exec(line.slice(i))
    if (open) { lvl = open[1]!.length; i += open[0].length; continue }
    out += ch
    i += 1
  }
  return { code: out, level: lvl }
}

export function extractLua(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const funcStack: FunctionFrame[] = []
  // Non-null while inside an unterminated long-bracket comment or string; carries its level.
  let longBracketLevel: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strips `--` line comments plus long-bracket comments and strings, which span lines.
    const span = stripLuaSpans(rawLine, longBracketLevel)
    longBracketLevel = span.level
    const line = span.code.trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'

    // `function` — both top-level and nested
    const fm = FUNC_RE.exec(stripped)
    if (fm) {
      const fname = fm[1] ?? ''
      // Extract just the final name (after any dot or colon path) for symbol indexing. The colon
      // matters as much as the dot: `function M:bar()` is the idiomatic method form, and splitting
      // on the dot alone stored it whole as `M:bar`, which no lookup by method name ever finds.
      const baseName = fname.split(/[.:]/).pop() ?? fname
      const parent = nearestFunctionName(funcStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, baseName, 'function', lineNum, stripped.slice(0, 200)))
      }
      if (!lineClosesItself(stripped)) {
        funcStack.push({ name: baseName, endKeywordNeeded: true, isBlock: false, symbolIndex: symbols.length - 1 })
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
        funcStack.push({ name: fname, endKeywordNeeded: true, isBlock: false, symbolIndex: symbols.length - 1 })
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
        funcStack.push({ name: baseName, endKeywordNeeded: true, isBlock: false, symbolIndex: symbols.length - 1 })
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
        for (const part of (lvm[1] ?? '').split(',')) {
          const name = part.replace(/<[^>]*>/, '').trim()
          if (name) symbols.push(makeLineSymbol(filePath, name, 'variable', lineNum, stripped.slice(0, 200)))
        }
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

    // Pop finished function/block frames when we see `end` keyword(s). A line can close
    // multiple nested blocks at once (`end end`, `end end end` -- a common compact style for
    // stacked closes), so the whole line must consist of nothing but `end` tokens (each
    // followed by whitespace or end-of-line) before popping once PER `end` token; popping only
    // once regardless of count left a stale frame on the stack, corrupting parent attribution
    // for every symbol declared afterward in the enclosing scope.
    // Trailing `)`/`}`/`,`/`;` count as closing punctuation, not as code: an anonymous callback
    // body ends on `end)`, and a function stored in a table literal ends on `end,`. Requiring the
    // line to be bare `end` tokens left those frames on the stack forever, so the *enclosing*
    // function's own `end` popped the stale frame instead and every symbol declared after it was
    // attributed to a parent that had already closed.
    if (/^(?:\bend\b[\s),;}]*)+$/.test(stripped)) {
      const popCount = (stripped.match(/\bend\b/g) ?? []).length
      for (let k = 0; k < popCount && funcStack.length > 0; k++) {
        const popped = funcStack.pop()
        // Widen the function's one-line placeholder span to its real body, now that its matching
        // `end` is known. Block frames carry no symbolIndex, so control flow closing on this line
        // never rewrites a symbol. Uses this loop's own frame accounting rather than a second
        // scan for `end`, so a nested block's `end` cannot be mistaken for the function's.
        if (popped !== undefined && popped.symbolIndex !== undefined) {
          const open = symbols[popped.symbolIndex]
          if (open !== undefined && lineNum > open.lineStart) {
            symbols[popped.symbolIndex] = { ...open, lineEnd: lineNum, body: lines.slice(open.lineStart - 1, lineNum).join('\n') }
          }
        }
      }
    }
  }

  return { symbols, imports }
}
