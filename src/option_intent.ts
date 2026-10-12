/** Translation of a flag an agent guesses into the one token-goat has. `read "f.ts" --lines 1-5` and `search "x" --top 3` each fail with commander's bare `unknown option` (for `--start` it adds a misleading `Did you mean --stats?`), and the caller spends a round trip finding the real spelling. Two outcomes, split by whether the intent survives translation. A line range on `read` is lossless (`f.ts@1-5` is the spec grammar), and so is a rename that carries its value over unchanged (`--top 3` to `--limit 3`, `--search X` to `--grep X`): both are rewritten and run, with a stderr note naming the real form. Whatever fails the checks for that (a value that is not a positive integer, the real flag already given, several spellings at once) is not run, since a guessed value is not ours to complete, and the failure gains the corrected command. `section` has no range grammar, so a line range there only gets the `read` command that has one. Every alias is verified absent from its command's registered options by tests/option_intent.test.ts, so this never shadows a real flag: like command_intent.ts, it only annotates a failure that has already happened or rewrites one that would have. */

import { attemptedCommandName, commandWordIndex, GLOBAL_VALUE_OPTIONS } from './command_intent.js'
import { fencedCommand, quotedArg } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { parseLineRange } from './read_spec.js'

/** A guessed flag spelling per command family, and the real flag each stands for. */
export interface FlagRename {
  readonly commands: readonly string[]
  readonly aliases: readonly string[]
  readonly target: string
  /** What the value must be for the rename to run on its own: a positive integer, or any text that is not itself a flag. */
  readonly value: 'integer' | 'text'
  /** Other spellings of the target that, when also given, mean the caller already chose and the guess is not ours to merge. */
  readonly targetSpellings: readonly string[]
}

/** The renames that keep the value as it is, so the corrected command differs only in the flag's name. `--lines` on the cached-output commands is not here: it is a real option there (`--lines <a-b>`, src/cli.ts and src/cli_cmd_formats.ts), so treating it as a guess would shadow it. */
export const FLAG_RENAMES: readonly FlagRename[] = [
  { commands: ['bash-output', 'web-output', 'mcp-output'], aliases: ['--search', '--filter', '--pattern'], target: '--grep', value: 'text', targetSpellings: ['--grep'] },
  { commands: ['search', 'semantic', 'recall'], aliases: ['--top', '-k', '--max', '--count'], target: '--limit', value: 'integer', targetSpellings: ['--limit', '-l'] },
]

/** The spellings of a line range given as flags instead of the `file@A-B` spec: one flag holding `A` or `A-B`, a start flag and an end flag, or an offset and a count (read as the first line and how many, so `--offset 3 --limit 4` is lines 3-6). */
export const LINE_RANGE_FLAGS = { whole: ['--lines', '--line', '--range'], start: ['--start', '--from'], end: ['--end', '--to'], offset: ['--offset'], count: ['--limit'] } as const

