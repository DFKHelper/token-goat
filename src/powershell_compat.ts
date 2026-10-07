/** Adapts bash-style heredocs and inline Python scripts with complex quotes for reliable execution under PowerShell (both pwsh 7+ and Windows PowerShell 5.1). Windows PowerShell unescapes/strips quotes when passing arguments to native binaries (like python.exe), causing `SyntaxError: unterminated string literal`. Bash heredocs (`<<'EOF'`) also fail under PowerShell's parser. Carrying heredoc bodies as UTF-8 base64 and inline Python `-c` scripts as UTF-8 hex bypasses shell argument parsing and delivers byte-for-byte exact script text: a heredoc body is decoded and piped into its command (`[System.Text.Encoding]::UTF8.GetString(...) | <cmd>`) or written to its file, and a `-c` script goes to a `-c` loader that decodes and runs it, so its arguments and stdin stay as they were. Every rewritten Python call reads and writes its standard streams in UTF-8, and the result reads and writes the same bytes under Windows PowerShell 5.1, whose file cmdlets and $OutputEncoding otherwise use the ANSI code page and ASCII. A double-quoted `-c` script is encoded at run time from the PowerShell string it is, so PowerShell still expands it, and only top-level code is rewritten, never text inside a string, here-string or comment. */

/** Matches the line that opens a bash heredoc, `<cmd> <<[-]?'DELIM' [rest of line]`, preceded by start of command, newline, semicolon, &&, or ||. Its body and closing line are the ones layoutPowerShell found for that `<<`. */
// eslint-disable-next-line regexp/no-super-linear-backtracking
const HEREDOC_RE = /(?:^|(?<=[;\r\n]|&&|\|\|))\s*([^\r\n;&|<]+?)\s*<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\3([^\r\n]*?)(?=\r?\n)/g

// A heredoc operator, its `-` and its delimiter word, read at a top-level `<<`, and a line that ends the body: the delimiter at the start of the line, or after tabs for `<<-`, as bash reads it, optionally followed by blanks and `;`, `&`, `|` or a CR.
const HEREDOC_HEAD_RE = /<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\2/y
const HEREDOC_TERMINATOR_RE = /^(\t*)([A-Za-z0-9_]+)[ \t]*(?=$|[\r;&|])/

// PowerShell reads the curly and low-9 quotation marks as quotes too.
const SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B"
const DOUBLE_QUOTES = '"\u201C\u201D\u201E'

interface Span { end: number; closed: boolean }

// A heredoc body runs from `bodyStart` to `termStart`, the start of its closing line, and `end` is the index just past the closing delimiter.
interface HeredocSpan { bodyStart: number; termStart: number; end: number }

