/** Decides whether a PreToolUse input rewrite may ship, and whether it may carry Claude Code's `permissionDecision: "allow"`, so that rewriting a tool call never changes the permission outcome the user's own rules give the ORIGINAL call. Claude Code evaluates its permission rules against a hook's `updatedInput`, not the input the model wrote (claude.exe 2.1.289: the PreToolUse result's `updatedInput` replaces the input before `canUseTool` runs, and an `allow` logs "Hook approved tool use ..., bypassing permission prompt"), so a `token-goat compress -c '<cmd>'` wrapper or a shrunk image's temp path is what a `Bash(curl *)` or `Read(./private/**)` rule gets matched against. Answering every rewrite with `allow`, as serializeOutput once did, therefore skipped the user's prompt for any wrapped command and let deny and ask rules miss. Every rewriteInput producer routes through {@link permissionNeutralRewrite}: it returns null (do not rewrite) whenever a deny or ask rule could match the original call, or the settings cannot be read; `approve` only when the original call is provably auto-allowed anyway and no auto-mode classifier would have reviewed it (a trusted allow rule matching a simple command, Claude Code's built-in read-only commands, a Read inside the working directory); otherwise a rewrite with no decision, which Claude Code runs through its normal permission flow. Losing a compression is fine; bypassing a user's rule is not, so every doubt resolves to null. Settings sources and precedence are from https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/managed-settings and https://code.claude.com/docs/en/permissions. Node built-ins plus the config-dir accessor, paths.ts's share check, util.ts's runGit and types only, all already on every hook's path, so every hook can import it without dragging a subsystem onto the hook's eager path. */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { HarnessName } from './bridges/types.js'
import { claudeConfigDir } from './claude_config_dir.js'
import { isUncOrDevicePath } from './paths.js'
import type { HookOutput } from './types.js'
import { runGit } from './util.js'

/** What is being rewritten: a shell command wrapped to run under `token-goat compress` (`shell-wrap`), a shell search replaced by a read-only token-goat query (`shell-query`), a Read pointed at a shrunk copy (`read`), or a subagent prompt with a briefing appended (`agent`). */
export type RewriteKind = 'shell-wrap' | 'shell-query' | 'read' | 'agent'

/** `skip`: do not rewrite. `rewrite`: rewrite with no permission decision. `approve`: rewrite and answer `allow`, because the original call would have run without a prompt anyway. */
export type RewriteVerdict = 'skip' | 'rewrite' | 'approve'

/** One permission rule as written in a settings file. `tool` is undefined for a rule that does not parse, which a deny or ask list treats as matching everything. `trustedAllow` says whether an allow rule may prove a call auto-allowed: true only for a source Claude Code is known to apply. */
export interface PermissionRule {
  readonly raw: string
  readonly tool: string | undefined
  readonly content: string | undefined
  readonly trustedAllow: boolean
}

/** The merged rules of every settings source, deny and ask from every file that could apply, allow only from files Claude Code reads for this working directory. */
export interface PermissionSnapshot {
  readonly allow: readonly PermissionRule[]
  readonly deny: readonly PermissionRule[]
  readonly ask: readonly PermissionRule[]
  readonly blockReadsOutside: boolean
}

/** One parsed settings document and the role it plays. `managedGroup` names the managed delivery mechanism it came from, since Claude Code applies only one of those unless told to merge. */
export interface SettingsDoc {
  readonly role: 'managed' | 'user' | 'project' | 'local' | 'ancestor'
  readonly json: Record<string, unknown>
  readonly managedGroup?: string
  /** For a local file: false when it is tracked by git or its `.claude` directory is a symlink, the two cases Claude Code does not trust its allow rules in. */
  readonly localTrusted?: boolean
}

export interface RewriteRequest {
  readonly kind: RewriteKind
  readonly harness: HarnessName
  /** The hook payload's `permission_mode`. */
  readonly mode: unknown
  readonly cwd: string
  /** The command or file path the model wrote. */
  readonly original: string
  /** The command or file path the rewrite substitutes. */
  readonly rewritten: string
  /** For a Read: whether the original path is inside the working directory, where Claude Code reads without a prompt. */
  readonly insideCwd?: boolean
}

const KNOWN_MODES: ReadonlySet<string> = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'])

