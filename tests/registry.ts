/**
 * Single source of truth for "which commands does the CLI register?", shared by
 * the fast pre-commit registration guard and the pre-push built-bundle command
 * matrix. Both derive their command set from this helper, so a newly registered
 * command is automatically in scope for both layers — there is no second list to
 * forget to update.
 */

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, flattenCommandNames } from '../src/cli_commands.js'

/**
 * Every registered command name, including `parent sub` entries for subcommands
 * (e.g. `worker start`). Excludes Commander's built-in `help` command.
 */
export function allCommandNames(): string[] {
  return flattenCommandNames(buildCommandManifest(buildProgram()))
}
