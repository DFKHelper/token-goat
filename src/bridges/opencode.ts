/**
 * opencode bridge plugin.
 *
 * Unlike Codex (had an existing `CODEX_HOOK_SCRIPT` template) and pi (had a
 * whole real extension already sitting unreferenced in the repo), no opencode
 * bridge code existed anywhere in this repo before this file. It was authored
 * fresh, verified directly against opencode's real source
 * (github.com/anomalyco/opencode -- the project formerly at sst/opencode;
 * GitHub transparently redirects the old path) and
 * https://opencode.ai/docs/plugins/, not secondhand descriptions.
 *
 * opencode's plugin API (packages/plugin/src/index.ts) exposes three hooks
 * relevant here:
 *   - tool.execute.before(input: {tool, sessionID, callID}, output: {args}) => Promise<void>
 *   - tool.execute.after(input: {tool, sessionID, callID, args}, output: {title, output, metadata}) => Promise<void>
 *   - experimental.session.compacting(input: {sessionID}, output: {context, prompt?}) => Promise<void>
 * There is no pre-read context-injection hook like Claude Code's PreToolUse
 * additionalContext -- tool.execute.before can only mutate output.args (or
 * throw to abort the call; opencode's own docs demonstrate this with
 * `throw new Error("Do not read .env files")` inside tool.execute.before, and
 * community plugin guides show the same pattern for blocking `rm -rf`). This
 * is exactly why README's "opencode users" section says session hints don't
 * work here: there is no channel to inject text into the model's context
 * before a read happens.
 *
 * Image shrinking still works despite that gap. token-goat's pre_tool_use
 * response for a shrunk image is a `context` output --
 * `{hookSpecificOutput:{additionalContext: "<summary>\ndata:image/<fmt>;base64,<data>"}}`
 * (see preReadImageHandler in image_shrink.ts) -- built for Claude Code's
 * additionalContext channel, which opencode has no equivalent of. Rather than
 * drop the feature, this plugin decodes the embedded data URL, writes it to a
 * temp file, and rewrites output.args.filePath to point there, so opencode's
 * own `read` tool ends up reading the shrunk copy instead of the original.
 *
 * Real opencode built-in tool ids and parameter keys, confirmed directly
 * against source (not the tool's file name or display name):
 *   read:     filePath, offset, limit                  (tool/read.ts)
 *   write:    filePath, content                          (tool/write.ts)
 *   edit:     filePath, oldString, newString, replaceAll (tool/edit.ts)
 *   bash:     command, timeout, workdir                  (tool/shell.ts registers
 *             under ShellID.ToolID, which -- despite the file being named
 *             shell.ts -- is literally the string "bash": tool/shell/id.ts)
 *   grep:     pattern, path, include                     (tool/grep.ts)
 *   glob:     pattern, path                              (tool/glob.ts)
 *   webfetch: url, format, timeout                       (tool/webfetch.ts)
 *
 * `token-goat hook <event>` only accepts the exact snake_case event names in
 * HOOK_EVENTS (src/types.ts): pre_tool_use, post_tool_use, pre_compact,
 * notification, stop, user_prompt_submit, subagent_stop --
 * relay() (src/relay.ts) checks the event name against that closed set via
 * isHookEventName() and no-ops to `{}` on anything else. This plugin uses
 * those exact names (unlike PI_EXTENSION_SCRIPT's pre-existing
 * "session-start" / "pre-read" / "post-bash" style event names, none of which
 * match HOOK_EVENTS -- every one of those calls currently no-ops).
 *
 * Response contract from `token-goat hook <event>` (src/hook_registry.ts
 * serializeOutput), all confirmed by reading the handlers that actually
 * produce them:
 *   - deny:   {"decision":"block","reason":"..."}
 *   - context (pre_compact / notification): {"systemMessage":"..."}
 *   - context (other events): {"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}
 *   - rewriteInput (pre_tool_use only, e.g. Bash command compression):
 *     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...}}}
 *   - pass: {}
 */
import { BRIDGE_RELAY_JS } from "./relay_block.js";

