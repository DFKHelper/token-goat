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
 * (alias `rg`), `glob`, `bash`, `powershell`, `read_bash`, `stop_bash`,
 * `list_bash` (and the `read_powershell`/`stop_powershell`/`list_powershell`
 * twins the PowerShell shell config uses), `edit`, `create`, `web_fetch`,
 * `task`, `ask_user`, `memory`, and MCP-server tool invocations (named
 * `<server-name>-<tool-name>`). The ones with a clear token-goat equivalent
 * are remapped (bash/powershell->Bash, read_bash/read_powershell->BashOutput,
 * view->Read, create->Write, edit->Edit, web_fetch->WebFetch, grep->Grep,
 * glob->Glob); `task`, `ask_user`, `memory`, the stop/list shell tools, and
 * MCP tool calls are forwarded with their original
 * name unchanged, which is safe because token-goat's dispatch loop simply
 * no-ops for tool names none of its handlers are registered for. The bash
 * tool's `toolArgs` command key is confirmed literally `command` (GitHub's
 * own hooks-reference example: `"toolArgs": "{\"command\":\"rm -rf dist\",
 * \"description\":\"Clean build\"}"`), matching what hooks_bash.ts reads
 * (`event.toolInput['command']`), so no remap is needed there. Other tools'
 * `toolArgs` key names beyond the view/edit/create `path` remap and the
 * read_bash/read_powershell `shellId` remap below were
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
// HOOK_EVENTS). Only these eight have a token-goat handler; every other real
// Copilot event (sessionEnd, subagentStart, errorOccurred, notification,
// permissionRequest) is left unimplemented
// rather than guessed at, and falls through to the default no-op below.
// postToolUseFailure is the newest of the eight and the only one whose channel
// costs tokens instead of saving them: it fires instead of postToolUse when a
// tool result is a failure, and accepts only additionalContext back --
// modifiedResult and suppressOutput are not honored there, so a failed result
// still cannot be fenced, compressed or shrunk. It is wired anyway because
// additionalContext demonstrably reaches the model (see the postToolUseFailure
// branch in translate() for the bundle offset), and hooks_tool_failure.ts
// spends that channel only on an exact repeat failure, where staying silent
// costs a whole wasted retry.
// 'sessionStart' was previously a permanent no-op on the stated grounds that
// token-goat has no internal session_start handler. That was simply wrong --
// hooks_session_start.ts has long emitted the command-routing reminder that
// every other harness receives -- and the no-op was the reason Copilot CLI
// sessions alone never got told token-goat exists. It is wired now: verified
// against Copilot CLI 1.0.77 that a hooks.json sessionStart entry returning
// {additionalContext} does reach the model. The github/copilot-cli#2142
// fire-and-forget bug that would have made this dead wiring was fixed in a
// pre-release months before that version, and its companion multi-extension
// hook-overwrite bug never applied here: it hit runtime *extension* hooks,
// while this config-file hooks.json path goes through Copilot's own merge.
const COPILOT_TO_TG_EVENT = {
  sessionStart: 'session_start',
  preToolUse: 'pre_tool_use',
  postToolUse: 'post_tool_use',
  preCompact: 'pre_compact',
  agentStop: 'stop',
  subagentStop: 'subagent_stop',
  userPromptSubmitted: 'user_prompt_submit',
  postToolUseFailure: 'post_tool_use_failure',
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
// 'read_bash'/'read_powershell' are the background-shell output pollers, and
// they are the exact shape of Claude Code's BashOutput: Copilot's shell tool
// is async, so a long-running command is started once and then re-read over
// and over within one turn, each read returning the accumulated output again.
// hooks_bashoutput.ts already collapses that into a delta (or a short
// "unchanged" marker) for Claude Code, and now does the same here. Both the
// names and the argument key were read out of the shipping 1.0.80 bundle
// rather than guessed: the builtin tool-name table in
// prebuilds/win32-x64/runtime.node lists read_bash/stop_bash/list_bash and
// read_powershell/stop_powershell/list_powershell, and the poller's own input
// schema in app.js is {shellId, delay} -- so the shell id needs the
// POLL_ID_ARG_KEY remap below to reach postBashOutputHandler, which reads
// 'bash_id'. read_shell/stop_shell/list_shells, which an earlier static sweep
// of the same binary suggested were the real names, are internal Rust
// identifiers (tool_read_shell_prepare_input, tool_list_shells_descriptor,
// PreparedStopShellInput, and the serde field names of the shell config
// struct), never wire tool names, so they are deliberately absent here.
// stop_bash/list_bash and their powershell twins stay unmapped because
// token-goat has no KillShell-equivalent handler for them to reach; a mapping
// would be pure decoration.
// 'bash'/'powershell' stay exactly as they were. The same sweep suggested the
// executor had been renamed to write_bash/write_powershell and that this
// mapping was dead, and that is not what the bundle says: app.js resolves the
// executor as shellConfig?.shellToolName ?? "bash" (with "powershell" as the
// Windows default of the same config), and its command lives under 'command'
// exactly as hooks_bash.ts expects. write_bash/write_powershell are real tool
// names, but they are a different tool -- their schema is {shellId, input,
// delay} and the bundle files them under the subtype "write_shell", i.e. send
// stdin to an already-running shell, not run a command. Mapping them to Bash
// would label a stdin write as a shell execution, so they are left unmapped.
// 'task', 'read_agent' and 'memory'-family tools are likewise left alone:
// task's result is assembled in the native addon and its shape is unknown,
// read_agent is an incremental poll that postAgentHandler is not written for,
// and the real tool names behind memory were never confirmed. Each would put
// a handler that rewrites model-visible output in front of a payload shape
// nobody has seen, which is worse than leaving the compression on the table.
const TOOL_TO_TG = {
  bash: 'Bash',
  powershell: 'Bash',
  read_bash: 'BashOutput',
  read_powershell: 'BashOutput',
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

// read_bash/read_powershell send the background shell's id under 'shellId' (confirmed
// against the poller's input schema in the shipping 1.0.80 app.js: {shellId, delay});
// postBashOutputHandler reads 'bash_id'. Without this the tool-name mapping above would
// be inert -- the handler bails on a missing bash_id and every poll would keep costing
// the full accumulated output. Same keying convention as FILE_PATH_ARG_KEY: the ORIGINAL
// Copilot tool name, since that is what the argument shape belongs to.
const POLL_ID_ARG_KEY = {
  read_bash: 'shellId',
  read_powershell: 'shellId',
}

// Copilot spawns a brand-new process for every single hook invocation (no long-lived plugin
// process the way OpenClaw's is -- OPENCLAW_HOOK_SCRIPT's own \`copilot-\${process.pid}-\${Date.now()}\`
// fallback is safe there specifically because that process lives for the whole session, so the
// pid stays constant across calls). If Copilot ever omits \`sessionId\` from a payload, falling
// back to \`process.pid\` here would mint a DIFFERENT id on every single call for what's really
// the same session, since process.pid varies per invocation -- breaking token-goat's
// session-based dedup/state ledger, which never accumulates across calls as a result. Derive a
// stable id instead from the one thing that's actually constant across calls for the same
// session: the working directory Copilot reports. That field is \`workingDirectory\`, declared
// required on BaseHookInput in copilot-sdk/types.d.ts since 1.0.76, so it is present on EVERY
// hook event. This previously read \`payload.cwd\`, which Copilot has never sent under any name in
// any version -- the key simply did not exist, so this derived every fallback id from
// process.cwd() instead and \`canonical.cwd\` below was undefined on every single call. It went
// unnoticed because process.cwd() happens to be the project directory Copilot spawns the hook in,
// so the fallback was accidentally right; nothing about that was by design. \`cwd\` is still read
// as a secondary in case a future version adds it under the shorter name.
function stableFallbackSessionId(cwd) {
  const key = typeof cwd === 'string' && cwd ? cwd : process.cwd()
  const hash = require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 16)
  return 'copilot-' + hash
}

function remapToolInput(copilotToolName, input) {
  if (!input || typeof input !== 'object') return input
  let out = input
  // Add the canonical key alongside the original rather than renaming it, so nothing that
  // might read the original 'path'/'shellId' key elsewhere (e.g. a future handler) loses it.
  const pathKey = FILE_PATH_ARG_KEY[copilotToolName]
  if (pathKey !== undefined && pathKey in out) {
    out = Object.assign({}, out, { file_path: out[pathKey] })
  }
  const idKey = POLL_ID_ARG_KEY[copilotToolName]
  if (idKey !== undefined && idKey in out) {
    out = Object.assign({}, out, { bash_id: out[idKey] })
  }
  return out
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
    session_id:
      (payload && payload.sessionId) ||
      stableFallbackSessionId(payload && (payload.workingDirectory || payload.cwd)),
    cwd: payload && (payload.workingDirectory || payload.cwd),
  }

  // Subagent correlation and W3C Trace Context propagation from Copilot CLI payloads
  const agentId = payload && (payload.agent_id || payload.agentId)
  if (typeof agentId === 'string' && agentId !== '') {
    canonical.agent_id = agentId
  }
  const traceparent = payload && (payload.traceparent || payload.traceParent)
  if (typeof traceparent === 'string' && traceparent !== '') {
    canonical.traceparent = traceparent
  }
  const tracestate = payload && (payload.tracestate || payload.traceState)
  if (typeof tracestate === 'string' && tracestate !== '') {
    canonical.tracestate = tracestate
  }

  // userPromptSubmitted only: Copilot declares \`prompt\` required on UserPromptSubmittedHookInput.
  // hooks_session.ts's userPromptSubmitHandler reads it as \`event.raw['prompt']\` and gates every
  // branch it has on the text, so without this it saw '' on every Copilot prompt and the
  // embedded-skill dedup hint could never fire. Same shape as the postToolUseFailure \`error\`
  // drop: a required field the canonical builder simply did not list.
  if (typeof (payload && payload.prompt) === 'string' && payload.prompt !== '') {
    canonical.prompt = payload.prompt
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
  // postToolUseFailure only: Copilot's PostToolUseFailureHookInput (copilot-sdk/types.d.ts:1042)
  // carries {toolName, toolArgs, error} and no toolResult at all -- the failure text lives in
  // \`error\`, a plain string. Without forwarding it, hooks_tool_failure.ts's extractFailureText
  // finds nothing to key on and the repeat-failure brake returns pass on every single call: wired,
  // green, and doing nothing. Found by driving the installed shim rather than by a test, because
  // the handler's own tests hand it a raw payload that already has the field.
  if (typeof (payload && payload.error) === 'string' && payload.error !== '') {
    canonical.error = payload.error
  }

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
    // Verified against the shipping @github/copilot 1.0.80 bundle, not against the docs page.
    // NativeHookPipelineProcessor.postToolExecution (app.js offset 2043150) gates on
    // toolResult.resultType === "success", then does n.toolResultJson && CSr(e.toolResult,
    // n.toolResultJson), where CSr (offset 2032350) is an in-place Object.assign; the mutated
    // object is re-serialized back to native in the postTool callback at offset 1793926. So
    // modifiedResult IS honored on this event, and token-goat's rewriteOutput producers
    // (compression, injection fencing, image shrink) really do reach the model. resultType is
    // hardcoded 'success' because success is the only branch this event ever runs on.
    //
    // additionalContext on THIS event is dropped on the JS path. grep -abo "onAdditionalContext:"
    // app.js returns nothing, so the callback is never supplied, and the two "onAdditionalContext?"
    // call sites (offsets 2041896 and 2043300) are both no-ops. preToolsExecution (offset 2041832)
    // additionally pushes each context into an array that IS drained into the native return
    // payload (additional_contexts, offset 1791950); postToolExecution has no such push and its
    // native return payload (offset 1793926) has no additional_contexts key. Residual, stated
    // honestly: the native hookProcessorPostToolUse might fold additionalContext into the
    // toolResultJson it returns, and that was NOT verified. The evidence leans against it, since
    // the failure sibling path appends its context explicitly in JS via
    // hookAppendPostToolUseFailureContext and there is no success-path counterpart. The
    // out.additionalContext below is kept as cheap best-effort, not as a channel anything should
    // depend on -- see src/pending_context.ts, whose whole design depended on it.
    //
    // Failed tool calls never reach this event. postToolUse and postToolUseFailure are two
    // distinct hook events (both listed in the runtime.node hook-event enum at offset 101618150),
    // and the shipped copilot-sdk/types.d.ts says onPostToolUse "does not fire for non-success
    // results". The failure event cannot carry a fence either: PostToolUseFailureHookInput carries
    // only a stringified error message, not the tool result, and PostToolUseFailureHookOutput
    // consumes only additionalContext -- "modifiedResult or suppressOutput are not honored for
    // failure hooks". rejected/denied/timeout results trigger no post hook at all. So on Copilot,
    // the output of a failed tool call reaches the model unfenced, uncompressed and unshrunk, and
    // no response shape this shim could emit changes that. That gap is real and still open. What
    // is now wired is the narrower thing that IS possible there: the postToolUseFailure branch
    // below carries advisory text alongside the failure, and never rewrites it.
    //
    // Emitted camelCase-only. The inbound side around line 247 also tolerates a snake_case "VS
    // Code compatible" shape, and this comment used to justify the camelCase choice by claiming
    // PascalCase event registration selects the snake_case response format. That reasoning is
    // UNVERIFIED in 1.0.80: every hook-response field in the native string tables is camelCase,
    // and the snake_case hits in the bundle are unrelated internal Rust identifiers. camelCase
    // stays because it is what the bundle reads; the old justification is no longer asserted.
    const hso = resp && resp.hookSpecificOutput
    const updatedToolOutput = hso && hso.updatedToolOutput
    const context = extractContext(resp)
    const out = {}
    if (typeof updatedToolOutput === 'string') {
      out.modifiedResult = { resultType: 'success', textResultForLlm: updatedToolOutput }
    }
    if (context) out.additionalContext = context
    return out
  }

  if (copilotEvent === 'postToolUseFailure') {
    // The failed-tool twin of postToolUse, and the only response field it accepts is
    // additionalContext: the shipped copilot-sdk/types.d.ts says "modifiedResult or suppressOutput
    // are not honored for failure hooks", so nothing here can fence, compress or shrink the failed
    // output -- that gap is real and stays open. What is NOT open, and was the reason this event
    // went unwired for so long, is whether additionalContext reaches the model at all. It does:
    // app.js 1.0.80 at offset 2043380 either folds it into textResultForLlm (when
    // appendFailureContextToToolResult is set) or has the native
    // hookAppendPostToolUseFailureContext push {content, source:'system'} onto
    // toolResult.newMessages. That is the exact opposite of postToolUse, whose additionalContext
    // the JS side drops on the floor, so neither event's behaviour generalises to the other.
    //
    // Because this channel spends tokens rather than saving them, the handler behind it
    // (hooks_tool_failure.ts) is silent on a first failure and speaks only on an exact repeat.
    const context = extractContext(resp)
    if (context) return { additionalContext: context }
    return {}
  }

  if (copilotEvent === 'sessionStart') {
    // sessionStart has no tool result to modify -- only additionalContext applies, and it's the
    // one channel that reaches the model before it picks its first read tool, so this is where
    // the routing reminder has to land.
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

  if (copilotEvent === 'userPromptSubmitted') {
    // Copilot's own hooks reference says command-hook output here "is dropped, including
    // modifiedPrompt", and this branch used to believe it and return nothing. That is wrong for
    // additionalContext on 1.0.80, established by experiment rather than by reading: a config-file
    // command hook (at <cwd>/.github/hooks/, the project scope -- the user scope ~/.copilot/hooks/
    // was never exercised) returned {"additionalContext":"<marker>"} and the marker turned up
    // verbatim inside the session's user.message.transformedContent, wrapped in a
    // <system_reminder> block. What settles that it reached the model rather than only the on-disk
    // record is the billing: the provider's returned usage charged ~140 input tokens for a turn
    // whose raw content field is 35 bytes, so the marker's bytes were paid for whichever field
    // carried them. (The weaker argument first offered for this -- that transformedContent carries
    // an envelope the content field lacks, 29 B vs 195 B -- was measured on the control turn that
    // had no marker in it, and proves nothing about the marker.) That the model sees it is the
    // whole point: hook.start/hook.end records also persist and reach nothing.
    //
    // Scope of the finding, stated honestly: demonstrated ONCE on 1.0.80, not shown to be
    // reliable. Of two turns in that experiment, one delivered the marker and one fired a
    // userPromptSubmitted hook that produced no output and never ran the script; no explanation
    // was established and the rate is unknown. A hint that silently fails to arrive costs nothing
    // and breaks nothing here, which is why the direct return is still the right default.
    //
    // modifiedPrompt is NOT claimed to work and is not wanted: rewriting a user's prompt is far
    // more invasive than anything token-goat does, so only additionalContext is forwarded.
    //
    // This is also the write end of any post-compaction channel. Copilot has no postCompact hook.
    // Whether the summary is recoverable from events.jsonl is NOT settled -- the emit()/
    // emitEphemeral() distinction does not gate the writer, and the real decision is in native
    // code; see COPILOT_NO_POST_COMPACT_REASON in ../bridges_status.ts for what was and was not
    // established. The read end that IS confirmed is preCompact, which fires as a notification, so
    // a manifest can be built there and drained here without reading the event log at all.
    const context = extractContext(resp)
    if (context) return { additionalContext: context }
    return {}
  }

  // preCompact is the genuine notification-only case, and the contrast with userPromptSubmitted
  // above is why this fallthrough is worth a comment at all. The hooks reference marks it
  // "No -- notification only" for output processing, and unlike the additionalContext claim that
  // turned out to be false, this one is confirmed in the shipping bundle: both preCompact call
  // sites in app.js (1.0.79 and re-checked in 1.0.80) await the hook and never assign its result.
  // There is no field to aim at here, so nothing to reconsider on the next version bump.
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
