/**
 * Claude Code bridge.
 *
 * Claude Code fires hooks by running a command from `settings.json` for each
 * event; that command receives the hook payload as JSON on stdin and must emit
 * the response JSON on stdout. token-goat's installer normally wires this to
 * the `token-goat hook <event>` subcommand directly. {@link CLAUDECODE_HOOK_SCRIPT}
 * is the standalone Node shim form of that wiring — a small script that reads
 * stdin, shells out to `token-goat hook <event>`, and relays the result.
 *
 * The wire format matters: Claude Code reads exactly what the shim prints to
 * stdout, so the shim must pass the child's stdout through verbatim and emit
 * `{}` (a no-op) on any failure rather than crashing the hook.
 */


/**
 * Node source for the Claude Code hook shim.
 *
 * Behavior:
 * 1. Read the full hook payload from stdin (JSON).
 * 2. Spawn `token-goat hook <eventName>`, feeding it that payload on stdin.
 * 3. Print the child's stdout verbatim to this process's stdout.
 * 4. On any error (spawn failure, non-JSON, missing binary) print `{}` so the
 *    tool call proceeds unchanged instead of the hook hard-failing.
 *
 * `eventName` is taken from `process.argv[2]`, mirroring how the installed
 * settings.json command appends the event name as the last argument.
 */
export const CLAUDECODE_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Claude Code hook shim. Reads the hook payload on stdin, forwards it to \`token-goat hook <event>\`, and relays the response on stdout.
'use strict'
const { spawnSync } = require('node:child_process')

function main() {
  const eventName = process.argv[2] || ''
  let input = ''
  try {
    input = require('node:fs').readFileSync(0, 'utf8')
  } catch {
    process.stdout.write('{}')
    return
  }
  const res = spawnSync('token-goat', ['hook', eventName], {
    input,
    encoding: 'utf8',
  })
  if (res.status !== 0 || !res.stdout) {
    process.stdout.write('{}')
    return
  }
  process.stdout.write(res.stdout)
}

main()
`