// Claude Code's built-in read-only commands, which run without a prompt in every mode (https://code.claude.com/docs/en/permissions#read-only-commands). `find` and `git` are handled apart: both have write-capable forms.
const READ_ONLY_PLAIN: ReadonlySet<string> = new Set(['ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'wc', 'which', 'diff', 'stat', 'du'])
const READ_ONLY_FIRST_WORDS: ReadonlySet<string> = new Set([...READ_ONLY_PLAIN, 'find', 'git', 'cd'])
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'show'])
const GIT_READ_FLAG = /^(?:-s|--short|-b|--branch|--porcelain(?:=v[12])?|--stat|--shortstat|--numstat|--name-only|--name-status|--cached|--staged|-p|--patch|--no-patch|--oneline|--graph|--decorate|--all|--no-color|--summary|-n\d*|-\d+|--max-count=\d+|--format=\S*|--pretty=\S*|--)$/
const FIND_WRITE_FLAGS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])
// Wrappers Claude Code strips before matching, exec wrappers no prefix rule approves, and shells or launchers that run their argument as a command: a command starting with any of them is never proven allowed here.
const UNPROVABLE_FIRST_WORDS: ReadonlySet<string> = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob', 'xargs', 'watch', 'setsid', 'ionice', 'flock', 'env', 'sudo', 'doas', 'exec', 'eval', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'cmd.exe', 'nocorrect'])
// Paths Claude Code's safety check guards even under an allow rule or bypassPermissions (https://code.claude.com/docs/en/permission-modes): a command naming one is never rewritten, since the wrapper would hide the path from that check.
const PROTECTED_PATH_FRAGMENTS: readonly string[] = ['.git', '.config/git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude', '.bashrc', '.zshrc', '.profile', '.envrc', '.npmrc', '.pnp.', 'bunfig.toml', '.bazelrc', '.pre-commit-config.yaml', 'lefthook.yml', '.mcp.json']
// rm and rmdir on a critical path prompt in every mode, whatever a hook answers, including inside `bash -c` and `$()`: never hidden inside a wrapper.
const RM_WORD = /(?:^|[^a-z0-9_.-])(?:rm|rmdir)(?:[^a-z0-9_-]|$)/
const FILE_RULE_TOOLS: readonly string[] = ['read', 'edit', 'write', 'multiedit', 'notebookedit']
const BASH_COMMAND_CEILING = 10_000

/** A mode string Claude Code documents, `default` when the payload carries none, null for anything else. */
function normalizedMode(mode: unknown): string | null {
  if (mode === undefined || mode === null || mode === '') return 'default'
  return typeof mode === 'string' && KNOWN_MODES.has(mode) ? mode : null
}

/** Split `Tool(content)` the way a settings file writes a rule. */
export function parseRule(raw: unknown, trustedAllow: boolean): PermissionRule {
  if (typeof raw !== 'string') return { raw: String(raw), tool: undefined, content: undefined, trustedAllow: false }
  const m = /^([A-Za-z0-9_*.-]+)(?:\(([\s\S]*)\))?$/.exec(raw.trim())
  if (m === null) return { raw, tool: undefined, content: undefined, trustedAllow: false }
  return { raw, tool: m[1], content: m[2], trustedAllow }
}

