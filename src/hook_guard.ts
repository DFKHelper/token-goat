import { plainWindowsPath } from './process_util.js'

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
export const GUARD_VERSION = 4
const SH_PREFIX = /^:\s+tg-guard-v(\d+)\s*;/
const PS_PREFIX = /^'tg-guard-v(\d+)'\s*\|\s*Out-Null\s*;/
// Built from parts so the version is not an interpolation between hand-written quotes (hint_templates guard).
const PS_VERSION_LINE = ['\'tg-guard-v', String(GUARD_VERSION), '\' | Out-Null'].join('')
const CMD_PREFIX = 'powershell -NoProfile -NonInteractive -Command "'
const CMD_QUOTE = "'+[char]34+'"
const CMD_FORM = /^powershell -NoProfile -NonInteractive -Command "([^"]*)"(?: & if errorlevel 9009 .*)?$/

/** cmd.exe's status for a program it cannot find; a PowerShell guard itself exits only 0, 1 or 2. */
const CMD_NOT_FOUND = 9009

/** The cmd tail that prints `safe` and exits 0 when PowerShell could not start, else keeps its exit status. */
function cmdStartFailureTail(safe: string): string {
  const bare = safe.replace(/"[^"]*"/g, '')
  // An answer cmd.exe would read as more than one command prints nothing: an empty answer is still no hook error.
  const unprintable = !safe.startsWith('{') || safe.split('"').length % 2 === 0 || safe.includes(BS) ||
    /[&|<>^()!]/.test(bare)
  const print = safe === '' || unprintable ? 'type nul' : `echo ${safe}`
  return ` & if errorlevel ${String(CMD_NOT_FOUND)} (${print}& exit /b 0) else exit /b`
}

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

function quoteWord(shell: GuardShell, raw: string): string {
  if (/[\0\r\n]/.test(raw)) {
    throw new HookCommandRewriteError(
      `a hook command cannot hold a NUL or line break (${JSON.stringify(raw)})`,
    )
  }
  const text = plainWindowsPath(raw)
  // Git Bash halves the leading backslash pair of a UNC path; forward slashes reach it whole.
  const word = shell === 'sh' && UNC_BACKSLASHES.test(text) ? text.split(BS).join('/') : text
  // PowerShell reads four typographic quotes as single quotes too, so each is doubled like the ASCII one.
  return shell === 'sh' ? `'${word.replace(/'/g, "'\\''")}'` : `'${text.replace(PS_QUOTES, (q) => q + q)}'`
}

// A route's outcome is a hook answer only as exit 0, or exit 2 that speaks: a stderr message or a stdout decision. Node's own failures exit 1, 9, 13 or by signal, and a silent exit 2 is a crash, so any other outcome falls through to the next route. Both streams are held in files ($1 stderr, $2 stdout) until the outcome is accepted, so a failed route never reaches the host. No $NAME word: Grok CLI substitutes those itself in a hook command, so the temp files are parameters 1 and 2. mktemp is tried in TMPDIR then /tmp; with no hold files ($1, $2 empty) no route runs: the safe answer prints. limit: no writable temp directory gives the safe answer and no hook work; revisit-when: a machine reports it
const SH_RM_ERR = '[ ! -f "$1" ] || rm -f "$1"; [ ! -f "$2" ] || rm -f "$2"'
const SH_REPLAY = `cat "$1" >&3; [ -z "$2" ] || cat "$2" >&4; ${SH_RM_ERR}`
// Stdout with its whitespace removed is an answer when empty, or opening with `{` and ending with `}`.
const SH_OUT_SQUEEZED = `case "$(tr -d '[:space:]' <"$2" 2>/dev/null)" in`
const SH_OUT_OBJECT = `${SH_OUT_SQUEEZED} ''|'{'*'}') true;; *) false;; esac`
/** What an exit-0 stdout must be: `object` (blank, or `{...}`), or `any` (a host that reads plain text). */
type AnswerRule = 'object' | 'any'
const shOutOk = (rule: AnswerRule): string => (rule === 'any' ? 'true' : SH_OUT_OBJECT)
const SH_WORDS = `[ -n "$(tr -d '[:space:]' <"$1" 2>/dev/null)" ] || ` +
  `{ [ -n "$2" ] && ${SH_OUT_SQUEEZED} '{'*'}') true;; *) false;; esac; }`
