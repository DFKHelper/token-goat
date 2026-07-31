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
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Keep in sync with HOOK_EVENTS in src/types.ts. eventName is validated against this closed
// set before being concatenated into a shell command string, so a hostile argv (e.g.
// 'pre_tool_use & calc.exe') can never reach the shell parser.
const VALID_HOOK_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'user_prompt_submit',
  'subagent_stop',
  'session_start',
])

// Attempts the in-process hook call: import()s dist/token-goat-hook.mjs (a sibling of
// the baked token-goat entry path, built with zero load-time side effects -- unlike
// the CLI entry, which runs the full argv-parsing CLI as a side effect of being
// loaded) and calls its exported relayInProcess() directly, avoiding a second node
// process spawn entirely. Returns undefined (triggering the spawnSync fallback below)
// when entryPath is absent, the sibling file doesn't exist (an older install predating
// this file), or anything else goes wrong -- this must never throw.
async function tryInProcess(entryPath, eventName, input) {
  if (!entryPath) return undefined
  try {
    const hookLibPath = path.join(path.dirname(entryPath), 'token-goat-hook.mjs')
    if (!require('node:fs').existsSync(hookLibPath)) return undefined
    const mod = await import(pathToFileURL(hookLibPath).href)
    const payload = JSON.parse(input)
    return await mod.relayInProcess(eventName, payload)
  } catch {
    return undefined
  }
}

async function main() {
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
  // process.argv[3], when present, is the absolute path to the running token-goat CLI
  // entry (mirrors the same argv[3]-baked-entry convention used by the Codex/Copilot
  // CLI shims). Try the in-process hook lib first (tryInProcess above), which avoids
  // spawning a second node process altogether; fall back to the entry path directly via
  // process.execPath, then finally to the old PATH-based shell:true invocation (an
  // older cached hook config with no argv[3], or a config wired directly to
  // \`token-goat hook <event>\` rather than through this shim). A 3000ms
  // timeout/killSignal on both spawnSync fallbacks means token-goat degrades to its own
  // fail-open '{}' rather than being force-killed by Claude Code's own hook timeout.
  const entryPath = process.argv[3]
  let stdout = await tryInProcess(entryPath, eventName, input)
  if (stdout === undefined) {
    const res = entryPath
      ? spawnSync(process.execPath, [entryPath, 'hook', eventName], {
          input,
          encoding: 'utf8',
          timeout: 3000,
          killSignal: 'SIGKILL',
        })
      : spawnSync('token-goat hook ' + eventName, {
          input,
          encoding: 'utf8',
          shell: true,
          timeout: 3000,
          killSignal: 'SIGKILL',
        })
    if (res.status !== 0 || !res.stdout) {
      process.stdout.write('{}')
      return
    }
    stdout = res.stdout
  }
  process.stdout.write(stdout)
}

main().catch(() => {
  process.stdout.write('{}')
})
`
