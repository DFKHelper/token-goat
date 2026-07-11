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
 * no-ops for tool names none of its handlers are registered for. The bash
 * tool's `toolArgs` command key is confirmed literally `command` (GitHub's
 * own hooks-reference example: `"toolArgs": "{\"command\":\"rm -rf dist\",
 * \"description\":\"Clean build\"}"`), matching what hooks_bash.ts reads
 * (`event.toolInput['command']`), so no remap is needed there. Other tools'
 * `toolArgs` key names beyond the view/edit/create `path` remap above were
 * not individually enumerated, so `toolArgs` is otherwise forwarded to
 * token-goat verbatim (no key renaming) and any `modifiedArgs` token-goat
 * returns is likewise passed back verbatim.
 *
 * `postToolUse`'s payload also carries `toolResult`, confirmed (same hooks-reference
 * doc above) as an object -- `{ resultType: 'success', textResultForLlm: string }` --
 * not a bare string. `textResultForLlm` is extracted into `canonical.tool_response` so
 * token-goat's post-read/post-bash stat handlers (which measure `tool_response`) see
 * real content instead of nothing.
 *
 * `view`/`edit`/`create`'s file-path argument arrives under the key `path`, not the
 * `file_path` key every token-goat handler that resolves a path reads (getFilePath in
 * hooks_common.ts; the only handler any of these three tools reach -- postEditHandler
 * for edit/create, preReadHandler/preReadImageHandler for view -- and none of them read
 * any other argument key, so `old_string`/`new_string`/`content`-style remapping is not
 * needed here). Left unremapped, getFilePath() always returns undefined for these three
 * tools and no Read/Edit/Write is ever recorded -- token-goat stats and re-read hints
 * silently never engage for Copilot CLI sessions. This resolves the `toolArgs` key
 * question the block above previously flagged as unconfirmed.
 */
