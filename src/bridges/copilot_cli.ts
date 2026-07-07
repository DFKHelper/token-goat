/**
 * Copilot CLI hook shim.
 *
 * GitHub Copilot CLI's hook config (`.github/hooks/*.json` project-scope, or
 * `~/.copilot/hooks/*.json` user-scope -- confirmed against
 * https://docs.github.com/en/copilot/reference/hooks-reference and
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
 * points each event at an external command. Unlike Codex, Copilot's own event
 * names (`preToolUse`, `postToolUse`, `preCompact`, `agentStop`,
 * `subagentStop`, `sessionStart`, ...) and response schema
 * (`permissionDecision`/`permissionDecisionReason`/`modifiedArgs` for
 * `preToolUse`; `modifiedResult`/`additionalContext` for `postToolUse`) are
 * genuinely different from Claude Code's `hookSpecificOutput`-nested shape,
 * so this shim does real translation rather than Codex's mostly-pass-through
 * strip-and-relabel.
 *
 * Also unlike Codex, no ambient env var documenting "this subprocess is
 * running under Copilot CLI" turned up in either doc above or in a broader
 * search (`COPILOT_HOME`/`COPILOT_MODEL`/`COPILOT_SUBAGENT_MAX_CONCURRENT`
 * are all user-configurable overrides, not signals Copilot sets
 * automatically) -- see the note in src/bridges/registry.ts. So, exactly
 * like PI_EXTENSION_SCRIPT (src/bridges/pi.ts), this shim sets
 * `TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli` itself before invoking
 * `token-goat hook`, instead of relying on a guessed detection branch.
 *
 * Copilot's built-in tool names are `shell`, `write`, `read`, `url`,
 * `memory`, and MCP-server tool invocations (confirmed via
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference).
 * Only the four with a clear token-goat equivalent are remapped
 * (shell->Bash, read->Read, write->Write, url->WebFetch); `memory` and MCP
 * tool calls are forwarded with their original name unchanged, which is safe
 * because token-goat's dispatch loop simply no-ops for tool names none of
 * its handlers are registered for. The exact `toolArgs` key names Copilot
 * sends per tool (e.g. whether the shell tool's command key is literally
 * `command`) were NOT enumerated in any fetched doc, so `toolArgs` is
 * forwarded to token-goat verbatim (no key renaming) and any `modifiedArgs`
 * token-goat returns is likewise passed back verbatim -- unconfirmed, flag
 * for follow-up if Copilot's real key names turn out to differ.
 */
export const COPILOT_CLI_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Copilot CLI hook shim. Translates Copilot's hook event names and
// request/response schema to/from token-goat's internal hook protocol.
'use strict'
const { spawnSync } = require('node:child_process')

// Copilot event name -> token-goat internal HookEventName (src/types.ts's
// HOOK_EVENTS). Only these five have a token-goat handler; every other real
// Copilot event (sessionEnd, userPromptSubmitted, postToolUseFailure,
// subagentStart, errorOccurred, notification, permissionRequest) is left
// unimplemented rather than guessed at, and falls through to the default
// no-op below. 'sessionStart' is handled as a permanent no-op even though
// it's a real Copilot event, because token-goat has no internal session_start
// handler (mirrors PI_EXTENSION_SCRIPT's documented precedent).
const COPILOT_TO_TG_EVENT = {
  preToolUse: 'pre_tool_use',
  postToolUse: 'post_tool_use',
  preCompact: 'pre_compact',
  agentStop: 'stop',
  subagentStop: 'subagent_stop',
}

// Copilot built-in tool name -> token-goat internal tool name. 'memory' and
// MCP-server tool invocations have no equivalent and are passed through
// unmapped (safe no-op for handlers that don't recognize the name).
const TOOL_TO_TG = {
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  url: 'WebFetch',
}

function main() {
  const copilotEvent = process.argv[2] || ''

  if (copilotEvent === 'sessionStart') {
    process.stdout.write('{}')
    return
  }

  const tgEvent = COPILOT_TO_TG_EVENT[copilotEvent]
  if (!tgEvent) {
    process.stdout.write('{}')
    return
  }

  let raw = ''
  try {
    raw = require('node:fs').readFileSync(0, 'utf8')
  } catch {
    process.stdout.write('{}')
    return
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.stdout.write('{}')
    return
  }

  const toolName = payload && payload.toolName
  const canonical = {
    session_id: (payload && payload.sessionId) || 'copilot-' + process.pid,
    cwd: payload && payload.cwd,
  }
  if (toolName) {
    canonical.tool_name = TOOL_TO_TG[toolName] || toolName
    canonical.tool_input = (payload && payload.toolArgs) || {}
  }

  // A single command string (not an args array) with shell: true, exactly like
  // CODEX_HOOK_SCRIPT -- an args array with shell: true triggers Node's DEP0190
  // deprecation warning (unescaped arg concatenation) on every invocation.
  // Safe here because tgEvent is only ever one of COPILOT_TO_TG_EVENT's five
  // fixed values (the lookup above returns undefined, short-circuiting before
  // this line, for anything else), never raw external input.
  const res = spawnSync('token-goat hook ' + tgEvent, {
    input: JSON.stringify(canonical),
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    env: Object.assign({}, process.env, { TOKEN_GOAT_HARNESS_OVERRIDE: 'copilot_cli' }),
  })
  if (res.status !== 0 || !res.stdout) {
    process.stdout.write('{}')
    return
  }

  let resp
  try {
    resp = JSON.parse(res.stdout)
  } catch {
    process.stdout.write('{}')
    return
  }

  process.stdout.write(JSON.stringify(translate(copilotEvent, resp)))
}

function translate(copilotEvent, resp) {
  if (copilotEvent === 'preToolUse') {
    const hso = resp && resp.hookSpecificOutput
    const denied = resp && (resp.decision === 'block' || (hso && hso.permissionDecision === 'deny'))
    if (denied) {
      const reason =
        (resp && resp.reason) || (hso && hso.permissionDecisionReason) || 'blocked by token-goat'
      return { permissionDecision: 'deny', permissionDecisionReason: reason }
    }
    const updated = hso && hso.updatedInput
    if (updated && typeof updated === 'object') {
      return { modifiedArgs: updated }
    }
    return {}
  }

  if (copilotEvent === 'postToolUse') {
    const context = extractContext(resp)
    if (context) return { additionalContext: context }
    return {}
  }

  // preCompact / agentStop / subagentStop: Copilot's docs (as fetched) do not
  // enumerate an output schema for these three events. This maps the one
  // context channel token-goat produces for them (systemMessage, per
  // src/hook_registry.ts's serializeOutput) onto additionalContext as a
  // best-effort guess -- unconfirmed, verify against Copilot's real behavior.
  const context = extractContext(resp)
  if (context) return { additionalContext: context }
  return {}
}

function extractContext(resp) {
  const hso = resp && resp.hookSpecificOutput
  if (hso && typeof hso.additionalContext === 'string') return hso.additionalContext
  if (resp && typeof resp.systemMessage === 'string') return resp.systemMessage
  return undefined
}

main()
`
