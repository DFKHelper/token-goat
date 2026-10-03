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
 * Heredoc bodies (`<<EOF ... EOF`, `<<'EOF' ... EOF`, `<<-EOF ... EOF`, `<<\EOF ... EOF`, and any other delimiter word the shell would accept, matched by `matchBashHeredocOpener`) are masked out entirely
 * so embedded script content (which can itself contain `#`, `=`, and `{`/`}` that would
 * otherwise desync comment stripping and brace-depth tracking) is never misread as real code.
 * A single line may open several (`cat <<A <<B`), so pending terminators are held as a queue.
 * A here-string (`<<<`) opens no body at all and is deliberately not matched.
 */

import type { SymbolEntry } from '../parser_types.js'
import { isInsideStringLiteral, stripStringLiterals, makeLineSymbol, matchBashHeredocOpener } from './common.js'
import { extractShellBannerHeading } from '../section_reader.js'

const MAX_SYMBOLS = 10_000 // raised from 500: see makeSymbolEmitter's own comment in common.ts for the measurement

// A bash function name is any word that is not a shell metacharacter, so `-`, `.`, `+` and `:` are all legal and all common in the wild (`docker-run()`, `npm.install()`). Restricting the name to `\w` dropped `my-func()` outright and, worse, silently truncated `function other-func` to `other` -- indexed under a name nothing will ever search for. Variable names have no such freedom: `NAME=value` only accepts `\w`, so VAR_RE is left alone.
const FUNC_NAME = '[A-Za-z_][A-Za-z0-9_.+:-]*'
const FUNC_KEYWORD_RE = new RegExp(`^function\\s+(${FUNC_NAME})\\s*(?:\\(\\s*\\))?`)
const FUNC_POSIX_RE = new RegExp(`^(${FUNC_NAME})\\s*\\(\\s*\\)`)
const VAR_RE = /^(?:(?:export|declare|readonly)\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=/
const COMPOUND_OPENERS = new Set(['if', 'for', 'while', 'until', 'select', 'case'])
const COMPOUND_CLOSERS = new Set(['fi', 'done', 'esac'])
const COMPOUND_PREFIX_WORDS = new Set(['then', 'do', 'else', '!', 'time'])
const COMPOUND_BODY_START_RE = /^(?:if|for|while|until|select|case)\b/
const COMPOUND_SEGMENT_SPLIT_RE = /;|&&|\|\||\||&|\(|\{|\)|\}/

// Cleans one source line for structural scanning: no comment, no string contents.
function cleanForScan(line: string): string {
  return stripStringLiterals(stripBashComment(line)).trim()
}

// Net change in compound-command nesting on one cleaned line, counting only words in command position so `echo if` is not an opener.
function compoundDelta(text: string): number {
  let delta = 0
  for (const segment of text.split(COMPOUND_SEGMENT_SPLIT_RE)) {
    const words = segment.trim().split(/\s+/)
    let w = 0
    while (w < words.length && COMPOUND_PREFIX_WORDS.has(words[w] ?? '')) w++
    const first = words[w] ?? ''
    if (COMPOUND_OPENERS.has(first)) delta++
    else if (COMPOUND_CLOSERS.has(first)) delta--
  }
  return delta
}

const SUBSHELL_TOKEN_RE = /;;&|;;|;&|\|\||&&|[()]|[;&|]|[^\s()&;|]+/g
const CASE_ARM_ENDS = new Set([';;', ';&', ';;&'])
const COMMAND_POSITION_WORDS = new Set(['then', 'do', 'else', 'elif', '!', 'time', '{'])

// Paren nesting of a subshell function body (`f() ( ... )`), read token by token across lines. A case pattern's `)` and its optional leading `(` are not nesting, so a `case` inside the body does not end the function at its first arm.
class SubshellParenScanner {
  private depth = 0
  // One entry per open `case`: 'subject' until `in`, 'pattern' while reading an arm's pattern, 'body' inside an arm.
  private readonly cases: Array<'subject' | 'pattern' | 'body'> = []
  private commandPosition = true

  // Feeds one cleaned line; true once the body's opening `(` has been closed.
  closes(text: string): boolean {
    for (const tok of text.match(SUBSHELL_TOKEN_RE) ?? []) {
      const top = this.cases.length - 1
      const state = this.cases[top]
      if (state === 'subject') {
        if (tok === 'in') this.cases[top] = 'pattern'
        continue
      }
      if (state === 'pattern') {
        if (tok === 'esac') {
          this.cases.pop()
          this.commandPosition = false
        } else if (tok === ')') {
          this.cases[top] = 'body'
          this.commandPosition = true
        }
        continue
      }
      if (state === 'body' && CASE_ARM_ENDS.has(tok)) {
        this.cases[top] = 'pattern'
        continue
      }
      if (tok === '(') {
        this.depth++
        this.commandPosition = true
        continue
      }
      if (tok === ')') {
        this.depth--
        if (this.depth <= 0) return true
        this.commandPosition = false
        continue
      }
      if (this.commandPosition && tok === 'case') this.cases.push('subject')
      else if (this.commandPosition && tok === 'esac' && state === 'body') this.cases.pop()
      this.commandPosition = /^[;&|]/.test(tok) || COMMAND_POSITION_WORDS.has(tok)
    }
    // A newline ends a command, so the next line starts in command position.
    this.commandPosition = true
    return false
  }
}

// A function body need not be a brace group: bash accepts any compound command, so `f() ( ... )`, `f() if ...; fi`, `f() [[ ... ]]` and `f() while ...; done` are all functions. Returns the 1-based line the body ends on, or null when the body is a brace group (or no compound command follows) so the caller keeps its brace tracking. `rest` is the header line's text after the name and `()`; when it is empty the body starts on the next non-blank line.
function findCompoundBodyEnd(lines: string[], headerIdx: number, rest: string): number | null {
  let startIdx = headerIdx
  let text = rest
  if (text === '') {
    let j = headerIdx + 1
    while (j < lines.length && cleanForScan(lines[j] ?? '') === '') j++
    if (j >= lines.length) return null
    startIdx = j
    text = cleanForScan(lines[j] ?? '')
  }
  const kind = text.startsWith('(') ? 'paren' : text.startsWith('[[') ? 'test' : COMPOUND_BODY_START_RE.test(text) ? 'keyword' : null
  if (kind === null) return null
  let depth = 0
  const parens = kind === 'paren' ? new SubshellParenScanner() : null
  for (let k = startIdx; k < lines.length; k++) {
    const cur = k === startIdx ? text : cleanForScan(lines[k] ?? '')
    if (parens !== null) {
      if (parens.closes(cur)) return k + 1
    } else if (kind === 'test') {
      if (cur.includes(']]')) return k + 1
    } else {
      depth += compoundDelta(cur)
      if (depth <= 0) return k + 1
    }
  }
  return null
}

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
  for (let i = 0; i < masked.length; i++) {
    const opener = matchBashHeredocOpener(masked, i)
    if (opener === null) continue
    // The delimiter word is scanned on `masked` (arithmetic blanked) but the quote state is read off the raw line, because blanking replaces characters with spaces and would lose a quote that opened earlier on the line.
    if (isInsideStringLiteral(line, i)) continue
    terminators.push(opener.terminator)
    i = opener.openerEnd - 1
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
  let openHeadingIndex: number | null = null
  // Last line (1-based) of a compound-command function body already spanned; lines up to it are skipped.
  let skipUntil = 0

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

    // Heading comment banners in shell scripts: recognize procedural section dividers
    // (## Section, # -- Section --, # [Section], # REGION:) outside functions
    if (!inFunction && braceDepth === 0 && lineNum > skipUntil) {
      const banner = extractShellBannerHeading(rawLine)
      if (banner !== null) {
        if (openHeadingIndex !== null) {
          const prev = symbols[openHeadingIndex]
          if (prev !== undefined && lineNum > prev.lineStart) {
            symbols[openHeadingIndex] = {
              ...prev,
              lineEnd: lineNum - 1,
              body: lines.slice(prev.lineStart - 1, lineNum - 1).join('\n'),
            }
          }
          openHeadingIndex = null
        }
        if (symbols.length < MAX_SYMBOLS) {
          const pushIdx = symbols.length
          symbols.push({
            filePath,
            name: banner.heading,
            kind: 'heading',
            lineStart: lineNum,
            lineEnd: lineNum,
            body: rawLine.trim(),
            docstring: '',
            parent: '',
          })
          openHeadingIndex = pushIdx
        }
      }
    }

    const noComment = stripBashComment(rawLine)
    const stripped = noComment.trim()

    const opened = findHeredocOpeners(noComment, arithmeticDepth)
    // An arithmetic span may span lines (`MASK=$((` … `))`), so its depth carries forward. Without
    // this, only the opening line was blanked and a `<<` on a continuation line was read as a
    // heredoc opener again -- the same silent index loss, one line further down.
    arithmeticDepth = opened.depth
    heredocs.push(...opened.terminators)

    // Inside a compound-command function body already spanned above: nothing here is a new declaration or brace nesting.
    if (lineNum <= skipUntil) continue

    if (!stripped) continue

    if (!inFunction && !awaitingFunctionBrace && braceDepth === 0) {
      const kwMatch = FUNC_KEYWORD_RE.exec(stripped)
      const posixMatch = kwMatch === null ? FUNC_POSIX_RE.exec(stripped) : null
      const funcMatch = kwMatch ?? posixMatch
      if (funcMatch) {
        if (openHeadingIndex !== null) {
          const prev = symbols[openHeadingIndex]
          if (prev !== undefined && lineNum > prev.lineStart) {
            symbols[openHeadingIndex] = {
              ...prev,
              lineEnd: lineNum - 1,
              body: lines.slice(prev.lineStart - 1, lineNum - 1).join('\n'),
            }
          }
          openHeadingIndex = null
        }
        const fname = funcMatch[1] ?? ''
        let pushedIndex: number | null = null
        if (fname && symbols.length < MAX_SYMBOLS) {
          pushedIndex = symbols.length
          symbols.push(makeLineSymbol(filePath, fname, 'function', lineNum, stripped.slice(0, 200), undefined, lines, 'hash'))
        }
        const rest = stripped.slice(funcMatch[0].length).trim()
        const compoundEnd = fname && !rest.startsWith('{') ? findCompoundBodyEnd(lines, i, rest) : null
        if (compoundEnd !== null) {
          // Subshell / `if` / `[[` / loop body: its extent is known now, so widen the span and skip the body rather than await a brace that belongs to the next function.
          if (pushedIndex !== null) {
            const open = symbols[pushedIndex]
            if (open !== undefined && compoundEnd > lineNum) {
              symbols[pushedIndex] = { ...open, lineEnd: compoundEnd, body: lines.slice(lineNum - 1, compoundEnd).join('\n') }
            }
          }
          skipUntil = compoundEnd
          continue
        } else if (fname) {
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

  // Widen the trailing heading if one remained open through EOF
  if (openHeadingIndex !== null && lines.length > 0) {
    const prev = symbols[openHeadingIndex]
    if (prev !== undefined && lines.length >= prev.lineStart) {
      symbols[openHeadingIndex] = {
        ...prev,
        lineEnd: lines.length,
        body: lines.slice(prev.lineStart - 1, lines.length).join('\n'),
      }
    }
  }

  return symbols
}
