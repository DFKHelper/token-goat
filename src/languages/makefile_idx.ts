/**
 * Makefile target and define-block extractor.
 *
 * Surfaces `makefile_target` and `makefile_define` symbols so
 * `token-goat symbol test` jumps to the `test:` target.
 * Pure-regex; column-0 anchored. GNU make, BSD make, POSIX make all handled.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import { assignFlatEndLines, buildLineIndex, makeSymbolEmitter, offsetToLine, propagateEndLinesToSymbols} from './common.js'
import { countContentLines } from '../util.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

// Strip # comments but preserve newlines so line numbers stay correct. GNU Make treats `\#` as
// an escaped, literal hash - it does not start a comment - so a `#` only opens a comment when
// preceded by an even number (including zero) of contiguous backslashes.
function stripComments(text: string): string {
  let result = ''
  let backslashRun = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '#' && backslashRun % 2 === 0) {
      let j = i
      while (j < text.length && text[j] !== '\n') j++
      result += ' '.repeat(j - i)
      i = j - 1
      backslashRun = 0
      continue
    }
    result += ch
    backslashRun = ch === '\\' ? backslashRun + 1 : 0
  }
  return result
}

// Recognize `define`/`endef` lines, tolerating GNU make's legal leading spaces before `endef`
// (and `define`, for symmetry) - but never a leading tab, since a tab-indented line is always a
// recipe (arbitrary shell text handed to the shell), never a make directive, even if its first
// word happens to be "define" or "endef". A `define` opener may also carry one or more legal
// modifier prefixes (`override`, `export`, `private`, in any combination GNU make accepts, e.g.
// `override define FOO` or `override export define FOO`) before the `define` keyword itself.
const DEFINE_LINE_RE = /^ *(?:(?:override|export|private)\s+)*define\s+/
const ENDEF_LINE_RE = /^ *endef\b/

// True when this physical line is continued into the next one. GNU make joins lines only when the backslash sits immediately before the newline, and it strips a CR from a CRLF line ending before applying that rule -- but splitting the source on `\n` leaves that CR sitting after the backslash, so a bare `endsWith('\\')` reports every line of a CRLF Makefile as unterminated and the continuation masking below never fires at all (a wrapped assignment's continuation line was then rescanned as an independent rule header, emitting a phantom target). Strip exactly one trailing CR and nothing else: a genuine trailing space after the backslash really does end the continuation in GNU make, so trimEnd() here would be wrong in the other direction.
function isContinued(line: string): boolean {
  return (line.endsWith('\r') ? line.slice(0, -1) : line).endsWith('\\')
}

interface MaskResult {
  // Continuation lines blanked, but define...endef bodies left intact (DEFINE_RE still scans
  // this so a nested `define` inside a block's body still gets its own symbol, matching
  // pre-existing behavior).
  noContinuation: string
  // Continuation lines AND define...endef bodies blanked, for TARGET_RE to scan.
  forTargets: string
}

// Single combined pass tracking both backslash-continuation state and define/endef nesting
// depth together, rather than two independent line scans run in sequence. Two prior bugs each
// came from running continuation-masking and define-block-masking as separate passes with an
// implicit ordering assumption that turned out to be wrong in one direction or the other:
//   - continuation masking BEFORE define detection is required so a wrapped assignment whose
//     continuation line happens to start with the word "define" (e.g. a list of directive
//     names) isn't misread as a real define opener.
//   - but once genuinely inside a define block, a body line ending in `\` is just literal body
//     text (GNU make does not join continuations across an `endef` terminator), so the
//     following line - even if it's the closing `endef` - must NOT be blanked as a
//     "continuation of the previous line", or maskDefineBlocks's depth counter never sees the
//     `endef` and masks every line through EOF, dropping every real target after the block.
// Tracking both states in one pass (continuation only applies while depth === 0) satisfies both
// constraints at once instead of re-deriving depth twice on divergent inputs.
function maskContinuationAndDefines(text: string): MaskResult {
  const lines = text.split('\n')
  const contLines = lines.slice()
  const targetLines = lines.slice()
  let depth = 0
  let continuing = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (depth > 0) {
      // Inside a define block body: mask it out of the targets scan (define/endef delimiter
      // lines included), then update depth for nested define/endef pairs. GNU make allows
      // define/endef to nest, so this is depth-tracking rather than a single first-match regex.
      targetLines[i] = ' '.repeat(line.length)
      if (DEFINE_LINE_RE.test(line)) depth++
      else if (ENDEF_LINE_RE.test(line)) depth--
      continuing = false
      continue
    }
    if (continuing) {
      // A continuation of the previous (non-define-body) line: blank it from both views so a
      // colon or the word "define" appearing in a wrapped logical line is never mistaken for a
      // new rule header or a real define opener.
      contLines[i] = ' '.repeat(line.length)
      targetLines[i] = ' '.repeat(line.length)
      continuing = isContinued(line)
      continue
    }
    if (DEFINE_LINE_RE.test(line)) {
      targetLines[i] = ' '.repeat(line.length)
      depth++
      continuing = false
      continue
    }
    continuing = isContinued(line)
  }
  return { noContinuation: contLines.join('\n'), forTargets: targetLines.join('\n') }
}

// Target rule: column-0 non-whitespace followed by one or two colons not part of an assignment. The `(?![:=])` after the colon run rejects `:=`, `::=`, and `:::=` (GNU make immediate-expansion assignments) while still matching real `:` and `::` (double-colon) rules. A colon immediately followed by `/` or `\` (e.g. the drive-letter colon in a Windows absolute path like `C:/foo/bar.o`) is treated as part of the target name rather than the rule separator, so a Windows-path target no longer mis-splits at its drive colon.
// `\#` is a legally-escaped literal hash in a target name (GNU Make) - excluded by the bare `#`
// exclusion below unless allowed back in explicitly, same treatment as the `:(?=[\\/])` exemption
// already given to a Windows drive-letter colon.
const TARGET_RE = /^((?:[^\t\n#:=]|:(?=[\\/])|\\#)(?:[^:\n#=]|:(?=[\\/])|\\#)*):{1,2}(?![:=])\s*(?:[^=\n]|$)/gm

// define VARNAME, tolerating GNU make's legal leading spaces and modifier prefixes (matching
// DEFINE_LINE_RE's tolerance in maskContinuationAndDefines - a leading tab is never legal here
// since that's a recipe line).
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
  const totalLines = countContentLines(content)
  const lineIndex = buildLineIndex(stripped)

  const { noContinuation: strippedNoContinuation, forTargets: strippedForTargets } = maskContinuationAndDefines(stripped)

  // Targets (scan a copy with continuation lines and define...endef bodies masked out, so
  // wrapped assignments and script content embedded in a define block are never mistaken for a
  // target declaration)
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
  for (const m of strippedNoContinuation.matchAll(DEFINE_RE)) {
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
