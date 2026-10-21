/** Answers a single-file structural Grep with the one symbol it names, instead of a hint that names the command which would fetch it. The agent's next turn is then not spent running `token-goat read`. A wrong body costs more than a pointer, so every link must be certain: the pattern is nothing but a declaration word and one name, the file's fresh index holds that name exactly once, the body read back from disk is the one the index describes, and it fits under a byte cap. Anything short of that returns the reason and the caller keeps today's hint. Off by default (hints.inline_symbol_body). */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { quotedArg } from './hint_suggestion_guard.js'
import { matchScopeLines, readScopeDir, readScopeSingleFile, type ScopeMatch } from './inline_grep_scan.js'
import { querySymbols } from './index_reader.js'
import { fenceUntrustedFileContent } from './injection_scan.js'
import { displaySafePath, resolveIndexPath } from './paths.js'
import { isInsideRoot } from './path_containment.js'
import { resolveProjectRoot } from './project.js'
import { getReadNavigationEvidence } from './read_navigation_evidence.js'
import { redactSecrets } from './secret_redact.js'
import { commandPathIsTouchable } from './vscode_path_gate.js'
import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { denyOutput } from './hooks_common.js'
import { countNoun, foldPath } from './util.js'

/** The most a deny will inline. Smaller than hooks_skill.ts's COMPACT_INLINE_MAX_BYTES (24_000) because a wrong body here costs a turn the pointer would not have; {@link decideInline} clamps any caller-supplied cap to it, so nothing can raise it. */
export const INLINE_SYMBOL_MAX_BYTES = 12_000

/** Why an answer was not inlined; the caller falls back to the command-naming hint for every one of these. */
export type NameReason = 'disabled' | 'no_declaration_pattern' | 'none' | 'ambiguous' | 'stale' | 'staleness_unknown' | 'unreadable_body' | 'untouchable_path' | 'outside_project' | 'pattern_mismatch' | 'scope_unreadable' | 'body_mismatch' | 'over_cap'

export type Staleness = 'fresh' | 'stale' | 'unknown'

/** A symbol the index holds under the name the pattern gave, with the file (index key) it lives in. */
export interface InlineCandidate {
  readonly name: string
  readonly file: string
}

/** What `token-goat read` would print for one candidate, and whether the lines it came from still agree with the index range. */
export interface InlineBody {
  readonly text: string
  readonly agreesWithIndex: boolean
}

export interface InlineInput {
  readonly enabled: boolean
  /** The one name the Grep pattern gave. */
  readonly symbol: string
  /** Index key of the file or directory the Grep was scoped to; candidates outside it are dropped. Absent means the whole index. */
  readonly scope?: string
  readonly candidates: readonly InlineCandidate[]
  /** Staleness of each candidate file's index copy, keyed by index key. A file not listed is unknown, and unknown is never fresh. */
  readonly staleness: Readonly<Record<string, Staleness>>
  /** Reads the candidate's body lazily: it costs a disk read, so it runs only once every cheaper link has held. */
  readonly readBody: (candidate: InlineCandidate) => InlineBody | null | Promise<InlineBody | null>
  readonly capBytes?: number
}

export type InlineDecision = { readonly inline: string; readonly file: string; readonly symbol: string; readonly matches?: readonly string[] } | { readonly name: NameReason }

function insideScope(scope: string | undefined, file: string): boolean {
  if (scope === undefined) return true
  const s = scope.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const f = file.replace(/\\/g, '/').toLowerCase()
  return f === s || f.startsWith(s + '/')
}

/** Inline the body of the one symbol the input resolves to, or name why not. Pure apart from `readBody`, which is awaited because the real one loads read_commands.ts on demand. */
export async function decideInline(input: InlineInput): Promise<InlineDecision> {
  if (!input.enabled) return { name: 'disabled' }
  const inScope = input.candidates.filter((c) => c.name === input.symbol && insideScope(input.scope, c.file))
  if (inScope.length === 0) return { name: 'none' }
  if (inScope.length > 1) return { name: 'ambiguous' }
  const only = inScope[0] as InlineCandidate
  const state = input.staleness[only.file] ?? 'unknown'
  if (state === 'stale') return { name: 'stale' }
  if (state !== 'fresh') return { name: 'staleness_unknown' }
  const body = await input.readBody(only)
  if (body === null) return { name: 'unreadable_body' }
  if (!body.agreesWithIndex) return { name: 'body_mismatch' }
  const cap = Math.min(input.capBytes ?? INLINE_SYMBOL_MAX_BYTES, INLINE_SYMBOL_MAX_BYTES)
  if (Buffer.byteLength(body.text, 'utf8') > cap) return { name: 'over_cap' }
  return { inline: body.text, file: only.file, symbol: only.name }
}

