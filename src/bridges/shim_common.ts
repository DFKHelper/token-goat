/**
 * Text fragments shared by the generated harness hook shims.
 *
 * Four bridges ship a Node shim that does the same three things before any
 * harness-specific translation: require the same modules, reject an event name
 * outside the closed `HOOK_EVENTS` set, and reach `token-goat hook <event>`
 * through the same three-step ladder (in-process hook lib, then the baked entry
 * via `process.execPath`, then a PATH-based `shell: true` call). Those parts
 * were byte-identical copies in {@link ../claudecode.ts}, {@link ../codex.ts},
 * {@link ../grok.ts} and {@link ../kimi.ts}, so a fix to the spawn ladder or the
 * event allowlist had to be applied four times or silently diverge. They live
 * here once and are interpolated into each shim template.
 *
 * What is deliberately NOT here: everything downstream of `stdout`. Each
 * harness has its own response contract and its own fail-open shape (`{}` for
 * Claude Code and Codex, `{"decision":"allow"}` for Grok on `pre_tool_use`,
 * empty stdout for Kimi), and forcing those through one template would be worse
 * than the duplication it removed. Grok also keeps its own `VALID_HOOK_EVENTS`:
 * it genuinely has no `session_start` event.
 *
 * These are fragments of generated JavaScript, not TypeScript. They must stay
 * free of backticks and `${` so they interpolate verbatim.
 */

/** The three `require`s every shim opens with. */
export const SHIM_REQUIRES = `const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')`

/** The closed hook-event allowlist, kept in sync with `HOOK_EVENTS` in ../types.ts. */
export const SHIM_VALID_HOOK_EVENTS = `// Keep in sync with HOOK_EVENTS in src/types.ts. eventName is validated against this closed
// set before being concatenated into a shell command string, so a hostile argv (e.g.
// 'pre_tool_use & calc.exe') can never reach the shell parser.
const VALID_HOOK_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'post_compact',
  'user_prompt_submit',
  'subagent_stop',
  'session_start',
  'post_tool_use_failure',
])`

/** `tryInProcess()`: the in-process `dist/token-goat-hook.mjs` fast path. */
export const SHIM_TRY_IN_PROCESS = `// Attempts the in-process hook call: import()s dist/token-goat-hook.mjs (a sibling of
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
}`

/** The `spawnSync` fallback ladder, indented for use inside `main()`'s `if (stdout === undefined)`. */
export const SHIM_SPAWN_LADDER = `    const res = entryPath
      ? spawnSync(process.execPath, [entryPath, 'hook', eventName], {
          input,
          encoding: 'utf8',
          timeout: 3000,
          killSignal: 'SIGKILL',
        })`
