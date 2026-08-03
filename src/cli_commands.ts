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
