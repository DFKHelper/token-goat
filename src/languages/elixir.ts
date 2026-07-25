/**
 * Elixir symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: modules (defmodule), functions (def/defp), macros (defmacro),
 * and structs (defstruct). Private functions (defp) are extracted with
 * a 'function' kind (no separate private variant).
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
}

// `defmodule Foo` or `defmodule Foo.Bar` (qualified module names are common)
const MODULE_RE = /^defmodule\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/

// `def name(...)`, `def name do`, operator functions like `def +(...)` (Elixir allows operator overloads)
const FUNC_RE = /^def(?:macro)?\s+([A-Za-z_][A-Za-z0-9_!?]*|[+\-*/%=!<>&|^~]+)/

// `defp name(...)` — private function (same pattern as def but with defp keyword)
const PRIVATE_FUNC_RE = /^defp\s+([A-Za-z_][A-Za-z0-9_!?]*|[+\-*/%=!<>&|^~]+)/

// `defmacro name(...)` — macro definition
const MACRO_RE = /^defmacro\s+([A-Za-z_][A-Za-z0-9_!?]*|[+\-*/%=!<>&|^~]+)/

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

    // defmodule Foo / defmodule Foo.Bar
    const modM = MODULE_RE.exec(stripped)
    if (modM) {
      const modName = modM[1] ?? ''
      symbols.push(makeLineSymbol(filePath, modName, 'class', lineNum, stripped.slice(0, 200)))
      moduleStack.push({ name: modName, endKeywordNeeded: true })
      continue
    }

    // def/defp/defmacro inside a module
    const fm = FUNC_RE.exec(stripped)
    if (fm) {
      const fname = fm[1] ?? ''
      if (moduleStack.length > 0) {
        const parent = moduleStack[moduleStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        // Top-level function (not inside a module) — still index it
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
      continue
    }

    // defp (private function) — index the same way as def
    const pfm = PRIVATE_FUNC_RE.exec(stripped)
    if (pfm) {
      const fname = pfm[1] ?? ''
      if (moduleStack.length > 0) {
        const parent = moduleStack[moduleStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
      }
      continue
    }

    // defmacro name(...)
    const macM = MACRO_RE.exec(stripped)
    if (macM) {
      const mname = macM[1] ?? ''
      if (moduleStack.length > 0) {
        const parent = moduleStack[moduleStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, mname, 'function', lineNum, stripped.slice(0, 200), parent))
      } else {
        symbols.push(makeLineSymbol(filePath, mname, 'function', lineNum, stripped.slice(0, 200)))
      }
      continue
    }

    // defstruct — index as a special symbol
    if (STRUCT_RE.test(stripped)) {
      if (moduleStack.length > 0) {
        const parent = moduleStack[moduleStack.length - 1]!.name
        symbols.push(makeLineSymbol(filePath, '__struct__', 'var', lineNum, stripped.slice(0, 200), parent))
      }
      continue
    }

    // Pop finished module frames when we see `end` keyword
    if (stripped === 'end' || /^end\s/.test(stripped) || /^end$/.test(stripped)) {
      if (moduleStack.length > 0) {
        moduleStack.pop()
      }
    }
  }

  return { symbols, imports }
}