// Exit 2 speaks as non-blank stderr or stdout shaped as an object (a decision); `tr` runs on exits 0 and 2 only.
const SH_SPOKE = `{ ${SH_WORDS}; }`
const SH_CLEAR = ': >"$1"; [ -z "$2" ] || : >"$2"'
const caseSh = (rule: AnswerRule): string =>
  `case $? in 0) if ${shOutOk(rule)}; then ${SH_REPLAY}; exit 0; fi; ${SH_CLEAR};; ` +
  `2) if ${SH_SPOKE}; then ${SH_REPLAY}; exit 2; fi; ${SH_CLEAR};; *) ${SH_CLEAR};; esac`
// The line a route prints first to detach the host (ASYNC_DETACH_LINE in hook_adapters.ts, pinned by a test).
const ASYNC_QUOTED = `'{"async":true}'`
// Events whose payloads isAsyncDetachEligible can accept: only their guards carry the early-forwarding stage.
const ASYNC_EVENTS: ReadonlySet<string> = new Set(['subagent_stop', 'post_tool_use'])
// sh status travels as `x<status>x` and `m` (forwarded) in the capture of fd 6, landing in $3 (no $NAME word). The route's reader takes 15 bytes (marker and LF) into the hold $2; exactly the marker goes to fd 4 at once.
const SH_LEAD =
  'dd bs=1 count=15 >>"$2" 2>/dev/null; ' +
  `if [ "$(cat "$2" 2>/dev/null; echo .)" = ${ASYNC_QUOTED}"$(echo; echo .)" ]; then ` +
  `: >"$2"; echo ${ASYNC_QUOTED} >&4; echo m; fi; cat >>"$2"`
// Accepted outcomes are judged as in CASE_SH; after a forwarded marker a failed run prints nothing and exits 0.
const caseShLead = (rule: AnswerRule): string =>
  `case "$3" in *x0x*) if ${shOutOk(rule)}; then ${SH_REPLAY}; exit 0; fi; ${SH_CLEAR};; ` +
  `*x2x*) if ${SH_SPOKE}; then ${SH_REPLAY}; exit 2; fi; ` +
  `${SH_CLEAR};; *) ${SH_CLEAR};; esac; case "$3" in *m*) ${SH_RM_ERR}; exit 0;; esac`
const SH_HOLD_OK = '[ -f "$1" ] && [ -f "$2" ]'
const SH_MKTEMP_TMP = '"$(mktemp /tmp/tg-guard.XXXXXX 2>/dev/null)"'
const SH_TMP_IN_TMP = `set -- ${SH_MKTEMP_TMP} ${SH_MKTEMP_TMP}`
const SH_STDERR =
  `set -- "$(mktemp 2>/dev/null)" "$(mktemp 2>/dev/null)"; ` +
  `${SH_HOLD_OK} || { ${SH_RM_ERR}; ${SH_TMP_IN_TMP}; }; ` +
  `${SH_HOLD_OK} || { ${SH_RM_ERR}; set -- "" ""; }; exec 3>&2 4>&1; [ -z "$1" ] || exec 2>>"$1" >>"$2"`

function shRoute(test: string, argv: readonly string[], forward: boolean, rule: AnswerRule): string {
  const call = argv.map((w) => quoteWord('sh', w)).join(' ')
  if (!forward) return `if [ -n "$1" ] && ${test}; then ${call}; ${caseSh(rule)}; fi`
  // The `then` statement ends at the first `;`, so the argv stays the quoted words of that statement.
  return `if [ -n "$1" ] && ${test}; then set -- "$1" "$2" "$( { { ${call} 6>&-; echo "x$?x" >&6; } | ` +
    `{ ${SH_LEAD}; }; } 6>&1 )"; ${caseShLead(rule)}; fi`
}

