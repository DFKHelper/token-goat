// PowerShell language adapter (.ps1, .psm1) using regex-based symbol extraction.
import type { SymbolEntry } from '../parser_types.js'

const MAX_SYMBOLS = 500

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  line: number,
  sig?: string,
  parent?: string,
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: line,
    lineEnd: line,
    body: sig ?? '',
    docstring: parent ?? '',
  }
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

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Handle <# ... #> block comments. A `<#` only opens a real comment when
    // it isn't sitting inside a quoted string literal - PowerShell strings can
    // legitimately contain that two-character sequence (e.g. "the <# marker").
    let line = rawLine
    if (!inBlockComment) {
      const openIdx = findUnquoted(rawLine, '<#')
      if (openIdx !== -1) {
        const closeIdx = rawLine.indexOf('#>', openIdx + 2)
        if (closeIdx !== -1) {
          // Opens and closes on this same line: blank out the comment span
          // (keeping column positions stable) and keep processing the rest of
          // the line as normal code instead of short-circuiting the whole line.
          line = rawLine.slice(0, openIdx) + ' '.repeat(closeIdx + 2 - openIdx) + rawLine.slice(closeIdx + 2)
        } else {
          inBlockComment = true
        }
      }
    }

    if (inBlockComment) {
      if (rawLine.includes('#>')) {
        inBlockComment = false
      }
      braceDepth += (rawLine.match(/\{/g) ?? []).length - (rawLine.match(/\}/g) ?? []).length
      continue
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
      const funcMatch = /^\s*(?:function|filter)\s+([A-Za-z_][\w-]*)/i.exec(line)
      if (funcMatch) {
        const fname = funcMatch[1] ?? ''
        if (symbols.length < MAX_SYMBOLS) {
          symbols.push(makeSymbol(filePath, fname, 'function', lineNum, line.trimEnd().slice(0, 200)))
        }
      }
    }

    // CLASS or ENUM (top-level)
    if (braceDepth === 0) {
      const classMatch = /^\s*(?:class|enum)\s+([A-Za-z_]\w*)/i.exec(line)
      if (classMatch) {
        const cname = classMatch[1] ?? ''
        const kind = /enum/i.test(line) ? 'enum' : 'class'
        if (symbols.length < MAX_SYMBOLS) {
          symbols.push(makeSymbol(filePath, cname, kind, lineNum, line.trimEnd().slice(0, 200)))
        }
        if (kind === 'class') {
          const openCount = (line.match(/\{/g) ?? []).length
          const closeCount = (line.match(/\}/g) ?? []).length
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
            symbols.push(makeSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), currentClass))
          }
        }
      }
    }

    // Apply brace delta BEFORE scope pop check (critical ordering)
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
