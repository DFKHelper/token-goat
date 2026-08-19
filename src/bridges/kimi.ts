/**
 * Kimi Code CLI bridge (MoonshotAI/kimi-code).
 *
 * Kimi Code fires hooks the same way Claude Code does: a `command` string from
 * its config file is spawned per event, the payload arrives as JSON on stdin
 * with snake_case field names (`hook_event_name`, `session_id`, `cwd`,
 * `tool_name`, `tool_input`), and the script answers on stdout. Verified
 * against MoonshotAI/kimi-code's own source and docs, not guessed:
 *
 * - Payload keys and the camelCase->snake_case conversion:
 *   `packages/agent-core-v2/src/app/externalHooksRunner/runner.ts`
 *   (`toHookInputData` / `camelToSnake`, and the `hookEventName`/`sessionId`/
 *   `cwd` base fields), plus `docs/en/customization/hooks.md`'s "Event Data
 *   Format" section.
 * - `tool_name` / `tool_input` for `PreToolUse`/`PostToolUse`:
 *   `packages/agent-core-v2/src/agent/externalHooks/externalHooksService.ts`
 *   (`runPreToolUse`, `notifyPostToolUse`).
 *
 * The response contract is where Kimi diverges from Claude Code, and it is the
 * reason this bridge needs a translating shim rather than wiring `token-goat
 * hook <event>` straight into the config the way the Qwen Code bridge does.
 * Kimi's stdout parser is `structuredOutput()` in
 * `packages/agent-core-v2/src/agent/externalHooks/runner.ts`, whose schema
 * (`HookJsonOutputSchema`) reads exactly three fields: top-level `message`,
 * `hookSpecificOutput.message`, and `hookSpecificOutput.permissionDecision` /
 * `permissionDecisionReason`. So:
 *
 * - token-goat's deny shape, `{"decision":"block","reason":"..."}`
 *   (`serializeOutput` in ../hook_registry.ts), means nothing to Kimi: it
 *   would be parsed, found to have no `permissionDecision`, and allowed. The
 *   shim rewrites it to `hookSpecificOutput.permissionDecision = "deny"` with
 *   `permissionDecisionReason`, which `resultFromExitCode` turns into a real
 *   block on exit 0.
 * - token-goat's hint shapes, `hookSpecificOutput.additionalContext` and the
 *   top-level `systemMessage`, are both ignored by Kimi's schema. The shim
 *   maps either one onto the top-level `message` field Kimi does read.
 * - A no-op `{}` is written as *empty* stdout, not as the literal `{}`. On
 *   `UserPromptSubmit`, Kimi falls back to raw stdout when a structured
 *   response carries no message (`userPromptHookMessage` in
 *   `packages/agent-core-v2/src/agent/externalHooks/user-prompt.ts`), so
 *   printing `{}` would inject the two characters `{}` into the model's
 *   context on every prompt.
 *
 * Not translated, because Kimi has no equivalent: token-goat's `rewriteInput`
 * (`updatedInput`) and `rewriteOutput` (`updatedToolOutput`). `runPreToolUse`
 * returns only a block reason and `notifyPostToolUse` is fire-and-forget, so
 * Kimi offers no channel to replace a tool's input or its result. Those
 * responses degrade to a no-op here rather than being faked.
 */

