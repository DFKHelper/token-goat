/** Answers a single-file structural Grep with the one symbol it names, instead of a hint that names the command which would fetch it. The agent's next turn is then not spent running `token-goat read`. A wrong body costs more than a pointer, so every link must be certain: the pattern is nothing but a declaration word and one name, the file's fresh index holds that name exactly once, the body read back from disk is the one the index describes, and it fits under a byte cap. Anything short of that returns the reason and the caller keeps today's hint. Off by default (hints.inline_symbol_body). */
import { quotedArg } from './hint_suggestion_guard.js'
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

/** The most a deny will inline. Smaller than hooks_skill.ts's COMPACT_INLINE_MAX_BYTES (24_000) because a wrong body here costs a turn the pointer would not have; {@link decideInline} clamps any caller-supplied cap to it, so nothing can raise it. */
export const INLINE_SYMBOL_MAX_BYTES = 12_000

/** Why an answer was not inlined; the caller falls back to the command-naming hint for every one of these. */
export type NameReason = 'disabled' | 'no_declaration_pattern' | 'none' | 'ambiguous' | 'stale' | 'staleness_unknown' | 'unreadable_body' | 'untouchable_path' | 'outside_project' | 'pattern_mismatch' | 'body_mismatch' | 'over_cap'

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

export type InlineDecision = { readonly inline: string; readonly file: string; readonly symbol: string } | { readonly name: NameReason }

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
async function readIndexedBody(row: SymbolEntry, grepPath: string, cwd: string): Promise<InlineBody | null> {
  const [{ readFileText, resolveBody, runRead }, { indexedSourceText }] = await Promise.all([import('./read_commands.js'), import('./indexed_source.js')])
  const printed = runRead({ spec: grepPath + '::' + row.name, projectRoot: cwd, suppressStat: true })
  if (printed.code !== 0) return null
  const source = readFileText(row.filePath)
  if (source === null) return null
  const onDisk = indexedSourceText(row.filePath, source).split(/\r?\n/).slice(Math.max(0, row.lineStart - 1), row.lineEnd).join('\n')
  const resolved = resolveBody(row)
  return { text: printed.text, agreesWithIndex: resolved === onDisk && printed.text.includes(resolved) }
}

/** Everything the decision needs from the index and the disk for one declaration Grep, then the decision itself. Async because the exact bytes `read` prints come from read_commands.ts, which the hook bundle must not load unless an answer is going to be inlined. */
export async function inlineSymbolAnswer(args: { enabled: boolean; pattern: string; grepPath: string; cwd: string; event: HookEvent }): Promise<InlineDecision> {
  if (!args.enabled) return { name: 'disabled' }
  const symbol = declaredNameOf(args.pattern)
  if (symbol === null) return { name: 'no_declaration_pattern' }
  const file = inlineIndexKey(args.grepPath, args.cwd, args.event)
  if (file === null) return { name: 'untouchable_path' }
  // Before any read: the harness has not approved this Grep yet, so a path that real-resolves outside the project, or cannot be resolved, delivers nothing.
  if (!isInsideRoot(file, resolveProjectRoot({ project: args.cwd }))) return { name: 'outside_project' }
  const rows = querySymbols({ name: symbol, filePath: file, limit: 20 }).filter((r) => r.kind !== 'heading' && !r.name.includes('.'))
  const evidence = getReadNavigationEvidence(file)
  const staleness: Record<string, Staleness> = evidence === null ? {} : { [file]: evidence.isStale ? 'stale' : 'fresh' }
  const decision = await decideInline({
    enabled: true,
    symbol,
    scope: file,
    candidates: rows.map((r) => ({ name: r.name, file: r.filePath })),
    staleness,
    readBody: async () => {
      const row = rows[0]
      return row === undefined ? null : await readIndexedBody(row, args.grepPath, args.cwd)
    },
  })
  if (!('inline' in decision)) return decision
  const answered = rows.find((r) => r.name === decision.symbol)
  return answered !== undefined && (await patternMatchesOnlyRow(args.pattern, answered)) ? decision : { name: 'pattern_mismatch' }
}

/** True when the Grep's own pattern, run over the file's lines, matches exactly one line and that line lies inside the row's range: an index name that is unique does not make the regex's matches unique (`function foo\b` also matches `function foo$bar`), and a pattern may match nothing the row declares (`class foo\b` against a function). A pattern the regex guard refuses (it does not compile, or could stall), or a file the grep would not see as these lines, is false. For the narrow patterns declaredNameOf accepts, JS and ripgrep agree on `\b`, `\(`, `\s`, `^` and `$`. */
async function patternMatchesOnlyRow(pattern: string, row: SymbolEntry): Promise<boolean> {
  const [{ readFileText }, { indexedSourceText, isVirtualIndexedPath }, { compileGuardedRegex }] = await Promise.all([import('./read_commands.js'), import('./indexed_source.js'), import('./regex_guard.js')])
  const compiled = compileGuardedRegex(pattern)
  if (!compiled.ok) return false
  const re = compiled.re
  const source = isVirtualIndexedPath(row.filePath) ? null : readFileText(row.filePath)
  if (source === null) return false
  const hits: number[] = []
  indexedSourceText(row.filePath, source).split(/\r?\n/).forEach((line, i) => {
    if (re.test(line)) hits.push(i + 1)
  })
  const only = hits[0]
  return hits.length === 1 && only !== undefined && only >= row.lineStart && only <= row.lineEnd
}

/** The deny for an inlined answer. The fence and the redaction are the ones the other delivering denies use; the wording matches delivering_deny.ts's DELIVERS_CONTENT_RE, and the command stays in the text so the agent can rerun the Grep-free path. */
export function inlineAnswerDeny(answer: { readonly inline: string; readonly file: string; readonly symbol: string }): HookOutput {
  const file = displaySafePath(answer.file)
  const symbol = displaySafePath(answer.symbol)
  const bytes = Buffer.byteLength(answer.inline, 'utf8')
  const body = fenceUntrustedFileContent(redactSecrets(answer.inline).text)
  return denyOutput(
    'Grep not run: its pattern names the one symbol `' + symbol + '` in `' + file + '`, whose symbol body (' + bytes + ' bytes) is inlined below, exactly as `token-goat read ' + quotedArg(file + '::' + symbol) + '` prints it. Run that command for the same text again, or Grep again to search the file anyway.\n' + body,
  )
}
