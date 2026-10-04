/** The one stderr rendering of a command failure (`token-goat: <message>`) and the error class command handlers throw to reach it. A leaf importing only paths.ts and util.ts, so a command module the CLI entry imports (or a hook path reaches) can print an error in the same shape without importing cli.ts back. */

import { displaySafeText } from './paths.js'
import { extractErrorMessage } from './util.js'

/** Thrown by command handlers for a clean exit-1 with a stderr message. Pass an array for a message of several lines: the stderr printer escapes each line on its own, so the breaks token-goat put between them survive while a newline inside a file-derived part stays escaped. */
export class CliError extends Error {
  readonly lines: readonly string[] | undefined
  constructor(message: string | readonly string[]) {
    super(typeof message === 'string' ? message : message.join('\n'))
    this.lines = typeof message === 'string' ? undefined : message
  }
}

/** The stderr rendering of a command failure: one `token-goat:` line, then any further lines a CliError was built from. */
export function formatCommandError(e: unknown): string {
  if (e instanceof CliError && e.lines !== undefined) return 'token-goat: ' + e.lines.map(displaySafeText).join('\n')
  return 'token-goat: ' + displaySafeText(extractErrorMessage(e))
}