export const COPILOT_CLI_HOOK_SCRIPT = `#!/usr/bin/env node
// token-goat Copilot CLI hook shim. Translates Copilot's hook event names and
// request/response schema to/from token-goat's internal hook protocol.
'use strict'
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

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

// view/edit/create send the file path under 'path'; every token-goat handler these
// three tools reach only ever looks for 'file_path' (getFilePath in hooks_common.ts).
// Keyed by the ORIGINAL Copilot tool name (before TOOL_TO_TG renames it) since that's
// the name toolArgs' shape is keyed to, not token-goat's internal tool name.
const FILE_PATH_ARG_KEY = {
  view: 'path',
  edit: 'path',
  create: 'path',
}

// Copilot spawns a brand-new process for every single hook invocation (no long-lived plugin
// process the way OpenClaw's is -- OPENCLAW_HOOK_SCRIPT's own \`copilot-\${process.pid}-\${Date.now()}\`
// fallback is safe there specifically because that process lives for the whole session, so the
// pid stays constant across calls). If Copilot ever omits \`sessionId\` from a payload, falling
// back to \`process.pid\` here would mint a DIFFERENT id on every single call for what's really
// the same session, since process.pid varies per invocation -- breaking token-goat's
// session-based dedup/state ledger, which never accumulates across calls as a result. Derive a
// stable id instead from the one thing that's actually constant across calls for the same
// session: the working directory Copilot reports in \`payload.cwd\`.
function stableFallbackSessionId(cwd) {
  const key = typeof cwd === 'string' && cwd ? cwd : process.cwd()
  const hash = require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 16)
  return 'copilot-' + hash
}

function remapToolInput(copilotToolName, input) {
  const pathKey = FILE_PATH_ARG_KEY[copilotToolName]
  if (pathKey === undefined || !input || typeof input !== 'object' || !(pathKey in input)) {
    return input
  }
  // Add file_path alongside the original key rather than renaming it, so nothing that
  // might read the original 'path' key elsewhere (e.g. a future handler) loses it.
  return Object.assign({}, input, { file_path: input[pathKey] })
}

// Attempts the in-process hook call: import()s dist/token-goat-hook.mjs (a sibling of
// the baked token-goat entry path, built with zero load-time side effects -- unlike
// the CLI entry, which runs the full argv-parsing CLI as a side effect of being
// loaded) and calls its exported relayInProcess() directly, avoiding a second node
// process spawn entirely. Returns undefined (triggering the spawnSync fallback below)
// when entryPath is absent, the sibling file doesn't exist (an older install predating
// this file), or anything else goes wrong -- this must never throw.
async function tryInProcess(entryPath, tgEvent, canonical) {
  if (!entryPath) return undefined
  try {
    const hookLibPath = path.join(path.dirname(entryPath), 'token-goat-hook.mjs')
    if (!require('node:fs').existsSync(hookLibPath)) return undefined
    const mod = await import(pathToFileURL(hookLibPath).href)
    process.env.TOKEN_GOAT_HARNESS_OVERRIDE = 'copilot_cli'
    return await mod.relayInProcess(tgEvent, canonical)
  } catch {
    return undefined
  }
}

async function main() {
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
    session_id: (payload && payload.sessionId) || stableFallbackSessionId(payload && payload.cwd),
    cwd: payload && payload.cwd,
  }
  if (toolName) {
    canonical.tool_name = TOOL_TO_TG[toolName] || toolName
    canonical.tool_input = remapToolInput(toolName, parseMaybeJsonObject(payload && payload.toolArgs))
  }

  // postToolUse only: confirmed via https://docs.github.com/en/copilot/reference/hooks-reference
  // that Copilot's toolResult is an object ({resultType, textResultForLlm}), not a bare string
  // or array. Without this, token-goat's tool_response consumers (hooks_read.ts's
  // extractReadOutput, hooks_bash.ts's extractBashOutput, etc. -- all of which check for a
  // string or an object keyed by output/content/text/body) never see any content, so
  // post-read/post-bash stats stay empty no matter how many tool calls happen. Extract the
  // LLM-facing text directly rather than forwarding the raw object, since textResultForLlm
  // isn't one of those recognized object keys.
  const rawResult = payload && payload.toolResult
  if (rawResult && typeof rawResult === 'object') {
    const tr = rawResult
    // text_result_for_llm: Copilot's docs also describe a "VS Code compatible" snake_case
    // wire format (tool_result.text_result_for_llm) alongside the camelCase one above; try
    // both rather than assuming only the camelCase shape ever reaches this shim.
    const text = typeof tr.textResultForLlm === 'string' ? tr.textResultForLlm : tr.text_result_for_llm
    if (typeof text === 'string') canonical.tool_response = text
  }

  // process.argv[3], when present, is the absolute path to the token-goat CLI entry that ran
  // \`token-goat install --copilot\` (baked in by hookCommandFor in copilot_cli_install.ts).
  // Invoking it directly via process.execPath sidesteps PATH/cmd.exe resolution for this
  // inner call too -- confirmed live-production root cause of an *intermittent* (not the
  // original, already-fixed github/copilot-cli#4001) "(hook errored)" deny-all: even once the
  // outer command launches via its own baked process.execPath, this inner call still shelled
  // out to a bare \`token-goat\`, which depends on the npm global bin being on whatever PATH
  // Copilot spawns this hook subprocess with. Falls back to the old PATH-based shell:true
  // invocation when argv[3] is absent (an older cached hook config still pointing at a
  // freshly-reinstalled shim, or a direct dev/test invocation), so this is a pure hardening,
  // never a behavior break for configs installed before this fix. An args array (not a
  // template string) is safe here specifically because entryPath and tgEvent never touch a
  // shell -- no DEP0190 concern, unlike the shell:true fallback below.
  const entryPath = process.argv[3]
  // Try the in-process hook lib first (tryInProcess above), which avoids spawning a
  // second node process altogether. If that's unavailable, invoking the entry directly
  // via process.execPath sidesteps PATH/cmd.exe resolution for this inner call, per the
  // note above this function's original single-spawn form documented. A 3000ms
  // timeout/killSignal on both spawnSync fallbacks keeps them well under Copilot CLI's
  // own hook timeout budget (~30000ms), so token-goat degrades to its own fail-open
  // '{}' rather than being force-killed by Copilot first.
  let stdout = await tryInProcess(entryPath, tgEvent, canonical)
  if (stdout === undefined) {
    const res = entryPath
      ? spawnSync(process.execPath, [entryPath, 'hook', tgEvent], {
          input: JSON.stringify(canonical),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000,
          killSignal: 'SIGKILL',
          env: Object.assign({}, process.env, { TOKEN_GOAT_HARNESS_OVERRIDE: 'copilot_cli' }),
        })
      : spawnSync('token-goat hook ' + tgEvent, {
          input: JSON.stringify(canonical),
          encoding: 'utf8',
          shell: true,
          windowsHide: true,
          timeout: 3000,
          killSignal: 'SIGKILL',
          env: Object.assign({}, process.env, { TOKEN_GOAT_HARNESS_OVERRIDE: 'copilot_cli' }),
        })
    if (res.status !== 0 || !res.stdout) {
      process.stdout.write('{}')
      return
    }
    stdout = res.stdout
  }

  let resp
  try {
    resp = JSON.parse(stdout)
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
main()
  .catch(() => {
    try {
      process.stdout.write('{}')
    } catch {
      // stdout itself is broken; nothing more can be done here.
    }
  })
  .finally(() => {
    process.exitCode = 0
  })
`
