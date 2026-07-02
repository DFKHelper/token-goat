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
    const line = lines[i] ?? ''
    const stripped = line.trim()

    // Handle <# ... #> block comments
    if (stripped.includes('<#')) {
      inBlockComment = true
    }
    if (inBlockComment) {
      if (stripped.includes('#>')) {
        inBlockComment = false
      }
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      continue
    }

    // Skip empty lines and single-line comments (#)
    if (!stripped || stripped.startsWith('#')) {
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      continue
    }

    const lineNum = i + 1

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
          currentClass = cname
          classBraceDepth = braceDepth
          classBodyEntered = false
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
