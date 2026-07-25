/**
 * Elixir symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: modules (defmodule), protocols (defprotocol), functions (def/defp),
 * macros (defmacro), and structs (defstruct). Private functions (defp) are
 * extracted with a 'function' kind (no separate private variant).
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripLineComment,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

interface ModuleFrame {
  name: string
  endKeywordNeeded: boolean
  // true for a non-def/defmodule block frame (quote/case/cond/try/receive/if/unless/with,
  // or any other `do ... end` construct) pushed only to keep the stack balanced against its
  // own `end` -- it must never be reported as a parent, so parent lookup walks past these to
  // the nearest real def/defmodule frame. Mirrors lua.ts's isBlock/nearestFunctionName fix.
  isBlock: boolean
}

/** Nearest enclosing real def/defmodule name, skipping past non-def block frames. */
function nearestDefName(stack: readonly ModuleFrame[]): string | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]!
    if (!frame.isBlock) return frame.name
  }
  return undefined
}

// `defmodule Foo` or `defmodule Foo.Bar` (qualified module names are common)
const MODULE_RE = /^defmodule\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/

// `defprotocol Sizeable do` / `defprotocol My.Nested.Proto do` -- a protocol is a named,
// module-like container (a `do ... end` body of `def` signatures). It was absent here, so the
// protocol name was dropped AND its body pushed only an anonymous *block* frame: every `def`
// inside it was orphaned to the top level (parent lost) instead of attributed to the protocol.
// `defprotocol` never false-matches FUNC_RE/PRIVATE_FUNC_RE (`def(?:macro)?`/`defp` both
// require whitespace immediately after the keyword, which the `protocol`/`rotocol` tail denies).
const PROTOCOL_RE = /^defprotocol\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/

// `def name(...)`, `def name do`, `defmacro name(...)`, operator functions like `def +(...)`
// (Elixir allows operator overloads). This also matches `defmacro` -- there is no separate
// macro regex, since `def(?:macro)?` already covers both and both are indexed as 'function'.
const FUNC_RE = /^def(?:macro)?\s+([A-Za-z_][A-Za-z0-9_!?]*|[+\-*/%=!<>&|^~]+)/

// `defp name(...)` — private function (same pattern as def but with defp keyword)
const PRIVATE_FUNC_RE = /^defp\s+([A-Za-z_][A-Za-z0-9_!?]*|[+\-*/%=!<>&|^~]+)/

// `defstruct field1: type, field2: type` — struct definition
const STRUCT_RE = /^defstruct/

export function extractElixir(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const moduleStack: ModuleFrame[] = []

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Strip a trailing `#` line comment (Elixir uses `#` for line comments).
    const line = stripLineComment(rawLine, ['#']).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      continue
    }

    // Whether this line's construct opens a `do ... end` block that will need a matching
    // `end` to close (the standard multi-line `def foo(x) do` form). A one-liner like
    // `def foo(x), do: expr` does NOT open a block -- it has no matching `end` -- so it must
    // NOT push a frame, or the next real `end` in the file would incorrectly pop it instead
    // of the enclosing module/function frame it actually belongs to.
    const opensDoBlock = /\bdo\s*$/.test(stripped)

    // defmodule Foo / defmodule Foo.Bar
    const modM = MODULE_RE.exec(stripped)
    if (modM) {
      const modName = modM[1] ?? ''
      symbols.push(makeLineSymbol(filePath, modName, 'class', lineNum, stripped.slice(0, 200)))
      moduleStack.push({ name: modName, endKeywordNeeded: true, isBlock: false })
      continue
    }

    // defprotocol Sizeable -- index as a named 'protocol' type and push a real (non-block)
    // frame so the `def` signatures in its body are parented to it, mirroring defmodule.
    const protoM = PROTOCOL_RE.exec(stripped)
    if (protoM) {
      const protoName = protoM[1] ?? ''
      symbols.push(makeLineSymbol(filePath, protoName, 'protocol', lineNum, stripped.slice(0, 200)))
      moduleStack.push({ name: protoName, endKeywordNeeded: true, isBlock: false })
      continue
    }

    // def/defp/defmacro inside a module. Each pushes its own frame when it opens a `do`
    // block, so its own `end` pops itself rather than prematurely popping the enclosing
    // module frame (the bug this fix addresses: previously only defmodule pushed a frame,
    // so the FIRST function's `end` popped the module, and every function after it in the
    // same module lost its parent attribution).
    const fm = FUNC_RE.exec(stripped)
    if (fm) {
      const fname = fm[1] ?? ''
      const parent = nearestDefName(moduleStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        // Top-level function (not inside a module) — still index it
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
      if (opensDoBlock) {
        moduleStack.push({ name: fname, endKeywordNeeded: true, isBlock: false })
      }
      continue
    }

    // defp (private function) — index the same way as def
    const pfm = PRIVATE_FUNC_RE.exec(stripped)
    if (pfm) {
      const fname = pfm[1] ?? ''
      const parent = nearestDefName(moduleStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
      if (opensDoBlock) {
        moduleStack.push({ name: fname, endKeywordNeeded: true, isBlock: false })
      }
      continue
    }

    // defstruct — index as a special symbol
    if (STRUCT_RE.test(stripped)) {
      const parent = nearestDefName(moduleStack)
      if (parent !== undefined) {
        symbols.push(makeLineSymbol(filePath, '__struct__', 'var', lineNum, stripped.slice(0, 200), parent))
      }
      continue
    }

    // Any other `do ... end` construct (quote/case/cond/try/receive/if/unless/with, etc.) --
    // push a placeholder block frame so its `end` doesn't prematurely pop a real def/module
    // frame and corrupt parent attribution for whatever comes after it.
    if (opensDoBlock) {
      moduleStack.push({ name: '', endKeywordNeeded: true, isBlock: true })
      continue
    }

    // Pop finished frames when we see `end` keyword
    if (stripped === 'end' || /^end\s/.test(stripped) || /^end$/.test(stripped)) {
      if (moduleStack.length > 0) {
        moduleStack.pop()
      }
    }
  }

  return { symbols, imports }
}
