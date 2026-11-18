/** Guarded hook command and its one parser: native client if present, else Node shim, else safe answer. */
/** Shells a guard is written for; `cmd` is PowerShell encoded, read alike by cmd.exe, PowerShell and sh. */
export type GuardShell = 'sh' | 'powershell' | 'cmd'

/** Thrown before any config write when a command holds text the harness rewrites, so it runs other code. */
export class HookCommandRewriteError extends Error {
  /** The command the install would have written, when the refusal comes from building it. */
  readonly command: string | undefined

  constructor(message: string, command?: string) {
    super(message)
    this.command = command
  }
}

/** Version token every guarded command starts with: a no-op, so a later build recognises both forms. */
export const GUARD_VERSION = 1
const SH_PREFIX = /^:\s+tg-guard-v(\d+)\s*;/
const PS_PREFIX = /^'tg-guard-v(\d+)'\s*\|\s*Out-Null\s*;/
const CMD_PREFIX = 'powershell -NoProfile -NonInteractive -Command "'
const CMD_QUOTE = "'+[char]34+'"
const CMD_FORM = /^powershell -NoProfile -NonInteractive -Command "([^"]*)"$/

/** Guarded command contents: native argv (client, flags, `--`, Node command), safe answer, notice file. */
export interface GuardInput {
  readonly shell: GuardShell
  readonly native: readonly string[]
  readonly safe: string
  readonly marker: string
}

/** The notice the guard leaves when only the safe answer could run, in the shape `readHookBroken` reads. */
export function guardNoticeJson(nativeBin: string): string {
  // Git Bash halves backslash runs; a JSON backslash is written as a unicode escape, arriving as one.
  const json = JSON.stringify({
    schema: 1,
    first: 'unknown (written by the registered command)',
    last: 'unknown (written by the registered command)',
    count: 1,
    events: [
      {
        time: 'unknown',
        route: 'guard',
        path: nativeBin,
        error: 'the native client and the Node shim were both unusable',
      },
    ],
  })
  return json.split(BS + BS).join(BS + 'u005c')
}

