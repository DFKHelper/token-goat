/** opencode bridge plugin. Unlike Codex (had an existing `CODEX_HOOK_SCRIPT` template) and pi (had a whole real extension already sitting unreferenced in the repo), no opencode bridge code existed anywhere in this repo before this file. It was authored fresh, verified directly against opencode's real source (github.com/anomalyco/opencode -- the project formerly at sst/opencode; GitHub transparently redirects the old path) and https://opencode.ai/docs/plugins/, not secondhand descriptions. opencode's plugin API (packages/plugin/src/index.ts) exposes three hooks relevant here: - tool.execute.before(input: {tool, sessionID, callID}, output: {args}) => Promise<void> - tool.execute.after(input: {tool, sessionID, callID, args}, output: {title, output, metadata}) => Promise<void> - experimental.session.compacting(input: {sessionID}, output: {context, prompt?}) => Promise<void> There is no pre-read context-injection hook like Claude Code's PreToolUse additionalContext -- tool.execute.before can only mutate output.args (or throw to abort the call; opencode's own docs demonstrate this with `throw new Error("Do not read .env files")` inside tool.execute.before, and community plugin guides show the same pattern for blocking `rm -rf`). This is exactly why README's "opencode users" section says session hints don't work here: there is no channel to inject text into the model's context before a read happens. Image shrinking does not ship here either. This plugin used to point output.args.filePath at a shrunk temp copy, but opencode 1.18.16 runs tool.execute.before before the tool's own execute, and ReadTool.execute asks its external_directory and `read` permissions against the path it then holds, so a `read` deny or ask the user set on the original image stopped applying to it, and opencode's permission rules can come from an organization account or a well-known URL no hook reads. Real opencode built-in tool ids and parameter keys, confirmed directly against source (not the tool's file name or display name): read:     filePath, offset, limit                  (tool/read.ts) write:    filePath, content                          (tool/write.ts) edit:     filePath, oldString, newString, replaceAll (tool/edit.ts) bash:     command, timeout, workdir                  (tool/shell.ts registers under ShellID.ToolID, which -- despite the file being named shell.ts -- is literally the string "bash": tool/shell/id.ts) grep:     pattern, path, include                     (tool/grep.ts) glob:     pattern, path                              (tool/glob.ts) webfetch: url, format, timeout                       (tool/webfetch.ts) websearch: query, numResults, ...                    (tool/websearch.ts, v1.18.16) skill:    name                                       (tool/skill.ts, v1.18.16) task:     prompt, subagent_type, description, ...    (tool/task.ts, v1.18.16) `token-goat hook <event>` only accepts the exact snake_case event names in HOOK_EVENTS (src/types.ts): pre_tool_use, post_tool_use, pre_compact, notification, stop, user_prompt_submit, subagent_stop -- relay() (src/relay.ts) checks the event name against that closed set via isHookEventName() and no-ops to `{}` on anything else. This plugin uses those exact names (unlike PI_EXTENSION_SCRIPT's pre-existing "session-start" / "pre-read" / "post-bash" style event names, none of which match HOOK_EVENTS -- every one of those calls currently no-ops). Response contract from `token-goat hook <event>` (src/hook_registry.ts serializeOutput), all confirmed by reading the handlers that actually produce them: - deny:   {"decision":"block","reason":"..."} - context (pre_compact / notification): {"systemMessage":"..."} - context (other events): {"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}} - rewriteInput (pre_tool_use only, e.g. Bash command compression): {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...}}} - rewriteOutput (post_tool_use only, e.g. WebFetch fencing/redaction, output compression): {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"..."}} - pass: {} This list is the complete producer set from serializeOutput, on purpose: an earlier revision enumerated only four of the five shapes, and the missing one (rewriteOutput) silently shipped dead -- tool.execute.after applied the context append and nothing else, so injection fencing, secret redaction and output compression never reached an opencode session's model. The file loads on opencode v1 (default export {id, server} plus the named TokenGoatPlugin) and on opencode v2 (default export {id, setup}, registering execute.before, execute.after and compaction hooks that translate v2 tool names and argument keys to the v1 ones). */
import { bridgeRelayJs } from "./relay_block.js";