export const OPENCODE_PLUGIN_SCRIPT = `// token-goat bridge plugin for opencode
// Bridges opencode's plugin hooks to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// opencode built-in tool id -> token-goat canonical tool name.
const TOOL_TO_TG = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
}

// Tools with a real pre_tool_use handler registered server-side (hooks_read.ts,
// image_shrink.ts, hooks_bash.ts, hooks_fetch.ts). Edit/Write have no pre-hook
// in token-goat at all, so skip the subprocess call for them entirely. Glob
// has none either, so it's excluded too rather than spawning a no-op call.
const PRE_HOOK_TOOLS = new Set(["read", "bash", "grep", "webfetch"])

// opencode tool args (camelCase) -> token-goat snake_case tool_input keys.
const ARGS_TO_TG = {
  read: { filePath: "file_path", offset: "offset", limit: "limit" },
  bash: { command: "command", timeout: "timeout" },
  edit: { filePath: "file_path" },
  write: { filePath: "file_path" },
  grep: { pattern: "pattern", path: "path" },
  glob: { pattern: "pattern", path: "path" },
  webfetch: { url: "url" },
}

function reverseArgMap(tool) {
  const fwd = ARGS_TO_TG[tool] ?? {}
  const rev = {}
  for (const [opencodeKey, tgKey] of Object.entries(fwd)) rev[tgKey] = opencodeKey
  return rev
}

function toToolInput(tool, args) {
  const map = ARGS_TO_TG[tool] ?? {}
  const out = {}
  for (const [opencodeKey, tgKey] of Object.entries(map)) {
    if (args && args[opencodeKey] !== undefined) out[tgKey] = args[opencodeKey]
  }
  return out
}

${BRIDGE_RELAY_JS}

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

// Decode a token-goat image-shrink additionalContext payload
// ("<summary>\\ndata:image/<fmt>;base64,<data>") into a real file on disk,
// since tool.execute.before has no context-injection channel to hand the
// shrunk image to the model directly -- only output.args mutation. Returns
// undefined (leaving output.args untouched) if the context isn't a shrink
// payload or anything goes wrong writing it.
function materializeShrunkImage(context) {
  if (typeof context !== "string") return undefined
  const idx = context.indexOf("data:image/")
  if (idx === -1) return undefined
  const match = /^data:image\\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(context.slice(idx).trim())
  if (!match) return undefined
  try {
    const buf = Buffer.from(match[2], "base64")
    const name = \`token-goat-shrink-\${process.pid}-\${Date.now()}-\${Math.random().toString(36).slice(2)}.\${match[1]}\`
    const file = path.join(os.tmpdir(), name)
    fs.writeFileSync(file, buf)
    return file
  } catch {
    return undefined
  }
}

export const TokenGoatPlugin = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      const tg = TOOL_TO_TG[input.tool]
      if (!tg || !PRE_HOOK_TOOLS.has(input.tool)) return

      const resp = await callHook("pre_tool_use", {
        session_id: input.sessionID,
        tool_name: tg,
        tool_input: toToolInput(input.tool, output.args),
        cwd: directory,
      })
      if (!resp) return

      if (resp.decision === "block") {
        throw new Error(resp.reason || "blocked by token-goat")
      }

      const updated = extractUpdatedInput(resp)
      if (updated) {
        const rev = reverseArgMap(input.tool)
        for (const [tgKey, val] of Object.entries(updated)) {
          output.args[rev[tgKey] ?? tgKey] = val
        }
        return
      }

      // Image shrink has no context channel here -- translate it into a
      // rewritten filePath pointing at a materialized shrunk copy instead.
      if (tg === "Read") {
        const shrunkPath = materializeShrunkImage(extractContext(resp))
        if (shrunkPath) output.args.filePath = shrunkPath
      }
    },

    "tool.execute.after": async (input, output) => {
      const tg = TOOL_TO_TG[input.tool]
      if (!tg) return

      const resp = await callHook("post_tool_use", {
        session_id: input.sessionID,
        tool_name: tg,
        tool_input: toToolInput(input.tool, input.args),
        tool_response: { output: output.output, exit_code: output.metadata ? output.metadata.exit : undefined },
        cwd: directory,
      })
      if (!resp) return

      const context = extractContext(resp)
      if (context && typeof output.output === "string") {
        output.output += \`\\n\\n[token-goat] \${context}\`
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const resp = await callHook("pre_compact", { session_id: input.sessionID })
      const manifest = resp && typeof resp.systemMessage === "string" ? resp.systemMessage : undefined
      if (manifest) output.context.push(manifest)
    },
  }
}
`