const BS = String.fromCharCode(92)
const PS_QUOTES = /['‘’‚‛]/g
const UNC_BACKSLASHES = /^\\\\[^\\/]/

function quoteWord(shell: GuardShell, text: string): string {
  if (/[\0\r\n]/.test(text)) {
    throw new HookCommandRewriteError(
      `a hook command cannot hold a NUL or line break (${JSON.stringify(text)})`,
    )
  }
  // Git Bash halves the leading backslash pair of a UNC path; forward slashes reach it whole.
  const word = shell === 'sh' && UNC_BACKSLASHES.test(text) ? text.split(BS).join('/') : text
  // PowerShell reads four typographic quotes as single quotes too, so each is doubled like the ASCII one.
  return shell === 'sh' ? `'${word.replace(/'/g, "'\\''")}'` : `'${text.replace(PS_QUOTES, (q) => q + q)}'`
}

const CASE_SH = 'case $? in 126|127) ;; *) exit $?;; esac'

function shRoute(test: string, argv: readonly string[]): string {
  return `if ${test}; then ${argv.map((w) => quoteWord('sh', w)).join(' ')}; ${CASE_SH}; fi`
}

function psRoute(test: string, argv: readonly string[]): string {
  const call = argv.map((w) => quoteWord('powershell', w)).join(' ')
  return `if (${test}) { try { & ${call}; ` +
    `if ((Get-Variable LASTEXITCODE -ValueOnly -ErrorAction Ignore) -notin 126, 127) ` +
    `{ exit (Get-Variable LASTEXITCODE -ValueOnly) } } catch { } }`
}

/** The part of a native argv after `--`: the Node command the client falls back to. */
export function wrappedNodeArgv(native: readonly string[]): string[] {
  const i = native.indexOf('--')
  return i < 0 ? [] : native.slice(i + 1)
}

/** Guarded command line for `input`; throws on NUL or line break. No `--`: Node alone, shim must exist. */
export function buildGuardedCommand(input: GuardInput): string {
  if (input.shell === 'cmd') {
    const script = buildGuardedCommand({ ...input, shell: 'powershell' })
    // A path word's double quote would end cmd.exe's quoting; safe answer and notice keep theirs in parens.
    const bad = [...input.native, input.marker].find((w) => w.includes('"'))
    if (bad !== undefined) {
      throw new HookCommandRewriteError(
        `a hook command run through cmd.exe cannot hold a double quote in a path (${JSON.stringify(bad)})`,
      )
    }
    // cmd.exe expands %NAME% inside double quotes, so a word holding one can't reach PowerShell as written.
    if (script.includes('%')) {
      const at = script.indexOf('%')
      throw new HookCommandRewriteError(
        `a hook command run through cmd.exe cannot hold a percent sign ` +
          `(${JSON.stringify(script.slice(at, at + 24))})`,
        script,
      )
    }
    return CMD_PREFIX + script.split('"').join(CMD_QUOTE) + '"'
  }
  const q = (w: string): string => quoteWord(input.shell, w)
  // Every word is quoted up front, so a word no route writes (Node-only) is still refused if unquotable.
  for (const w of input.native) q(w)
  const bin = input.native[0]!
  const nodeOnly = !input.native.includes('--')
  const node = nodeOnly ? input.native : wrappedNodeArgv(input.native)
  const shim = node[1]
  const notice = guardNoticeJson(bin)
  if (input.shell === 'sh') {
    const parts = [': tg-guard-v1']
    if (!nodeOnly) parts.push(shRoute(`[ -x ${q(bin)} ] && [ -s ${q(bin)} ]`, input.native))
    if (shim !== undefined) {
      parts.push(shRoute(`[ -f ${q(shim)} ] && [ -x ${q(node[0]!)} ]`, node))
      parts.push(shRoute(`[ -f ${q(shim)} ] && command -v node >/dev/null 2>&1`, ['node', ...node.slice(1)]))
    }
    parts.push(`[ -e ${q(input.marker)} ] || printf '%s' ${q(notice)} > ${q(input.marker)} 2>/dev/null`)
    parts.push(`printf '%s' ${q(input.safe)}`, 'exit 0')
    return parts.join('; ')
  }
  const exists = (p: string): string => `Test-Path -LiteralPath ${q(p)} -PathType Leaf`
  const parts = ["'tg-guard-v1' | Out-Null"]
  if (!nodeOnly) {
    parts.push(psRoute(`(${exists(bin)}) -and ((Get-Item -LiteralPath ${q(bin)}).Length -gt 0)`, input.native))
  }
  if (shim !== undefined) {
    parts.push(psRoute(`${exists(shim)}`, node))
    parts.push(
      psRoute(`(${exists(shim)}) -and (Get-Command node -ErrorAction Ignore)`, ['node', ...node.slice(1)]),
    )
  }
  parts.push(
    `try { if (-not (Test-Path -LiteralPath ${q(input.marker)} )) { ` +
      `Set-Content -LiteralPath ${q(input.marker)} -Value (${q(notice)}) ` +
        `-Encoding ascii -ErrorAction Stop } } catch { }`,
  )
  parts.push(`[Console]::Out.Write( ${q(input.safe)} )`, 'exit 0')
  return parts.join('; ')
}

interface Token {
  readonly text: string
  readonly quoted: boolean
}

/** Split `text` into words; unquoted `;` ends a statement. Reads only {@link buildGuardedCommand} output. */
function statements(text: string, shell: GuardShell): Token[][] {
  const out: Token[][] = [[]]
  let cur = ''
  let inWord = false
  let quoted = false
  const flush = (): void => {
    if (inWord) out[out.length - 1]!.push({ text: cur, quoted })
    cur = ''
    inWord = false
    quoted = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === ';') {
      flush()
      out.push([])
    } else if (/\s/.test(ch)) flush()
    else if (shell === 'sh' ? ch === "'" : isPsQuote(ch)) {
      inWord = true
      quoted = true
      for (i++; i < text.length; i++) {
        const c = text[i]!
        if (shell === 'sh') {
          if (c === "'") break
        } else if (isPsQuote(c)) {
          if (text[i + 1] !== undefined && isPsQuote(text[i + 1]!)) {
            cur += c
            i++
            continue
          }
          break
        }
        cur += c
      }
    } else if (shell === 'sh' && ch === '\\' && i + 1 < text.length) {
      inWord = true
      cur += text[++i]
    } else {
      inWord = true
      cur += ch
    }
  }
  flush()
  return out.filter((s) => s.length > 0)
}

