/**
 * Shell/Bash symbol extractor. No tree-sitter grammar is bundled for bash (see
 * isTreeSitterAvailable in parser.ts), so this regex adapter is the only source of
 * `.sh`/`.bash` symbols -- without it every shell script indexes to zero symbols, exactly
 * like an unrecognized language, despite `detectLanguage` already mapping the extension to
 * `'bash'`.
 *
 * Extracts two kinds: top-level `function` declarations (`function name`, `function name()`,
 * or bare POSIX `name()`, all optionally followed by `{` on the same line) and top-level
 * `NAME=value` variable assignments (optionally prefixed with `export`/`declare .../`readonly`).
 * "Top-level" means not nested inside another function body -- mirrors the powershell adapter's
 * `braceDepth === 0 && currentClass === null` gate, one level simpler since bash has no classes.
 * Heredoc bodies (`<<EOF ... EOF`, `<<'EOF' ... EOF`, `<<-EOF ... EOF`) are masked out entirely
 * so embedded script content (which can itself contain `#`, `=`, and `{`/`}` that would
 * otherwise desync comment stripping and brace-depth tracking) is never misread as real code.
 */

import type { SymbolEntry } from '../parser_types.js'
import { isInsideStringLiteral, stripStringLiterals, makeLineSymbol } from './common.js'

const MAX_SYMBOLS = 500

const FUNC_KEYWORD_RE = /^function\s+([A-Za-z_]\w*)\s*(?:\(\s*\))?/
const FUNC_POSIX_RE = /^([A-Za-z_]\w*)\s*\(\s*\)/
const VAR_RE = /^(?:export\s+|declare\s+(?:-\w+\s+)*|readonly\s+)?([A-Za-z_]\w*)=/
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/

/**
 * Strips a bash `#` line comment, respecting bash's own word-boundary comment rule: `#` only
 * starts a comment when it's the first character of a "word" -- at column 0 or preceded by
 * whitespace. A `#` glued directly to an identifier, as in the extremely common
 * `${VAR#pattern}` / `${VAR##pattern}` parameter-expansion syntax, is real code, not a comment
 * marker -- a generic C-style line-comment stripper (which treats any unquoted `#` as an opener)
 * would truncate every such expansion mid-line.
 */
function stripBashComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '#') continue
    const prev = line[i - 1]
    if (i > 0 && prev !== ' ' && prev !== '\t') continue
    if (isInsideStringLiteral(line, i)) continue
    return line.slice(0, i)
  }
  return line
}

interface HeredocState {
  readonly terminator: string
}

/** Finds a real (not-inside-a-string) heredoc redirect on `line`, or null. */
function findHeredocOpener(line: string): HeredocState | null {
  const m = HEREDOC_RE.exec(line)
  if (m === null || m.index === undefined) return null
  if (isInsideStringLiteral(line, m.index)) return null
  const terminator = m[2] ?? ''
  return terminator ? { terminator } : null
}

export function extractBash(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  let heredoc: HeredocState | null = null
  let braceDepth = 0
  let inFunction = false
  let functionBraceDepth = 0
  let awaitingFunctionBrace = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    if (heredoc !== null) {
      // A heredoc terminator must appear alone on its line (leniently, ignoring surrounding
      // whitespace -- real-world scripts are not always strictly POSIX about `<<-` tab-only
      // stripping, and being lenient here only risks closing a heredoc one line early on an
      // unusual body, never desyncing the rest of the file).
      if (rawLine.trim() === heredoc.terminator) heredoc = null
      continue
    }

    const noComment = stripBashComment(rawLine)
    const stripped = noComment.trim()

    const opener = findHeredocOpener(noComment)
    if (opener !== null) heredoc = opener

    if (!stripped) continue

    if (!inFunction && !awaitingFunctionBrace) {
      const kwMatch = FUNC_KEYWORD_RE.exec(stripped)
      const posixMatch = kwMatch === null ? FUNC_POSIX_RE.exec(stripped) : null
      const funcMatch = kwMatch ?? posixMatch
      if (funcMatch) {
        const fname = funcMatch[1] ?? ''
        if (fname && symbols.length < MAX_SYMBOLS) {
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200)))
        }
        if (fname) {
          if (stripped.includes('{')) {
            const braceLine = stripStringLiterals(stripped)
            const openCount = (braceLine.match(/\{/g) ?? []).length
            const closeCount = (braceLine.match(/\}/g) ?? []).length
            if (openCount > 0 && openCount === closeCount) {
              // One-liner function (`foo() { echo hi; }`): body opens and closes on this same
              // line, so there's no lingering scope to track.
            } else if (openCount > closeCount) {
              inFunction = true
              functionBraceDepth = braceDepth
            }
          } else {
            // Allman-style: `{` follows on a later line.
            awaitingFunctionBrace = true
          }
        }
      } else if (!inFunction) {
        const varMatch = VAR_RE.exec(stripped)
        if (varMatch) {
          const vname = varMatch[1] ?? ''
          if (vname && symbols.length < MAX_SYMBOLS) {
            symbols.push(makeLineSymbol(filePath, vname, 'variable', lineNum, stripped.slice(0, 200)))
          }
        }
      }
    } else if (awaitingFunctionBrace && stripped.includes('{')) {
      awaitingFunctionBrace = false
      inFunction = true
      functionBraceDepth = braceDepth
    }

    const braceLine = stripStringLiterals(stripped)
    braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length

    if (inFunction && braceDepth <= functionBraceDepth) {
      inFunction = false
    }
  }

  return symbols
}
