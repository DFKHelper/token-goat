/** Adapts bash-style heredocs and inline Python scripts with complex quotes for reliable execution under PowerShell (both pwsh 7+ and Windows PowerShell 5.1). Windows PowerShell unescapes/strips quotes when passing arguments to native binaries (like python.exe), causing `SyntaxError: unterminated string literal`. Bash heredocs (`<<'EOF'`) also fail under PowerShell's parser. Converting heredoc bodies and inline Python `-c` scripts into UTF-8 Base64 decoded stdin streams (`[System.Text.Encoding]::UTF8.GetString(...) | <cmd>`) bypasses shell argument parsing and delivers byte-for-byte exact script text. */

/** Matches bash heredocs: `<cmd> <<[-]?'DELIM'\n<body>\nDELIM` Preceded by start of command, newline, semicolon, &&, or ||. */
// eslint-disable-next-line regexp/no-super-linear-backtracking
const HEREDOC_RE = /(?:^|(?<=[;\r\n]|&&|\|\|))\s*([^\r\n;&|<]+?)\s*<<-?\s*(['"]?)([A-Za-z0-9_]+)\2([^\r\n]*?)(?:\r?\n)([\s\S]*?)(?:\r?\n)[ \t]*\3[ \t]*(?=$|[\r\n;&|])/g

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

/** Adapts bash heredoc syntax into PowerShell base64 stdin piping. */
export function adaptHeredoc(command: string): string {
  return command.replace(HEREDOC_RE, (_match, prefix: string, _quote: string, _delim: string, suffix: string, body: string) => {
    let targetCmd = (prefix.trim() + ' ' + (suffix ? suffix.trim() : '')).trim()
    // Append ' -' to python/py/node when no script file or dash argument exists
    if (/^(?:.*[/\\])?(python3?|py)(?:\.exe)?$/i.test(targetCmd)) {
      targetCmd += ' -'
    } else if (/^(?:.*[/\\])?node(?:\.exe)?$/i.test(targetCmd)) {
      targetCmd += ' -'
    } else if (/^cat\s*>/i.test(targetCmd)) {
      const dest = targetCmd.slice(targetCmd.indexOf('>') + 1).trim()
      targetCmd = 'Set-Content -Path ' + dest
    } else if (/^cat$/i.test(targetCmd)) {
      targetCmd = 'Write-Output'
    }

    const b64 = Buffer.from(body, 'utf8').toString('base64')
    return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | ${targetCmd}`
  })
}

/** Adapts inline `python -c ...` commands into base64 stdin piping to prevent PowerShell quote stripping and `SyntaxError: unterminated string literal`. */
export function adaptInlinePython(command: string): string {
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

    const rest = command.slice(matchEnd)
    if (!rest || (rest[0] !== "'" && rest[0] !== '"')) continue

    const quote = rest[0]
    let script = ''
    let scriptEnd = -1
    let i = 1

    while (i < rest.length) {
      const ch = rest[i]
      if (quote === "'") {
        if (ch === "'") {
          // In PowerShell or bash, '' inside '...' can represent a single literal '
          if (rest[i + 1] === "'") {
            script += "'"
            i += 2
            continue
          }
          scriptEnd = i + 1
          break
        }
        script += ch
        i++
      } else {
        // Double quote
        if (ch === '\\') {
          const next = rest[i + 1]
          if (next === '"' || next === '\\' || next === '$') {
            script += next
            i += 2
            continue
          }
        } else if (ch === '"') {
          scriptEnd = i + 1
          break
        }
        script += ch
        i++
      }
    }

    if (scriptEnd === -1) continue

    result += command.slice(lastIndex, matchStart)
    const leadMatch = command.slice(matchStart, matchEnd).match(/^\s*/)
    const leadSpace = leadMatch ? leadMatch[0] : ''

    const afterScript = rest.slice(scriptEnd)
    const endOfStmtMatch = afterScript.match(/[;\r\n]|&&|\|\|/)
    const postArgsEnd = endOfStmtMatch ? endOfStmtMatch.index! : afterScript.length
    const postArgs = afterScript.slice(0, postArgsEnd).trim()

    const b64 = Buffer.from(script, 'utf8').toString('base64')
    const pyParts = [pyBin]
    if (preFlags) pyParts.push(preFlags)
    pyParts.push('-')
    if (postArgs) pyParts.push(postArgs)

    const adapted = `${leadSpace}[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | ${pyParts.join(' ')}`
    result += adapted

    lastIndex = matchEnd + scriptEnd + postArgsEnd
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

