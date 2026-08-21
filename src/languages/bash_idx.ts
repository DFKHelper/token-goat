/**
 * Shell/Bash symbol extractor. No tree-sitter grammar is bundled for bash (see
 * isTreeSitterAvailable in parser.ts), so this regex adapter is the only source of
 * `.sh`/`.bash` symbols -- without it every shell script indexes to zero symbols, exactly
 * like an unrecognized language, despite `detectLanguage` already mapping the extension to
 * `'bash'`.
 *
 * Extracts two kinds: top-level `function` declarations (`function name`, `function name()`,
 * or bare POSIX `name()`, all optionally followed by `{` on the same line) and top-level
 * `NAME=value` variable assignments (optionally prefixed with `export`/`declare`/`readonly`, each optionally followed by getopts-style flags like `-a`/`-A`/`-x`/`-r`).
 * "Top-level" means not nested inside another function body -- mirrors the powershell adapter's
 * `braceDepth === 0 && currentClass === null` gate, one level simpler since bash has no classes.
 * Heredoc bodies (`<<EOF ... EOF`, `<<'EOF' ... EOF`, `<<-EOF ... EOF`) are masked out entirely
 * so embedded script content (which can itself contain `#`, `=`, and `{`/`}` that would
 * otherwise desync comment stripping and brace-depth tracking) is never misread as real code.
 * A single line may open several (`cat <<A <<B`), so pending terminators are held as a queue.
 * A here-string (`<<<`) opens no body at all and is deliberately not matched.
 */

import type { SymbolEntry } from '../parser_types.js'
import { isInsideStringLiteral, stripStringLiterals, makeLineSymbol } from './common.js'

const MAX_SYMBOLS = 500

// A bash function name is any word that is not a shell metacharacter, so `-`, `.`, `+` and `:` are all legal and all common in the wild (`docker-run()`, `npm.install()`). Restricting the name to `\w` dropped `my-func()` outright and, worse, silently truncated `function other-func` to `other` -- indexed under a name nothing will ever search for. Variable names have no such freedom: `NAME=value` only accepts `\w`, so VAR_RE is left alone.
const FUNC_NAME = '[A-Za-z_][A-Za-z0-9_.+:-]*'
const FUNC_KEYWORD_RE = new RegExp(`^function\\s+(${FUNC_NAME})\\s*(?:\\(\\s*\\))?`)
const FUNC_POSIX_RE = new RegExp(`^(${FUNC_NAME})\\s*\\(\\s*\\)`)
const VAR_RE = /^(?:(?:export|declare|readonly)\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=/
// The `<` guards on either side keep `<<<` (a here-string, not a heredoc) out. Without them `cmd <<< "hello"` matched from the second `<`, taking `hello` for a heredoc terminator and masking every following line as heredoc body until a line that happened to read exactly `hello` -- usually never, so the rest of the file was lost.
const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/g

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

/**
 * Every real (not-inside-a-string) heredoc terminator opened on `line`, in order. One line may
 * open several (`cat <<A <<B`), and their bodies then follow one after another, each ended by its
 * own terminator. Returning only the first left the second body to be scanned as ordinary code.
 */
/**
 * Blanks out every arithmetic span on `line` -- `$(( ... ))` and the bare `(( ... ))` command --
 * replacing their contents with spaces so character offsets, and therefore
 * {@link isInsideStringLiteral}, still line up with the original.
 *
 * Inside arithmetic, `<<` is the left-shift operator, not a heredoc redirect. With a bare
 * identifier on the right (`$(( 1 << shift ))`, `(( x << bits ))`) {@link HEREDOC_RE} read that
 * identifier as a terminator, and `extractBash` then masked every following line as heredoc body
 * waiting for a line reading exactly `shift` -- which never came, so every function and variable
 * below it vanished from the index. Nothing failed; `symbol`, `read` and `outline` simply
 * returned nothing for them.
 *
 * The sibling scanner in hooks_bash.ts already skips `$(( ... ))` for this exact reason. This is
 * the same guard on the indexer's side, extended to the bare `(( ... ))` form the other one does
 * not need to handle.
 */
function maskArithmeticSpans(line: string, carryDepth: number): { masked: string; depth: number } {
  const chars = line.split('')
  let depth = carryDepth
  for (let i = 0; i < chars.length; i++) {
    // Continuation of a span opened on an earlier line: blank through to its closing paren.
    if (depth > 0) {
      if (chars[i] === '(') depth++
      else if (chars[i] === ')') depth--
      chars[i] = ' '
      continue
    }
    const isDollar = chars[i] === '$' && chars[i + 1] === '(' && chars[i + 2] === '('
    const isBare = chars[i] === '(' && chars[i + 1] === '('
    if (!isDollar && !isBare) continue
    // A `((` inside a quoted word is literal text, not arithmetic. Without this check
    // `echo '(( literal' <<EOF` blanked its own heredoc opener, and every line of the body was
    // then read as ordinary code -- turning whatever the heredoc contained into indexed symbols.
    if (isInsideStringLiteral(line, i)) continue
    const open = isDollar ? i + 1 : i
    for (let j = open; j < chars.length; j++) {
      if (chars[j] === '(') depth++
      else if (chars[j] === ')') depth--
      chars[j] = ' '
      i = j
      if (depth === 0) break
    }
  }
  return { masked: chars.join(''), depth }
}

function findHeredocOpeners(line: string, carryDepth: number): { terminators: string[]; depth: number } {
  const terminators: string[] = []
  const { masked, depth } = maskArithmeticSpans(line, carryDepth)
  HEREDOC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEREDOC_RE.exec(masked)) !== null) {
    if (isInsideStringLiteral(line, m.index)) continue
    const terminator = m[2] ?? ''
    if (terminator) terminators.push(terminator)
  }
  return { terminators, depth }
}

