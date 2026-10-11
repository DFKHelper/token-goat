/** Translation of a flag an agent guesses into the one token-goat has. `read "f.ts" --lines 1-5` and `search "x" --top 3` each fail with commander's bare `unknown option` (for `--start` it adds a misleading `Did you mean --stats?`), and the caller spends a round trip finding the real spelling. Two outcomes, split by whether the intent survives translation. A line range on `read` is lossless (`f.ts@1-5` is the spec grammar), so it is rewritten and run, with a stderr note naming the real form. Every other guess names a flag that exists under another name; the command is not run, since a guessed value is not ours to complete, and the failure gains the corrected command. Every alias is verified absent from its command's registered options by tests/option_intent.test.ts, so this never shadows a real flag: like command_intent.ts, it only annotates a failure that has already happened or rewrites one that would have. */

import { attemptedCommandName } from './command_intent.js'
import { fencedCommand, quotedArg } from './hint_suggestion_guard.js'
import { parseLineRange } from './read_spec.js'

/** A guessed flag spelling per command family, and the real flag each stands for. */
export interface FlagRename {
  readonly commands: readonly string[]
  readonly aliases: readonly string[]
  readonly target: string
}

/** The renames that keep the value as it is, so the corrected command differs only in the flag's name. `--lines` on the cached-output commands is not here: it could mean `--head` or `--tail`, and a guess between them is not ours to make. */
export const FLAG_RENAMES: readonly FlagRename[] = [
  { commands: ['bash-output', 'web-output', 'mcp-output'], aliases: ['--search', '--filter', '--pattern'], target: '--grep' },
  { commands: ['search', 'semantic', 'recall'], aliases: ['--top', '-k', '--max', '--count'], target: '--limit' },
]

/** The spellings of a line range given as flags instead of the `file@A-B` spec: one flag holding `A` or `A-B`, or a start flag and an end flag. `--offset`/`--limit` are left out: that pair is a start and a count, so `A-B` would read the wrong lines. */
export const LINE_RANGE_FLAGS = { whole: ['--lines', '--line', '--range'], start: ['--start', '--from'], end: ['--end', '--to'] } as const

const WHOLE_RANGE = /^\d+(?:-\d+)?$/
const LINE_NUMBER = /^\d+$/
/** A backtick ends the fence a suggested command is wrapped in, and a line break splits the hint, so a value holding either gets no suggestion at all rather than a mangled one. */
const FENCE_BREAKER = /[`\r\n]/

/** Splits `--flag=value` into its name and value; a token with no `=` has no inline value. */
function splitFlag(token: string): { name: string; value: string | undefined } {
  const eq = token.startsWith('--') ? token.indexOf('=') : -1
  return eq === -1 ? { name: token, value: undefined } : { name: token.slice(0, eq), value: token.slice(eq + 1) }
}

/** Whether a spec already says where in the file to read (`f::symbol`, `f@A-B`, `f:A-B`), so a line-range flag has nothing to add and the two would contradict. */
function specNamesAPlace(spec: string): boolean {
  return spec.includes('::') || spec.includes('@') || parseLineRange(spec) !== null || /:\d+(?:-\d+)?$/.test(spec)
}

/** `read <file> --lines A-B` (or `--start A --end B`) run as `read "<file>@A-B"`, or null when this is some other invocation. Requires exactly one positional spec that names no place yet, each flag given once with a line number or range for its value, and a complete range; anything else is left for commander's own error, since a rewrite built on a guess about what was meant is worse than the plain failure. Returns the whole argv to parse and the one-line note to print. */
export function rewriteLineRangeFlag(argv: readonly string[]): { argv: string[]; note: string; flags: string[] } | null {
  const commandAt = argv.findIndex((arg, i) => i >= 2 && !arg.startsWith('-'))
  if (commandAt === -1 || argv[commandAt] !== 'read') return null
  const rest = argv.slice(commandAt + 1)
  if (rest.includes('--')) return null

  const kept: string[] = []
  const given: { whole?: string; start?: string; end?: string } = {}
  const flags: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const { name, value } = splitFlag(rest[i]!)
    const kind = (['whole', 'start', 'end'] as const).find((k) => (LINE_RANGE_FLAGS[k] as readonly string[]).includes(name))
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
  const range = given.whole !== undefined ? (given.start === undefined && given.end === undefined ? given.whole : null) : given.start !== undefined && given.end !== undefined ? `${given.start}-${given.end}` : null
  const positional = kept.filter((arg) => !arg.startsWith('-'))
  if (range === null || positional.length !== 1 || specNamesAPlace(positional[0]!)) return null

  const spec = `${positional[0]!}@${range}`
  const rewritten = [...argv.slice(0, commandAt + 1), ...kept.map((arg) => (arg === positional[0] ? spec : arg))]
  return { argv: rewritten, flags, note: `Note: ran as ${fencedCommand(`read ${quotedArg(spec)}`)} (${flags.join(' and ')} ${flags.length === 1 ? 'is' : 'are'} not ${flags.length === 1 ? 'an option' : 'options'}; a line range goes in the spec as @A-B).` }
}

/** The guessed spellings in argv that a rename covers for its command, for the stat that records which guesses recur. Static flag names only, never a value. */
export function renamedFlagsIn(argv: readonly string[]): string[] {
  const command = attemptedCommandName(argv)
  if (command === null) return []
  const renames = FLAG_RENAMES.filter((r) => r.commands.includes(command))
  return argv.slice(2).map((token) => splitFlag(token).name).filter((name) => renames.some((r) => r.aliases.includes(name)))
}

/** The corrected command for a guessed flag that commander rejected, or null when no rename covers it. Replaces each alias in argv with the real flag and quotes every value the way the other suggestions do; flags and plain numbers are written bare. */
export function suggestForUnknownOption(argv: readonly string[]): string | null {
  const command = attemptedCommandName(argv)
  if (command === null) return null
  const renames = FLAG_RENAMES.filter((r) => r.commands.includes(command))
  if (renames.length === 0) return null
  if (argv.slice(2).some((token) => FENCE_BREAKER.test(token))) return null
  let changed = false
  let commandSeen = false
  const words = argv.slice(2).map((token) => {
    if (!token.startsWith('-')) {
      if (token === command && !commandSeen) {
        commandSeen = true
        return token
      }
      return LINE_NUMBER.test(token) ? token : quotedArg(token)
    }
    const { name, value } = splitFlag(token)
    const rename = renames.find((r) => r.aliases.includes(name))
    if (rename === undefined) return token
    changed = true
    return value === undefined ? rename.target : `${rename.target}=${value}`
  })
  return changed ? `Did you mean: ${fencedCommand(`token-goat ${words.join(' ')}`)}?` : null
}
