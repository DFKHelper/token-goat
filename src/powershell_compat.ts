/** Adapts bash-style heredocs and inline Python scripts with complex quotes for reliable execution under PowerShell (both pwsh 7+ and Windows PowerShell 5.1). Windows PowerShell unescapes/strips quotes when passing arguments to native binaries (like python.exe), causing `SyntaxError: unterminated string literal`. Bash heredocs (`<<'EOF'`) also fail under PowerShell's parser. Carrying heredoc bodies as UTF-8 base64 and inline Python `-c` scripts as UTF-8 hex bypasses shell argument parsing and delivers byte-for-byte exact script text: a heredoc body is decoded and piped into its command (`[System.Text.Encoding]::UTF8.GetString(...) | <cmd>`) or written to its file, and a `-c` script goes to a `-c` loader that decodes and runs it, so its arguments and stdin stay as they were. Every rewritten Python call reads and writes its standard streams in UTF-8, and the result reads and writes the same bytes under Windows PowerShell 5.1, whose file cmdlets and $OutputEncoding otherwise use the ANSI code page and ASCII. A double-quoted `-c` script is encoded at run time from the PowerShell string it is, so PowerShell still expands it, and only top-level code is rewritten, never text inside a string, here-string or comment. */

import { quotePowershellPath } from './process_util.js'

/** Matches the line that opens a bash heredoc, `<cmd> <<[-]?'DELIM' [rest of line]`, preceded by start of command, newline, semicolon, &&, or ||. Its body and closing line are the ones layoutPowerShell found for that `<<`. */
// Built fresh for each call, since a global regex keeps its lastIndex between calls.
// eslint-disable-next-line regexp/no-super-linear-backtracking
const heredocRe = (): RegExp => /(?:^|(?<=[;\r\n]|&&|\|\|))\s*([^\r\n;&|<]+?)\s*<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\3([^\r\n]*?)(?=\r?\n)/g

// A heredoc operator, its `-` and its delimiter word, read at a top-level `<<`, and a line that ends the body: the delimiter alone on its line, after tabs for `<<-`, as bash reads it, so `EOF;`, `EOF ` and `EOF` followed by a CR do not end the body.
const HEREDOC_HEAD_RE = /<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\2/y
const HEREDOC_TERMINATOR_RE = /^(\t*)([A-Za-z0-9_]+)$/

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

// A Python interpreter word, with the directory it may be called through: python, python3 or py, each with or without `.exe`. Every Python pattern below is built from this one source.
const PYTHON_NAME = String.raw`(?:python3?|py)(?:\.exe)?`
const PYTHON_BIN = String.raw`(?:[A-Za-z0-9_.:\\/-]*[\\/])?${PYTHON_NAME}`

// Matches inline python invocations with -c: `python [preFlags] -c <quoted_script> [postArgs]` Preceded by start of command, newline, semicolon, &&, or || (not pipe |). Built fresh for each call, since a global regex keeps its lastIndex between calls.
// eslint-disable-next-line regexp/no-super-linear-backtracking
const inlinePythonRe = (): RegExp => new RegExp(String.raw`(?:^|(?<=[;\r\n]|&&|\|\|))\s*(${PYTHON_BIN})\s+([^;&|\r\n]*?)-c\s+`, 'gi')

// Whether a command may hold an inline `python -c` script at all, a cheaper test than finding where.
// eslint-disable-next-line regexp/no-super-linear-backtracking
const INLINE_PYTHON_PROBE_RE = new RegExp(String.raw`${PYTHON_NAME}\s+[^;&|\r\n]*?-c\s+`, 'i')

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
const PYTHON_CALL_RE = new RegExp(String.raw`^${PYTHON_BIN}(?=\s|$)`, 'i')

// The most characters of encoded text a rewrite may carry, kept under Windows' 32,767-character limit for both a command line and an environment variable: a script's hex above it is left as written instead of going to the `-c` loader, a heredoc body's base64 above it stays a heredoc, and a command whose rewrite grows past it, as TG_CMD carries it to the wrapper, is run as written.
export const MAX_ENCODED_CHARS = 28_000

