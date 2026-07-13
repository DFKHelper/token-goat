// PowerShell language adapter (.ps1, .psm1) using regex-based symbol extraction.
import type { SymbolEntry } from '../parser_types.js'
import { stripMultilineStringSpan, type MultilineStringState, makeLineSymbol } from './common.js'

const MAX_SYMBOLS = 500

// Blanks the contents of single-line PowerShell string literals so a `{`/`}` inside a string
// value is never counted as real code structure. PowerShell strings do NOT use backslash as an
// escape character (unlike `stripStringLiterals` in common.ts, which assumes C-like backslash
// escaping) - a backslash in a PowerShell string is always a literal character, most commonly
// seen in Windows path literals like `"C:\Temp\"`. Treating it as an escape (as the shared
// `stripStringLiterals` does) misreads a trailing backslash immediately before the closing quote
// as an escaped quote, leaving the string "open" past its real end and swallowing the rest of the
// line - including any brace characters - as phantom string content, desyncing `braceDepth` for
// every line after. PowerShell's real escaping rules are: a doubled quote of the same kind (`""`
// inside a double-quoted string, `''` inside a single-quoted string) is a literal quote, and a
// backtick immediately inside a double-quoted string escapes the following character (backtick
// escaping does not apply inside single-quoted strings).
function stripPowershellStringLiterals(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      out += quote
      i++
      while (i < line.length) {
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
          i++
          break
        }
        out += ' '
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

// Finds the index of the first unquoted occurrence of `needle` in `text`,
// tracking single- and double-quoted string state as it scans left to right.
// Used so that comment markers (`<#`, `#`) that merely appear inside a string
// literal aren't mistaken for real comment syntax.
function findUnquoted(text: string, needle: string): number {
  let inSingle = false
  let inDouble = false
  for (let idx = 0; idx < text.length; idx++) {
    const ch = text[idx]
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

export function extractPowershell(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  let currentClass: string | null = null
  let classBraceDepth = 0
  // True once braceDepth has risen above classBraceDepth at least once, i.e. the class's own
  // opening brace has actually been consumed. Guards the pop check below: for Allman-style
  // declarations (`class Foo` on one line, `{` on the next) braceDepth still equals
  // classBraceDepth on the header line itself, so an ungated pop check fires immediately and
  // discards the class context before its body is ever seen.
  let classBodyEntered = false
  let braceDepth = 0
  let inBlockComment = false
  let mlState: MultilineStringState | null = null

  for (let i = 0; i < lines.length; i++) {
    const sourceLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line PowerShell here-string spans (@"..."@ / @'...'@) first, state carried
    // across lines, so braces (and comment-looking sequences) inside one of those can never
    // desync braceDepth or the <# #> block-comment scanner below. Skipped on lines that start
    // already inside a block comment (mlState null) to avoid misreading comment prose that
    // happens to contain opener-shaped text.
    let mlLine = sourceLine
    if (mlState !== null || !inBlockComment) {
      const masked = stripMultilineStringSpan(sourceLine, mlState, 'powershell')
      mlLine = masked.code
      mlState = masked.state
    }
    const rawLine = mlLine

    // Handle <# ... #> block comments. A `<#` only opens a real comment when
    // it isn't sitting inside a quoted string literal - PowerShell strings can
    // legitimately contain that two-character sequence (e.g. "the <# marker").
    let line = rawLine
    let openedBlockCommentThisLine = false
    if (!inBlockComment) {
      const openIdx = findUnquoted(rawLine, '<#')
      if (openIdx !== -1) {
        // A `<#` only opens a real block comment if no unquoted `#` line-comment
        // marker appears earlier on the line. Otherwise the `<#` is just text
        // sitting inside an ordinary `# ...` line comment (e.g. `# See <# for
        // syntax details`), and treating it as an opener would leave
        // inBlockComment stuck true for the rest of the file since no matching
        // #> ever follows. Fall through to the line-comment stripping below instead.
        const hashIdx = findUnquoted(rawLine, '#')
        const isRealOpener = hashIdx === -1 || hashIdx >= openIdx
        if (isRealOpener) {
          const closeIdx = rawLine.indexOf('#>', openIdx + 2)
          if (closeIdx !== -1) {
            // Opens and closes on this same line: blank out the comment span
            // (keeping column positions stable) and keep processing the rest of
            // the line as normal code instead of short-circuiting the whole line.
            line = rawLine.slice(0, openIdx) + ' '.repeat(closeIdx + 2 - openIdx) + rawLine.slice(closeIdx + 2)
          } else {
            // The comment opens here but doesn't close on this line. Any code
            // before the opener (e.g. `function Foo {`) is still real code and
            // must not be discarded - only the swallow-check below (for lines
            // fully INSIDE an already-open comment) should be skipped this pass.
            inBlockComment = true
            openedBlockCommentThisLine = true
            line = rawLine.slice(0, openIdx)
          }
        }
      }
    }

    if (inBlockComment && !openedBlockCommentThisLine) {
      const closeMarkerIdx = rawLine.indexOf('#>')
      if (closeMarkerIdx === -1) {
        // The whole line sits inside the block comment. Comment prose is not code, so it
        // must never affect braceDepth - counting braces here is what desyncs braceDepth
        // away from 0 whenever comment-based help text (e.g. `.EXAMPLE ... { foo }`)
        // contains an unbalanced brace, silently dropping every top-level symbol after it.
        continue
      }
      inBlockComment = false
      // The comment closes on this line. Slice off everything up to and including `#>` so
      // only the real trailing code (if any) is brace-counted and processed as normal code
      // below, instead of `continue`-ing past it.
      line = rawLine.slice(closeMarkerIdx + 2)
    }

    // Strip an unquoted `#` onward before anything else, so comment text
    // (e.g. `# TODO: handle { edge case`) never desyncs the brace counter or
    // gets mistaken for a declaration.
    const hashIdx = findUnquoted(line, '#')
    if (hashIdx !== -1) {
      line = line.slice(0, hashIdx)
    }
    const stripped = line.trim()

    // Skip empty lines (including lines that were pure comments)
    if (!stripped) {
      continue
    }

    // FUNCTION or FILTER (top-level only, not nested)
    if (braceDepth === 0 && currentClass === null) {
      const funcMatch = /^\s*(?:function|filter)\s+(?:(?:global|local|script|private):)?([A-Za-z_][\w-]*)/i.exec(line)
      if (funcMatch) {
        const fname = funcMatch[1] ?? ''
        if (symbols.length < MAX_SYMBOLS) {
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, line.trimEnd().slice(0, 200)))
        }
      }
    }

    // CLASS or ENUM (top-level)
    if (braceDepth === 0) {
      const classMatch = /^\s*(class|enum)\s+([A-Za-z_]\w*)/i.exec(line)
      if (classMatch) {
        const cname = classMatch[2] ?? ''
        const kind = (classMatch[1] ?? '').toLowerCase() === 'enum' ? 'enum' : 'class'
        if (symbols.length < MAX_SYMBOLS) {
          symbols.push(makeLineSymbol(filePath, cname, kind, lineNum, line.trimEnd().slice(0, 200)))
        }
        if (kind === 'class') {
          // Count on a string-stripped copy, not the raw line: a literal brace inside a
          // string value (e.g. a default like `"}"`) would otherwise desync this one-liner
          // check from the real braceDepth tracker below (which already strips strings) --
          // the phantom brace makes openCount !== closeCount even though the real braces net
          // to zero, so the class is wrongly treated as multi-line and currentClass is never
          // cleared, stranding it and dropping every top-level declaration that follows.
          const strippedLine = stripPowershellStringLiterals(line)
          const openCount = (strippedLine.match(/\{/g) ?? []).length
          const closeCount = (strippedLine.match(/\}/g) ?? []).length
          if (openCount > 0 && openCount === closeCount) {
            // The class header, body, and closing brace are all on this one
            // line, so there is no lingering class scope to track. Leaving
            // `currentClass` set here would otherwise drop every top-level
            // declaration that follows (it only nets back to classBraceDepth
            // within this single line, so the classBodyEntered guard below
            // never trips and the pop check never fires).
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
    if (currentClass !== null) {
      const depthInClass = braceDepth - classBraceDepth
      if (depthInClass === 1) {
        // Match constructor or method: [returntype] methodName([params]) or static [type] Name(); negative-lookahead rejects PS control keywords as defense in depth
        const methodMatch = /^\s*(?!(?:if|elseif|else|while|for|foreach|do|switch|return|throw|try|catch|finally|param|begin|process|end)\b)(?:(?:static|hidden)\s+)*(?:\[[^\]]*\]\s*)?([A-Za-z_]\w*)\s*\(/i.exec(line)
        if (methodMatch) {
          const mname = methodMatch[1] ?? ''
          if (mname && symbols.length < MAX_SYMBOLS) {
            const sigEnd = line.indexOf('{')
            const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
            symbols.push(makeLineSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), currentClass))
          }
        }
      }
    }

    // Apply brace delta BEFORE scope pop check (critical ordering). Brace-count on a
    // string-stripped copy of the line so a literal brace inside a string literal is never
    // counted as real nesting.
    const braceLine = stripPowershellStringLiterals(line)
    braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length

    if (currentClass !== null && braceDepth > classBraceDepth) {
      classBodyEntered = true
    }
    if (currentClass !== null && classBodyEntered && braceDepth <= classBraceDepth) {
      currentClass = null
    }
  }

  return { symbols }
}