// The merge of stderr into the held output, as the statement reader returns it.
const PS_ERR_REDIRECT_WORD = '2>&1'
// A route's stdout lines and stderr records are held in one variable (no $NAME word) and written only once its exit is accepted. A stderr line is an ErrorRecord, whose message is the raw line (a `2>file` redirect would wrap it in a decorated record on Windows PowerShell 5.1, even a blank one).
const PS_OUT_SINK = ['|', 'Tee-Object', '-Variable', 'tgo', '|', 'Out-Null']
// Per-line stage: the pipeline item is read as `Get-Variable _` (a `$_` word is one Grok CLI rewrites). New-Variable -Force, not Set-Variable: two Set-Variable words in one cmd-form command line failed (observed).
const PS_ITEM = '(Get-Variable _ -ValueOnly)'
const PS_FLAG = (name: string): string => `(Get-Variable ${name} -ValueOnly -ErrorAction Ignore)`
const PS_STAGE = 'tgm'
const PS_STAGE_WORDS = ['|', PS_STAGE]
const PS_STAGE_DEF = `function ${PS_STAGE} { process { ` +
  `if (${PS_ITEM} -is [string] -and -not ${PS_FLAG('tgn')}) { New-Variable tgn 1 -Scope Global -Force; ` +
  `if (${PS_ITEM} -ceq (${ASYNC_QUOTED}) -and -not ${PS_FLAG('tgf')}) { ` +
  `[Console]::Out.Write((${ASYNC_QUOTED}) + [char]10); New-Variable tgf 1 -Scope Global -Force } ` +
  `else { Write-Output ${PS_ITEM} } } else { Write-Output ${PS_ITEM} } } }`
// After a forwarded marker a route that did not answer ends the run: nothing more is printed, exit 0.
const PS_FORWARDED_EXIT = `if (${PS_FLAG('tgf')}) { exit 0 }`
const PS_HELD = 'Get-Variable tgo -ValueOnly -ErrorAction Ignore | Write-Output | Where-Object PSTypeNames'
// Only the tail of the type name is matched: a line naming Management.Automation beside a file write is denied.
const PS_RECORD = "'Automation.ErrorRecord'"
const PS_TEXT = "'System.String'"
// Functions defined once (tgs: the stderr text, tgt: the stdout text): cmd.exe refuses over 8191 characters.
const PS_ERR_DEF = `function tgs { (${PS_HELD} -Match ${PS_RECORD} | ForEach-Object Exception | ` +
  'ForEach-Object Message) -join [char]10 }'
const PS_ERR = '(tgs)'
const PS_REPLAY = `[Console]::Error.Write(${PS_ERR})`
// Latin-1 maps every byte to one char and back, so the route's stdout bytes are replayed as they were written. With no console attached the assignment throws, so it has its own try and the route runs regardless.
const PS_BYTE_ENCODING = 'try { [Console]::OutputEncoding | Tee-Object -Variable tge | Out-Null; ' +
  '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(28591) } catch { }'
// Puts the console's earlier output encoding back; unset or unwritable, it leaves the console as it is. A function, defined once: cmd.exe refuses a command line over 8191 characters, and the routes call it often.
const PS_ENCODING_BACK = 'tgb'
const PS_ENCODING_BACK_DEF =
  'function tgb { try { [Console]::OutputEncoding = (Get-Variable tge -ValueOnly) } catch { } }'
const PS_OUT_CLEAR = `Remove-Variable tgo, tge, tgn -ErrorAction Ignore; ${PS_BYTE_ENCODING}`
// limit: PowerShell splits stdout into lines, so CR and a final newline are lost; revisit-when one is needed
const PS_OUT_DEF = `function tgt { (${PS_HELD} -Contains ${PS_TEXT}) -join [char]10 }`
const PS_OUT = '(tgt)'
const PS_REPLAY_OUT = `[Console]::Out.Write(${PS_OUT})`
// Stdout is an answer only when blank, or opening with `{` and ending with `}` once trimmed (no JSON parser here).
const PS_OUT_OBJECT = `(${PS_OUT}.Trim().Length -eq 0) -or (${PS_OUT}.Trim() -like '{*}')`
const psOutOk = (rule: AnswerRule): string => (rule === 'any' ? '1 -eq 1' : PS_OUT_OBJECT)
// Exit 2 counts as a block only when it speaks: non-blank stderr, or stdout shaped as an object.
const PS_SPOKE = `(${PS_ERR}.Trim().Length -gt 0) -or (${PS_OUT}.Trim() -like '{*}')`