function isPsQuote(c: string): boolean {
  return c === "'" || c === '‘' || c === '’' || c === '‚' || c === '‛'
}

/** How a command that starts like a guard reads back. */
export type GuardedParse =
  | {
    readonly kind: 'v1'
    readonly shell: GuardShell
    readonly native: string[]
    readonly safe: string
    readonly marker: string
  }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'malformed' }

/** The PowerShell guard inside a `cmd` form, or undefined when `command` is not one. */
function decodeCmdForm(command: string): string | undefined {
  const m = CMD_FORM.exec(command.trim())
  return m === null ? undefined : m[1]!.split(CMD_QUOTE).join('"')
}

/** The guard version a command declares, or undefined when it is not a guarded command. */
export function guardVersionOf(command: string): number | undefined {
  const t = decodeCmdForm(command) ?? command.trimStart()
  const m = SH_PREFIX.exec(t) ?? PS_PREFIX.exec(t)
  return m === null ? undefined : Number(m[1])
}

/** Parse a guarded command: argv, safe answer, notice path; undefined if unguarded, `newer` if unknown. */
export function parseGuardedCommand(command: string): GuardedParse | undefined {
  const inner = decodeCmdForm(command)
  if (inner !== undefined) {
    const back = parseGuardedCommand(inner)
    return back?.kind === 'v1' ? { ...back, shell: 'cmd' } : back
  }
  const version = guardVersionOf(command)
  if (version === undefined) return undefined
  if (version !== GUARD_VERSION) return { kind: 'newer', version }
  const shell: GuardShell = SH_PREFIX.test(command.trimStart()) ? 'sh' : 'powershell'
  const stmts = statements(command.trim(), shell)
  const texts = (s: Token[]): string[] => s.map((t) => t.text)
  let native: string[] | undefined
  let safe: string | undefined
  let marker: string | undefined
  for (const s of stmts) {
    const t = texts(s)
    if (shell === 'sh') {
      if (native === undefined && t[0] === 'if') {
        const then = stmts[stmts.indexOf(s) + 1]
        if (then?.[0]?.text === 'then') native = texts(then).slice(1)
      }
      if (t[0] === 'printf' && t[1] === '%s' && safe === undefined && !t.includes('||')) safe = t[2]
      const e = t.indexOf('-e')
      if (t[0] === '[' && e >= 0 && marker === undefined) marker = t[e + 1]
    } else {
      const call = t.indexOf('&')
      if (native === undefined && call >= 0) native = t.slice(call + 1)
      if (t[0] === '[Console]::Out.Write(') safe = t[1]
      if (t.includes('Set-Content')) marker = t[t.indexOf('-LiteralPath') + 1]
    }
  }
  if (native === undefined || native.length === 0 || safe === undefined || marker === undefined) {
    return { kind: 'malformed' }
  }
  return { kind: 'v1', shell, native, safe, marker }
}

/** Paths a guarded command names: the native client, absolute Node-command words, and the notice file. */
export function guardedPaths(parsed: GuardedParse): string[] {
  if (parsed.kind !== 'v1') return []
  return [...parsed.native.filter((w) => /^(?:[A-Za-z]:[\\/]|\/)/.test(w)), parsed.marker]
}

/** Every string literal of a config, decoded: a JSON string value or a TOML basic or literal string. */
export function stringLiterals(raw: string): string[] {
  const out: string[] = []
  for (const m of raw.matchAll(/"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g)) {
    const lit = m[0]
    if (lit.startsWith("'")) out.push(lit.slice(1, -1))
    else {
      try {
        out.push(JSON.parse(lit) as string)
      } catch {
        // an escape JSON does not know (TOML's U form): the raw text still matches by spelling
      }
    }
  }
  return out
}
