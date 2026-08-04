/**
 * Machine-readable command manifest.
 *
 * `buildCommandManifest` walks a built Commander `Command` tree (from
 * `buildProgram()` in cli.ts) into a plain-object shape safe for
 * `JSON.stringify` -- the same tree-walk `tests/registry.ts::allCommandNames`
 * used to hand-roll for its own narrower "just the names" need, now shared so
 * there is exactly one place that knows how to enumerate the program's
 * commands/subcommands/options/arguments. `token-goat commands --json`
 * exposes this same manifest to users and external tooling (shell
 * completion, doc generators, other scripts) instead of leaving Commander
 * introspection as a test-only capability.
 */

import type { Command } from 'commander'

export interface CommandManifestOption {
  readonly flags: string
  readonly description: string
}

export interface CommandManifestArgument {
  readonly name: string
  readonly description: string
  readonly required: boolean
}

export interface CommandManifestEntry {
  readonly name: string
  readonly description: string
  readonly aliases: readonly string[]
  readonly options: readonly CommandManifestOption[]
  readonly arguments: readonly CommandManifestArgument[]
  readonly subcommands: readonly CommandManifestEntry[]
}

function toEntry(cmd: Command): CommandManifestEntry {
  return {
    name: cmd.name(),
    description: cmd.description(),
    aliases: cmd.aliases(),
    options: cmd.options.map((o) => ({ flags: o.flags, description: o.description })),
    arguments: cmd.registeredArguments.map((a) => ({ name: a.name(), description: a.description, required: a.required })),
    subcommands: cmd.commands.filter((sub) => sub.name() !== 'help').map(toEntry),
  }
}

/** Top-level commands (with their subcommands nested), excluding Commander's built-in `help` command. */
export function buildCommandManifest(program: Command): CommandManifestEntry[] {
  return program.commands.filter((cmd) => cmd.name() !== 'help').map(toEntry)
}

/** Flatten a manifest into `allCommandNames()`'s flat shape: top-level names plus `parent sub` entries. */
export function flattenCommandNames(manifest: readonly CommandManifestEntry[]): string[] {
  const names: string[] = []
  for (const entry of manifest) {
    names.push(entry.name)
    for (const sub of entry.subcommands) {
      names.push(`${entry.name} ${sub.name}`)
    }
  }
  return names
}

/** True if `entry`'s name, description, or aliases match `pattern` (regex, falling back to a literal substring match on invalid regex -- same convention as `--grep` on `bash-output`/`web-output`/`read`/`section`). */
function entryMatches(entry: CommandManifestEntry, re: RegExp | null, pattern: string): boolean {
  const haystacks = [entry.name, entry.description, ...entry.aliases]
  return haystacks.some((h) => (re !== null ? re.test(h) : h.includes(pattern)))
}

/**
 * Filter a manifest by `pattern`, matched against each entry's name, description, and aliases.
 * A parent that matches directly is kept whole (all of its subcommands included, since the agent
 * asked for that command and its children are part of it). A parent that doesn't match directly
 * but has a matching child is kept with only the matching subcommand(s), so the result stays
 * narrow. Entries with no match anywhere in their own fields or their subcommands' fields are
 * dropped.
 */
export function filterCommandManifest(manifest: readonly CommandManifestEntry[], pattern: string): CommandManifestEntry[] {
  let re: RegExp | null
  try {
    re = new RegExp(pattern)
  } catch {
    re = null
  }
  const result: CommandManifestEntry[] = []
  for (const entry of manifest) {
    if (entryMatches(entry, re, pattern)) {
      result.push(entry)
      continue
    }
    const matchingSubs = entry.subcommands.filter((sub) => entryMatches(sub, re, pattern))
    if (matchingSubs.length > 0) {
      result.push({ ...entry, subcommands: matchingSubs })
    }
  }
  return result
}

/** Render the manifest as a human-readable text listing (default `token-goat commands` output). */
export function formatCommandManifest(manifest: readonly CommandManifestEntry[]): string {
  const lines: string[] = []
  lines.push('# token-goat commands')
  lines.push('')
  for (const entry of manifest) {
    lines.push(`## ${entry.name}${entry.aliases.length ? ' (alias: ' + entry.aliases.join(', ') + ')' : ''}${entry.description ? ' -- ' + entry.description : ''}`)
    for (const arg of entry.arguments) {
      lines.push(`  arg: ${arg.name}${arg.required ? '' : ' (optional)'}${arg.description ? ' -- ' + arg.description : ''}`)
    }
    for (const opt of entry.options) {
      lines.push(`  ${opt.flags}${opt.description ? ' -- ' + opt.description : ''}`)
    }
    for (const sub of entry.subcommands) {
      lines.push(`  ${entry.name} ${sub.name}${sub.description ? ' -- ' + sub.description : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
