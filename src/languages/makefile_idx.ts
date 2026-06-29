/**
 * Makefile target and define-block extractor.
 *
 * Surfaces `makefile_target` and `makefile_define` symbols so
 * `token-goat symbol test` jumps to the `test:` target.
 * Pure-regex; column-0 anchored. GNU make, BSD make, POSIX make all handled.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import { assignFlatEndLines, makeSymbolEmitter, propagateEndLinesToSymbols } from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

// Strip # comments but preserve newlines so line numbers stay correct.
const COMMENT_RE = /#[^\n]*/g

function stripComments(text: string): string {
  return text.replace(COMMENT_RE, (m) => ' '.repeat(m.length))
}

// Target rule: column-0 non-whitespace followed by one or two colons. Excludes variable assignments (contains `=` before the colon).
const TARGET_RE = /^([^\t\n#:=][^:\n#=]*?):{1,2}\s*(?:[^=\n]|$)/gm

// define VARNAME at column 0
const DEFINE_RE = /^define\s+([\w./%$()-]+)/gm

// Internal GNU make special targets — never emitted as symbols.
const SPECIAL_TARGETS = new Set([
  '.PHONY', '.DEFAULT', '.SUFFIXES', '.SILENT', '.PRECIOUS',
  '.IGNORE', '.NOTPARALLEL', '.ONESHELL', '.EXPORT_ALL_VARIABLES',
  '.INTERMEDIATE', '.SECONDARY', '.DELETE_ON_ERROR',
  '.LOW_RESOLUTION_TIME', '.POSIX', '.MAKEFLAGS',
])

export function extractMakefile(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const stripped = stripComments(content)
  const totalLines = content.split('\n').length

  // Targets
  for (const m of stripped.matchAll(TARGET_RE)) {
    const rawTarget = m[1]?.trim() ?? ''
    if (!rawTarget) continue
    if (SPECIAL_TARGETS.has(rawTarget)) continue
    const line = stripped.slice(0, m.index ?? 0).split('\n').length
    emit(rawTarget, 'makefile_target', line)
  }

  // define blocks
  for (const m of stripped.matchAll(DEFINE_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = stripped.slice(0, m.index ?? 0).split('\n').length
      emit(name, 'makefile_define', line)
    }
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  return propagateEndLinesToSymbols(symbols, sections)
}