/**
 * Node source for the Kimi Code hook shim.
 *
 * Behavior mirrors the Codex shim (validate `eventName` against the closed set
 * of known hook events, read stdin, call the in-process hook lib or fall back
 * to spawning `token-goat hook <event>`), with two Kimi-specific differences:
 *
 * 1. It sets `TOKEN_GOAT_HARNESS_OVERRIDE=kimi` before dispatching. Kimi Code
 *    publishes no ambient per-session environment variable that
 *    `detectHarness()` (../bridges/registry.ts) could key off: its documented
 *    variables (`KIMI_CODE_HOME`, `KIMI_DISABLE_TELEMETRY`, the `KIMI_MODEL_*`
 *    family, and the provider credential names) are all user-set inputs, not
 *    signals the CLI exports into every hook subprocess. Same workaround the
 *    Copilot CLI and pi bridges use for the same reason.
 * 2. It rewrites the response into Kimi's own wire contract (see this module's
 *    docstring) instead of relaying it verbatim.
 *
 * `eventName` is validated against `VALID_HOOK_EVENTS` before it is ever
 * concatenated into a shell command string, so a hostile argv cannot reach the
 * shell parser. On any error the shim writes nothing and exits 0, which Kimi
 * treats as "allow" (its fail-open design, `docs/en/customization/hooks.md`).
 */
export const KIMI_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Kimi Code hook shim. Forwards the hook payload to \`token-goat hook <event>\`, then rewrites the response into Kimi's own contract: permissionDecision "deny" for a block, top-level "message" for a hint, empty stdout for a no-op.
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

// Kimi Code publishes no ambient per-session env var identifying its own hook
// subprocesses, so the harness identity has to be injected here for
// detectHarness() (src/bridges/registry.ts) to resolve 'kimi'.
process.env.TOKEN_GOAT_HARNESS_OVERRIDE = 'kimi'

// Pull the hint text out of a token-goat response: hookSpecificOutput.additionalContext
// (most events) or the top-level systemMessage (notification/pre_compact, which Claude
// Code rejects additionalContext on). Kimi reads neither, so both fold into its 'message'.
function hintText(parsed) {
  if (!parsed || typeof parsed !== 'object') return ''
  const hso = parsed.hookSpecificOutput
  if (hso && typeof hso === 'object' && typeof hso.additionalContext === 'string') return hso.additionalContext
  if (typeof parsed.systemMessage === 'string') return parsed.systemMessage
  return ''
}

// Translate a token-goat (Claude Code shaped) response into Kimi's contract.
// Returns '' for anything Kimi cannot act on, which the caller writes as empty
// stdout rather than '{}' -- see this module's docstring for why that matters
// on UserPromptSubmit.
function toKimi(parsed) {
  if (!parsed || typeof parsed !== 'object') return ''
  if (parsed.decision === 'block' && typeof parsed.reason === 'string' && parsed.reason) {
    return JSON.stringify({
      message: parsed.reason,
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: parsed.reason },
    })
  }
  const hint = hintText(parsed)
  if (hint) return JSON.stringify({ message: hint })
  return ''
}

// Attempts the in-process hook call: import()s dist/token-goat-hook.mjs (a sibling of
// the baked token-goat entry path, built with zero load-time side effects) and calls its
// exported relayInProcess() directly, avoiding a second node process spawn entirely.
// Returns undefined (triggering the spawnSync fallback below) when entryPath is absent,
// the sibling file doesn't exist, or anything else goes wrong -- this must never throw.
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
  if (!VALID_HOOK_EVENTS.has(eventName)) return
  let input = ''
  try {
    input = require('node:fs').readFileSync(0, 'utf8')
  } catch {
    return
  }
  // process.argv[3], when present, is the absolute path to the token-goat CLI entry that ran
  // 'token-goat install --kimi' (baked in by hookCommandFor in kimi_install.ts). Same three-step
  // ladder as the Codex shim: in-process hook lib, then the baked entry via process.execPath,
  // then a PATH-based shell:true invocation for an older cached hook config. The 3000ms
  // timeout keeps both spawn fallbacks well inside Kimi's own 30s default hook timeout
  // (docs/en/customization/hooks.md), so token-goat degrades to its own fail-open no-op.
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
    if (res.status !== 0 || !res.stdout) return
    stdout = res.stdout
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return
  }
  const out = toKimi(parsed)
  if (out) process.stdout.write(out)
}

main().catch(() => {
  // Fail open: write nothing, exit 0. Kimi treats a silent hook as "allow".
})
`
