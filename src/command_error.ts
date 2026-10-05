/** The one stderr rendering of a command failure (`token-goat: <message>`) and the error class command handlers throw to reach it. A leaf importing only paths.ts and util.ts, so a command module the CLI entry imports (or a hook path reaches) can print an error in the same shape without importing cli.ts back. */

import { displaySafeJson, displaySafeText } from './paths.js'
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

/** commander's own parse failures ("error: unknown option '--x'", "error: missing required argument 'spec'", then any "(Did you mean ...?)" line) in the same rendering: its `error:` label gives way to the `token-goat:` one. Takes and returns commander's newline-terminated string. */
export function formatParseError(str: string): string {
  const lines = (str.endsWith('\n') ? str.slice(0, -1) : str).split('\n')
  if (lines[0]!.startsWith('error: ')) lines[0] = lines[0]!.slice('error: '.length)
  return formatCommandError(new CliError(lines)) + '\n'
}

/** The stderr rendering of a `{ text, code }` handler's non-zero result: the same `token-goat:` first line a thrown error gets, each line escaped on its own. A JSON body is a `--json` caller's machine-readable answer and passes through untouched, so it still parses. */
export function formatFailedResultText(text: string): string {
  const head = text.trimStart()[0]
  if (head === '{' || head === '[') {
    try {
      JSON.parse(text)
      return text
    } catch {
      // Not JSON after all: an error message that happens to open with a bracket.
    }
  }
  return formatCommandError(new CliError(text.split('\n')))
}

/** A report command's failure, written where its caller looks: with `--json` the `body` goes to stdout, so the caller still gets a document that parses, and otherwise `message` is the one `token-goat:` error on stderr, never a report header on stdout. Sets exit code 1 either way. */
export function writeCommandFailure(json: boolean, body: Record<string, unknown>, message: string | readonly string[]): void {
  if (json) process.stdout.write(`${displaySafeJson(body, 0)}\n`)
  else process.stderr.write(formatCommandError(new CliError(message)) + '\n')
  process.exitCode = 1
}