// The `-c` program that runs a script carried as hex in the next argument. It imports nothing but sys, so a base64.py or binascii.py in the working directory cannot stand in for a module it uses; it sets stdin, stdout and stderr to UTF-8 (keeping their error handlers) unless PYTHONIOENCODING already names an encoding, so text crosses a pipe intact, while open() keeps the locale encoding as it does when the script runs unwrapped; and it pops the hex from sys.argv, so the script sees the arguments it had, and a traceback that quotes the `-c` line, as Python 3.13 does, prints this line rather than the whole script.
const PYTHON_LOADER = "(lambda s:(not s.flags.ignore_environment and getattr(s.modules.get('os'),'environ',{}).get('PYTHONIOENCODING')) or [getattr(f,'reconfigure',lambda **k:0)(encoding='utf-8',errors=getattr(f,'errors',None)) for f in (s.stdin,s.stdout,s.stderr)])(__import__('sys'));exec(bytearray.fromhex(__import__('sys').argv.pop(1)[1:]).decode('utf-8'))"
const PYTHON_LOADER_ARG = `'${PYTHON_LOADER.replace(/'/g, "''")}'`

// The base64 of `text` as UTF-8 and the UTF-8 byte count it decodes to.
export function base64Bytes(text: string): { base64: string; bytes: number } {
  const bytes = Buffer.from(text, 'utf8')
  return { base64: bytes.toString('base64'), bytes: bytes.length }
}

// A PowerShell expression for `text`, carried as base64 so no quote or `$` in it is read by PowerShell.
function utf8TextExpression(text: string): string {
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Bytes(text).base64}'))`
}

// Runs a statement list that sets $TgQ to whether its command succeeded, with $OutputEncoding set to UTF-8 without a BOM, so text piped into a cmdlet-fed native command reaches it as UTF-8 under Windows PowerShell 5.1, whose default is ASCII ("héllo" arrived as "h?llo"), as it already does under PowerShell 7. The setting lives in an advanced script block's scope and ends with it, and every heredoc pipe runs in one, as bash runs each pipeline stage in a subshell, so a variable the pipeline sets never outlives it whatever the body holds. The block runs under the caller's $ErrorActionPreference, and since `& { }` always reports success, a failed command is written back as an ignored error so `$?`, `&&`, `||` and the wrapper's exit code still see it fail. A pipe into Python also runs with PYTHONIOENCODING set to UTF-8 unless it already names an encoding, since a script read from stdin can be reached only through the environment, and the variable is put back as it was, unset included, however the statements end.
function inUtf8PipeScope(statements: string, python: boolean): string {
  const run = python ? `$TgPy = $env:PYTHONIOENCODING; if (-not $TgPy) { $env:PYTHONIOENCODING = 'utf-8' }; $TgQ = $false; try { ${statements} } finally { $env:PYTHONIOENCODING = $TgPy }; if (-not $TgQ)` : `$TgQ = $false; ${statements}; if (-not $TgQ)`
  return `& { [CmdletBinding()] param($TgEap) $ErrorActionPreference = $TgEap; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${run} { $PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([System.Exception]::new('pipeline failed'), 'TgPipelineFailed', [System.Management.Automation.ErrorCategory]::NotSpecified, $null)) } } $ErrorActionPreference -ErrorAction Ignore`
}

