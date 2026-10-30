import { bodyFromDeclaration, firstBodyLine } from './read_suggest.js'

function cobolCodeLines(body: string): string[] {
  return body.split(/\r?\n/).map((raw) => {
    let line = raw
    if (/^[ 0-9]{6}[ */Dd-]/.test(line)) {
      const indicator = line[6]
      if (indicator === '*' || indicator === '/' || indicator === 'D' || indicator === 'd') return ''
      line = line.slice(7, 72)
    }
    let quote = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (quote !== '') {
        if (ch === quote) {
          if (line[i + 1] === quote) i++
          else quote = ''
        }
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '*' && line[i + 1] === '>') return line.slice(0, i).trim()
    }
    return line.trim()
  }).filter((line) => line !== '')
}

function cobolPeriodIndex(text: string): number {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) {
        if (text[i + 1] === quote) i++
        else quote = ''
      }
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '.' && !(i > 0 && /\d/.test(text[i - 1]!) && /\d/.test(text[i + 1] ?? ''))) return i
  }
  return -1
}

function cobolSignature(body: string, kind?: string): string | undefined {
  const lines = cobolCodeLines(body)
  const first = lines[0]
  if (first === undefined) return undefined
  if (kind === 'section') return /^([A-Za-z0-9][A-Za-z0-9-]*\s+SECTION\s*\.)/i.exec(first)?.[1]?.trim()
  if (kind === 'paragraph') return /^([A-Za-z0-9][A-Za-z0-9-]*\s*\.)/.exec(first)?.[1]?.trim()
  if (kind !== 'variable' || !/^01\b/i.test(first)) return undefined
  let declaration = ''
  for (const line of lines) {
    declaration = declaration === '' ? line : `${declaration} ${line}`
    const period = cobolPeriodIndex(declaration)
    if (period >= 0) return declaration.slice(0, period + 1).trim()
  }
  return declaration
}

/**
 * Extracts a compact declaration signature from a symbol's body.
 * Skips implementation blocks { ... }, Python suites, or multiline method bodies,
 * returning the declaration header up to the opening brace, colon, or semicolon.
 */
export function extractSignature(body: string, kind?: string, filePath?: string): string {
  // Java annotations are part of the declaration signature; other languages keep the decorator-stripping behavior.
  const preserveJavaAnnotations = filePath?.toLowerCase().endsWith('.java') === true
  const cleanBody = (preserveJavaAnnotations ? body : bodyFromDeclaration(body)).trim()
  if (cleanBody === '') return ''
  const cobol = cobolSignature(cleanBody, kind)
  if (cobol !== undefined) return cobol

  // Look for implementation block open `{` or `:` that is outside of parentheses `()` or angle brackets `<>`
  let parenDepth = 0
  let braceDepth = 0
  let bracketDepth = 0
  let inString: string | null = null

  for (let i = 0; i < cleanBody.length; i++) {
    const ch = cleanBody[i]

    if (inString !== null) {
      if (ch === '\\') {
        i++
      } else if (ch === inString) {
        inString = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }

    if (ch === '(') {
      parenDepth++
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (ch === '{') {
      if (parenDepth === 0 && bracketDepth === 0) {
        // This is the start of the function/class body!
        const sig = cleanBody.slice(0, i).trimEnd()
        if (sig.length > 0) return sig
      }
      braceDepth++
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (ch === ':') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        // Check if this is a Python suite opener: "def ...:", "async def ...:", "class ...:"
        const prefix = cleanBody.slice(0, i + 1).trim()
        if (/^(?:async\s+def|def|class)\b/.test(prefix)) {
          return prefix
        }
      }
    }
  }

  // Fallback to firstBodyLine if no opening block was found (e.g. interfaces, type aliases)
  return firstBodyLine(cleanBody)
}