export const OPENCODE_PLUGIN_SCRIPT = `// token-goat bridge plugin for opencode
// Bridges opencode's plugin hooks to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// opencode built-in tool id -> token-goat canonical tool name. websearch/skill/task were re-verified against opencode's own source at the tag matching the installed release (anomalyco/opencode v1.18.16 packages/opencode/src/tool/): WebSearchTool registers as "websearch" (websearch.ts), SkillTool as "skill" (skill.ts), TaskTool as "task" (task.ts, params prompt/subagent_type/description -- the exact keys token-goat's hooks_agent_spawn.ts reads, which registers a lowercase 'task' handler). Unmapped, all three were dead mechanisms here: no WebSearch repeat-search deny/compression, no repeat-skill-load deny, no agent-spawn briefing or report compaction. apply_patch is mapped to Edit (see patchTextPaths below). lsp/plan/question/todo have no token-goat equivalent and stay unmapped.
const TOOL_TO_TG = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  skill: "Skill",
  task: "task",
  apply_patch: "Edit",
}

// Tools with a pre_tool_use handler server-side whose OUTPUT SHAPE this hook can act on: deny (throw), updatedInput (args rewrite), or the Read image-shrink materialization. websearch (repeat-search deny within the dedup TTL, hooks_websearch.ts), skill (repeat-load deny, hooks_skill.ts) and task (briefing updatedInput rewrite, hooks_agent_spawn.ts) all qualify. Edit/Write have no pre-hook at all. Glob DOES have one (preGlobDedupHandler, hooks_glob.ts) -- the old claim here that it has none was stale -- but its only output is an advisory contextOutput hint, and tool.execute.before has no context channel (see the module docblock), so calling it would spawn a subprocess per glob only to drop the answer; it stays excluded for that reason, not the old one.
const PRE_HOOK_TOOLS = new Set(["read", "bash", "grep", "webfetch", "websearch", "skill", "task"])

// opencode tool args (camelCase) -> token-goat snake_case tool_input keys. websearch's query (websearch.ts Parameters), skill's name (skill.ts Parameters; hooks_skill.ts reads tool_input['skill']) and task's prompt/subagent_type/description (task.ts BaseParameterFields) are all from opencode's own schemas at v1.18.16.
const ARGS_TO_TG = {
  read: { filePath: "file_path", offset: "offset", limit: "limit" },
  bash: { command: "command", timeout: "timeout" },
  edit: { filePath: "file_path" },
  write: { filePath: "file_path" },
  grep: { pattern: "pattern", path: "path" },
  glob: { pattern: "pattern", path: "path" },
  webfetch: { url: "url" },
  websearch: { query: "query" },
  skill: { name: "skill" },
  task: { prompt: "prompt", subagent_type: "subagent_type", description: "description" },
}

function reverseArgMap(tool) {
  const fwd = ARGS_TO_TG[tool] ?? {}
  const rev = {}
  for (const [opencodeKey, tgKey] of Object.entries(fwd)) rev[tgKey] = opencodeKey
  return rev
}

// opencode's apply_patch tool (tool/apply_patch.ts, v1.18.33) takes one patchText argument and no per-file path; it is the tool opencode offers GPT models in place of edit and write. The file paths are the header lines of the patch (patch/index.ts parsePatchHeader: "*** Add File: ", "*** Delete File: ", "*** Update File: ", plus "*** Move to: " for a rename), each trimmed and resolved against the instance directory, which is the directory this plugin sends as cwd. A trailing carriage return is dropped by the trim. Left unmapped, an edit a GPT model made was never queued for reindexing.
const PATCH_PATH_HEADERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "]

function patchTextPaths(patchText) {
  const paths = []
  if (typeof patchText !== "string") return paths
  for (const line of patchText.split(String.fromCharCode(10))) {
    for (const header of PATCH_PATH_HEADERS) {
      if (!line.startsWith(header)) continue
      const p = line.slice(header.length).trim()
      if (p && !paths.includes(p)) paths.push(p)
    }
  }
  return paths
}

function toToolInput(tool, args) {
  if (tool === "apply_patch") {
    const paths = patchTextPaths(args && args.patchText)
    return paths.length === 1 ? { file_path: paths[0], file_paths: paths } : { file_paths: paths }
  }
  const map = ARGS_TO_TG[tool] ?? {}
  const out = {}
  for (const [opencodeKey, tgKey] of Object.entries(map)) {
    if (args && args[opencodeKey] !== undefined) out[tgKey] = args[opencodeKey]
  }
  return out
}

${bridgeRelayJs("opencode")}

// Pull the additionalContext / systemMessage string out of a hook response,
// whichever shape it came back as (see the response-contract note above).
function extractContext(resp) {
  if (!resp) return undefined
  const hso = resp.hookSpecificOutput
  if (hso && typeof hso.additionalContext === "string") return hso.additionalContext
  if (typeof resp.systemMessage === "string") return resp.systemMessage
  return undefined
}

function extractUpdatedInput(resp) {
  const hso = resp && resp.hookSpecificOutput
  return hso && typeof hso === "object" ? hso.updatedInput : undefined
}

// The three hook bodies below are shared by the v1 hooks and the v2 setup(), so both generations relay through the same code. They take opencode's v1 tool ids and v1 argument keys; the v2 side translates into those first (V2_TOOLS).

// Returns the argument keys token-goat wants rewritten (keyed the way opencode names them), or undefined. Throws to block the call.
async function preToolUse(directory, tool, sessionID, args) {
  const tg = TOOL_TO_TG[tool]
  if (!tg || !PRE_HOOK_TOOLS.has(tool)) return undefined

  const resp = await callHook("pre_tool_use", {
    session_id: sessionID,
    tool_name: tg,
    tool_input: toToolInput(tool, args),
    cwd: directory,
  })
  if (!resp) return undefined

  if (resp.decision === "block") {
    throw new Error(resp.reason || "blocked by token-goat")
  }

  const updated = extractUpdatedInput(resp)
  if (!updated) return undefined
  const rev = reverseArgMap(tool)
  const rewritten = {}
  for (const [tgKey, val] of Object.entries(updated)) {
    rewritten[rev[tgKey] ?? tgKey] = val
  }
  return rewritten
}

// Returns the tool result text to put back, or undefined to leave the result alone.
async function postToolUse(directory, tool, sessionID, args, text, exitCode) {
  const tg = TOOL_TO_TG[tool]
  if (!tg) return undefined

  const resp = await callHook("post_tool_use", {
    session_id: sessionID,
    tool_name: tg,
    tool_input: toToolInput(tool, args),
    tool_response: { output: text, exit_code: exitCode },
    cwd: directory,
  })
  if (!resp) return undefined

  // rewriteOutput: replace the tool result wholesale. This is the shape every post_tool_use rewrite producer emits (WebFetch injection fencing and secret redaction, websearch redaction, bash/grep output compression, agent-report compaction), and it went unapplied here for the same whitelist reason the response-contract docblock above used to omit it -- the plugin only handled the shapes its author listed, so opencode sessions got the appended hint channel but never a fenced, redacted or compressed result. Mutating output.output is the exact mechanism the context append below already relies on, so this claims no capability the append did not.
  const hso = resp.hookSpecificOutput
  const updatedToolOutput = hso && typeof hso.updatedToolOutput === "string" ? hso.updatedToolOutput : undefined
  if (updatedToolOutput !== undefined) return updatedToolOutput

  const context = extractContext(resp)
  if (context && typeof text === "string") {
    return text + \`\\n\\n[token-goat] \${context}\`
  }
  return undefined
}

// Returns the session manifest to hand opencode before it compacts, or undefined.
async function compactionManifest(sessionID) {
  const resp = await callHook("pre_compact", { session_id: sessionID })
  return resp && typeof resp.systemMessage === "string" && resp.systemMessage ? resp.systemMessage : undefined
}

// opencode v1 (and the v1 loader, which calls the default export's server()): a function returning hooks.
export const TokenGoatPlugin = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      const rewritten = await preToolUse(directory, input.tool, input.sessionID, output.args)
      if (rewritten) Object.assign(output.args, rewritten)
    },

    "tool.execute.after": async (input, output) => {
      const next = await postToolUse(
        directory,
        input.tool,
        input.sessionID,
        input.args,
        output.output,
        output.metadata ? output.metadata.exit : undefined,
      )
      if (next !== undefined) output.output = next
    },

    "experimental.session.compacting": async (input, output) => {
      const manifest = await compactionManifest(input.sessionID)
      if (manifest) output.context.push(manifest)
    },
  }
}

// opencode v2 names its built-in tools and their arguments differently: v2 tool name -> [v1 tool id, v2 argument key -> v1 argument key]. Taken from the .ts files in packages/core/src/tool/plugin in opencode v2.4.1 (each file's exported name and Input schema).
const V2_TOOLS = {
  read: ["read", { path: "filePath" }],
  shell: ["bash", {}],
  grep: ["grep", {}],
  glob: ["glob", {}],
  edit: ["edit", { path: "filePath" }],
  write: ["write", { path: "filePath" }],
  webfetch: ["webfetch", {}],
  websearch: ["websearch", {}],
  skill: ["skill", { id: "name" }],
  subagent: ["task", { agent: "subagent_type" }],
  patch: ["apply_patch", {}],
}

function isRecordValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function renameKeys(source, renames) {
  const out = {}
  for (const [key, val] of Object.entries(source)) out[renames[key] ?? key] = val
  return out
}

function invertKeys(renames) {
  const out = {}
  for (const [from, to] of Object.entries(renames)) out[to] = from
  return out
}

// A v2 tool result carries text in content (a string or a list of parts) or, for a tool with no content, in a string output.
function v2ResultText(result) {
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts = content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text)
    if (texts.length > 0) return texts.join(String.fromCharCode(10))
  }
  return typeof result.output === "string" ? result.output : undefined
}

// The shell tool reports its exit code in its structured output (v2 core/src/tool/plugin/shell.ts: exitCode, null while running).
function v2ExitCode(result) {
  const out = result.output
  return isRecordValue(out) && typeof out.exitCode === "number" ? out.exitCode : undefined
}

// opencode v2: setup() registers the same relays through the v2 hook API (packages/plugin/src/promise/{plugin,tool,session}.ts).
const tokenGoatV2 = {
  id: "token-goat",
  async setup(ctx) {
    const directory = ctx.location.directory

    await ctx.tool.hook("execute.before", async (event) => {
      const entry = V2_TOOLS[event.tool]
      if (!entry || !isRecordValue(event.input)) return
      const [tool, renames] = entry
      const rewritten = await preToolUse(directory, tool, event.sessionID, renameKeys(event.input, renames))
      if (rewritten) event.input = { ...event.input, ...renameKeys(rewritten, invertKeys(renames)) }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const entry = V2_TOOLS[event.tool]
      if (!entry || event.status !== "completed") return
      const [tool, renames] = entry
      const args = isRecordValue(event.input) ? renameKeys(event.input, renames) : {}
      const next = await postToolUse(directory, tool, event.sessionID, args, v2ResultText(event.result), v2ExitCode(event.result))
      if (next !== undefined) event.result = { ...event.result, content: next }
    })

    await ctx.session.hook("compaction", async (event) => {
      const manifest = await compactionManifest(event.sessionID)
      if (manifest) event.system.push({ type: "text", text: manifest })
    })
  },
}

// One default export for both generations: the v2 loader reads id + setup (packages/core/src/plugin/module.ts), the v1 loader reads id + server (packages/opencode/src/plugin/shared.ts readV1Plugin) and ignores setup. The named export above stays for callers that import it directly.
export default { ...tokenGoatV2, server: TokenGoatPlugin }
`