function psRoute(test: string, argv: readonly string[], forward: boolean, rule: AnswerRule): string {
  const call = argv.map((w) => quoteWord('powershell', w)).join(' ')
  const code = '(Get-Variable LASTEXITCODE -ValueOnly)'
  const sink = (forward ? [...PS_STAGE_WORDS, ...PS_OUT_SINK] : PS_OUT_SINK).join(' ')
  const after = forward ? `; ${PS_FORWARDED_EXIT}` : ''
  return `if (${test}) { try { ${PS_OUT_CLEAR}; & ${call} ${PS_ERR_REDIRECT_WORD} ${sink}; ` +
    `if (${code} -eq 0) { if (${psOutOk(rule)}) { ` +
    `${PS_REPLAY}; ${PS_REPLAY_OUT}; ${PS_ENCODING_BACK}; exit 0 } }; ` +
    `if (${code} -eq 2) { if (${PS_SPOKE}) { ${PS_REPLAY}; ${PS_REPLAY_OUT}; ` +
    `${PS_ENCODING_BACK}; exit 2 } } ` +
    `} catch { }; ${PS_ENCODING_BACK}${after} }`
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
    return CMD_PREFIX + script.split('"').join(CMD_QUOTE) + '"' + cmdStartFailureTail(input.safe)
  }
  const q = (w: string): string => quoteWord(input.shell, w)
  // Every word is quoted up front, so a word no route writes (Node-only) is still refused if unquotable.
  for (const w of input.native) q(w)
  const bin = input.native[0]!
  const nodeOnly = !input.native.includes('--')
  const node = nodeOnly ? input.native : wrappedNodeArgv(input.native)
  const shim = node[1]
  const forward = ASYNC_EVENTS.has(node[2] ?? '')
  // Claude Code reads a pre_compact hook's stdout as plain summarizer instructions (see validAnswer).
  const harness = input.native[input.native.indexOf('--harness') + 1]
  const plainHost = input.native.includes('--harness') ? harness === 'claudecode' : true
  const rule: AnswerRule = node[2] === 'pre_compact' && plainHost ? 'any' : 'object'
  const notice = guardNoticeJson(bin)
  if (input.shell === 'sh') {
    const parts = [`: tg-guard-v${String(GUARD_VERSION)}`, SH_STDERR]
    if (!nodeOnly) parts.push(shRoute(`[ -x ${q(bin)} ] && [ -s ${q(bin)} ]`, input.native, forward, rule))
    // limit: a native route reads stdin then fails: no payload, safe answer. revisit-when: a native client does
    if (shim !== undefined) {
      parts.push(shRoute(`[ -f ${q(shim)} ] && [ -x ${q(node[0]!)} ]`, node, forward, rule))
      const viaPath = ['node', ...node.slice(1)]
      parts.push(shRoute(`[ -f ${q(shim)} ] && command -v node >/dev/null 2>&1`, viaPath, forward, rule))
    }
    parts.push(SH_RM_ERR)
    parts.push(`[ -e ${q(input.marker)} ] || printf '%s' ${q(notice)} > ${q(input.marker)} 2>/dev/null`)
    parts.push(`printf '%s' ${q(input.safe)} >&4`, 'exit 0')
    return parts.join('; ')
  }
  const exists = (p: string): string => `Test-Path -LiteralPath ${q(p)} -PathType Leaf`
  const parts = [PS_VERSION_LINE, PS_ENCODING_BACK_DEF, PS_ERR_DEF, PS_OUT_DEF]
  if (forward) parts.push(PS_STAGE_DEF)
  if (!nodeOnly) {
    const test = `(${exists(bin)}) -and ((Get-Item -LiteralPath ${q(bin)}).Length -gt 0)`
    parts.push(psRoute(test, input.native, forward, rule))
  }
  if (shim !== undefined) {
    parts.push(psRoute(`${exists(shim)}`, node, forward, rule))
    const viaPath = `(${exists(shim)}) -and (Get-Command node -ErrorAction Ignore)`
    parts.push(psRoute(viaPath, ['node', ...node.slice(1)], forward, rule))

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
        // Only the quoted words are the argv: a forwarding route wraps them in unquoted shell words.
        if (then?.[0]?.text === 'then') native = then.slice(1).filter((w) => w.quoted).map((w) => w.text)
      }
      if (t[0] === 'printf' && t[1] === '%s' && safe === undefined && !t.includes('||')) safe = t[2]
      const e = t.indexOf('-e')
      if (t[0] === '[' && e >= 0 && marker === undefined) marker = t[e + 1]
    } else {
      const call = t.indexOf('&')
      if (native === undefined && call >= 0) {
        native = t.slice(call + 1)
        const sink = native.length - PS_OUT_SINK.length
        if (native.slice(sink).join(' ') === PS_OUT_SINK.join(' ')) native.length = sink
        const stage = native.length - PS_STAGE_WORDS.length
        if (native.slice(stage).join(' ') === PS_STAGE_WORDS.join(' ')) native.length = stage
        if (native.at(-1) === PS_ERR_REDIRECT_WORD) native.pop()
      }
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
