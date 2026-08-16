// PowerShell language adapter (.ps1, .psm1) using regex-based symbol extraction.
import type { SymbolEntry } from '../parser_types.js'
import { stripMultilineStringSpan, type MultilineStringState, makeLineSymbol } from './common.js'

const MAX_SYMBOLS = 500

// PowerShell identifiers are not restricted to ASCII, and `\w` in a JavaScript regex is. An ASCII-only class does not merely miss a non-ASCII name, it truncates one: `function Get-Ünicode` matched as far as `Get-` and stored that fabricated prefix as a real symbol.
const IDENT_START = 'A-Za-z_\\u00C0-\\uFFFF'
const IDENT_CONT = 'A-Za-z0-9_\\u00C0-\\uFFFF'
const IDENT = `[${IDENT_START}][${IDENT_CONT}]*`
// Command names are Verb-Noun, so a function or filter name may contain hyphens; a class or enum name may not.
const FUNC_IDENT = `[${IDENT_START}][${IDENT_CONT}-]*`

// Finds the index of the first unquoted occurrence of `needle` in `text`, tracking single- and double-quoted string state as it scans left to right. Used so that comment markers (`<#`, `#`) that merely appear inside a string literal aren't mistaken for real comment syntax. Regression: this used to toggle inDouble on every literal `"`, with no backtick-escape awareness. A backtick-escaped quote (`` `" ``) was misread as the string's real closing quote, so a `#` appearing later on the same (still logically-open) string got treated as a real comment marker and truncated the line -- silently dropping any code, including a closing brace, past that point.
function findUnquoted(text: string, needle: string): number {
  let inSingle = false
  let inDouble = false
  for (let idx = 0; idx < text.length; idx++) {
    const ch = text[idx]
    if (inDouble && ch === '`' && idx + 1 < text.length) {
      idx++
      continue
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && text.startsWith(needle, idx)) {
      return idx
    }
  }
  return -1
}

/**
 * Blanks every `<# ... #>` span that both opens and closes on this line, keeping column positions
 * stable, and returns the result. Loops rather than handling a single span: only the first one used
 * to be blanked, and the `#` of the second `<#` was then read as an ordinary line comment, so
 * `function One { <# a #> <# b #> }` lost its closing brace and with it every top-level declaration
 * in the rest of the file. Running before the here-string scanner also stops a completed comment
 * from hiding a real here-string header: that scanner treats a `#` anywhere earlier on the line as
 * proof the header sits in a comment, so `<# note #> $text = @"` left the here-string unmasked and
 * its braces were counted as code.
 */
function blankCompletedBlockComments(line: string): string {
  let out = line
  for (;;) {
    const openIdx = findUnquoted(out, '<#')
    if (openIdx === -1) return out
    // A `<#` sitting after an ordinary `# ...` line comment marker is just comment prose, not an opener.
    const hashIdx = findUnquoted(out, '#')
    if (hashIdx !== -1 && hashIdx < openIdx) return out
    const closeIdx = out.indexOf('#>', openIdx + 2)
    if (closeIdx === -1) return out
    out = out.slice(0, openIdx) + ' '.repeat(closeIdx + 2 - openIdx) + out.slice(closeIdx + 2)
  }
}

/**
 * Blanks the contents of PowerShell string literals, carrying an unterminated quote across lines,
 * and neutralises backtick escapes outside strings.
 *
 * Two faults live here. A quoted string may span lines in PowerShell, but the quote state used to
 * reset on every line, so the body of one was read as code: a `{` in it desynced the brace counter
 * and suppressed every later top-level declaration, and a `function` word in it was indexed as a
 * real declaration. Separately, a backtick escapes the next character outside a string too, so
 * `` Write-Output `{ `` passes a literal brace as an argument; counting it left the depth stuck
 * above zero for the rest of the file, and `` `# `` was read as a comment marker that swallowed a
 * real closing brace.
 *
 * PowerShell does NOT use backslash as an escape character - a backslash is a literal, most often
 * in a Windows path like `"C:\Temp\"`. Its real rules are: a doubled quote of the same kind is a
 * literal quote, and a backtick escapes the following character inside a double-quoted string (but
 * not inside a single-quoted one).
 */
