/**
 * Content sniffs that pick a language for an ambiguous extension (`.m`, `.pp`, `.h`, `.pl`, `.t`, `.p`, `.w`, `.cls`).
 *
 * Kept apart from the adapters they belong to because language detection runs on the hook path and the adapters do not:
 * parser_types.ts imports these, and importing them from the adapter modules put every one of those adapters in the
 * eager set of each hook invocation. Each adapter re-exports its own sniff, so callers of the adapter are unaffected.
 */

// How far into a file the markers are looked for, matching the head detectLanguageOfFile reads.
const SNIFF_CHARS = 8192

/** Lines at the head of a file that only ABL writes, each read from the trimmed line. */
const ABL_MARKER_RES: readonly RegExp[] = [
  /^&ANALYZE-SUSPEND\b/i,
  /^&(?:SCOPED|GLOBAL)-DEFINE\s/i,
  /^(?:ROUTINE|BLOCK)-LEVEL\s+ON\s+ERROR\s+UNDO\b/i,
  /^DEF(?:INE)?\s+(?:NEW\s+)?(?:GLOBAL\s+)?(?:SHARED\s+)?(?:VAR|VARIABLE|TEMP-TABLE|BUFFER|QUERY|STREAM|DATASET|FRAME|(?:INPUT|OUTPUT|INPUT-OUTPUT)\s+PARAM(?:ETER)?)\s/i,
  /^FUNCTION\s+[\w-]+\s+RETURNS\s/i,
  /^FOR\s+EACH\s/i,
  /^END\s+(?:PROCEDURE|FUNCTION|CLASS|INTERFACE|METHOD|CONSTRUCTOR)\s*\.$/i,
  /^USING\s+[\w.*-]+(?:\s+FROM\s+(?:ASSEMBLY|PROPATH))?\s*\.$/i,
]
// Header lines that must also end with the block colon: `PROCEDURE x:`, `CLASS a.b.C INHERITS D:`. Apex and Pascal headers never do.
const ABL_HEADER_RE = /^(?:PROCEDURE\s+[\w-]+|(?:CLASS|INTERFACE)\s+[\w.-]+)(?:\s|:)/i

/** How much of a file the ABL sniff reads: the same head {@link detectLanguageOfFile} reads from disk, so both answer alike. */
export const ABL_SNIFF_CHARS = SNIFF_CHARS

/**
 * True when the head of `content` has a line only ABL writes: an ABL `.p`, `.w` or `.cls` is told from a Pascal program, a
 * CWEB file or an Apex class this way. Header comments before the first marker are fine; the marker must start its line.
 */
export function isAblSource(content: string): boolean {
  const head = content.slice(0, ABL_SNIFF_CHARS)
  if (head.includes('\0')) return false
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (ABL_MARKER_RES.some((re) => re.test(line))) return true
    if (ABL_HEADER_RE.test(line) && line.endsWith(':')) return true
  }
  return false
}

// A header the MATLAB sniff accepts: the name must be followed by its parameter list, a comment, a separator or nothing.
const SNIFF_FUNCTION_RE = /^function\b\s*(?:(?:\[[\w\s,~]*\]|[A-Za-z]\w*)\s*=\s*)?[A-Za-z]\w*(?:\.[A-Za-z]\w*)?\s*(?:\(|[%#;,]|$)/
const SNIFF_CLASSDEF_RE = /^classdef\b\s*(?:\([^)]*\)\s*)?[A-Za-z]\w*\s*(?:<|[%#]|$)/

/** True when a `.m` file that is not Objective-C has a MATLAB or Octave `function` or `classdef` header line. */
export function isMatlabSource(content: string): boolean {
  for (const raw of content.slice(0, SNIFF_CHARS).split('\n')) {
    const line = raw.trim()
    if (SNIFF_FUNCTION_RE.test(line) || SNIFF_CLASSDEF_RE.test(line)) return true
  }
  return false
}

/** True when a `.m` file is Objective-C rather than MATLAB: a line starts with `#import <...>` or `#import "..."`, `@interface`, `@implementation` or `@protocol`. The target is required so an Octave comment such as `# import the data` does not count. */
export function isObjcSource(content: string): boolean {
  return /^[ \t]*(?:#[ \t]*import[ \t]*[<"]|@(?:interface|implementation|protocol)\b)/m.test(content.slice(0, SNIFF_CHARS))
}

/** True when a `.h` header declares an Objective-C class or protocol, so it is not a plain C header. */
export function isObjcHeader(content: string): boolean {
  return /^[ \t]*@(?:interface|protocol)\b/m.test(content.slice(0, SNIFF_CHARS))
}

/** True when a `.pp` file (Puppet uses it too) opens, after any comments, with a Pascal `unit`, `program` or `library` header. */
export function isPascalSource(content: string): boolean {
  const head = content.slice(0, SNIFF_CHARS)
  let i = 0
  for (;;) {
    while (i < head.length && /\s/.test(head[i]!)) i++
    if (head[i] === '{') {
      const end = head.indexOf('}', i)
      if (end < 0) return false
      i = end + 1
    } else if (head.startsWith('(*', i)) {
      const end = head.indexOf('*)', i)
      if (end < 0) return false
      i = end + 2
    } else if (head.startsWith('//', i)) {
      const end = head.indexOf('\n', i)
      if (end < 0) return false
      i = end + 1
    } else {
      break
    }
  }
  return /^(?:unit|program|library)[ \t\r\n]+[A-Za-z_][\w.]*[ \t\r\n]*[;(]/i.test(head.slice(i, i + 300))
}

const PERL_MARKER_RE = /^(?:#!.*\bperl\b|[ \t]*use[ \t]+(?:strict|warnings|Test::More|Test2::V0|Test::Simple)\b|[ \t]*package[ \t]+[\w:]+[ \t]*;|[ \t]*my[ \t]+[$@%]|[ \t]*sub[ \t]+\w+[ \t]*\{)/m

/** True when a `.t` file is a Perl test script: a perl shebang, `use strict`, `use warnings` or a Test module, and no Raku `use v6`. */
export function isPerlSource(content: string): boolean {
  const head = content.slice(0, SNIFF_CHARS)
  return PERL_MARKER_RE.test(head) && !/^[ \t]*use[ \t]+v6\b/m.test(head)
}

/** True when a `.pl` file is Prolog: a `:-` directive or clause and no Perl marker. */
export function isPrologSource(content: string): boolean {
  const head = content.slice(0, SNIFF_CHARS)
  if (PERL_MARKER_RE.test(head)) return false
  return /^:-/m.test(head) || /^[a-z]\w*(?:\([^()\n]*\))?[ \t]*:-/m.test(head)
}

// A LaTeX document class or package definition file (`.cls`) declares itself with one of these
// commands near the top -- `\ProvidesClass` is the LaTeX2e-mandated self-identification a `.cls`
// file gives (see the LaTeX2e kernel documentation, `\ProvidesClass{name}[...]`), and
// `\documentclass` appears in the rare `.cls` that is actually a driver/example file bundled
// alongside a class. Neither string is valid Apex or VB6 syntax, so this can never fire on those.
const LATEX_CLASS_MARKER_RE = /\\(?:ProvidesClass|documentclass)\b/

/**
 * True when a `.cls` file is LaTeX: a positive test for LaTeX's own self-identifying commands, never a
 * negative test for "not Apex". Apex and VB6 class files never contain a backslash-command like
 * `\ProvidesClass` or `\documentclass`, so this cannot misfire on either.
 */
export function isLatexClassFile(content: string): boolean {
  return LATEX_CLASS_MARKER_RE.test(content.slice(0, SNIFF_CHARS))
}
