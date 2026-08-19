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
import { SHIM_REQUIRES, SHIM_SPAWN_LADDER, SHIM_TRY_IN_PROCESS, SHIM_VALID_HOOK_EVENTS } from './shim_common.js'

export const CLAUDECODE_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Claude Code hook shim. Reads the hook payload on stdin, forwards it to \`token-goat hook <event>\`, and relays the response on stdout.
'use strict'
// Cache V8's compiled bytecode for the 3.4 MB hook bundle this shim import()s below. Without it
// every hook invocation recompiles that bundle from source, which profiled at ~40ms of the ~148ms
// a single hook takes -- and a hook fires on every tool call. Worth ~23ms per invocation, measured
// twice on the installed shim by interleaving both variants: 148ms to 125ms, and later 186ms to
// 163ms on a busier machine. The floor moves with load; the 23ms it removes does not.
//
// It has to be here rather than inside the bundle: a module is compiled before any of its own code
// runs, so a bundle cannot enable the cache for itself. This shim is small enough to compile in
// well under a millisecond, and the dynamic import() happens after this line, so the bundle is
// compiled with the cache already active. Same reason the MCP SDK could not be deferred from
// inside mcp_server.ts -- what a module can affect starts after it is already compiled.
//
// enableCompileCache landed in Node 22.1 and package.json allows >=22.0.0, so a miss is possible;
// it is also best-effort by nature (read-only cache dir, full disk). Swallow everything: this shim
// must never fail a tool call to save itself 23ms.
try { require('node:module').enableCompileCache() } catch { /* older Node, or an unwritable cache dir: run uncached */ }
${SHIM_REQUIRES}

${SHIM_VALID_HOOK_EVENTS}

${SHIM_TRY_IN_PROCESS}

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
${SHIM_SPAWN_LADDER}
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
