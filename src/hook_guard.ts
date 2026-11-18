/** The guarded form of a registered hook command, and the one parser that reads it back. A host runs the registered string through a shell; the guard makes that shell, not the host, decide what happens when the native client is gone: run it when it exists, else run the Node shim with the same arguments, else print the host's safe answer and exit 0. Every path a registration names is read back through {@link parseGuardedCommand}. */
/** The shells a guard can be written for. */
export type GuardShell = 'sh' | 'powershell'

/** Thrown by an installer, before it writes any hook config, when a command it would write contains text the harness rewrites before the command runs, so the hook would run something other than token-goat. */
export class HookCommandRewriteError extends Error {}

/** The version token each guarded command starts with: a no-op statement, so a later build recognises both forms. */
export const GUARD_VERSION = 1
const SH_PREFIX = /^:\s+tg-guard-v(\d+)\s*;/
const PS_PREFIX = /^'tg-guard-v(\d+)'\s*\|\s*Out-Null\s*;/

/** What a guarded command holds: the native client's argv (client, its flags, `--`, then the Node command it falls back to), the host's safe answer, and the notice file the guard writes when nothing could run. */
export interface GuardInput {
  readonly shell: GuardShell
  readonly native: readonly string[]
  readonly safe: string
  readonly marker: string
}

/** The notice the guard leaves when only the safe answer could run, in the shape `readHookBroken` reads. */
export function guardNoticeJson(nativeBin: string): string {
  // Git Bash halves each run of backslashes in the command line it is started with, so a JSON escaped backslash is written as the unicode escape, whose lone backslash arrives as written.
  const json = JSON.stringify({
    schema: 1,
    first: 'unknown (written by the registered command)',
    last: 'unknown (written by the registered command)',
    count: 1,
    events: [{ time: 'unknown', route: 'guard', path: nativeBin, error: 'the native client and the Node shim were both unusable' }],
  })
  return json.split(BS + BS).join(BS + 'u005c')
}

const BS = String.fromCharCode(92)
const PS_QUOTES = /['‘’‚‛]/g

function quoteWord(shell: GuardShell, text: string): string {
  if (/[\0\r\n]/.test(text)) throw new HookCommandRewriteError(`a hook command cannot hold a NUL or line break (${JSON.stringify(text)})`)
  // PowerShell reads four typographic quotes as single quotes too, so each is doubled like the ASCII one.
  return shell === 'sh' ? `'${text.replace(/'/g, "'\\''")}'` : `'${text.replace(PS_QUOTES, (q) => q + q)}'`
}

const CASE_SH = 'case $? in 126|127) ;; *) exit $?;; esac'

function shRoute(test: string, argv: readonly string[]): string {
  return `if ${test}; then ${argv.map((w) => quoteWord('sh', w)).join(' ')}; ${CASE_SH}; fi`
}

function psRoute(test: string, argv: readonly string[]): string {
  const call = argv.map((w) => quoteWord('powershell', w)).join(' ')
  return `if (${test}) { try { & ${call}; if ((Get-Variable LASTEXITCODE -ValueOnly -ErrorAction Ignore) -notin 126, 127) { exit (Get-Variable LASTEXITCODE -ValueOnly) } } catch { } }`
}

/** The part of a native argv after `--`: the Node command the client falls back to. */
export function wrappedNodeArgv(native: readonly string[]): string[] {
  const i = native.indexOf('--')
  return i < 0 ? [] : native.slice(i + 1)
}

/** The guarded command line for `input`. Throws when a word holds a NUL or line break. */
export function buildGuardedCommand(input: GuardInput): string {
  const q = (w: string): string => quoteWord(input.shell, w)
  const bin = input.native[0]!
  const node = wrappedNodeArgv(input.native)
  const shim = node[1]
  const notice = guardNoticeJson(bin)
  if (input.shell === 'sh') {
    const parts = [': tg-guard-v1', shRoute(`[ -x ${q(bin)} ] && [ -s ${q(bin)} ]`, input.native)]
    if (shim !== undefined) {
      parts.push(shRoute(`[ -f ${q(shim)} ] && [ -x ${q(node[0]!)} ]`, node))
      parts.push(shRoute(`[ -f ${q(shim)} ] && command -v node >/dev/null 2>&1`, ['node', ...node.slice(1)]))
    }
    parts.push(`[ -e ${q(input.marker)} ] || printf '%s' ${q(notice)} > ${q(input.marker)} 2>/dev/null`)
    parts.push(`printf '%s' ${q(input.safe)}`, 'exit 0')
    return parts.join('; ')
  }
  const exists = (p: string): string => `Test-Path -LiteralPath ${q(p)} -PathType Leaf`
  const parts = ["'tg-guard-v1' | Out-Null", psRoute(`(${exists(bin)}) -and ((Get-Item -LiteralPath ${q(bin)}).Length -gt 0)`, input.native)]
  if (shim !== undefined) {
    parts.push(psRoute(`${exists(shim)}`, node))
    parts.push(psRoute(`(${exists(shim)}) -and (Get-Command node -ErrorAction Ignore)`, ['node', ...node.slice(1)]))
  }
  parts.push(`try { if (-not (Test-Path -LiteralPath ${q(input.marker)} )) { Set-Content -LiteralPath ${q(input.marker)} -Value ${q(notice)} -Encoding ascii -ErrorAction Stop } } catch { }`)
  parts.push(`[Console]::Out.Write( ${q(input.safe)} )`, 'exit 0')
  return parts.join('; ')
}

interface Token {
  readonly text: string
  readonly quoted: boolean
}

/** Split `text` into statements of words: single quotes (`'\''` in sh, doubled quotes in PowerShell) group, an unquoted `;` ends a statement. Not a shell parser: it reads only what {@link buildGuardedCommand} writes. */
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
  | { readonly kind: 'v1'; readonly shell: GuardShell; readonly native: string[]; readonly safe: string; readonly marker: string }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'malformed' }

/** The guard version a command declares, or undefined when it is not a guarded command. */
export function guardVersionOf(command: string): number | undefined {
  const t = command.trimStart()
  const m = SH_PREFIX.exec(t) ?? PS_PREFIX.exec(t)
  return m === null ? undefined : Number(m[1])
}

/** Read a guarded command back: the native argv it runs, the safe answer, and the notice path. undefined when `command` is not a guarded one; `newer` for a version this build does not know, which a reader leaves untouched. */
export function parseGuardedCommand(command: string): GuardedParse | undefined {
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
  if (native === undefined || native.length === 0 || safe === undefined || marker === undefined) return { kind: 'malformed' }
  return { kind: 'v1', shell, native, safe, marker }
}

/** The paths a guarded command names: the native client, the Node command's words that are absolute paths, and the notice file. */
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
