/**
 * Makefile target and define-block extractor.
 *
 * Surfaces `makefile_target` and `makefile_define` symbols so
 * `token-goat symbol test` jumps to the `test:` target.
 * Pure-regex; column-0 anchored. GNU make, BSD make, POSIX make all handled.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import { assignFlatEndLines, buildLineIndex, makeSymbolEmitter, offsetToLine, propagateEndLinesToSymbols } from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

// Strip # comments but preserve newlines so line numbers stay correct.
const COMMENT_RE = /#[^\n]*/g

function stripComments(text: string): string {
  return text.replace(COMMENT_RE, (m) => ' '.repeat(m.length))
}

// Recognize `define`/`endef` lines, tolerating GNU make's legal leading spaces before `endef`
// (and `define`, for symmetry) - but never a leading tab, since a tab-indented line is always a
// recipe (arbitrary shell text handed to the shell), never a make directive, even if its first
// word happens to be "define" or "endef". A `define` opener may also carry one or more legal
// modifier prefixes (`override`, `export`, `private`, in any combination GNU make accepts, e.g.
// `override define FOO` or `override export define FOO`) before the `define` keyword itself.
const DEFINE_LINE_RE = /^ *(?:(?:override|export|private)\s+)*define\s+/
const ENDEF_LINE_RE = /^ *endef\b/

// Mask define...endef block bodies (replacing with spaces, preserving newlines/offsets) so
// TARGET_RE never scans script content embedded inside a define block (e.g. an embedded
// Python/shell help-generation script) for spurious colon-bearing "target" lines. GNU make
// allows `define`/`endef` to nest (a define block containing its own nested define block), so
// this is a depth-tracking line scanner rather than a single first-match regex: a non-greedy
// regex stops masking at the FIRST (innermost) `endef`, leaving the remainder of the outer
// block's body unmasked and scanned as real rule text.
function maskDefineBlocks(text: string): string {
  const lines = text.split('\n')
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const isDefine = DEFINE_LINE_RE.test(line)
    const isEndef = ENDEF_LINE_RE.test(line)
    if (depth > 0) {
      // Inside a define block: mask this line (define/endef delimiter lines included), then
      // update depth for nested define/endef pairs.
      lines[i] = ' '.repeat(line.length)
      if (isDefine) depth++
      else if (isEndef) depth--
    } else if (isDefine) {
      // Outer define opener: mask it and enter the block.
      lines[i] = ' '.repeat(line.length)
      depth++
    }
  }
  return lines.join('\n')
}

// Mask (blank) any line that is a backslash-continuation of the line before it, so a colon
// appearing inside a continued logical line - a variable assignment's wrapped value (a search
// path, a sed substitution `s/a:/b:/`, ...) or a target's wrapped prerequisite list - is never
// mistaken by TARGET_RE for a new rule header on its own physical line. GNU make joins
// `line1 \` + `line2` into a single logical line, so a continuation line can never
// independently open a rule regardless of what it contains.
function maskContinuationLines(text: string): string {
  const lines = text.split('\n')
  let continuing = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (continuing) {
      lines[i] = ' '.repeat(line.length)
    }
    continuing = line.endsWith('\\')
  }
  return lines.join('\n')
}

// Target rule: column-0 non-whitespace followed by one or two colons not part of an assignment. The `(?![:=])` after the colon run rejects `:=`, `::=`, and `:::=` (GNU make immediate-expansion assignments) while still matching real `:` and `::` (double-colon) rules.
const TARGET_RE = /^([^\t\n#:=][^:\n#=]*?):{1,2}(?![:=])\s*(?:[^=\n]|$)/gm

// define VARNAME, tolerating GNU make's legal leading spaces and modifier prefixes (matching
// DEFINE_LINE_RE's tolerance in maskDefineBlocks - a leading tab is never legal here since
// that's a recipe line).
const DEFINE_RE = /^ *(?:(?:override|export|private)\s+)*define\s+([\w./%$()-]+)/gm

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
  const lineIndex = buildLineIndex(stripped)

  // Targets (scan a copy with define...endef bodies masked out, so script content embedded
  // in a define block is never mistaken for a target declaration)
  const strippedForTargets = maskContinuationLines(maskDefineBlocks(stripped))
  for (const m of strippedForTargets.matchAll(TARGET_RE)) {
    const rawTarget = m[1]?.trim() ?? ''
    if (!rawTarget) continue
    const line = offsetToLine(lineIndex, m.index ?? 0)
    // A rule may declare multiple space-separated targets on one line (e.g. `all clean:`),
    // each of which is a real, independently-lookup-able target — emit them individually
    // rather than fusing them into one bogus "all clean" symbol.
    for (const target of rawTarget.split(/\s+/)) {
      if (!target) continue
      if (SPECIAL_TARGETS.has(target)) continue
      emit(target, 'makefile_target', line)
    }
  }

  // define blocks
  for (const m of stripped.matchAll(DEFINE_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      emit(name, 'makefile_define', line)
    }
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  return propagateEndLinesToSymbols(symbols, sections)
}
