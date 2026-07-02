/**
 * Structural skeleton extraction for code compression.
 *
 * Extracts function/class signatures and import statements, replacing bodies
 * with placeholder comments to reduce token count while preserving structure.
 */

const supportedExts = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.rs', '.java'])

const pyImportRe = /^(import |from )/
const pyDefRe = /^(async\s+)?def\s|^class\s/
const pyDecoratorRe = /^@/
const pyTypeAliasRe = /^[A-Z]\w*\s*(?::\s*\w+\s*)?=/

const jsSignatureRe = /^\s*(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+)*(?:function\b|class\b|interface\b|type\b|enum\b|const\s+\w|let\s+\w|var\s+\w)/

const goSignatureRe = /^\s*(?:func\s|type\s+\w+\s+(?:struct|interface)\b)/
const rustSignatureRe = /^\s*(?:pub(?:\s+\(crate\))?\s+)?(?:async\s+)?(?:fn\s|struct\s|enum\s|trait\s|impl\b)/
const javaSignatureRe = /^\s*(?:(?:public|private|protected|static|abstract|final|native|synchronized)\s+)+(?:class\b|interface\b|enum\b|void\b|\w+)\s+\w+\s*[(<]/

const importRe = /^\s*(?:import\b|from\b|use\b|require\b)/

const jsRegexPrevChars = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
const jsRegexPrevKeywords = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void', 'delete', 'instanceof', 'new', 'yield', 'await'])

/**
 * Compress source code to a skeleton: signatures + structure only.
 *
 * @param source The source code.
 * @param fileExt The file extension (e.g., '.ts', '.py').
 * @returns Skeleton string, or null if extension not supported.
 */
export function compressToSkeleton(source: string, fileExt: string): string | null {
  if (!supportedExts.has(fileExt)) {
    return null
  }
  if (!source) {
    return ''
  }
  if (fileExt === '.py') {
    return compressPython(source)
  }
  return compressBraceLang(source, fileExt)
}

/**
 * Compress Python source to skeleton.
 */
function compressPython(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const stripped = line.trimStart()
    const indent = line.length - stripped.length

    if (!stripped) {
      i++
      continue
    }

    if (indent === 0 && pyImportRe.test(stripped)) {
      out.push(line)
      i++
      continue
    }

    if (indent === 0 && /^__all__\s*=/.test(stripped)) {
      out.push(line)
      i++
      continue
    }

    if (indent === 0 && pyTypeAliasRe.test(stripped)) {
      out.push(line)
      i++
      continue
    }

    if (pyDecoratorRe.test(stripped)) {
      out.push(line)
      i++
      continue
    }

    if (pyDefRe.test(stripped)) {
      out.push(line)
      i++
      let bodyCount = 0

      while (i < lines.length) {
        const nxt = lines[i]!
        const nxtStripped = nxt.trimStart()
        if (!nxtStripped) {
          i++
          continue
        }

        const nxtIndent = nxt.length - nxtStripped.length
        if (nxtIndent <= indent) {
          break
        }

        if (pyDecoratorRe.test(nxtStripped) || pyDefRe.test(nxtStripped)) {
          break
        }

        bodyCount++
        i++
      }

      if (bodyCount > 0) {
        const bodyPfx = ' '.repeat(indent + 4)
        out.push(`${bodyPfx}# ... ${bodyCount} lines`)
      }
      continue
    }

    i++
  }

  return out.join('\n')
}

/**
 * Skip a brace-delimited block. Returns [next_line_index, body_line_count].
 */
function skipBraceBody(lines: string[], start: number, initialDepth: number, isJsTs: boolean = false): [number, number] {
  let depth = initialDepth
  let bodyCount = 0
  let i = start
  let inBlockComment = false
  // Carries "still inside an unclosed backtick template literal" state across lines, so real
  // braces/comments inside a multi-line template literal's content are not scanned as code.
  let inTemplateLiteral = false
  let prev = ''
  let prevWord = ''
  let word = ''

  while (i < lines.length && depth > 0) {
    const line = lines[i]!
    let j = 0

    if (inTemplateLiteral) {
      let k = 0
      let closed = false
      while (k < line.length) {
        if (line[k] === '\\') {
          k += 2
        } else if (line[k] === '`') {
          k++
          closed = true
          break
        } else {
          k++
        }
      }
      inTemplateLiteral = !closed
      j = closed ? k : line.length
    }

    while (j < line.length && depth > 0) {
      const ch = line[j]!

      if (inBlockComment) {
        if (ch === '*' && j + 1 < line.length && line[j + 1] === '/') {
          inBlockComment = false
          j += 2
        } else {
          j++
        }
        continue
      }

      if (/[a-zA-Z0-9_$]/.test(ch)) {
        if (!word) {
          // word_pre = prev
        }
        word += ch
        prev = ch
        j++
        continue
      }

      if (word) {
        prevWord = word
        word = ''
      }

      if (/\s/.test(ch)) {
        j++
        continue
      }

      if (ch === '/' && j + 1 < line.length && line[j + 1] === '/') {
        break
      }

      if (ch === '/' && j + 1 < line.length && line[j + 1] === '*') {
        inBlockComment = true
        j += 2
        continue
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        j++
        let closedQuote = false
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2
          } else if (line[j] === quote) {
            j++
            closedQuote = true
            break
          } else {
            j++
          }
        }
        if (!closedQuote && quote === '`') {
          inTemplateLiteral = true
        }
        prev = quote
        prevWord = ''
        continue
      }

      if (isJsTs && ch === '/' && (prev === '' || jsRegexPrevChars.has(prev) || (jsRegexPrevKeywords.has(prevWord) && prev !== '.'))) {
        let k = j + 1
        let inClass = false
        let closed = false

        while (k < line.length) {
          const c = line[k]!
          if (c === '\\') {
            k += 2
            continue
          }
          if (c === '[') {
            inClass = true
          } else if (c === ']') {
            inClass = false
          } else if (c === '/' && !inClass) {
            k++
            closed = true
            break
          }
          k++
        }

        if (closed) {
          j = k
          prev = '/'
          prevWord = ''
          continue
        }
      }

      if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          break
        }
      }

      prev = ch
      j++
    }

    if (word) {
      prevWord = word
      word = ''
    }

    if (depth > 0) {
      bodyCount++
    }

    i++
  }

  return [i, bodyCount]
}

