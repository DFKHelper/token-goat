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
 * Copilot's real built-in tool names -- confirmed via `@github/copilot-sdk`
 * type definitions and multiple real GitHub issue payload dumps, superseding
 * an earlier docs-based guess (`shell`/`write`/`read`/`url`) that didn't hold
 * up in practice (`write` in particular was never a real `toolName` value at
 * all, only a Copilot permission-pattern keyword) -- are `view`, `grep`
 * (alias `rg`), `glob`, `bash`, `powershell`, `edit`, `create`, `web_fetch`,
 * `task`, `ask_user`, `memory`, and MCP-server tool invocations (named
 * `<server-name>-<tool-name>`). The ones with a clear token-goat equivalent
 * are remapped (bash/powershell->Bash, view->Read, create->Write,
 * edit->Edit, web_fetch->WebFetch, grep->Grep, glob->Glob); `task`,
 * `ask_user`, `memory`, and MCP tool calls are forwarded with their original
 * name unchanged, which is safe because token-goat's dispatch loop simply
 * no-ops for tool names none of its handlers are registered for. The exact
 * `toolArgs` key names Copilot sends per tool (e.g. whether the bash tool's
 * command key is literally `command`) were NOT enumerated in any fetched
 * doc, so `toolArgs` is forwarded to token-goat verbatim (no key renaming)
 * and any `modifiedArgs` token-goat returns is likewise passed back verbatim
 * -- unconfirmed, flag for follow-up if Copilot's real key names turn out to
 * differ.
 */
export const COPILOT_CLI_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Copilot CLI hook shim. Translates Copilot's hook event names and
// request/response schema to/from token-goat's internal hook protocol.
'use strict'
const { spawnSync } = require('node:child_process')

// Copilot event name -> token-goat internal HookEventName (src/types.ts's
// HOOK_EVENTS). Only these six have a token-goat handler; every other real
// Copilot event (sessionEnd, postToolUseFailure, subagentStart,
// errorOccurred, notification, permissionRequest) is left unimplemented
// rather than guessed at, and falls through to the default no-op below.
// 'sessionStart' is handled as a permanent no-op even though it's a real
// Copilot event, because token-goat has no internal session_start handler
// (mirrors PI_EXTENSION_SCRIPT's documented precedent).
const COPILOT_TO_TG_EVENT = {
  preToolUse: 'pre_tool_use',
  postToolUse: 'post_tool_use',
  preCompact: 'pre_compact',
  agentStop: 'stop',
  subagentStop: 'subagent_stop',
  userPromptSubmitted: 'user_prompt_submit',
}

// Copilot built-in tool name -> token-goat internal tool name. Confirmed via
// @github/copilot-sdk type definitions and multiple real GitHub issue payload
// dumps -- supersedes an earlier docs-based guess (shell/read/write/url) that
// didn't hold up in practice; 'write' in particular was never a real
// toolName value, only a Copilot permission-pattern keyword. 'powershell'
// maps to the same 'Bash' handler as 'bash' since both are shell-command
// execution from token-goat's perspective (mirrors how hooks_bash.ts's own
// filters already treat powershell-wrapped commands as part of the Bash
// pipeline, not a separate tool). 'task', 'ask_user', 'memory', and
// MCP-server tool invocations (<server-name>-<tool-name>) have no
// token-goat equivalent and are passed through unmapped (safe no-op for
// handlers that don't recognize the name).
const TOOL_TO_TG = {
  bash: 'Bash',
  powershell: 'Bash',
  view: 'Read',
  create: 'Write',
  edit: 'Edit',
  web_fetch: 'WebFetch',
  grep: 'Grep',
  glob: 'Glob',
}

// Confirmed via github/copilot-cli#3349 (open, unresolved as of writing): some
// real Copilot CLI invocations send toolArgs as a JSON-*encoded string*
// rather than a parsed object, contradicting the documented schema. Left
// unhandled, canonical.tool_input would become a raw string and every
// downstream event.toolInput[key] lookup in token-goat's handlers would
// silently return undefined -- the deny/dedup mechanism would no-op with no
// error surfaced. Parse it defensively; on a non-string, absent, or
// unparsable value, fall back to {} rather than throwing (this shim's
// convention throughout is fail-open, never crash on a malformed payload).
function parseMaybeJsonObject(value) {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // fall through to {}
    }
  }
  return {}
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
    canonical.tool_input = parseMaybeJsonObject(payload && payload.toolArgs)
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

  if (copilotEvent === 'agentStop' || copilotEvent === 'subagentStop') {
    // Confirmed against the hooks reference doc: the only accepted response
    // shape for these two events is {decision, reason} -- additionalContext
    // is not part of their schema and Copilot silently ignores it there.
    // token-goat's internal 'stop'/'subagent_stop' handlers never return a
    // real deny today (subagentStopHandler only ever logs and passes), but a
    // future deny is mapped through here rather than silently dropped.
    if (resp && resp.decision === 'block') {
      const reason = (resp && resp.reason) || 'blocked by token-goat'
      return { decision: 'block', reason: reason }
    }
    return { decision: 'allow' }
  }

  // preCompact / userPromptSubmitted: confirmed against the hooks reference
  // doc that both are notification-only -- Copilot never reads a response
  // body for either, so any additionalContext/systemMessage token-goat
  // produces has no surfacing channel here. This still routes through the
  // token-goat hook call above (unlike sessionStart's early no-op) so the
  // internal handler's own side effects keep running; only the response is
  // discarded.
  return {}
}

function extractContext(resp) {
  const hso = resp && resp.hookSpecificOutput
  if (hso && typeof hso.additionalContext === 'string') return hso.additionalContext
  if (resp && typeof resp.systemMessage === 'string') return resp.systemMessage
  return undefined
}

// Hard outer safety net, on top of main()'s own per-step try/catch fallbacks
// (JSON.parse, readFileSync, spawnSync): a hook error must never itself cause
// Copilot's fail-closed "(hook errored)" behavior, which denies EVERY tool
// call unconditionally (the exact live-production failure mode behind
// github/copilot-cli#4001). Any uncaught exception anywhere in this script --
// including one a future code path adds that the existing per-step guards
// don't anticipate -- still guarantees stdout gets valid JSON and the
// process exits 0. process.exitCode is set explicitly and unconditionally at
// the very end of every path so nothing upstream (e.g. an unhandled-rejection
// warning in some Node versions nudging exit-code inference) can flip it.
try {
  main()
} catch {
  try {
    process.stdout.write('{}')
  } catch {
    // stdout itself is broken; nothing more can be done here.
  }
}
process.exitCode = 0
`