function maskPowershellStrings(
  line: string,
  openQuote: '"' | "'" | null,
): { code: string; quote: '"' | "'" | null } {
  let out = ''
  let quote = openQuote
  let i = 0
  // A carried-over quote resumes mid-line, so the opening delimiter is not on this line at all.
  while (i < line.length) {
    if (quote !== null) {
      const c = line[i]
      if (quote === '"' && c === '`' && i + 1 < line.length) {
        out += '  '
        i += 2
        continue
      }
      if (c === quote) {
        if (line[i + 1] === quote) {
          out += '  '
          i += 2
          continue
        }
        out += quote
        quote = null
        i++
        continue
      }
      out += ' '
      i++
      continue
    }
    const ch = line[i]
    if (ch === '#') {
      // An unquoted `#` starts a line comment, so the rest of the line is prose. Stopping here is
      // what keeps a quote character inside a comment (`# example usage: @"`) from opening a string
      // that then swallows every following line.
      return { code: out, quote }
    }
    if (ch === '`' && i + 1 < line.length) {
      out += '  '
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      out += ch
      quote = ch
      i++
      continue
    }
    out += ch
    i++
  }
  return { code: out, quote }
}

/**
 * Skips a balanced `[...]` group at the start of `text` and returns the remainder, or null when
 * `text` does not start with one. Used for both a method's return type and a declaration attribute,
 * neither of which a fixed-depth regex handles: `[List[List[string]]]` nests deeper than the two
 * levels the old pattern allowed and the whole method was dropped, and `[Flags()] enum Mode` never
 * matched a pattern that required `enum` to be the first token on the line.
 */
function skipBracketGroup(text: string): string | null {
  if (text[0] !== '[') return null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') depth++
    else if (text[i] === ']') {
      depth--
      if (depth === 0) return text.slice(i + 1)
    }
  }
  return null
}

/** Strips leading declaration attributes (`[Flags()]`, `[CmdletBinding()]`) plus surrounding space. */
function stripLeadingAttributes(text: string): string {
  let rest = text.trimStart()
  for (;;) {
    const after = skipBracketGroup(rest)
    if (after === null) return rest
    rest = after.trimStart()
  }
}

const FUNC_RE = new RegExp(`^(?:function|filter)\\s+(?:(?:global|local|script|private):)?(${FUNC_IDENT})`, 'i')
const CLASS_RE = new RegExp(`^(class|enum)\\s+(${IDENT})`, 'i')
const METHOD_NAME_RE = new RegExp(
  `^(?!(?:if|elseif|else|while|for|foreach|do|switch|return|throw|try|catch|finally|param|begin|process|end)\\b)(${IDENT})\\s*\\(`,
  'i',
)

/** Matches a method or constructor declaration at the start of `text`, after any static/hidden modifiers and any return type. */
function matchMethodName(text: string): string | null {
  let rest = text.trimStart()
  for (;;) {
    const mod = /^(?:static|hidden)\s+/i.exec(rest)
    if (mod === null) break
    rest = rest.slice(mod[0].length)
  }
  const afterType = skipBracketGroup(rest)
  if (afterType !== null) rest = afterType.trimStart()
  const named = METHOD_NAME_RE.exec(rest)
  return named === null ? null : (named[1] ?? null)
}