/** Words a declaration pattern leads with, across the languages hooks_grep.ts's STRUCTURAL_SOURCE_PATTERN_RE recognises. */
const DECLARATION_WORDS = new Set(['def', 'class', 'function', 'async', 'export', 'default', 'const', 'let', 'var', 'interface', 'type', 'enum', 'func', 'fn', 'struct', 'impl', 'pub', 'trait', 'object', 'val', 'fun'])
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/

/** The one name a declaration pattern asks for (`^class Foo\b`, `def foo\(`, `class Foo:`), or null when the pattern asks for anything else: an alternation, a wildcard, a qualified name, a bare identifier with no declaration word. Whitespace classes and a leading anchor are noise around the name. The name must also END in a terminator (word boundary, open paren, colon, `<` or end anchor): a regex is a substring match, so `class Foo` alone also matches `class FooBar` and every other longer identifier. Every other regex character is a pattern the agent wrote to match more than one thing. */
export function declaredNameOf(pattern: string): string | null {
  const unanchored = pattern.trim().replace(/^\^/, '').replace(/\\s[*+]?/g, ' ')
  const bounded = unanchored.replace(/(?:\\b|\\\(|\(|:|\$|<)+$/, '')
  if (bounded === unanchored) return null
  const spaced = bounded.trim()
  const words = spaced.split(/ +/)
  const name = words[words.length - 1] ?? ''
  const lead = words.slice(0, -1)
  if (lead.length === 0 || !IDENTIFIER_RE.test(name) || DECLARATION_WORDS.has(name.toLowerCase())) return null
  return lead.every((w) => DECLARATION_WORDS.has(w.toLowerCase())) ? name : null
}

/** Grep tool_input keys that leave the answer a plain content search of one pattern in one path. Key names are Claude Code's GrepInput (@anthropic-ai/claude-code 2.1.306, sdk-tools.d.ts): pattern, path, glob, output_mode, -B, -A, -C, context, -n, -i, -o, type, head_limit, offset, multiline. `-n` only toggles line numbers, so it is harmless here. */
const PLAIN_GREP_KEYS = new Set(['pattern', 'path', 'output_mode', '-n'])

/** True when the Grep is a plain content search: `output_mode` exactly `content` (Claude Code defaults an absent one to files_with_matches, which a body would replace), and every other key outside {@link PLAIN_GREP_KEYS} (`-i`, `-o`, `-A`, `-B`, `-C`, `context`, `multiline`, `head_limit`, `offset`, `glob`, `type`, or one a later Claude Code adds) absent, null or false. A modifier changes what the Grep would have returned, so the body is no longer the answer to it; an allowlist keeps an unknown key from slipping through. */
export function isPlainGrep(toolInput: Readonly<Record<string, unknown>>): boolean {
  if (toolInput['output_mode'] !== 'content') return false
  return Object.entries(toolInput).every(([key, value]) => PLAIN_GREP_KEYS.has(key) || value === undefined || value === null || value === false)
}

/** Session-hint key: a file's symbol is answered once, so repeating the same Grep gets the ordinary hint rather than the same refusal forever. */
export function inlineAnswerKey(file: string, symbol: string): string {
  return 'inline-symbol-body:' + file + '::' + symbol
}

/** The Grep's own path, resolved to the index key, or null when the hook may not touch it before the harness has approved the call. */
export function inlineIndexKey(grepPath: string, cwd: string, event: HookEvent): string | null {
  if (grepPath.includes('::') || !commandPathIsTouchable(grepPath, event)) return null
  return resolveIndexPath(grepPath, cwd)
}

type SymbolEntry = ReturnType<typeof querySymbols>[number]

/** What `token-goat read "file::name"` prints for `row`, taken from the same runRead, plus whether the body it resolved is the very lines on disk at the index range. A print the overflow guard cut short fails the agreement too, since the deny would then carry less than the symbol. */
async function readIndexedBody(row: SymbolEntry, cwd: string): Promise<InlineBody | null> {
  const [{ readFileText, resolveBody, runRead }, { indexedSourceText }] = await Promise.all([import('./read_commands.js'), import('./indexed_source.js')])
  const printed = runRead({ spec: row.filePath + '::' + row.name, projectRoot: cwd, suppressStat: true })
  if (printed.code !== 0) return null
  const source = readFileText(row.filePath)
  if (source === null) return null
  const onDisk = indexedSourceText(row.filePath, source).split(/\r?\n/).slice(Math.max(0, row.lineStart - 1), row.lineEnd).join('\n')
  const resolved = resolveBody(row)
  return { text: printed.text, agreesWithIndex: resolved === onDisk && printed.text.includes(resolved) }
}

/** The name a bare-identifier pattern asks for (`foo`, `\bfoo\b`, `foo\b`, `\bfoo`), or null for anything else. An ASCII identifier only, with at most a word boundary on either side, so the JavaScript regex the check runs and ripgrep's agree on every line they both match: ripgrep's `\b` is Unicode-aware and JavaScript's is ASCII, which can only make this check find MORE lines than ripgrep, and an extra line passes the Grep through. */
export function bareNameOf(pattern: string): string | null {
  const m = /^(?:\\b)?([A-Za-z_][A-Za-z0-9_]*)(?:\\b)?$/.exec(pattern)
  return m === null ? null : (m[1] as string)
}

export interface InlineAnswerArgs {
  readonly enabled: boolean
  readonly pattern: string
  /** The Grep's own `path`, or null when it gave none (Claude Code then searches its working directory). */
  readonly grepPath: string | null
  readonly cwd: string
  readonly event: HookEvent
  /** True when a permission rule covers the file, so its lines must not reach the deny. Required, so a caller cannot forget it. */
  readonly isBarred: (absPath: string) => boolean
}

/** The text a deny delivers, redacted: the optional match listing and the body, each redacted on its own, with the bytes actually delivered. */
function deliveredText(answer: { readonly inline: string; readonly matches?: readonly string[] }): { listing: string | null; body: string; count: number; bodyBytes: number; totalBytes: number } {
  const body = redactSecrets(answer.inline)
  const listing = answer.matches === undefined ? null : redactSecrets(answer.matches.join('\n'))
  const bodyBytes = Buffer.byteLength(body.text, 'utf8')
  return { listing: listing === null ? null : listing.text, body: body.text, count: body.count + (listing === null ? 0 : listing.count), bodyBytes, totalBytes: bodyBytes + (listing === null ? 0 : Buffer.byteLength(listing.text, 'utf8')) }
}

/** What a Grep scoped to a file or a directory searches, with a way to name each file. */
type ScopeKind = 'file' | 'dir'

function scopeKindOf(abs: string): ScopeKind | null {
  try {
    const st = fs.statSync(abs)
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null
  } catch {
    return null
  }
}

/** Everything the decision needs from the index and the disk for one Grep, then the decision itself. The Grep is a declaration search for one symbol (`^class Foo\b`) or a bare name (`foo`, `\bfoo\b`), scoped to one file, a directory, or nothing (the working directory). A deny replaces the Grep's output, so it fires only when it carries every line the Grep would have printed: the name must resolve to exactly one indexed symbol in the scope, the pattern is run over every file ripgrep could search (see readScopeDir), a declaration pattern must match that symbol's declaration and nothing else, and a bare name's matching lines are all listed. Async because the exact bytes `read` prints come from read_commands.ts, which the hook bundle must not load unless an answer is going to be inlined. */
export async function inlineSymbolAnswer(args: InlineAnswerArgs): Promise<InlineDecision> {
  if (!args.enabled) return { name: 'disabled' }
  const declared = declaredNameOf(args.pattern)
  const symbol = declared ?? bareNameOf(args.pattern)
  if (symbol === null) return { name: 'no_declaration_pattern' }
  const scope = inlineIndexKey(args.grepPath ?? args.cwd, args.cwd, args.event)
  if (scope === null) return { name: 'untouchable_path' }
  // Before any read: the harness has not approved this Grep yet, so a path that real-resolves outside the project, or cannot be resolved, delivers nothing.
  const root = resolveProjectRoot({ project: args.cwd })
  if (!isInsideRoot(scope, root)) return { name: 'outside_project' }
  const kind = scopeKindOf(scope)
  if (kind === null) return { name: 'scope_unreadable' }
  const rows = querySymbols({ name: symbol, ...(kind === 'file' ? { filePath: scope } : { rootDir: scope }), limit: 20 }).filter((r) => r.kind !== 'heading' && !r.name.includes('.'))
  const staleness: Record<string, Staleness> = {}
  for (const r of rows) {
    const evidence = getReadNavigationEvidence(r.filePath)
    if (evidence !== null) staleness[r.filePath] = evidence.isStale ? 'stale' : 'fresh'
  }
  const decision = await decideInline({
    enabled: true,
    symbol,
    scope,
    candidates: rows.map((r) => ({ name: r.name, file: r.filePath })),
    staleness,
    readBody: async (candidate) => {
      const row = rows.find((r) => r.name === candidate.name && r.filePath === candidate.file)
      return row === undefined ? null : await readIndexedBody(row, args.cwd)
    },
  })
  if (!('inline' in decision)) return decision
  const answered = rows.find((r) => r.name === decision.symbol && r.filePath === decision.file)
  if (answered === undefined) return { name: 'pattern_mismatch' }
  const checked = await checkPatternOverScope({ pattern: args.pattern, bare: declared === null, kind, scope, root, answered, args })
  if ('name' in checked) return checked
  // Redaction can lengthen the text, so the cap is judged on what the deny will carry.
  const withMatches = checked.matches === null ? decision : { ...decision, matches: checked.matches }
  if (deliveredText(withMatches).totalBytes > INLINE_SYMBOL_MAX_BYTES) return { name: 'over_cap' }
  return withMatches
}

/** Run the Grep's own pattern over every file it could search and decide whether the answer covers it. Returns the `path:line:text` listing to deliver (null for a file-scoped declaration, whose one line is inside the body), or the reason to pass. */
async function checkPatternOverScope(input: {
  readonly pattern: string
  readonly bare: boolean
  readonly kind: ScopeKind
  readonly scope: string
  readonly root: string
  readonly answered: SymbolEntry
  readonly args: InlineAnswerArgs
}): Promise<{ readonly matches: readonly string[] | null } | { readonly name: NameReason }> {
  const [{ isVirtualIndexedPath }, { compileGuardedRegex }] = await Promise.all([import('./indexed_source.js'), import('./regex_guard.js')])
  const compiled = compileGuardedRegex(input.pattern)
  if (!compiled.ok || isVirtualIndexedPath(input.answered.filePath)) return { name: 'pattern_mismatch' }
  const read = input.kind === 'file' ? readScopeSingleFile(input.scope, input.args.cwd) : readScopeDir(input.scope, input.root)
  if ('passReason' in read) return { name: 'scope_unreadable' }
  const matches = matchScopeLines(compiled.re, read.files)
  const row = input.answered
  const inRow = (m: ScopeMatch): boolean => foldPath(m.file.key) === foldPath(row.filePath) && m.line >= row.lineStart && m.line <= row.lineEnd
  if (matches.length === 0 || !matches.some(inRow)) return { name: 'pattern_mismatch' }
  // A declaration pattern must match the declaration and nothing else; a bare name may match many lines, all of which are listed.
  if (!input.bare && matches.length !== 1) return { name: 'pattern_mismatch' }
  // The lines of a file a permission rule covers, or that the hook may not touch, must not reach the deny.
  for (const m of matches) {
    if (input.args.isBarred(m.file.abs) || !commandPathIsTouchable(m.file.abs, input.args.event)) return { name: 'untouchable_path' }
  }
  if (input.kind === 'file' && !input.bare) return { matches: null }
  return { matches: matches.map((m) => displaySafePath(relativeTo(input.args.cwd, m.file.abs)) + ':' + m.line + ':' + m.text.replace(/\r$/, '')) }
}

/** `abs` as a forward-slash path relative to `base` when it lies under it, else `abs` itself. */
function relativeTo(base: string, abs: string): string {
  const rel = path.relative(base, abs)
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel.replace(/\\/g, '/')
}

/** The deny for an inlined answer. The fence and the redaction are the ones the other delivering denies use; the wording matches delivering_deny.ts's DELIVERS_CONTENT_RE, and the command stays in the text so the agent can rerun the Grep-free path. */
export function inlineAnswerDeny(answer: { readonly inline: string; readonly file: string; readonly symbol: string; readonly matches?: readonly string[] }): HookOutput {
  const file = displaySafePath(answer.file)
  const symbol = displaySafePath(answer.symbol)
  const delivered = deliveredText(answer)
  const bytes = delivered.bodyBytes
  const body = fenceUntrustedFileContent(delivered.body)
  const command = 'token-goat read ' + quotedArg(file + '::' + symbol)
  const origin = delivered.count === 0 ? ', exactly as `' + command + '` prints it. Run that command for the same text again, or Grep again to search the file anyway.' : ', as `' + command + '` prints it except that [REDACTED] placeholders replace ' + countNoun(delivered.count, 'secret-looking value') + '. Run that command to read the symbol again, or Grep again to search the file anyway.'
  const listed = delivered.listing === null || answer.matches === undefined ? '' : '\nThe ' + countNoun(answer.matches.length, 'matching line') + ' the Grep would have printed, as path:line:text:\n' + fenceUntrustedFileContent(delivered.listing) + '\nThe symbol body:'
  return denyOutput('Grep not run: its pattern names the one symbol `' + symbol + '` in `' + file + '`, whose symbol body (' + bytes + ' bytes) is inlined below' + origin + listed + '\n' + body)
}

/** The Grep's `path` for the answer: a string with no glob character, null when it gave none (Claude Code then searches its working directory), or undefined when the value is something the answer cannot scope (a non-string, a glob). */
export function inlineGrepPath(toolInput: Readonly<Record<string, unknown>>): string | null | undefined {
  const raw = toolInput['path']
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return /[*?[{]/.test(trimmed) ? undefined : trimmed
}