export function extractBash(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = content.split(/\r?\n/)

  // Pending heredoc terminators, oldest first: bodies arrive in the order their redirects were written.
  const heredocs: string[] = []
  // Unclosed `$(( ` / `(( ` nesting carried over from the previous line.
  let arithmeticDepth = 0
  let braceDepth = 0
  let inFunction = false
  let functionBraceDepth = 0
  let awaitingFunctionBrace = false
  // Index in `symbols` of the function whose body is currently open, so its one-line placeholder
  // span can be widened to the real body once the closing brace is seen. Null while no function is
  // open. The end line is taken from this loop's own brace accounting rather than a second pass
  // over the raw text, because only this loop knows which braces are inside a masked heredoc body
  // -- a `{` in a heredoc is not real nesting, and matching braces naively runs a function's span
  // to end-of-file and swallows every function below it.
  let openFunctionIndex: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    if (heredocs.length > 0) {
      // A heredoc terminator must appear alone on its line (leniently, ignoring surrounding
      // whitespace -- real-world scripts are not always strictly POSIX about `<<-` tab-only
      // stripping, and being lenient here only risks closing a heredoc one line early on an
      // unusual body, never desyncing the rest of the file).
      if (rawLine.trim() === heredocs[0]) heredocs.shift()
      continue
    }

    const noComment = stripBashComment(rawLine)
    const stripped = noComment.trim()

    const opened = findHeredocOpeners(noComment, arithmeticDepth)
    // An arithmetic span may span lines (`MASK=$((` … `))`), so its depth carries forward. Without
    // this, only the opening line was blanked and a `<<` on a continuation line was read as a
    // heredoc opener again -- the same silent index loss, one line further down.
    arithmeticDepth = opened.depth
    heredocs.push(...opened.terminators)

    if (!stripped) continue

    if (!inFunction && !awaitingFunctionBrace && braceDepth === 0) {
      const kwMatch = FUNC_KEYWORD_RE.exec(stripped)
      const posixMatch = kwMatch === null ? FUNC_POSIX_RE.exec(stripped) : null
      const funcMatch = kwMatch ?? posixMatch
      if (funcMatch) {
        const fname = funcMatch[1] ?? ''
        let pushedIndex: number | null = null
        if (fname && symbols.length < MAX_SYMBOLS) {
          pushedIndex = symbols.length
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), undefined, lines, 'hash'))
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
              openFunctionIndex = pushedIndex
            }
          } else {
            // Allman-style: `{` follows on a later line.
            awaitingFunctionBrace = true
            openFunctionIndex = pushedIndex
          }
        }
      } else {
        // No `!inFunction` re-check here: the enclosing branch already requires it.
        const varMatch = VAR_RE.exec(stripped)
        if (varMatch) {
          const vname = varMatch[1] ?? ''
          if (vname && symbols.length < MAX_SYMBOLS) {
            symbols.push(makeLineSymbol(filePath, vname, 'variable', lineNum, stripped.slice(0, 200), undefined, lines, 'hash'))
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
      if (openFunctionIndex !== null) {
        const open = symbols[openFunctionIndex]
        // Widen the placeholder span to the real body so `read "script.sh::fn"` returns the
        // function instead of just its `fn() {` line. Guarded on lineNum so a malformed script
        // that somehow closes on the opening line cannot produce an inverted span.
        if (open !== undefined && lineNum > open.lineStart) {
          symbols[openFunctionIndex] = { ...open, lineEnd: lineNum, body: lines.slice(open.lineStart - 1, lineNum).join('\n') }
        }
        openFunctionIndex = null
      }
    }
  }

  return symbols
}
