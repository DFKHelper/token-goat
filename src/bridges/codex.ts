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
 * Wire-format references: Codex 0.137.0+ uses camelCase throughout
 * `hookSpecificOutput` (no snake_case translation needed).
 */

import type { BridgeConfig } from './types.js'

/**
 * Node source for the Codex hook shim.
 *
 * Behavior matches the Claude Code shim (stdin → `token-goat hook <event>` →
 * stdout) with two Codex-specific fixups applied to the child's JSON output:
 * 1. strip top-level and nested `_tg_*` keys (additionalProperties: false), and
 * 2. ensure `hookSpecificOutput.hookEventName` is set, defaulting to the
 *    event name passed in argv when the handler omitted it.
 *
 * On any error the shim prints `{}` so the tool call proceeds unchanged.
 */
export const CODEX_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Codex hook shim. Forwards the hook payload to
// \`token-goat hook <event>\`, then strips _tg_* keys and injects hookEventName
// so the response satisfies Codex's strict (additionalProperties:false) schema.
'use strict'
const { spawnSync } = require('node:child_process')

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
    hso.hookEventName = eventName
  }
  process.stdout.write(JSON.stringify(parsed))
}

main()
`

/**
 * Return the Codex bridge config.
 *
 * `hookSpecificOutput` is `true`: Codex requires `hookEventName` in every
 * `hookSpecificOutput` payload.
 */
export function getCodexHookConfig(): BridgeConfig {
  return {
    harness: 'codex',
    hookScriptPath: '.codex/token-goat-hook.cjs',
    hookSpecificOutput: true,
  }
}