/**
 * Compress brace-delimited language (JS/TS/Go/Rust/Java) to skeleton.
 */
function compressBraceLang(source: string, fileExt: string): string {
  const isJsTs = ['.js', '.jsx', '.ts', '.tsx'].includes(fileExt)
  let sigRe: RegExp
  if (isJsTs) {
    sigRe = jsSignatureRe
  } else if (fileExt === '.go') {
    sigRe = goSignatureRe
  } else if (fileExt === '.rs') {
    sigRe = rustSignatureRe
  } else {
    sigRe = javaSignatureRe
  }

  const lines = source.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const stripped = line.trimStart()

    if (!stripped) {
      i++
      continue
    }

    if (importRe.test(stripped)) {
      out.push(line)
      i++
      continue
    }

    if (sigRe.test(line) || sigRe.test(stripped)) {
      out.push(line)
      i++

      const depth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
      if (depth > 0) {
        const [nextI, bodyCount] = skipBraceBody(lines, i, depth, isJsTs)
        if (bodyCount > 0) {
          out.push(`// ... ${bodyCount} lines`)
        }
        i = nextI
      } else if (i < lines.length && lines[i]?.trim() === '{') {
        i++
        const [nextI, bodyCount] = skipBraceBody(lines, i, 1, isJsTs)
        if (bodyCount > 0) {
          out.push(`// ... ${bodyCount} lines`)
        }
        i = nextI
      }
      continue
    }

    i++
  }

  return out.join('\n')
}

/**
 * Strip comments from code (language-aware).
 * Handles: // for TS/JS/Go/Rust/Java, # for Python/Ruby.
 * Respects string literals to avoid removing comment chars inside strings.
 */
export function stripComments(code: string, language: string): string {
  const lines = code.split('\n')
  const isPython = ['py', 'ruby'].includes(language)
  // Carries "still inside an unclosed backtick template literal" state across lines, so a
  // multi-line JS/TS template literal's content (including a `//` sequence inside it) isn't
  // mistaken for a real comment.
  let inTemplateLiteral = false

  return lines
    .map((line) => {
      let inString = inTemplateLiteral
      let stringChar = inTemplateLiteral ? '`' : ''
      let i = 0
      inTemplateLiteral = false

      while (i < line.length) {
        const ch = line[i]!

        if (inString) {
          if (ch === '\\' && i + 1 < line.length) {
            i += 2
            continue
          }
          if (ch === stringChar) {
            inString = false
          }
          i++
          continue
        }

        if (ch === '"' || ch === "'" || (!isPython && ch === '`')) {
          inString = true
          stringChar = ch
          i++
          continue
        }

        if (isPython && ch === '#') {
          return line.slice(0, i).trimEnd()
        } else if (!isPython && ch === '/' && i + 1 < line.length && line[i + 1] === '/') {
          return line.slice(0, i).trimEnd()
        }

        i++
      }

      if (inString && stringChar === '`') {
        inTemplateLiteral = true
      }

      return line
    })
    .join('\n')
}

/**
 * Remove consecutive duplicate lines from text.
 */
export function deduplicateLines(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let prevLine = ''

  for (const line of lines) {
    if (line !== prevLine) {
      result.push(line)
      prevLine = line
    }
  }

  return result.join('\n')
}

/**
 * Compress code: apply strip + dedup.
 */
export function compressCode(code: string, language: string, opts?: { stripComments?: boolean; dedup?: boolean }): string {
  let result = code
  if (opts?.stripComments ?? true) {
    result = stripComments(result, language)
  }
  if (opts?.dedup ?? true) {
    result = deduplicateLines(result)
  }
  return result
}
