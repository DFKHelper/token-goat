/**
 * Wire-format shaping for VS Code's agent hooks (the built-in Copilot agent, VS Code 1.136+).
 *
 * VS Code reads a subset of the Claude Code response shape, and it is a strict subset: every field
 * below was read out of ChatHookService in resources/app/extensions/copilot/dist/extension.js
 * (VS Code 1.136.0), not assumed from Claude Code's documentation.
 *
 * - PreToolUse reads only `hookSpecificOutput`: `permissionDecision` (allow/ask/deny) with
 *   `permissionDecisionReason`, `updatedInput`, and `additionalContext`. A top-level
 *   `decision: "block"` is ignored there, so a Claude-shaped deny would let the call run.
 *   `updatedInput` is applied on its own (no decision needed) after a schema check against the
 *   tool's input schema, so it must use the tool's own key names.
 * - PostToolUse reads `hookSpecificOutput.additionalContext` and a top-level `decision: "block"`.
 *   It has no field that replaces the tool result: `updatedToolOutput` is never read.
 * - Stop and SubagentStop read `decision`/`reason` from inside `hookSpecificOutput`.
 * - SessionStart and UserPromptSubmit read `hookSpecificOutput.additionalContext`.
 * - A `hookSpecificOutput` whose `hookEventName` names a different event is dropped.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HookEventName, HookOutput } from '../types.js'
import type { HookEvent } from '../hook_registry.js'
import { VSCODE_TOOL_NAME_KEY, vscodeNativeToolInput } from '../hooks_cli.js'

/** The VS Code tool the model called, as stashed by normalizePayload's vscode branch; undefined for non-tool events. */
export function vscodeToolName(event: HookEvent | undefined): string | undefined {
  const name = event?.raw[VSCODE_TOOL_NAME_KEY]
  return typeof name === 'string' ? name : undefined
}

const SHRINK_PREFIX = 'token-goat-shrink-'
const MATERIALIZED_MAX_AGE_MS = 60 * 60 * 1000

/** Delete this mechanism's own temp copies older than an hour; the prefix confines the sweep to files it wrote. */
function pruneMaterialized(): void {
  const now = Date.now()
  try {
    const dir = os.tmpdir()
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(SHRINK_PREFIX)) continue
      const full = path.join(dir, file)
      try {
        const st = fs.statSync(full)
        if (st.isFile() && now - st.mtimeMs > MATERIALIZED_MAX_AGE_MS) fs.unlinkSync(full)
      } catch {
        // One bad entry must not stop the sweep.
      }
    }
  } catch {
    // A readdir failure must not stop the write below.
  }
}

/**
 * Write the shrunk image in an image-shrink context ("<summary>\ndata:image/<fmt>;base64,<data>") to a temp file.
 *
 * Typed twin of materializeShrunkImage in shrink_block.ts. The file name comes from pid, time and a
 * random UUID, never from the source image's name, and the suffix's character class admits no path
 * separator. Returns undefined when the context is not a shrink payload or the write fails.
 */
export function materializeShrunkImageFile(context: string): string | undefined {
  const idx = context.indexOf('data:image/')
  if (idx === -1) return undefined
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(context.slice(idx).trim())
  if (!match) return undefined
  try {
    pruneMaterialized()
    const file = path.join(os.tmpdir(), `${SHRINK_PREFIX}${process.pid}-${Date.now()}-${crypto.randomUUID()}.${match[1]!}`)
    fs.writeFileSync(file, Buffer.from(match[2]!, 'base64'))
    return file
  } catch {
    return undefined
  }
}

/** Events whose decision fields VS Code reads from inside `hookSpecificOutput` rather than the top level. */
const NESTED_DECISION_EVENTS = new Set<HookEventName>(['stop', 'subagent_stop'])

/**
 * Serialize a token-goat hook result into the response VS Code's agent reads.
 *
 * `hookEventName` is the PascalCase event name VS Code expects to see echoed back (the same names
 * Claude Code uses). Anything VS Code has no channel for becomes `{}` rather than a field it would
 * silently ignore: a result rewrite, a stop-event context note, or a base64 image payload.
 */
export function serializeVscodeOutput(
  output: HookOutput,
  eventName: HookEventName,
  hookEventName: string,
  event?: HookEvent,
): string {
  switch (output.hookType) {
    case 'deny':
      if (eventName === 'pre_tool_use') {
        return JSON.stringify({
          hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: output.message },
        })
      }
      if (NESTED_DECISION_EVENTS.has(eventName)) {
        return JSON.stringify({ hookSpecificOutput: { hookEventName, decision: 'block', reason: output.message } })
      }
      return JSON.stringify({ decision: 'block', reason: output.message })
    case 'context': {
      if (NESTED_DECISION_EVENTS.has(eventName)) return '{}'
      // Same systemMessage form serializeOutput gives these two everywhere else; VS Code never fires either through the Copilot hooks file, so this only keeps the contract uniform.
      if (eventName === 'pre_compact' || eventName === 'notification') return JSON.stringify({ systemMessage: output.context })
      // preReadImageHandler writes the shrunk copy itself on VS Code and answers view_image with a rewriteInput, so a base64 payload reaching here has no channel and would only cost tokens as context text.
      if (eventName === 'pre_tool_use' && output.context.includes('data:image/')) return '{}'
      return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: output.context } })
    }
    case 'rewriteInput': {
      const tool = vscodeToolName(event)
      const updatedInput = tool === undefined ? output.updatedInput : vscodeNativeToolInput(tool, output.updatedInput)
      // No permissionDecision: VS Code applies updatedInput on its own, and sending 'allow' would skip the user's own confirmation for the call.
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } })
    }
    case 'rewriteOutput':
      return '{}'
    case 'pass':
      return '{}'
  }
}
