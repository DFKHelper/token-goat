/** Failures for a file no command could open, each followed by a Did-you-mean list of the existing paths it may have been meant to name (path_suggest.ts). */

import * as path from 'node:path'

import { CliError, cliInvocation } from './command_error.js'
import { fileIsAbsent } from './fingerprint.js'
import { canQuoteArg, couldNotRead, echoedValue, quotedArg } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { suggestPaths } from './path_suggest.js'
import { resolveProjectRoot } from './project.js'
import { didYouMeanLines } from './read_suggest.js'

/** Existing paths `file` may have been meant to name, or none when the lookup itself fails: a suggestion that cannot be computed must not replace the error it decorates. None either when the path is there but could not be read (a directory, a denied file): that file is not a misspelling of anything. */
function nearPaths(file: string): string[] {
  try {
    if (!fileIsAbsent(path.resolve(file))) return []
    return suggestPaths(file, process.cwd(), resolveProjectRoot())
  } catch {
    return []
  }
}

/** An argument written without quotes when no shell would read it differently. */
const BARE_ARG = /^[\w./:@=+,%-]+$/

/** Most arguments of a command that is rewritten whole; a longer one is not worth repeating. */
const MAX_RETRY_ARGS = 12

/** The command the reader ran with `typed` swapped for `candidate`, as one line to paste, or null when the invocation cannot be recovered or a part of it cannot be quoted. `argv` is the process arguments after the entry script: the token that is `typed`, or `typed` followed by `::` and a selector, is the one replaced. */
export function retryCommand(typed: string, candidate: string, argv: readonly string[] = cliInvocation()): string | null {
  const at = argv.findIndex((arg) => arg === typed || arg.startsWith(`${typed}::`))
  if (at < 0 || argv.length > MAX_RETRY_ARGS) return null
  const swapped = argv.map((arg, i) => (i === at ? `${candidate}${arg.slice(typed.length)}` : arg))
  if (!swapped.every((arg) => displaySafeText(arg) === arg && canQuoteArg(arg))) return null
  return ['token-goat', ...swapped.map((arg, i) => (i !== at && BARE_ARG.test(arg) ? arg : quotedArg(arg)))].join(' ')
}

/** The `Did you mean:` lines for a file no command could open: the command that was run, repeated for each existing path the file may have been meant to name, or the quoted path itself where the invocation cannot be recovered. Nothing when none exists. */
export function nearPathLines(file: string): string[] {
  return didYouMeanLines(nearPaths(file).map((candidate) => retryCommand(file, candidate) ?? echoedValue(candidate)))
}

/** The failure for a file no command could open: `Could not read: "<path>"` (see {@link couldNotRead}), then the {@link nearPathLines}. The first line is unchanged, so a caller or test matching it still does. */
export function couldNotReadError(file: string): CliError {
  return new CliError([couldNotRead(file), ...nearPathLines(file)])
}

/** The same failure worded `File not found: "<path>"`, for the commands that have always said so. */
export function fileNotFoundError(file: string): CliError {
  return new CliError([`File not found: ${echoedValue(file)}`, ...nearPathLines(file)])
}