// One argument as CreateProcess's command-line parser reads it back: quoted when it is empty or holds a blank or a quote, with the backslashes before a quote and before the closing quote doubled.
function windowsArgument(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

// The name of a PowerShell cmdlet, written Verb-Noun: a command that takes the text as a string object, whatever its bytes, never a native program.
const CMDLET_WORD_RE = /^[A-Z][A-Za-z]*-[A-Z][A-Za-z]*(?=\s|$)/

// A native command line as the program name and its arguments in Windows command-line form, or null when any word is one the two shells read differently, or when it holds anything but words (a pipe, a redirect, a quoted program name). A bare word is made of letters, digits and `_ . / : = + -` alone, so it holds no quote, `$`, backtick, backslash, comma, glob or redirect character. PowerShell would hand the program the same words, so the program can be started directly.
function nativeCommandLine(command: string): { program: string; args: string } | null {
  const line = command.trim()
  // A single-quoted word holds its text as is in both shells, and a double-quoted one does too when it holds nothing either shell expands or escapes; neither holds a curly quote, which PowerShell reads as a quote of its own.
  const wordRe = /\s*(?:'([^'‘-‛]*)'|"([^"$`\\“-„]*)"|([A-Za-z0-9_./:=+-]+))(?=\s|$)/y
  const words: string[] = []
  let quotedProgram = false
  for (let at = 0; at < line.length; at = wordRe.lastIndex) {
    wordRe.lastIndex = at
    const word = wordRe.exec(line)
    if (word === null) return null
    quotedProgram ||= words.length === 0 && word[3] === undefined
    words.push(word[1] ?? word[2] ?? (word[3] as string))
  }
  const program = words.shift()
  return program === undefined || quotedProgram ? null : { program, args: words.map(windowsArgument).join(' ') }
}

