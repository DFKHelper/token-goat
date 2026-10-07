/** Adapts bash-style heredocs and inline Python scripts with complex quotes for reliable execution under PowerShell (both pwsh 7+ and Windows PowerShell 5.1). Windows PowerShell unescapes/strips quotes when passing arguments to native binaries (like python.exe), causing `SyntaxError: unterminated string literal`. Bash heredocs (`<<'EOF'`) also fail under PowerShell's parser. Converting heredoc bodies and inline Python `-c` scripts into UTF-8 Base64 decoded stdin streams (`[System.Text.Encoding]::UTF8.GetString(...) | <cmd>`) bypasses shell argument parsing and delivers byte-for-byte exact script text. A double-quoted `-c` script is piped as the PowerShell string it is, so PowerShell still expands it, and only top-level code is rewritten, never text inside a string, here-string or comment. */

/** Matches bash heredocs: `<cmd> <<[-]?'DELIM'\n<body>\nDELIM` Preceded by start of command, newline, semicolon, &&, or ||. */
// eslint-disable-next-line regexp/no-super-linear-backtracking
const HEREDOC_RE = /(?:^|(?<=[;\r\n]|&&|\|\|))\s*([^\r\n;&|<]+?)\s*<<-?\s*(['"]?)([A-Za-z0-9_]+)\2([^\r\n]*?)(?:\r?\n)([\s\S]*?)(?:\r?\n)[ \t]*\3[ \t]*(?=$|[\r\n;&|])/g

// A heredoc operator and its delimiter word, read at a top-level `<<`, and a line that ends the body (the delimiter, optionally followed by `;`, `&`, `|` or a CR, as HEREDOC_RE accepts).
const HEREDOC_HEAD_RE = /<<-?[ \t]*(['"]?)([A-Za-z0-9_]+)\1/y
const HEREDOC_TERMINATOR_RE = /^[ \t]*([A-Za-z0-9_]+)[ \t]*(?=$|[\r;&|])/

// PowerShell reads the curly and low-9 quotation marks as quotes too.
const SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B"
const DOUBLE_QUOTES = '"\u201C\u201D\u201E'

interface Span { end: number; closed: boolean }

/** Where a command's top-level PowerShell code is: `code[i]` is 1 for a character outside every string, here-string, comment, braced variable and recognized heredoc body, `stringEnd` maps a top-level string's opening quote to the index just past its closing quote, and `heredocEnd` maps a top-level `<<` whose body was found to the index just past its terminating delimiter. */
interface PowerShellLayout {
  code: Uint8Array
  stringEnd: Map<number, number>
  heredocEnd: Map<number, number>
}

function isQuote(quotes: string, ch: string | undefined): boolean {
  return ch !== undefined && quotes.includes(ch)
}

// A single-quoted string is literal apart from a doubled quote; `i` is the index after the opening quote.
function scanSingleQuoted(src: string, i: number): Span {
  for (let j = i; j < src.length; j++) {
    if (!isQuote(SINGLE_QUOTES, src[j])) continue
    if (isQuote(SINGLE_QUOTES, src[j + 1])) {
      j++
      continue
    }
    return { end: j + 1, closed: true }
  }
  return { end: src.length, closed: false }
}

// A double-quoted string ends at an undoubled quote not escaped by a backtick, and a `$(...)` or `${...}` inside it may hold quotes of its own; `i` is the index after the opening quote.
function scanDoubleQuoted(src: string, i: number): Span {
  let j = i
  while (j < src.length) {
    const ch = src[j]
    if (ch === '`') {
      j += 2
    } else if (isQuote(DOUBLE_QUOTES, ch)) {
      if (!isQuote(DOUBLE_QUOTES, src[j + 1])) return { end: j + 1, closed: true }
      j += 2
    } else if (ch === '$' && (src[j + 1] === '(' || src[j + 1] === '{')) {
      const inner = src[j + 1] === '(' ? scanSubexpression(src, j + 2) : scanBracedVariable(src, j + 2)
      if (!inner.closed) return inner
      j = inner.end
    } else {
      j++
    }
  }
  return { end: src.length, closed: false }
}

// `${name}` ends at the first `}` not escaped by a backtick; `i` is the index after the `{`.
function scanBracedVariable(src: string, i: number): Span {
  for (let j = i; j < src.length; j++) {
    if (src[j] === '`') j++
    else if (src[j] === '}') return { end: j + 1, closed: true }
  }
  return { end: src.length, closed: false }
}

// A `$(...)` subexpression ends at its unmatched `)`; `i` is the index after the `(`.
function scanSubexpression(src: string, i: number): Span {
  let depth = 0
  let j = i
  while (j < src.length) {
    const ch = src[j]
    if (ch === ')') {
      if (depth === 0) return { end: j + 1, closed: true }
      depth--
    } else if (ch === '(') {
      depth++
    } else {
      const token = scanToken(src, j)
      if (token) {
        if (!token.closed) return token
        j = token.end
        continue
      }
    }
    j++
  }
  return { end: src.length, closed: false }
}

// The string, here-string, comment, braced variable or backtick escape that starts at `i`, or null when `i` is plain code. A here-string opens with @' or @" at the end of its line and closes at a line that starts with the matching quote and @; a `#` starts a comment only where a token can start.
function scanToken(src: string, i: number): Span | null {
  const ch = src[i] as string
  const next = src[i + 1]
  if (ch === '`') return { end: Math.min(i + 2, src.length), closed: true }
  if (ch === '<' && next === '#') {
    const close = src.indexOf('#>', i + 2)
    return close === -1 ? { end: src.length, closed: false } : { end: close + 2, closed: true }
  }
  if (ch === '#' && (i === 0 || /[\s;|&(){},=]/.test(src[i - 1] as string))) {
    const eol = src.indexOf('\n', i)
    return { end: eol === -1 ? src.length : eol, closed: true }
  }
  if (ch === '@' && (isQuote(SINGLE_QUOTES, next) || isQuote(DOUBLE_QUOTES, next))) {
    const head = /[ \t]*\r?\n/y
    head.lastIndex = i + 2
    if (head.exec(src)) {
      const quotes = isQuote(SINGLE_QUOTES, next) ? SINGLE_QUOTES : DOUBLE_QUOTES
      for (let nl = head.lastIndex - 1; nl !== -1; nl = src.indexOf('\n', nl + 1)) {
        if (isQuote(quotes, src[nl + 1]) && src[nl + 2] === '@') return { end: nl + 3, closed: true }
      }
      return { end: src.length, closed: false }
    }
  }
  if (isQuote(SINGLE_QUOTES, ch)) return scanSingleQuoted(src, i + 1)
  if (isQuote(DOUBLE_QUOTES, ch)) return scanDoubleQuoted(src, i + 1)
  if (ch === '$' && next === '{') return scanBracedVariable(src, i + 2)
  return null
}

// Skips the bodies of the heredocs opened on the line that just ended, in order, returning the index past the last terminator, or `start` (recording none of them) when any body has no terminator.
function skipHeredocBodies(src: string, start: number, pending: Array<{ op: number; delim: string }>, heredocEnd: Map<number, number>): number {
  const found: Array<[number, number]> = []
  let lineStart = start
  for (const { op, delim } of pending) {
    let end = -1
    for (let ls = lineStart; ls <= src.length; ) {
      const nl = src.indexOf('\n', ls)
      const term = HEREDOC_TERMINATOR_RE.exec(src.slice(ls, nl === -1 ? src.length : nl))
      if (term && term[1] === delim) {
        end = ls + term[0].length
        break
      }
      if (nl === -1) break
      ls = nl + 1
    }
    if (end === -1) return start
    found.push([op, end])
    const nl = src.indexOf('\n', end)
    lineStart = nl === -1 ? src.length : nl + 1
  }
  for (const [op, end] of found) heredocEnd.set(op, end)
  return (found[found.length - 1] as [number, number])[1]
}

/** Lexes just enough PowerShell to tell top-level code from strings, here-strings, comments and bash heredoc bodies, so a rewrite never reaches into text PowerShell would not run as a statement. */
function layoutPowerShell(src: string): PowerShellLayout {
  const code = new Uint8Array(src.length)
  const stringEnd = new Map<number, number>()
  const heredocEnd = new Map<number, number>()
  let pending: Array<{ op: number; delim: string }> = []
  let i = 0
  while (i < src.length) {
    if (src[i] === '\n' && pending.length > 0) {
      code[i] = 1
      i = skipHeredocBodies(src, i + 1, pending, heredocEnd)
      pending = []
      continue
    }
    HEREDOC_HEAD_RE.lastIndex = i
    const head = src[i] === '<' ? HEREDOC_HEAD_RE.exec(src) : null
    if (head) {
      pending.push({ op: i, delim: head[2] as string })
      code.fill(1, i, i + 2)
      i += 2
      continue
    }
    const token = scanToken(src, i)
    if (token) {
      if (token.closed && (isQuote(SINGLE_QUOTES, src[i]) || isQuote(DOUBLE_QUOTES, src[i]))) stringEnd.set(i, token.end)
      i = token.end
      continue
    }
    code[i] = 1
    i++
  }
  return { code, stringEnd, heredocEnd }
}

/** Matches inline python invocations with -c: `python [preFlags] -c <quoted_script> [postArgs]` Preceded by start of command, newline, semicolon, &&, or || (not pipe |). */
// eslint-disable-next-line regexp/no-super-linear-backtracking
const INLINE_PYTHON_RE = /(?:^|(?<=[;\r\n]|&&|\|\|))\s*((?:[A-Za-z0-9_.:\\/-]*[\\/])?(?:python3?|py)(?:\.exe)?)\s+([^;&|\r\n]*?)-c\s+/gi

// Whether the words before `-c` are all the interpreter's own options: a script path or `-m` ends them, so a later `-c` is the script's or module's argument (`python -m pytest -c setup.cfg`), and only `-X` and `-W` take a separate value.
function interpreterOptionsOnly(preFlags: string): boolean {
  const words = preFlags.split(/\s+/).filter((w) => w !== '')
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (!/^-[A-Za-z0-9.]+$/.test(w) || w.startsWith('-m')) return false
    if (w === '-X' || w === '-W') i++
  }
  return true
}

// The PowerShell command a heredoc body is piped into, or null for a form this adapter does not recognize, which is then left as written rather than half rewritten. `cat` maps to Write-Output, `cat > f` to Set-Content, `cat >> f` to Add-Content, and `cat | cmd` pipes the body straight into cmd.
function heredocTarget(prefix: string, suffix: string): string | null {
  const target = `${prefix.trim()} ${suffix.trim()}`.trim()
  // Append ' -' to python/py/node when no script file or dash argument exists
  if (/^(?:.*[/\\])?(?:python3?|py|node)(?:\.exe)?$/i.test(target)) return `${target} -`
  const cat = /^cat(?=\s|[|>]|$)(.*)$/is.exec(target)
  if (cat) {
    const rest = (cat[1] as string).trim()
    if (rest === '') return 'Write-Output'
    if (rest.startsWith('|')) return rest.slice(1).trim() || null
    const redirect = /^(>>?)\s*("[^"]*"|'[^']*'|[^\s>|;&<'"]+)$/.exec(rest)
    if (!redirect) return null
    return `${redirect[1] === '>>' ? 'Add-Content' : 'Set-Content'} -Path ${redirect[2] as string}`
  }
  return /^[\w.:/\\-]+(?:\s|$)/.test(target) ? target : null
}

/** Adapts bash heredoc syntax into PowerShell base64 stdin piping. Only a heredoc whose `<<` is top-level code is rewritten, so `<<EOF` inside a string, here-string or comment is left alone. */
export function adaptHeredoc(command: string): string {
  const layout = layoutPowerShell(command)
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  HEREDOC_RE.lastIndex = 0
  while ((match = HEREDOC_RE.exec(command)) !== null) {
    const whole = match[0]
    const start = match.index + whole.length - whole.trimStart().length
    const end = match.index + whole.length
    const topLevel = layout.code[start] === 1 && layout.heredocEnd.get(match.index + whole.indexOf('<<')) === end
    const targetCmd = topLevel ? heredocTarget(match[1] as string, match[4] ?? '') : null
    if (targetCmd === null) {
      HEREDOC_RE.lastIndex = match.index + 1
      continue
    }
    const b64 = Buffer.from(match[5] ?? '', 'utf8').toString('base64')
    result += `${command.slice(lastIndex, start)}[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | ${targetCmd}`
    lastIndex = end
  }
  return result + command.slice(lastIndex)
}

/** Adapts inline `python -c ...` commands into base64 stdin piping to prevent PowerShell quote stripping and `SyntaxError: unterminated string literal`. */
export function adaptInlinePython(command: string): string {
  const layout = layoutPowerShell(command)
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  INLINE_PYTHON_RE.lastIndex = 0

  while ((match = INLINE_PYTHON_RE.exec(command)) !== null) {
    const matchStart = match.index
    const matchEnd = INLINE_PYTHON_RE.lastIndex
    const pyBin = match[1] ?? 'python'
    const preFlags = (match[2] ?? '').trim()
    if (!interpreterOptionsOnly(preFlags)) continue

    if (!layout.code.subarray(matchStart, matchEnd).every((c) => c === 1)) continue
    const scriptEnd = layout.stringEnd.get(matchEnd)
    if (scriptEnd === undefined) continue

    let script: string
    if (isQuote(SINGLE_QUOTES, command[matchEnd])) {
      // A single-quoted script is literal apart from a doubled quote, which stands for its second quote.
      const literal = command.slice(matchEnd + 1, scriptEnd - 1).replace(/['\u2018-\u201B](['\u2018-\u201B])/g, '$1')
      script = `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(literal, 'utf8').toString('base64')}'))`
    } else {
      // A double-quoted script is PowerShell's to expand ($variables, $(...), backtick escapes, doubled quotes), so the string itself is piped and PowerShell evaluates it exactly as it would have for -c.
      script = command.slice(matchEnd, scriptEnd)
    }

    result += command.slice(lastIndex, matchStart)
    const leadMatch = command.slice(matchStart, matchEnd).match(/^\s*/)
    const leadSpace = leadMatch ? leadMatch[0] : ''

    let postArgsEnd = scriptEnd
    while (postArgsEnd < command.length && !(layout.code[postArgsEnd] === 1 && /^(?:[;\r\n]|&&|\|\|)/.test(command.slice(postArgsEnd, postArgsEnd + 2)))) postArgsEnd++
    const postArgs = command.slice(scriptEnd, postArgsEnd).trim()

    const pyParts = [pyBin]
    if (preFlags) pyParts.push(preFlags)
    pyParts.push('-')
    if (postArgs) pyParts.push(postArgs)

    result += `${leadSpace}${script} | ${pyParts.join(' ')}`

    lastIndex = postArgsEnd
    INLINE_PYTHON_RE.lastIndex = lastIndex
  }

  result += command.slice(lastIndex)
  return result
}

/** Transforms bash heredocs and inline Python scripts with quotes into safe PowerShell stdin piping constructs. */
export function adaptPowerShellCommand(command: string): string {
  if (!command) return command
  let adapted = command
  // 1. Adapt heredocs first so their internal contents are base64-encoded
  if (adapted.includes('<<')) {
    adapted = adaptHeredoc(adapted)
  }
  // 2. Adapt inline Python -c commands
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  if (/(?:python3?|py)(?:\.exe)?\s+[^;&|\r\n]*?-c\s+/i.test(adapted)) {
    adapted = adaptInlinePython(adapted)
  }
  return adapted
}

