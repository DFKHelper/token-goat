/**
 * Codex CLI bridge.
 *
 * Codex fires hooks from `config.toml` much like Claude Code, but its output
 * schemas are stricter: every schema declares `additionalProperties: false`,
 * and every `hookSpecificOutput` shape requires a typed `hookEventName` const.
 * The shim therefore post-processes `token-goat hook` output before relaying
 * it: it drops internal `_tg_*` keys (which would trip `additionalProperties`)
 * and injects `hookEventName` into `hookSpecificOutput` when absent.
 *
 * Wire-format references: Codex 0.137.0+ expects `hookSpecificOutput.hookEventName`
 * in Claude Code's PascalCase spelling (e.g. `PreToolUse`, not the raw `pre_tool_use`
 * argv event name) -- matching CLAUDE_CODE_EVENT_NAMES in src/hook_registry.ts, the
 * convention the live/wired `token-goat hook <event>` path already emits.
 */


/**
 * Node source for the Codex hook shim.
 *
 * Behavior matches the Claude Code shim (validate `eventName` against the closed set of known
 * hook events, then stdin → `token-goat hook <event>` → stdout) with two Codex-specific
 * fixups applied to the child's JSON output:
 * 1. strip top-level and nested `_tg_*` keys (additionalProperties: false), and
 * 2. ensure `hookSpecificOutput.hookEventName` is set, defaulting to the
 *    PascalCase-mapped event name (HOOK_EVENT_NAME_MAP below, kept in sync with
 *    CLAUDE_CODE_EVENT_NAMES in src/hook_registry.ts) when the handler omitted it --
 *    never the raw snake_case argv event name.
 *
 * `eventName` is concatenated into a shell command string below (`shell: true` is required
 * on Windows to resolve the token-goat `.cmd`/`.bat` shim), so it is validated against
 * `VALID_HOOK_EVENTS` first — a closed set that must be kept in sync with `HOOK_EVENTS` in
 * src/types.ts.
 *
 * On any error the shim prints `{}` so the tool call proceeds unchanged.
 */
export const CODEX_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Codex hook shim. Forwards the hook payload to \`token-goat hook <event>\`, then strips _tg_* keys and injects hookEventName so the response satisfies Codex's strict (additionalProperties:false) schema.
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
  'user_prompt_submit',
  'subagent_stop',
])

// Keep in sync with CLAUDE_CODE_EVENT_NAMES in src/hook_registry.ts -- the
// live/wired 'token-goat hook <event>' path (src/relay.ts) always emits this
// PascalCase spelling for hookSpecificOutput.hookEventName, never the raw
// snake_case event name.
const HOOK_EVENT_NAME_MAP = {
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  notification: 'Notification',
  stop: 'Stop',
  pre_compact: 'PreCompact',
  user_prompt_submit: 'UserPromptSubmit',
  subagent_stop: 'SubagentStop',
}

function stripTg(value) {
  if (Array.isArray(value)) return value.map(stripTg)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_tg_')) continue
      out[k] = stripTg(v)
    }
    return out
  }
  return value
}

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
  // process.argv[3], when present, is the absolute path to the token-goat CLI entry
  // that ran 'token-goat install --codex' (baked in by hookCommandFor in
  // codex_install.ts). Invoking it directly via process.execPath sidesteps PATH/shell
  // resolution for this inner call, the same single-point-of-failure class fixed for
  // the Copilot CLI bridge's inner hook call (a bare 'token-goat' on PATH failing to
  // resolve crashes this call, and Codex -- like Copilot -- fails closed on a
  // non-zero-exit hook). Falls back to the old PATH-based shell:true invocation when
  // argv[3] is absent (an older cached hook config).
  const entryPath = process.argv[3]
  const res = entryPath
    ? spawnSync(process.execPath, [entryPath, 'hook', eventName], {
        input,
        encoding: 'utf8',
      })
    : spawnSync('token-goat hook ' + eventName, {
        input,
        encoding: 'utf8',
        shell: true,
      })
  if (res.status !== 0 || !res.stdout) {
    process.stdout.write('{}')
    return
  }
  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    process.stdout.write('{}')
    return
  }
  parsed = stripTg(parsed)
  const hso = parsed && parsed.hookSpecificOutput
  if (hso && typeof hso === 'object' && !hso.hookEventName) {
    hso.hookEventName = HOOK_EVENT_NAME_MAP[eventName] || eventName
  }
  process.stdout.write(JSON.stringify(parsed))
}

main()
`