export function extractPowershell(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  let currentClass: string | null = null
  let classBraceDepth = 0
  // True once braceDepth has risen above classBraceDepth at least once, i.e. the class's own opening brace has actually been consumed. Guards the pop check below: for Allman-style declarations (`class Foo` on one line, `{` on the next) braceDepth still equals classBraceDepth on the header line itself, so an ungated pop check fires immediately and discards the class context before its body is ever seen.
  let braceDepth = 0
  let classBodyEntered = false
  let inBlockComment = false
  let mlState: MultilineStringState | null = null
  let openQuote: '"' | "'" | null = null

  /** Records the methods declared in a class body fragment that shares a line with its class header. */
  const pushInlineMethods = (body: string, className: string, lineNum: number): void => {
    for (const piece of body.split(/(?<=[{}])/)) {
      const mname = matchMethodName(piece.replace(/^[{}\s]+/, ''))
      if (mname !== null && symbols.length < MAX_SYMBOLS) {
        symbols.push(makeLineSymbol(filePath, mname, 'method', lineNum, piece.trim().slice(0, 200), className, lines, 'hash'))
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const sourceLine = lines[i] ?? ''
    const lineNum = i + 1

    let line: string
    if (inBlockComment) {
      const closeMarkerIdx = sourceLine.indexOf('#>')
      if (closeMarkerIdx === -1) {
        // The whole line sits inside the block comment. Comment prose is not code, so it must never affect braceDepth - counting braces here is what desyncs braceDepth away from 0 whenever comment-based help text (e.g. `.EXAMPLE ... { foo }`) contains an unbalanced brace, silently dropping every top-level symbol after it.
        continue
      }
      inBlockComment = false
      const masked = maskPowershellStrings(blankCompletedBlockComments(sourceLine.slice(closeMarkerIdx + 2)), openQuote)
      openQuote = masked.quote
      line = masked.code
    } else {
      // Completed `<# ... #>` spans go first so neither the here-string scanner nor the unterminated-opener check below ever sees their `#` characters.
      const decommented = blankCompletedBlockComments(sourceLine)
      // Mask multi-line here-string spans (@"..."@ / @'...'@), state carried across lines, so braces (and comment-looking sequences) inside one can never desync braceDepth.
      const heredoc = stripMultilineStringSpan(decommented, mlState, 'powershell')
      mlState = heredoc.state
      let body = heredoc.code
      const openIdx = findUnquoted(body, '<#')
      if (openIdx !== -1) {
        const hashIdx = findUnquoted(body, '#')
        // Only a `<#` that is not itself inside an ordinary `# ...` line comment opens a real block comment; otherwise inBlockComment would stick true for the rest of the file since no matching `#>` ever follows.
        if (hashIdx === -1 || hashIdx >= openIdx) {
          // Any code before the opener (e.g. `function Foo {`) is still real code and must not be discarded.
          inBlockComment = true
          body = body.slice(0, openIdx)
        }
      }
      const masked = maskPowershellStrings(body, openQuote)
      openQuote = masked.quote
      line = masked.code
    }

    // maskPowershellStrings already ends the line at an unquoted `#`, so comment text (e.g.
    // `# TODO: handle { edge case`) can neither desync the brace counter nor look like a declaration.
    const stripped = stripLeadingAttributes(line)

    // Skip empty lines (including lines that were pure comments)
    if (!stripped) {
      continue
    }

    // FUNCTION or FILTER (top-level only, not nested)
    if (braceDepth === 0 && currentClass === null) {
      const funcMatch = FUNC_RE.exec(stripped)
      if (funcMatch) {
        const fname = funcMatch[1] ?? ''
        if (symbols.length < MAX_SYMBOLS) {
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, line.trimEnd().slice(0, 200), undefined, lines, 'hash'))
        }
      }
    }

    // CLASS or ENUM (top-level)
    if (braceDepth === 0) {
      const classMatch = CLASS_RE.exec(stripped)
      if (classMatch) {
        const cname = classMatch[2] ?? ''
        const kind = (classMatch[1] ?? '').toLowerCase() === 'enum' ? 'enum' : 'class'
        if (symbols.length < MAX_SYMBOLS) {
          symbols.push(makeLineSymbol(filePath, cname, kind, lineNum, line.trimEnd().slice(0, 200), undefined, lines, 'hash'))
        }
        if (kind === 'class') {
          const openCount = (line.match(/\{/g) ?? []).length
          const closeCount = (line.match(/\}/g) ?? []).length
          const bodyStart = line.indexOf('{')
          // Members sharing the header's line are matched here or not at all: the method branch below needs braceDepth to already be inside the class, and the delta for this line is not applied until after it runs.
          if (bodyStart !== -1) pushInlineMethods(line.slice(bodyStart + 1), cname, lineNum)
          if (openCount > 0 && openCount === closeCount) {
            // The class header, body, and closing brace are all on this one line, so there is no lingering class scope to track. Leaving `currentClass` set here would otherwise drop every top-level declaration that follows (it only nets back to classBraceDepth within this single line, so the classBodyEntered guard below never trips and the pop check never fires).
            currentClass = null
          } else {
            currentClass = cname
            classBraceDepth = braceDepth
            classBodyEntered = false
          }
        }
      }
    }

    // METHOD or constructor (exactly one brace level inside a class body, where bare statements cannot legally appear)
    if (currentClass !== null && braceDepth - classBraceDepth === 1) {
      const mname = matchMethodName(stripped)
      if (mname !== null && symbols.length < MAX_SYMBOLS) {
        const sigEnd = line.indexOf('{')
        const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
        symbols.push(makeLineSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), currentClass, lines, 'hash'))
      }
    }

    // Apply brace delta BEFORE scope pop check (critical ordering).
    braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length

    if (currentClass !== null && braceDepth > classBraceDepth) {
      classBodyEntered = true
    }
    if (currentClass !== null && classBodyEntered && braceDepth <= classBraceDepth) {
      currentClass = null
    }
  }

  return { symbols }
}
