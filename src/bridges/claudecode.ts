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
 * 1. Validate `eventName` (argv[2]) against the closed set of known hook events; if it
 *    doesn't match, print `{}` immediately without ever building a shell command from it.
 * 2. Read the full hook payload from stdin (JSON).
 * 3. Spawn `token-goat hook <eventName>`, feeding it that payload on stdin.
 * 4. Print the child's stdout verbatim to this process's stdout.
 * 5. On any error (spawn failure, non-JSON, missing binary) print `{}` so the
 *    tool call proceeds unchanged instead of the hook hard-failing.
 *
 * `eventName` is taken from `process.argv[2]`, mirroring how the installed
 * settings.json command appends the event name as the last argument. It is concatenated
 * into a shell command string below (`shell: true` is required on Windows to resolve the
 * token-goat `.cmd`/`.bat` shim), so it is validated against `VALID_HOOK_EVENTS` first — a
 * closed set that must be kept in sync with `HOOK_EVENTS` in src/types.ts.
 */
export const CLAUDECODE_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Claude Code hook shim. Reads the hook payload on stdin, forwards it to \`token-goat hook <event>\`, and relays the response on stdout.
'use strict'
const { spawnSync } = require('node:child_process')

// Keep in sync with HOOK_EVENTS in src/types.ts. eventName is validated against this closed
// set before being concatenated into a shell command string, so a hostile argv (e.g.
// 'pre_tool_use & calc.exe') can never reach the shell parser.
const VALID_HOOK_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'session_start',
  'user_prompt_submit',
  'subagent_stop',
])

function main() {
  const eventName = process.argv[2] || ''
  if (!VALID_HOOK_EVENTS.has(eventName)) {
    process.stdout.write('{}')
    return
  }
  let input = ''
  try {
    input = require('node:fs').readFileSync(0, 'utf8')
  } catch {
    process.stdout.write('{}')
    return
  }
  const res = spawnSync('token-goat hook ' + eventName, {
    input,
    encoding: 'utf8',
    shell: true,
  })
  if (res.status !== 0 || !res.stdout) {
    process.stdout.write('{}')
    return
  }
  process.stdout.write(res.stdout)
}

main()
`