const WHOLE_RANGE = /^[1-9]\d*(?:-[1-9]\d*)?$/
const LINE_NUMBER = /^[1-9]\d*$/
const DIGITS = /^\d+$/
const PLAIN_FLAG = /^--?[A-Za-z][\w-]*$/
const RANGE_KINDS =['whole', 'start', 'end', 'offset', 'count'] as const
/** A backtick ends the fence a suggested command is wrapped in, and a line break splits the hint, so a value holding either gets no suggestion at all rather than a mangled one. */
const FENCE_BREAKER = /[`\r\n]/

/** Splits `--flag=value` into its name and value; a token with no `=` has no inline value. */
function splitFlag(token: string): { name: string; value: string | undefined } {
  const eq = token.startsWith('--') ? token.indexOf('=') : -1
  return eq === -1 ? { name: token, value: undefined } : { name: token.slice(0, eq), value: token.slice(eq + 1) }
}

/** Whether a spec already says where in the file to read (`f::symbol`, `f@A-B`, `f:A-B`), so a line-range flag has nothing to add and the two would contradict. An `@` elsewhere is just part of a path (`node_modules/@types/node/index.d.ts`), which parseLineRange leaves alone because it matches only a trailing `@N` or `@N-M`. */
function specNamesAPlace(spec: string): boolean {
  return spec.includes('::') || parseLineRange(spec) !== null || /:\d+(?:-\d+)?$/.test(spec)
}

/** Whether a guessed flag's value is one the real flag takes as it stands, so the corrected command can run. A missing value never fits. */
function valueFits(rename: FlagRename, text: string | undefined, inline: boolean): boolean {
  if (text === undefined || text === '') return false
  return rename.value === 'integer' ? LINE_NUMBER.test(text) : inline || !text.startsWith('-')
}

/** What a rewrite hands back: the whole argv to parse, the one-line note to print on stderr, the command it applies to, and the guessed spellings it replaced. */
export interface OptionRewrite {
  argv: string[]
  note: string
  command: string
  flags: string[]
}

/** The arguments after the command word when argv runs `name`, or null for any other command. */
function argumentsOf(argv: readonly string[], name: string): { commandAt: number; rest: string[] } | null {
  const commandAt = commandWordIndex(argv)
  if (commandAt === -1 || argv[commandAt] !== name) return null
  return { commandAt, rest: argv.slice(commandAt + 1) }
}

/** `A-B` for the values given, or null when they do not describe one range: the kinds must be a lone whole range, a start with an end, or an offset with a count, and the last line must not come before the first. */
function joinRange(given: Partial<Record<(typeof RANGE_KINDS)[number], string>>): string | null {
  const only = (...kinds: (typeof RANGE_KINDS)[number][]): boolean => RANGE_KINDS.every((k) => kinds.includes(k) === (given[k] !== undefined))
  let first: string
  let last: string
  if (only('whole')) {
    const [from = '', to = from] = given.whole!.split('-')
    first = from
    last = to
  } else if (only('start', 'end')) {
    first = given.start!
    last = given.end!
  } else if (only('offset', 'count')) {
    first = given.offset!
    last = String(Number(first) + Number(given.count!) - 1)
  } else return null
  if (!Number.isSafeInteger(Number(last)) || Number(last) < Number(first)) return null
  return given.whole !== undefined && !given.whole.includes('-') ? first : `${first}-${last}`
}

/** The line-range flags in one command's arguments, with the single spec they apply to, or null when the intent is not certain: each flag given once with a positive line number (or an `A` / `A-B` range for the whole-range spellings), one complete range, and exactly one positional spec that names no place yet. */
function readLineRangeFlags(rest: readonly string[]): { kept: string[]; range: string; flags: string[]; spec: string } | null {
  if (rest.includes('--')) return null
  const kept: string[] = []
  const given: Partial<Record<(typeof RANGE_KINDS)[number], string>> = {}
  const flags: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const { name, value } = splitFlag(rest[i]!)
    const kind = RANGE_KINDS.find((k) => (LINE_RANGE_FLAGS[k] as readonly string[]).includes(name))
    if (kind === undefined) {
      kept.push(rest[i]!)
      continue
    }
    const text = value ?? rest[i + 1]
    if (given[kind] !== undefined || text === undefined || !(kind === 'whole' ? WHOLE_RANGE : LINE_NUMBER).test(text)) return null
    given[kind] = text
    flags.push(name)
    if (value === undefined) i++
  }
  if (flags.length === 0) return null
  const range = joinRange(given)
  const positional = kept.filter((arg, i) => !arg.startsWith('-') && !GLOBAL_VALUE_OPTIONS.includes(kept[i - 1] ?? ''))
  if (range === null || positional.length !== 1 || specNamesAPlace(positional[0]!)) return null
  return { kept, range, flags, spec: positional[0]! }
}

/** `read <file> --lines A-B` (or `--start A --end B`, or `--offset A --limit N`) run as `read "<file>@A-B"`, or null when this is some other invocation. Anything the checks in readLineRangeFlags do not settle is left for commander's own error, since a rewrite built on a guess about what was meant is worse than the plain failure. */
export function rewriteLineRangeFlag(argv: readonly string[]): OptionRewrite | null {
  const found = argumentsOf(argv, 'read')
  const parsed = found === null ? null : readLineRangeFlags(found.rest)
  if (found === null || parsed === null || FENCE_BREAKER.test(parsed.spec)) return null
  const spec = `${parsed.spec}@${parsed.range}`
  const rewritten = [...argv.slice(0, found.commandAt + 1), ...parsed.kept.map((arg) => (arg === parsed.spec ? spec : arg))]
  const { flags } = parsed
  return { argv: rewritten, command: 'read', flags, note: displaySafeText(`Note: ran as ${fencedCommand(`token-goat read ${quotedArg(spec)}`)} (${flags.join(' and ')} ${flags.length === 1 ? 'is' : 'are'} not ${flags.length === 1 ? 'an option' : 'options'}; a line range goes in the spec as @A-B).`) }
}

/** The `read` command for a line range given to `section`, which has no range grammar of its own, or null when this is some other invocation. Only a suggestion: `section` fails on its own unknown option, and what the caller wanted was lines, not a heading. */
function suggestReadForSectionRange(argv: readonly string[]): string | null {
  const found = argumentsOf(argv, 'section')
  const parsed = found === null ? null : readLineRangeFlags(found.rest)
  if (parsed === null || FENCE_BREAKER.test(parsed.spec)) return null
  return displaySafeText(`Did you mean: ${fencedCommand(`token-goat read ${quotedArg(`${parsed.spec}@${parsed.range}`)}`)}?`)
}

/** The argv with every guessed spelling the renames cover swapped for the real flag, keeping any inline value. Only the words after the command are touched. */
function replaceAliases(argv: readonly string[], renames: readonly FlagRename[]): { argv: string[]; changed: boolean } {
  let changed = false
  const commandAt = commandWordIndex(argv)
  const next = argv.map((token, i) => {
    if (i <= commandAt) return token
    const { name, value } = splitFlag(token)
    const rename = renames.find((r) => r.aliases.includes(name))
    if (rename === undefined) return token
    changed = true
    return value === undefined ? rename.target : `${rename.target}=${value}`
  })
  return { argv: next, changed }
}

/** The command as it would be typed, from the command word on: a plain flag name as given, a plain number bare, every other word quoted the way the other suggestions quote it. A `--flag=value` token is split into the flag and its quoted value, since the value is the caller's text and must not ride along unquoted. */
function renderCommand(argv: readonly string[]): string {
  const commandAt = commandWordIndex(argv)
  const words = argv.slice(commandAt).flatMap((token, i) => {
    if (i === 0) return [token]
    if (PLAIN_FLAG.test(token)) return [token]
    const { name, value } = splitFlag(token)
    if (value !== undefined && PLAIN_FLAG.test(name)) return [name, DIGITS.test(value) ? value : quotedArg(value)]
    return [DIGITS.test(token) ? token : quotedArg(token)]
  })
  return `token-goat ${words.join(' ')}`
}

/** `search x --top 3` run as `search x --limit 3`, or null when this is some other invocation. Runs only when the guess is certain: one guessed spelling, no `--`, a value that is a positive integer (for a limit) or text that is not itself a flag (for a pattern), and the real flag not already given. */
export function rewriteFlagRename(argv: readonly string[]): OptionRewrite | null {
  const command = attemptedCommandName(argv)
  if (command === null) return null
  const renames = FLAG_RENAMES.filter((r) => r.commands.includes(command))
  if (renames.length === 0) return null
  const rest = argv.slice(commandWordIndex(argv) + 1)
  if (rest.includes('--') || argv.some((token) => FENCE_BREAKER.test(token))) return null

  const hits = rest.flatMap((token, i) => (renames.some((r) => r.aliases.includes(splitFlag(token).name)) ? [i] : []))
  if (hits.length !== 1) return null
  const at = hits[0]!
  const { name, value } = splitFlag(rest[at]!)
  const rename = renames.find((r) => r.aliases.includes(name))!
  if (rest.some((token) => rename.targetSpellings.includes(splitFlag(token).name))) return null
  if (!valueFits(rename, value ?? rest[at + 1], value !== undefined)) return null

  const replaced = replaceAliases(argv, renames).argv
  return { argv: replaced, command, flags: [name], note: displaySafeText(`Note: ran as ${fencedCommand(renderCommand(replaced))} (${name} is not an option; the flag is ${rename.target}).`) }
}

/** The rewrite for a guessed flag that is certain enough to run, or null when commander should see argv as given. */
export function rewriteOptionIntent(argv: readonly string[]): OptionRewrite | null {
  return rewriteLineRangeFlag(argv) ?? rewriteFlagRename(argv)
}

/** The guessed spellings in argv that a table covers for its command, for the stat that records which guesses recur. Static flag names only, never a value. */
export function renamedFlagsIn(argv: readonly string[]): string[] {
  const command = attemptedCommandName(argv)
  if (command === null) return []
  const guessed = [
    ...FLAG_RENAMES.filter((r) => r.commands.includes(command)).flatMap((r) => r.aliases),
    ...(command === 'read' || command === 'section' ? Object.values(LINE_RANGE_FLAGS).flat() : []),
  ]
  return argv.slice(2).map((token) => splitFlag(token).name).filter((name) => guessed.includes(name))
}

/** The corrected command for a guessed flag that commander rejected, or null when no table covers it. A rename replaces each alias with the real flag; a line range given to `section` names the `read` command instead. */
export function suggestForUnknownOption(argv: readonly string[]): string | null {
  const command = attemptedCommandName(argv)
  if (command === null) return null
  const range = suggestReadForSectionRange(argv)
  if (range !== null) return range
  const renames = FLAG_RENAMES.filter((r) => r.commands.includes(command))
  if (renames.length === 0) return null
  if (argv.slice(2).some((token) => FENCE_BREAKER.test(token))) return null
  const rest = argv.slice(commandWordIndex(argv) + 1)
  const unusable = rest.some((token, i) => {
    const { name, value } = splitFlag(token)
    const rename = renames.find((r) => r.aliases.includes(name))
    return rename !== undefined && !valueFits(rename, value ?? rest[i + 1], value !== undefined)
  })
  if (unusable) return null
  const replaced = replaceAliases(argv, renames)
  return replaced.changed ? displaySafeText(`Did you mean: ${fencedCommand(renderCommand(replaced.argv))}?`) : null
}