/** Whether `text` matches `pattern` whole, where `*` stands for any run of characters and everything else is literal. A settings file is not token-goat's to trust, so this walks the two strings with one backtrack point rather than compiling the pattern into a regex: its cost is bounded by the product of the lengths, never exponential. */
function wildcardMatches(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      resume = t
    } else if (star >= 0) {
      p = star + 1
      t = ++resume
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** Whether a rule's tool name names one of `names` (lowercase), honoring a `*` in the rule's tool name and Claude Code's case-insensitive matching for deny and ask. */
function ruleToolIs(rule: PermissionRule, names: readonly string[]): boolean {
  if (rule.tool === undefined) return false
  const tool = rule.tool.toLowerCase()
  return names.some((n) => wildcardMatches(tool, n))
}

/** The texts a rule's literal pieces are searched in: lowercased, quotes dropped, once with each backslash read as a separator and once with it dropped, since a shell drops an escaping backslash and a Windows path uses it as a separator. */
function haystacks(parts: readonly string[]): string[] {
  const base = parts.join('\n').toLowerCase().replace(/["']/g, '')
  return [base.split('\\').join('/'), base.split('\\').join('')]
}

/** The spelling Claude Code also checks a path rule against: the path resolved against `cwd` through every symlink, Windows junction and 8.3 short name (https://code.claude.com/docs/en/permissions#symlinks: a deny rule applies when either the requested path or the file it resolves to matches). A path that does not exist yet is spelled through its nearest existing ancestor's real path; empty when the real spelling is the one already written. */
function realSpellings(p: string, cwd: string): string[] {
  const abs = path.resolve(cwd, p)
  // Never touch a network share or device path: resolving one connects to the host, and Windows hands it the user's credentials.
  if (isUncOrDevicePath(p) || isUncOrDevicePath(abs)) return []
  let existing = abs
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = path.join(fs.realpathSync.native(existing), path.relative(existing, abs))
      const same = process.platform === 'win32' ? real.toLowerCase() === abs.toLowerCase() : real === abs
      return same ? [] : [real]
    } catch {
      // Not there yet (a redirection target, a directory a command will create): spell it through its parent.
    }
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  return []
}

/** The words of a shell command that could name a file, for {@link realSpellings}: split at whitespace, quotes and shell operators, flags dropped, capped so a long command costs a bounded number of filesystem calls. */
function shellPathWords(command: string): string[] {
  return command.split(/[\s;&|<>()=,'"`]+/).filter((w) => w !== '' && !w.startsWith('-')).slice(0, 64)
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch)
}

/** One literal piece of a Bash rule's content, and whether a `*` touches its left or right end, where Claude Code's glob lets the match run on into a word. */
interface RulePiece {
  readonly text: string
  readonly openLeft: boolean
  readonly openRight: boolean
}

/** Whether `piece` occurs in `text` with no letter or digit beside it on any side a `*` does not touch. */
function containsPiece(text: string, piece: RulePiece): boolean {
  let at = text.indexOf(piece.text)
  while (at >= 0) {
    if ((piece.openLeft || !isWordChar(text[at - 1])) && (piece.openRight || !isWordChar(text[at + piece.text.length]))) return true
    at = text.indexOf(piece.text, at + 1)
  }
  return false
}

/** Whether a Bash rule could match a command these haystacks were built from: every literal piece of its content appears, bounded as a word except where a `*` touches it (`curl*` covers `curlie`). Over-matching is the safe direction, so a rule with no literal piece matches everything. */
function bashRuleMayMatch(rule: PermissionRule, hays: readonly string[]): boolean {
  if (rule.content === undefined) return true
  const pieces: RulePiece[] = []
  for (const token of rule.content.replace(/:\*\s*$/, ' ').split(/\s+/)) {
    const bits = token.split('*')
    bits.forEach((bit, i) => {
      const text = bit.replace(/["'\\]/g, '').toLowerCase()
      if (text !== '') pieces.push({ text, openLeft: i > 0, openRight: i < bits.length - 1 })
    })
  }
  if (pieces.length === 0) return true
  return pieces.every((p) => hays.some((h) => containsPiece(h, p)))
}

/** Whether a Read/Edit path rule could match a path named in these haystacks: the literal pieces of its last non-wildcard path segment all appear. A pattern using braces, brackets or backslashes is assumed to match. */
function pathRuleMayMatch(rule: PermissionRule, hays: readonly string[]): boolean {
  const content = rule.content
  if (content === undefined) return true
  if (/[{}[\]\\]/.test(content)) return true
  const segments = content.replace(/^(?:\/\/|~\/|\.\/|\/)/, '').split('/')
  for (let i = segments.length - 1; i >= 0; i--) {
    const pieces = (segments[i] ?? '').split(/[*?]+/).filter((p) => p !== '').map((p) => p.toLowerCase())
    if (pieces.length > 0) return pieces.every((p) => hays.some((h) => h.includes(p)))
  }
  return true
}

/** Claude Code's Bash rule glob against a whole simple command: `*` stands for any text, and a trailing ` *` or legacy `:*` also matches the bare command. Case-sensitive, as an allow match must be no looser than Claude Code's own. */
function bashGlobMatches(content: string, command: string): boolean {
  if (!content.endsWith(':*') && !content.endsWith(' *')) return wildcardMatches(content, command)
  const prefix = content.slice(0, -2)
  return wildcardMatches(prefix, command) || wildcardMatches(`${prefix} *`, command) || wildcardMatches(`${prefix}\t*`, command)
}

/** The words of a command with no shell operators, expansions, globs or escapes: single-quoted text, double-quoted text free of `$`, backticks, backslashes and `!`, and bare words from a conservative character set. Null for anything else. */
function simpleWords(command: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(current)
      current = ''
      inWord = false
      continue
    }
    inWord = true
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1)
      if (close < 0) return null
      const quoted = command.slice(i + 1, close)
      if (ch === '"' && /[$`\\!]/.test(quoted)) return null
      current += quoted
      i = close
      continue
    }
    if (!/[A-Za-z0-9_./:=@%+,-]/.test(ch)) return null
    current += ch
  }
  if (inWord) words.push(current)
  return words.length > 0 ? words : null
}

/** Whether Claude Code would run this command with no prompt whatever the mode: a simple command that a trusted allow rule matches, or one of its built-in read-only commands in a form with no write-capable flag. */
function provenAllowed(snapshot: PermissionSnapshot, command: string): boolean {
  if (command.length > BASH_COMMAND_CEILING) return false
  const words = simpleWords(command)
  if (words === null) return false
  const first = words[0] as string
  if (first.includes('=') || UNPROVABLE_FIRST_WORDS.has(first)) return false
  if (first === 'find' && words.some((w) => FIND_WRITE_FLAGS.has(w))) return false
  if (READ_ONLY_PLAIN.has(first)) return true
  if (first === 'git' && GIT_READ_SUBCOMMANDS.has(words[1] ?? '') && words.slice(2).every((w) => !w.startsWith('-') || GIT_READ_FLAG.test(w))) return true
  return snapshot.allow.some((r) => r.trustedAllow && r.tool === 'Bash' && (r.content === undefined || bashGlobMatches(r.content, command)))
}

/** Whether every subcommand of a possibly compound command starts with a word from Claude Code's read-only set, so the original may well have run with no prompt and the wrapper would add one. */
function allSubcommandsReadOnly(command: string): boolean {
  const parts = command.split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter((p) => p !== '')
  if (parts.length === 0) return false
  return parts.every((p) => {
    const first = /^\S+/.exec(p.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, ''))?.[0] ?? ''
    return READ_ONLY_FIRST_WORDS.has(first.replace(/["']/g, ''))
  })
}

function decideShell(snapshot: PermissionSnapshot, req: RewriteRequest, mode: string): RewriteVerdict {
  if (snapshot.blockReadsOutside) return 'skip'
  const original = req.original.trim()
  const lowered = original.toLowerCase()
  if (RM_WORD.test(lowered)) return 'skip'
  if (PROTECTED_PATH_FRAGMENTS.some((p) => lowered.includes(p))) return 'skip'
  // A symlink, junction or short name in a path the command names hides the real spelling a rule or the protected-path check is written for: Claude Code checks both spellings, the wrapper shows it neither.
  const linked = shellPathWords(original).flatMap((w) => realSpellings(w, req.cwd).map((real) => ({ real, lexical: path.resolve(req.cwd, w) })))
  if (linked.some(({ real, lexical }) => PROTECTED_PATH_FRAGMENTS.some((p) => haystacks([real])[0]?.includes(p) === true && haystacks([lexical])[0]?.includes(p) !== true))) return 'skip'
  const hays = haystacks([req.cwd, original, req.rewritten])
  const realHays = haystacks(linked.map(({ real }) => real))
  const expands = /[$`\\]/.test(original)
  const pathExpands = /[$`~*?[]/.test(original)
  for (const rule of [...snapshot.deny, ...snapshot.ask]) {
    if (rule.tool === undefined) return 'skip'
    if (ruleToolIs(rule, ['bash'])) {
      if (expands || bashRuleMayMatch(rule, hays)) return 'skip'
    } else if (ruleToolIs(rule, FILE_RULE_TOOLS)) {
      // Read and Edit rules also apply to file commands in Bash (`cat`, `sed`, `tee`, redirections), which the wrapper would hide.
      if (pathExpands || pathRuleMayMatch(rule, hays) || (linked.length > 0 && pathRuleMayMatch(rule, realHays))) return 'skip'
    }
  }
  // bypassPermissions runs the original with no prompt either way, so the wrapper needs no allow there, and the hook does not vouch for a call it cannot see every rule for (--disallowedTools, --settings, SDK options).
  if (mode === 'bypassPermissions') return 'rewrite'
  // auto mode drops broad allow rules (Bash(*), interpreter wildcards, package-manager runs) and has the classifier review even read-only commands, and plan mode runs that classifier by default: an allow there would skip the review, so the wrapper is left to it.
  if (mode !== 'auto' && mode !== 'plan' && provenAllowed(snapshot, original)) return 'approve'
  // dontAsk turns a prompt into a denial, so an unproven wrapper could refuse a call a rule we cannot see allowed.
  if (mode === 'dontAsk') return 'skip'
  const allowHays = req.kind === 'shell-wrap' ? hays : haystacks([original])
  for (const rule of snapshot.allow) {
    if (!ruleToolIs(rule, ['bash'])) continue
    // An exact rule naming this very wrapper is the user approving it ("don't ask again" saves one): Claude Code applies it to the wrapper itself.
    if (req.kind === 'shell-wrap' && rule.content !== undefined && !rule.content.includes('*') && rule.content === req.rewritten) continue
    // A wildcard rule covering the wrapper would auto-run a command the user never allowed; one covering the original means the wrapper would add a prompt it never had.
    if (bashRuleMayMatch(rule, allowHays)) return 'skip'
  }
  if (allSubcommandsReadOnly(original)) return 'skip'
  return 'rewrite'
}

function decideRead(snapshot: PermissionSnapshot, req: RewriteRequest): RewriteVerdict {
  if (snapshot.blockReadsOutside) return 'skip'
  // The real spellings too: a junction or short name in the original would otherwise hide the directory a rule names, while the copy's temp path carries none of it.
  const hays = haystacks([req.original, req.rewritten, ...realSpellings(req.original, req.cwd), ...realSpellings(req.rewritten, req.cwd)])
  for (const rule of [...snapshot.deny, ...snapshot.ask]) {
    if (rule.tool === undefined) return 'skip'
    if (ruleToolIs(rule, ['read']) && pathRuleMayMatch(rule, hays)) return 'skip'
  }
  if (req.harness !== 'claudecode') return 'rewrite'
  // The temp copy is outside the working directory, so Claude Code would prompt for it: approved only for an original it reads with no prompt.
  return req.insideCwd === true ? 'approve' : 'skip'
}

function decideAgent(snapshot: PermissionSnapshot): RewriteVerdict {
  for (const rule of [...snapshot.deny, ...snapshot.ask]) {
    if (rule.tool === undefined) return 'skip'
    // Agent rules match the subagent type, which the rewrite leaves alone; a rule with a pattern this module cannot read is assumed to look further.
    if (ruleToolIs(rule, ['agent', 'task']) && rule.content !== undefined && /[:*]/.test(rule.content)) return 'skip'
  }
  return 'rewrite'
}

/** The pure decision, given the merged settings (null when any source could not be read). */
export function decideRewrite(snapshot: PermissionSnapshot | null, req: RewriteRequest): RewriteVerdict {
  if (snapshot === null) return 'skip'
  const mode = req.harness === 'claudecode' ? normalizedMode(req.mode) : 'default'
  if (mode === null) return 'skip'
  switch (req.kind) {
    case 'shell-wrap':
    case 'shell-query':
      return decideShell(snapshot, req, mode)
    case 'read':
      return decideRead(snapshot, req)
    case 'agent':
      return decideAgent(snapshot)
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Merge parsed settings documents into one snapshot. Throws on a malformed `permissions` block, which the caller turns into a skip. */
export function snapshotFromDocs(docs: readonly SettingsDoc[]): PermissionSnapshot {
  const allow: PermissionRule[] = []
  const deny: PermissionRule[] = []
  const ask: PermissionRule[] = []
  let blockReadsOutside = false
  const managedGroups = new Set(docs.filter((d) => d.role === 'managed').map((d) => d.managedGroup ?? 'managed'))
  const managedOnly = docs.some((d) => d.role === 'managed' && d.json['allowManagedPermissionRulesOnly'] !== undefined && d.json['allowManagedPermissionRulesOnly'] !== false)
  for (const doc of docs) {
    const permissions = doc.json['permissions']
    if (permissions === undefined) continue
    const perms = asObject(permissions)
    if (perms === null) throw new Error('permissions is not an object')
    const block = perms['blockReadsOutsideWorkingDirectories']
    if (block !== undefined && block !== false) blockReadsOutside = true
    let trusted: boolean
    switch (doc.role) {
      case 'managed':
        // Claude Code applies one managed source unless told to merge, so a managed allow proves nothing when several are present.
        trusted = managedGroups.size === 1
        break
      case 'user':
        trusted = !managedOnly
        break
      case 'local':
        trusted = !managedOnly && doc.localTrusted === true
        break
      default:
        trusted = false
    }
    for (const [key, list] of [['allow', allow], ['deny', deny], ['ask', ask]] as const) {
      const entries = perms[key]
      if (entries === undefined) continue
      if (!Array.isArray(entries)) throw new Error(`permissions.${key} is not an array`)
      // An ancestor directory's settings are not ones Claude Code applies to this session, so only their restrictions count.
      if (key === 'allow' && doc.role === 'ancestor') continue
      for (const entry of entries) list.push(parseRule(entry, key === 'allow' && trusted))
    }
  }
  return { allow, deny, ask, blockReadsOutside }
}

/** Test isolation only: tests/setup/isolate-home.ts puts a predicate under this global symbol so a unit test reads neither this machine's managed policy nor the developer's own `.claude` files above its fixture. It is given a file path, or `registry:<key>` for a Windows policy key. A global symbol rather than a module variable so a test's vi.resetModules() keeps it; the shipped CLI never sets it. */
const SOURCE_FILTER_SLOT = Symbol.for('token-goat.permission-source-filter')

function sourceAllowed(source: string): boolean {
  const filter = (globalThis as unknown as Record<symbol, unknown>)[SOURCE_FILTER_SLOT]
  return typeof filter !== 'function' || (filter as (source: string) => unknown)(source) === true
}

/** Parse one settings file: undefined when it does not exist, throws when it exists but cannot be read or is not a JSON object. */
function readSettingsFile(file: string): Record<string, unknown> | undefined {
  if (!sourceAllowed(file)) return undefined
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw err
  }
  const json = asObject(JSON.parse(text))
  if (json === null) throw new Error(`${file} is not a JSON object`)
  return json
}

/** The `Settings` value of a Windows policy key: undefined when the key or value is absent, throws when it cannot be queried or is not a JSON object. */
function readRegistrySettings(key: string): Record<string, unknown> | undefined {
  if (!sourceAllowed(`registry:${key}`)) return undefined
  const res = spawnSync('reg', ['query', key, '/v', 'Settings'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  if (res.error !== undefined) throw res.error
  if (res.status === 1) return undefined
  if (res.status !== 0) throw new Error(`reg query ${key} exited ${String(res.status)}`)
  const m = /^\s*Settings\s+(REG_\w+)\s(.*)$/m.exec(res.stdout)
  if (m === null || (m[1] !== 'REG_SZ' && m[1] !== 'REG_EXPAND_SZ')) throw new Error(`unreadable Settings value under ${key}`)
  const json = asObject(JSON.parse((m[2] as string).trim()))
  if (json === null) throw new Error(`Settings under ${key} is not a JSON object`)
  return json
}

function managedFileDocs(dir: string, group: string, out: SettingsDoc[]): void {
  const main = readSettingsFile(path.join(dir, 'managed-settings.json'))
  if (main !== undefined) out.push({ role: 'managed', json: main, managedGroup: group })
  let names: string[]
  if (!sourceAllowed(path.join(dir, 'managed-settings.d'))) return
  try {
    names = fs.readdirSync(path.join(dir, 'managed-settings.d'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw err
  }
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const json = readSettingsFile(path.join(dir, 'managed-settings.d', name))
    if (json !== undefined) out.push({ role: 'managed', json, managedGroup: group })
  }
}

/** Every managed settings source on this machine (https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy), plus the server-managed cache. */
function managedDocs(): SettingsDoc[] {
  const out: SettingsDoc[] = []
  if (process.platform === 'win32') {
    const dirs = new Map<string, string>()
    for (const base of [process.env['ProgramFiles'], 'C:\\Program Files']) {
      if (base !== undefined && base !== '') dirs.set(path.join(base, 'ClaudeCode').toLowerCase(), path.join(base, 'ClaudeCode'))
    }
    for (const dir of dirs.values()) managedFileDocs(dir, 'file', out)
    const hklm = readRegistrySettings('HKLM\\SOFTWARE\\Policies\\ClaudeCode')
    if (hklm !== undefined) out.push({ role: 'managed', json: hklm, managedGroup: 'hklm' })
    const hkcu = readRegistrySettings('HKCU\\SOFTWARE\\Policies\\ClaudeCode')
    if (hkcu !== undefined) out.push({ role: 'managed', json: hkcu, managedGroup: 'hkcu' })
  } else if (process.platform === 'darwin') {
    managedFileDocs('/Library/Application Support/ClaudeCode', 'file', out)
    for (const plist of ['/Library/Managed Preferences/com.anthropic.claudecode.plist', path.join('/Library/Managed Preferences', os.userInfo().username, 'com.anthropic.claudecode.plist')]) {
      if (!sourceAllowed(plist) || !fs.existsSync(plist)) continue
      const res = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', timeout: 5000 })
      if (res.error !== undefined || res.status !== 0) throw new Error(`unreadable ${plist}`)
      const json = asObject(JSON.parse(res.stdout))
      if (json === null) throw new Error(`${plist} is not a dictionary`)
      out.push({ role: 'managed', json, managedGroup: 'plist' })
    }
  } else {
    managedFileDocs('/etc/claude-code', 'file', out)
  }
  const remote = readSettingsFile(path.join(claudeConfigDir(), 'remote-settings.json'))
  if (remote !== undefined && Object.keys(remote).length > 0) out.push({ role: 'managed', json: remote, managedGroup: 'remote' })
  return out
}

const MANAGED_CACHE_MS = 30_000
let managedCache: { readonly at: number; readonly docs: SettingsDoc[] } | undefined

/** Drop the cached managed sources, for a test that changes them. */
export function resetPermissionSourceCache(): void {
  managedCache = undefined
}

/** Whether Claude Code trusts the allow rules of this `settings.local.json`: not when the file is tracked by git or its `.claude` directory is a symlink. Any doubt reads as untrusted. */
function localFileTrusted(file: string): boolean {
  try {
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) return false
  } catch {
    return false
  }
  const res = runGit(['ls-files', '--error-unmatch', path.basename(file)], { cwd: path.dirname(file), timeoutMs: 5000 })
  // Only 1 (untracked inside a repository) proves it; 128 also covers a repository git refuses (safe.directory) and a downloaded tree with no repository at all, -1 is git missing or timed out.
  return res.exitCode === 1
}

/** Read every settings source Claude Code could apply to a session in `cwd`. Null when any of them exists but cannot be read, so the caller skips the rewrite. */
export function loadPermissionSnapshot(cwd: string): PermissionSnapshot | null {
  try {
    const now = Date.now()
    if (managedCache === undefined || now - managedCache.at > MANAGED_CACHE_MS) managedCache = { at: now, docs: managedDocs() }
    const docs: SettingsDoc[] = [...managedCache.docs]
    const user = readSettingsFile(path.join(claudeConfigDir(), 'settings.json'))
    if (user !== undefined) docs.push({ role: 'user', json: user })
    const userLocal = readSettingsFile(path.join(claudeConfigDir(), 'settings.local.json'))
    if (userLocal !== undefined) docs.push({ role: 'ancestor', json: userLocal })
    let dir = path.resolve(cwd)
    for (let depth = 0; depth < 64; depth++) {
      const atCwd = depth === 0
      const project = readSettingsFile(path.join(dir, '.claude', 'settings.json'))
      if (project !== undefined) docs.push({ role: atCwd ? 'project' : 'ancestor', json: project })
      const localFile = path.join(dir, '.claude', 'settings.local.json')
      const local = readSettingsFile(localFile)
      if (local !== undefined) {
        const perms = asObject(local['permissions'])
        const hasAllow = Array.isArray(perms?.['allow']) && (perms['allow'] as unknown[]).length > 0
        docs.push(atCwd ? { role: 'local', json: local, localTrusted: hasAllow && localFileTrusted(localFile) } : { role: 'ancestor', json: local })
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return snapshotFromDocs(docs)
  } catch {
    return null
  }
}

/** The rewriteInput output for `updatedInput`, or null when the rewrite must not ship. Claude Code's own settings are read only on the harnesses that read them (Claude Code, and VS Code, which also loads `.claude` settings); every other harness gets the rewrite with no decision, and its serializer decides what it needs. */
export function permissionNeutralRewrite(updatedInput: Record<string, unknown>, req: RewriteRequest): HookOutput | null {
  const verdict = req.harness === 'claudecode' || req.harness === 'vscode' ? decideRewrite(loadPermissionSnapshot(req.cwd), req) : 'rewrite'
  if (verdict === 'skip') return null
  return { hookType: 'rewriteInput', updatedInput, approve: verdict === 'approve' }
}
