/**
 * Single source of truth for "which commands does the CLI register?", shared by
 * the fast pre-commit registration guard and the pre-push built-bundle command
 * matrix. Both derive their command set from this helper, so a newly registered
 * command is automatically in scope for both layers — there is no second list to
 * forget to update.
 */

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, flattenCommandNames, type CommandManifestEntry } from '../src/cli_commands.js'
import { pinnedPopulation } from './guards/population.js'

/**
 * Every registered command name, including `parent sub` entries for subcommands
 * (e.g. `worker start`). Excludes Commander's built-in `help` command.
 *
 * The population is pinned here rather than in each caller. Every guard that sweeps "all commands"
 * inherits the same failure mode: if `buildProgram()` ever returns a program with no commands
 * registered -- a lazy-registration refactor, a moved `.command()` call, a manifest walker that
 * stops descending -- the sweep iterates nothing and reports a clean bill of health. Pinning at the
 * source means a caller cannot opt out of the check by forgetting it.
 */
export function allCommandNames(): string[] {
  return [
    ...pinnedPopulation({
      what: 'CLI commands registered by buildProgram()',
      items: flattenCommandNames(buildCommandManifest(buildProgram())),
      floor: 120,
      // Three shapes, so a walker that handles one but not the others is caught: a plain top-level
      // command, a subcommand rendered as `parent sub`, and a hyphenated name.
      mustInclude: ['symbol', 'worker start', 'bash-output'],
    }),
  ]
}

/**
 * Options that cap how many *rows* a command returns. Deliberately not every numeric option: a
 * `--depth`, `--budget` or `--max-bytes` shapes the work rather than clipping a finished list, and
 * demanding a row count from one would be asking for a number that does not exist.
 *
 * `--tail` is included with the rest. It selects the last N of a list instead of the first N, but
 * a reader who is shown 2 of 14 lines is exactly as misled either way.
 */
const ROW_LIMIT_FLAGS: readonly string[] = ['--limit', '--top', '--head', '--tail']

export interface RowLimitedCommand {
  /** Full command name, `parent sub` for subcommands. */
  readonly name: string
  /** The row-limiting flags this command accepts, e.g. `['--limit']`. */
  readonly flags: readonly string[]
  /** Whether it also accepts `--json`, which is the surface the invariant is checked on. */
  readonly json: boolean
}

/**
 * Every registered command that can return fewer rows than it found, derived from the shipping
 * program rather than from a checked-in list. A new `--limit` command enters this set on the day
 * it is registered, which is the property that keeps the truncation guard from decaying into a
 * whitelist of whatever was true when it was written -- this repo has shipped that decay twice
 * (`stats --json`'s payload, the Copilot canonical builder), both times as silently dead coverage.
 */
export function commandsWithRowLimit(): RowLimitedCommand[] {
  const out: RowLimitedCommand[] = []
  const walk = (entries: readonly CommandManifestEntry[], prefix: string): void => {
    for (const entry of entries) {
      const name = prefix === '' ? entry.name : `${prefix} ${entry.name}`
      const longFlags = entry.options.flatMap((o) => o.flags.split(/[ ,|]+/).filter((f) => f.startsWith('--')))
      const flags = ROW_LIMIT_FLAGS.filter((f) => longFlags.includes(f))
      if (flags.length > 0) out.push({ name, flags, json: longFlags.includes('--json') })
      walk(entry.subcommands, name)
    }
  }
  walk(buildCommandManifest(buildProgram()), '')
  return [
    ...pinnedPopulation({
      what: 'CLI commands accepting a row-limiting flag',
      items: out.map((c) => c.name),
      floor: 25,
      mustInclude: ['symbol', 'find', 'similar'],
    }),
  ].map((name) => out.find((c) => c.name === name) as RowLimitedCommand)
}