/** Where a command's top-level PowerShell code is: `code[i]` is 1 for a character outside every string, here-string, comment, braced variable and recognized heredoc body, `stringEnd` maps a top-level string's opening quote to the index just past its closing quote, and `heredocs` maps a top-level `<<` whose body was found to that body's span. */
interface PowerShellLayout {
  code: Uint8Array
  stringEnd: Map<number, number>
  heredocs: Map<number, HeredocSpan>
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
function skipHeredocBodies(src: string, start: number, pending: Array<{ op: number; delim: string; stripTabs: boolean }>, heredocs: Map<number, HeredocSpan>): number {
  const found: Array<[number, HeredocSpan]> = []
  let lineStart = start
  for (const { op, delim, stripTabs } of pending) {
    let span: HeredocSpan | null = null
    for (let ls = lineStart; ls <= src.length; ) {
      const nl = src.indexOf('\n', ls)
      const term = HEREDOC_TERMINATOR_RE.exec(src.slice(ls, nl === -1 ? src.length : nl))
      if (term && term[2] === delim && (stripTabs || term[1] === '')) {
        span = { bodyStart: lineStart, termStart: ls, end: ls + term[0].length }
        break
      }
      if (nl === -1) break
      ls = nl + 1
    }
    if (span === null) return start
    found.push([op, span])
    const nl = src.indexOf('\n', span.end)
    lineStart = nl === -1 ? src.length : nl + 1
  }
  for (const [op, span] of found) heredocs.set(op, span)
  return (found[found.length - 1] as [number, HeredocSpan])[1].end
}

/** Lexes just enough PowerShell to tell top-level code from strings, here-strings, comments and bash heredoc bodies, so a rewrite never reaches into text PowerShell would not run as a statement. */
function layoutPowerShell(src: string): PowerShellLayout {
  const code = new Uint8Array(src.length)
  const stringEnd = new Map<number, number>()
  const heredocs = new Map<number, HeredocSpan>()
  let pending: Array<{ op: number; delim: string; stripTabs: boolean }> = []
  let i = 0
  while (i < src.length) {
    if (src[i] === '\n' && pending.length > 0) {
      code[i] = 1
      i = skipHeredocBodies(src, i + 1, pending, heredocs)
      pending = []
      continue
    }
    HEREDOC_HEAD_RE.lastIndex = i
    const head = src[i] === '<' ? HEREDOC_HEAD_RE.exec(src) : null
    if (head) {
      pending.push({ op: i, delim: head[3] as string, stripTabs: head[1] === '-' })
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
  return { code, stringEnd, heredocs }
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

// A Python interpreter word at the start of a command.
const PYTHON_CALL_RE = /^(?:[A-Za-z0-9_.:\\/-]*[\\/])?(?:python3?|py)(?:\.exe)?(?=\s|$)/i

// A script's hex above this many characters is left as written instead of going to the `-c` loader, which keeps the rewritten command line under Windows' 32,767-character limit.
const MAX_LOADER_HEX = 28_000

// The `-c` program that runs a script carried as hex in the next argument. It imports nothing but sys, so a base64.py or binascii.py in the working directory cannot stand in for a module it uses; it sets stdin, stdout and stderr to UTF-8 (keeping their error handlers) unless PYTHONIOENCODING already names an encoding, so text crosses a pipe intact, while open() keeps the locale encoding as it does when the script runs unwrapped; and it pops the hex from sys.argv, so the script sees the arguments it had, and a traceback that quotes the `-c` line, as Python 3.13 does, prints this line rather than the whole script.
const PYTHON_LOADER = "(lambda s:(not s.flags.ignore_environment and getattr(s.modules.get('os'),'environ',{}).get('PYTHONIOENCODING')) or [getattr(f,'reconfigure',lambda **k:0)(encoding='utf-8',errors=getattr(f,'errors',None)) for f in (s.stdin,s.stdout,s.stderr)])(__import__('sys'));exec(bytearray.fromhex(__import__('sys').argv.pop(1)[1:]).decode('utf-8'))"
const PYTHON_LOADER_ARG = `'${PYTHON_LOADER.replace(/'/g, "''")}'`

// A PowerShell expression for `text`, carried as base64 so no quote or `$` in it is read by PowerShell.
function utf8TextExpression(text: string): string {
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))`
}

// Runs one pipeline with $OutputEncoding set to UTF-8 without a BOM, so text piped into a native command reaches it as UTF-8 under Windows PowerShell 5.1, whose default is ASCII ("héllo" arrived as "h?llo"), as it already does under PowerShell 7. The setting lives in an advanced script block's scope and ends with the pipeline, and every heredoc pipe runs in one, as bash runs each pipeline stage in a subshell, so a variable the pipeline sets never outlives it whatever the body holds. The block runs under the caller's $ErrorActionPreference, and since `& { }` always reports success, a failed pipeline is written back as an ignored error so `$?`, `&&`, `||` and the wrapper's exit code still see it fail. A pipeline into Python also runs with PYTHONIOENCODING set to UTF-8 unless it already names an encoding, since a script read from stdin can be reached only through the environment, and the variable is put back as it was, unset included, however the pipeline ends.
function inUtf8PipeScope(pipeline: string, python: boolean): string {
  const run = python ? `$TgPy = $env:PYTHONIOENCODING; if (-not $TgPy) { $env:PYTHONIOENCODING = 'utf-8' }; $TgQ = $false; try { ${pipeline}; $TgQ = $? } finally { $env:PYTHONIOENCODING = $TgPy }; if (-not $TgQ)` : `${pipeline}; if (-not $?)`
  return `& { [CmdletBinding()] param($TgEap) $ErrorActionPreference = $TgEap; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${run} { $PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([System.Exception]::new('pipeline failed'), 'TgPipelineFailed', [System.Management.Automation.ErrorCategory]::NotSpecified, $null)) } } $ErrorActionPreference -ErrorAction Ignore`
}

// Splits a command at its first top-level `;`, `&&` or `||`, so only the pipeline before it goes into a scope and later statements still run in the caller's.
function splitFirstPipeline(command: string): [string, string] {
  const layout = layoutPowerShell(command)
  for (let i = 0; i < command.length; i++) {
    if (layout.code[i] === 1 && /^(?:;|&&|\|\|)/.test(command.slice(i, i + 2))) return [command.slice(0, i).trimEnd(), ` ${command.slice(i)}`]
  }
  return [command, '']
}

type HeredocTarget = { kind: 'pipe'; command: string } | { kind: 'stdout' } | { kind: 'file'; append: boolean; path: string }

// Where a heredoc body goes, or null for a form this adapter does not recognize, which is then left as written rather than half rewritten. `cat` writes to standard output, `cat > f` and `cat >> f` to a file, and `cat | cmd` pipes the body straight into cmd.
function heredocTarget(prefix: string, suffix: string): HeredocTarget | null {
  const target = `${prefix.trim()} ${suffix.trim()}`.trim()
  // Append ' -' to python/py/node when no script file or dash argument exists
  if (/^(?:.*[/\\])?(?:python3?|py|node)(?:\.exe)?$/i.test(target)) return { kind: 'pipe', command: `${target} -` }
  const cat = /^cat(?=\s|[|>]|$)(.*)$/is.exec(target)
  if (cat) {
    const rest = (cat[1] as string).trim()
    if (rest === '') return { kind: 'stdout' }
    if (rest.startsWith('|')) {
      const command = rest.slice(1).trim()
      return command ? { kind: 'pipe', command } : null
    }
    const redirect = /^(>>?)\s*("[^"]*"|'[^']*'|[^\s>|;&<'"]+)$/.exec(rest)
    if (!redirect) return null
    return { kind: 'file', append: redirect[1] === '>>', path: redirect[2] as string }
  }
  return /^[\w.:/\\-]+(?:\s|$)/.test(target) ? { kind: 'pipe', command: target } : null
}

// The PowerShell statement that delivers a heredoc's text to its target. A file gets exactly the bytes bash writes, in UTF-8 with no BOM, through [IO.File] rather than Set-Content or Add-Content, which write the ANSI code page under Windows PowerShell 5.1 and end the file with CRLF; the path is read as the cmdlet's argument would have been and resolved against PowerShell's location, not .NET's current directory. A bare `cat` writes the same bytes to standard output, since Write-Output prints in the console code page under both shells ("é" came out as 0x82). A body is piped into its command under a UTF-8 $OutputEncoding, and into Python with UTF-8 standard streams, and an empty body pipes in nothing at all.
function heredocStatement(target: HeredocTarget, text: string): string {
  if (target.kind === 'file') {
    const path = `$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Write-Output ${target.path}))`
    return `[System.IO.File]::${target.append ? 'AppendAllText' : 'WriteAllText'}(${path}, ${utf8TextExpression(text)}, [System.Text.UTF8Encoding]::new($false))`
  }
  if (target.kind === 'stdout') return `[System.Console]::OpenStandardOutput().Write([System.Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'), 0, ${Buffer.byteLength(text, 'utf8')})`
  // PowerShell ends each string it pipes into a native command with a line break, so the text goes in without its own last one.
  const input = text === '' ? '@()' : utf8TextExpression(text.slice(0, -1))
  const [first, rest] = splitFirstPipeline(target.command)
  return `${inUtf8PipeScope(`${input} | ${first}`, PYTHON_CALL_RE.test(first.trim()))}${rest}`
}

// The text bash reads from a heredoc body: each line ended by `\n`, nothing for a body with no lines, and with each line's leading tabs removed for `<<-`.
function heredocText(body: string, stripTabs: boolean): string {
  const text = body.replace(/\r?\n$/, '\n')
  return stripTabs ? text.replace(/^\t+/gm, '') : text
}

/** Adapts bash heredoc syntax into PowerShell: the body is carried as base64 and piped into its command or written to its file. Only a heredoc whose `<<` is top-level code is rewritten, so `<<EOF` inside a string, here-string or comment is left alone. A body under an unquoted delimiter that holds `$`, a backtick or a backslash, which bash would expand, is left as written rather than delivered unexpanded. */
export function adaptHeredoc(command: string): string {
  const layout = layoutPowerShell(command)
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  HEREDOC_RE.lastIndex = 0
  while ((match = HEREDOC_RE.exec(command)) !== null) {
    const whole = match[0]
    const start = match.index + whole.length - whole.trimStart().length
    const lineEnd = match.index + whole.length
    const span = layout.code[start] === 1 ? layout.heredocs.get(match.index + whole.indexOf('<<')) : undefined
    const text = span !== undefined && span.bodyStart === lineEnd + (command[lineEnd] === '\r' ? 2 : 1) ? heredocText(command.slice(span.bodyStart, span.termStart), match[2] === '-') : null
    const target = text !== null && (match[3] !== '' || !/[$`\\]/.test(text)) ? heredocTarget(match[1] as string, match[5] ?? '') : null
    if (span === undefined || text === null || target === null) {
      HEREDOC_RE.lastIndex = match.index + 1
      continue
    }
    result += `${command.slice(lastIndex, start)}${heredocStatement(target, text)}`
    lastIndex = span.end
    HEREDOC_RE.lastIndex = span.end
  }
  return result + command.slice(lastIndex)
}

/** Adapts inline `python -c ...` commands into a `-c` loader that runs the script from a hex argument with UTF-8 standard streams, to prevent PowerShell quote stripping and `SyntaxError: unterminated string literal`. */
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

    let loaderArgs: string
    if (isQuote(SINGLE_QUOTES, command[matchEnd])) {
      // A single-quoted script is literal apart from a doubled quote, which stands for its second quote.
      const literal = command.slice(matchEnd + 1, scriptEnd - 1).replace(/['\u2018-\u201B](['\u2018-\u201B])/g, '$1')
      const hexArg = `x${Buffer.from(literal, 'utf8').toString('hex')}`
      if (hexArg.length > MAX_LOADER_HEX) continue
      loaderArgs = `${PYTHON_LOADER_ARG} ${hexArg}`
    } else {
      // A double-quoted script is PowerShell's to expand ($variables, $(...), backtick escapes, doubled quotes), so the string itself is encoded at run time and Python gets it exactly as PowerShell would have passed it to -c. Its length is known only then, so a script too long for the loader is passed as the original would have passed it.
      const expandable = command.slice(matchEnd, scriptEnd)
      loaderArgs = `$(& { param($TgS) $TgH = 'x' + [System.BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes($TgS)).Replace('-', ''); if ($TgH.Length -gt ${MAX_LOADER_HEX}) { $TgS } else { ${PYTHON_LOADER_ARG}; $TgH } } ${expandable})`
    }

    // The script stays a `-c` script, carried as hex (an `x` ahead of it, since Windows PowerShell 5.1 drops an empty argument) after a loader that decodes and runs it, so no quote in it reaches PowerShell's native argument passing, sys.argv keeps `-c` and every later argument, and stdin is left to the script.
    const leadMatch = command.slice(matchStart, matchEnd).match(/^\s*/)
    const leadSpace = leadMatch ? leadMatch[0] : ''
    result += `${command.slice(lastIndex, matchStart)}${leadSpace}${pyBin}${preFlags ? ` ${preFlags}` : ''} -c ${loaderArgs}`

    lastIndex = scriptEnd
    INLINE_PYTHON_RE.lastIndex = lastIndex
  }

  result += command.slice(lastIndex)
  return result
}

/** Transforms bash heredocs and inline Python scripts with quotes into PowerShell that delivers their text intact. */
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

