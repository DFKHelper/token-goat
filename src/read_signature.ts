import { bodyFromDeclaration, firstBodyLine } from './read_suggest.js'

/**
 * Extracts a compact declaration signature from a symbol's body.
 * Skips implementation blocks { ... }, Python suites, or multiline method bodies,
 * returning the declaration header up to the opening brace, colon, or semicolon.
 */
export function extractSignature(body: string, _kind?: string): string {
  const cleanBody = bodyFromDeclaration(body).trim()
  if (cleanBody === '') return ''

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