// The statements that give a native program `body` on its standard input byte for byte, as bash does. A string piped into a native command always ends with a line break of PowerShell's own ("\r\n"), which no $OutputEncoding or trimming of the text can turn into the "\n" bash sends, so the program is started directly, in PowerShell's current directory with the console's handles, and handed the bytes; Windows PowerShell 5.1's Process.Start wraps the pipe in a writer of Console.InputEncoding, which writes a BOM first when the console code page is UTF-8 (65001, as on a GitHub runner), so that encoding is a BOM-less UTF-8 for the duration of the start and put back after. A name that is not a program (a cmdlet, alias or function) takes the pipeline, which gives it a string, not a byte stream. The exit code is left in $LASTEXITCODE and $TgQ as a native call leaves it.
function nativeStdinStatements(call: { program: string; args: string }, body: string, pipeline: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const start = `$TgI = [System.Diagnostics.ProcessStartInfo]::new($TgC.Source, ${quote(call.args)}); $TgI.UseShellExecute = $false; $TgI.RedirectStandardInput = $true; $TgI.WorkingDirectory = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath; $TgU = $null; if ($PSVersionTable.PSEdition -eq 'Desktop') { try { $TgU = [Console]::InputEncoding; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { $TgU = $null } }; try { $TgP = [System.Diagnostics.Process]::Start($TgI) } finally { if ($TgU) { try { [Console]::InputEncoding = $TgU } catch { } } }`
  const feed = `$TgB = [System.Convert]::FromBase64String('${body}'); try { $TgP.StandardInput.BaseStream.Write($TgB, 0, $TgB.Length); $TgP.StandardInput.Close() } catch [System.IO.IOException] { }; $TgP.WaitForExit(); $global:LASTEXITCODE = $TgP.ExitCode; $TgQ = $TgP.ExitCode -eq 0`
  return `$TgC = Get-Command -Name ${quote(call.program)} -ErrorAction Ignore | Select-Object -First 1; if ($TgC -and $TgC.CommandType -eq 'Application') { ${start}; ${feed} } else { ${pipeline}; $TgQ = $? }`
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

// A bare redirect word with no character PowerShell or bash would read as code, a quote or a pattern ($, a backtick, parentheses, braces, a quote of any kind, a glob character, a space) and no leading `-`, `@` or `#`. A backslash is one too: bash removes it from a bare word (`C:\temp\x.txt` is `C:tempx.txt`) where PowerShell keeps it, so only a quoted word that holds one is rewritten.
const BARE_REDIRECT_PATH_RE = /^[^\s>|;&<(){}$`'"@#*?[\\\u2018-\u201E-][^\s>|;&<(){}$`'"*?[\\\u2018-\u201E]*$/

// What a quoted redirect word must not hold between its quotes, or bash and PowerShell read different text: a quote of its own kind (PowerShell also ends a string at a curly quote, and reads a doubled quote as one), and in double quotes a backtick or a backslash before a backslash or `$`, escapes the two shells read differently.
const SINGLE_QUOTED_UNSAFE_RE = /['\u2018-\u201B]/
const DOUBLE_QUOTED_UNSAFE_RE = /["\u201C-\u201E`]|\\[\\$]/

// The PowerShell string a `cat >` redirect word names its file with, or null for a word this adapter does not read the way bash does, which is then left as written. A quoted word keeps its own quotes; a bare word goes in single quotes, so nothing in it runs as code.
function redirectPath(word: string): string | null {
  const quote = word[0]
  if (quote === "'" || quote === '"') {
    const body = word.length >= 2 && word.endsWith(quote) ? word.slice(1, -1) : null
    return body !== null && !(quote === "'" ? SINGLE_QUOTED_UNSAFE_RE : DOUBLE_QUOTED_UNSAFE_RE).test(body) ? word : null
  }
  return BARE_REDIRECT_PATH_RE.test(word) ? quotePowershellPath(word) : null
}

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
    const redirect = /^(>>?)\s*([^\s>].*)$/s.exec(rest)
    const path = redirect ? redirectPath(redirect[2] as string) : null
    return redirect && path !== null ? { kind: 'file', append: redirect[1] === '>>', path } : null
  }
  return /^[\w.:/\\-]+(?:\s|$)/.test(target) ? { kind: 'pipe', command: target } : null
}

// The PowerShell statement that delivers a heredoc's text to its target, or null for a delivery that would not match bash. A file gets exactly the bytes bash writes, in UTF-8 with no BOM, through [IO.File] rather than Set-Content or Add-Content, which write the ANSI code page under Windows PowerShell 5.1 and end the file with CRLF; the path is the string redirectPath made of the redirect word, resolved against PowerShell's location, not .NET's current directory. A bare `cat` writes the same bytes to standard output, since Write-Output prints in the console code page under both shells ("é" came out as 0x82). A body is piped into a cmdlet under a UTF-8 $OutputEncoding, and into a native program as bytes (see nativeStdinStatements), with UTF-8 standard streams for Python, and an empty body pipes in nothing at all. A form whose bytes cannot be matched is left as written: a native command line holding more than words, a body whose base64 would not fit the wrapper's environment variable, and, inside a `$(...)` or other parentheses, where PowerShell would capture the output, a write to standard output or a native program, which write past the capture.
function heredocStatement(target: HeredocTarget, text: string, captured: boolean): string | null {
  const { base64, bytes } = base64Bytes(text)
  if (base64.length > MAX_ENCODED_CHARS) return null
  if (target.kind === 'file') {
    const path = `$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(${target.path})`
    return `[System.IO.File]::${target.append ? 'AppendAllText' : 'WriteAllText'}(${path}, ${utf8TextExpression(text)}, [System.Text.UTF8Encoding]::new($false))`
  }
  if (target.kind === 'stdout') return captured ? null : `[System.Console]::OpenStandardOutput().Write([System.Convert]::FromBase64String('${base64}'), 0, ${bytes})`
  // PowerShell ends each string it pipes into a native command with a line break, so the text goes in without its own last one.
  const input = text === '' ? '@()' : utf8TextExpression(text.slice(0, -1))
  const [first, rest] = splitFirstPipeline(target.command)
  const cmdlet = CMDLET_WORD_RE.test(first)
  const native = cmdlet ? null : nativeCommandLine(first)
  if (!cmdlet && (native === null || captured)) return null
  const pipeline = `${input} | ${first}`
  const statements = native === null ? `${pipeline}; $TgQ = $?` : nativeStdinStatements(native, base64, pipeline)
  return `${inUtf8PipeScope(statements, PYTHON_CALL_RE.test(first.trim()))}${rest}`
}

// The text bash reads from a heredoc body: each line ended by `\n`, nothing for a body with no lines, and with each line's leading tabs removed for `<<-`.
function heredocText(body: string, stripTabs: boolean): string {
  const text = body.replace(/\r?\n$/, '\n')
  return stripTabs ? text.replace(/^\t+/gm, '') : text
}

// Whether the top-level code before `index` holds an unclosed `(`, as in `$(...)` or `$x = (...)`, where PowerShell captures what a statement outputs.
function insideParentheses(command: string, layout: PowerShellLayout, index: number): boolean {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (layout.code[i] === 1) depth += command[i] === '(' ? 1 : command[i] === ')' ? -1 : 0
  }
  return depth > 0
}

/** Adapts bash heredoc syntax into PowerShell: the body is carried as base64 and piped into its command or written to its file. Only a heredoc whose `<<` is top-level code is rewritten, so `<<EOF` inside a string, here-string or comment is left alone. A body under an unquoted delimiter that holds `$`, a backtick or a backslash, which bash would expand, is left as written rather than delivered unexpanded. */
export function adaptHeredoc(command: string): string {
  const layout = layoutPowerShell(command)
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  const heredocs = heredocRe()
  while ((match = heredocs.exec(command)) !== null) {
    const whole = match[0]
    const start = match.index + whole.length - whole.trimStart().length
    const lineEnd = match.index + whole.length
    const op = match.index + whole.indexOf('<<')
    const span = layout.code[start] === 1 ? layout.heredocs.get(op) : undefined
    const text = span !== undefined && span.bodyStart === lineEnd + (command[lineEnd] === '\r' ? 2 : 1) ? heredocText(command.slice(span.bodyStart, span.termStart), match[2] === '-') : null
    const target = text !== null && (match[3] !== '' || !/[$`\\]/.test(text)) ? heredocTarget(match[1] as string, match[5] ?? '') : null
    const statement = text !== null && target !== null ? heredocStatement(target, text, insideParentheses(command, layout, op)) : null
    if (span === undefined || statement === null) {
      heredocs.lastIndex = match.index + 1
      continue
    }
    result += `${command.slice(lastIndex, start)}${statement}`
    lastIndex = span.end
    heredocs.lastIndex = span.end
  }
  return result + command.slice(lastIndex)
}

/** Adapts inline `python -c ...` commands into a `-c` loader that runs the script from a hex argument with UTF-8 standard streams, to prevent PowerShell quote stripping and `SyntaxError: unterminated string literal`. */
export function adaptInlinePython(command: string): string {
  const layout = layoutPowerShell(command)
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  const inlinePython = inlinePythonRe()

  while ((match = inlinePython.exec(command)) !== null) {
    const matchStart = match.index
    const matchEnd = inlinePython.lastIndex
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
      if (hexArg.length > MAX_ENCODED_CHARS) continue
      loaderArgs = `${PYTHON_LOADER_ARG} ${hexArg}`
    } else {
      // A double-quoted script is PowerShell's to expand ($variables, $(...), backtick escapes, doubled quotes), so the string itself is encoded at run time and Python gets it exactly as PowerShell would have passed it to -c. Its length is known only then, so a script too long for the loader is passed as the original would have passed it.
      const expandable = command.slice(matchEnd, scriptEnd)
      loaderArgs = `$(& { param($TgS) $TgH = 'x' + [System.BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes($TgS)).Replace('-', ''); if ($TgH.Length -gt ${MAX_ENCODED_CHARS}) { $TgS } else { ${PYTHON_LOADER_ARG}; $TgH } } ${expandable})`
    }

    // The script stays a `-c` script, carried as hex (an `x` ahead of it, since Windows PowerShell 5.1 drops an empty argument) after a loader that decodes and runs it, so no quote in it reaches PowerShell's native argument passing, sys.argv keeps `-c` and every later argument, and stdin is left to the script.
    const leadMatch = command.slice(matchStart, matchEnd).match(/^\s*/)
    const leadSpace = leadMatch ? leadMatch[0] : ''
    result += `${command.slice(lastIndex, matchStart)}${leadSpace}${pyBin}${preFlags ? ` ${preFlags}` : ''} -c ${loaderArgs}`

    lastIndex = scriptEnd
    inlinePython.lastIndex = lastIndex
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
  if (INLINE_PYTHON_PROBE_RE.test(adapted)) {
    adapted = adaptInlinePython(adapted)
  }
  // The wrapper carries the command in the TG_CMD environment variable, which Windows caps at 32,767 characters, so a rewrite that grew past the encoded-text limit is dropped and the command runs as written.
  return adapted.length > MAX_ENCODED_CHARS ? command : adapted
}

