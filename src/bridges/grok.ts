/**
 * Grok CLI (xAI's "Grok Build") bridge.
 *
 * Grok Build fires hooks from JSON files under `~/.grok/hooks/*.json` (or a
 * project-scoped `<project>/.grok/hooks/*.json`, gated behind folder trust --
 * see `grok_install.ts`'s module doc comment for why this bridge only wires
 * the global scope). Verified against the real hooks doc shipped in the
 * xai-org/grok-build repo (`crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md`,
 * fetched 2026-07-18): event names are Claude Code's own PascalCase spellings
 * (`PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, `SubagentStop`,
 * ...), and a `matcher` field is a regex tested against the real tool name (an
 * empty/omitted matcher matches everything, same as Claude Code's own
 * `settings.json` -- see `HOOK_EVENT_MAP`/`matcher: ''` in `../install.ts`).
 *
 * Only `PreToolUse` is blocking. Its documented response shape is
 * `{"decision":"allow"}` / `{"decision":"deny","reason":"..."}` -- explicitly
 * `"deny"`, never `"block"`. This differs from Gemini, whose own docs
 * explicitly confirm `"block"` as a documented alias for `"deny"` (see
 * `gemini_install.ts`'s module doc comment) -- nothing in Grok's hooks doc
 * makes the same claim, so relying on an unconfirmed alias for a
 * security-relevant deny path would be a guess, not a verified fact. The shim
 * therefore translates token-goat's own `{"decision":"block","reason":...}`
 * (emitted by every `pre_tool_use` deny via `serializeOutput` in
 * `../hook_registry.ts`, harness-independent) into Grok's `{"decision":"deny","reason":...}`
 * and additionally sets `process.exitCode = 2` (the doc's own "Explicit deny"
 * exit code), belt-and-suspenders alongside the stdout decision the doc says
 * is "honored regardless of exit code".
 *
 * No tool-name or stdin-key remapping is needed here: Grok's own hook runner
 * sends `GROK_SESSION_ID` (among other `GROK_*` env vars) on every hook
 * subprocess it spawns -- confirmed empirically against grok 0.2.93 (see the
 * long comment at the `grok` branch of `detectHarness()` in
 * `./registry.ts`) -- and this shim's inner call inherits that env
 * unchanged, so `detectHarness()` resolves to `'grok'` in the child process
 * and `normalizePayload(..., 'grok')` (`../hooks_cli.ts`) does the real
 * camelCase-wire / tool-name translation there. This shim's only job is the
 * PreToolUse response-shape translation above, plus the same
 * exec-path-hardened invocation (`process.execPath` / baked entry path, never
 * a bare `token-goat` relying on PATH) every other bridge shim uses for the
 * same Windows `.cmd`-shim reason (see `codex.ts`'s module doc comment).
 */

/**
 * Node source for the Grok hook shim.
 *
 * `eventName` (argv[2]) is validated against a closed set before being passed
 * to `spawnSync`'s args array (never concatenated into a shell string), so a
 * hostile argv can't do anything unexpected even though args-array `spawnSync`
 * has no shell-injection surface to begin with -- kept for defense in depth
 * and consistency with the Codex/Copilot shims' own validation.
 *
 * On any error the shim prints `{}` (or, for `pre_tool_use`, `{"decision":"allow"}`)
 * so a hook failure fails open rather than denying every tool call -- matching
 * every other bridge shim's fail-open convention.
 */
export const GROK_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Grok CLI hook shim. Forwards the hook payload to \`token-goat hook <event>\`, then -- for pre_tool_use only -- translates token-goat's {"decision":"block",...} deny shape into Grok's documented {"decision":"deny",...} shape and sets exit code 2.
'use strict'
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Keep in sync with HOOK_EVENTS in src/types.ts.
const VALID_HOOK_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'user_prompt_submit',
  'subagent_stop',
])

function allowResponse(eventName) {
  return eventName === 'pre_tool_use' ? '{"decision":"allow"}' : '{}'
}

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
    process.stdout.write(allowResponse(eventName))
    return
  }
  // process.argv[3], when present, is the absolute path to the token-goat CLI entry
  // that ran 'token-goat install --grok' (baked in by hookCommandFor in
  // grok_install.ts). Try the in-process hook lib first (tryInProcess above) -- this
  // avoids spawning a second node process altogether. If that's unavailable, invoking
  // the entry directly via process.execPath sidesteps PATH resolution for this inner
  // call, the same reasoning as every other bridge shim's inner call. Falls back
  // further to the old PATH-based shell:true invocation when argv[3] is absent. A
  // 3000ms timeout/killSignal on both spawnSync fallbacks bounds them well under
  // Grok's own hook timeout (default 5s, per the hooks doc), so token-goat degrades to
  // its own fail-open response rather than being force-killed by Grok first.
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
      process.stdout.write(allowResponse(eventName))
      return
    }
    stdout = res.stdout
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    process.stdout.write(allowResponse(eventName))
    return
  }

  if (eventName !== 'pre_tool_use') {
    // Passive events: Grok ignores stdout entirely (per the hooks doc), so the exact
    // shape doesn't matter -- forward token-goat's response verbatim.
    process.stdout.write(JSON.stringify(parsed))
    return
  }

  if (parsed && parsed.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: parsed.reason || 'blocked by token-goat' }))
    process.exitCode = 2
    return
  }
  process.stdout.write('{"decision":"allow"}')
}

main().catch((err) => {
  try {
    process.stdout.write(allowResponse(process.argv[2] || ''))
  } catch {
    // stdout itself is broken; nothing more can be done here.
  }
})
`
