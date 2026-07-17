/**
 * Shared helpers for hook handlers (Layers 5+).
 *
 * Ports the small accessor surface of Python's `hooks_common.py`: read tool
 * name / input / file path off a {@link HookEvent}, and build the four
 * {@link HookOutput} variants. The heavier `hooks_common.py` machinery
 * (watchdog, session mutation, stat recording) belongs to later layers.
 */

import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'

/** Return the event's tool name, or `undefined` for non-tool events. */
export function getToolName(event: HookEvent): string | undefined {
  return event.toolName
}

/** Return the event's tool input object (already defaulted to `{}` upstream). */
export function getToolInput(event: HookEvent): Record<string, unknown> {
  return event.toolInput
}

/**
 * Extract the edited/read file path from the tool input.
 *
 * Checks `file_path` first (Read/Edit/Write and most other tools), then
 * falls back to `notebook_path` (NotebookEdit's actual tool-input key) when
 * `file_path` is absent. Returns the string value when present and
 * non-empty, otherwise `undefined`. A non-string value (malformed payload)
 * is treated as absent rather than coerced.
 */
export function getFilePath(event: HookEvent): string | undefined {
  const value = event.toolInput['file_path']
  if (typeof value === 'string' && value !== '') return value
  const notebookValue = event.toolInput['notebook_path']
  return typeof notebookValue === 'string' && notebookValue !== '' ? notebookValue : undefined
}

/** Extract the working directory a hook event's wire payload carries, validated as a string. Replaces six unchecked `event.raw['cwd']` cast sites across hooks_bash.ts/hooks_session.ts/hooks_read.ts (two used `as string | undefined` with no runtime check, so a non-string cwd would throw inside runGit() and be silently swallowed by the caller's try/catch). Returns `undefined` (never a baked-in fallback) so each caller keeps its own default -- hooks_bash.ts wants `null`, hooks_read.ts wants `process.cwd()`. */
export function getCwd(event: HookEvent): string | undefined {
  const value = event.raw && typeof event.raw === 'object' ? event.raw['cwd'] : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Extract a string body from a raw hook event's `tool_response`, trying
 * `keys` in order and returning the first string value found.
 *
 * `tool_response` shapes vary by tool and harness (`output`, `body`, `text`,
 * `content` are all used by different tools) -- callers pass their own
 * priority order rather than this helper guessing one, since a shared
 * default order could silently change which field wins for a caller that
 * genuinely depends on its own priority.
 */
export function extractToolResponseField(raw: Record<string, unknown>, keys: readonly string[]): string {
  const resp = raw['tool_response']
  if (typeof resp === 'string') return resp
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>
    for (const key of keys) {
      if (typeof r[key] === 'string') return r[key] as string
    }
  }
  return ''
}

/** Pull the textual result out of a tool_response payload. Handles the plain string form, the Anthropic MCP `{ content: [{type:'text', text}] }` array (also what Agent/subagent tool results carry, since HookEvent.raw's wire shape is uniform across tool types, not MCP-specific), the common `{output|text|body|content}` string fields, and finally a JSON.stringify fallback so structured results still cache. */
export function extractToolResultText(raw: Record<string, unknown>): string {
  const tr = raw['tool_response']
  if (typeof tr === 'string') return tr
  if (!tr || typeof tr !== 'object') return ''
  const resp = tr as Record<string, unknown>
  const content = resp['content']
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const text = (block as Record<string, unknown>)['text']
        if (typeof text === 'string') parts.push(text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  for (const key of ['output', 'text', 'body']) {
    if (typeof resp[key] === 'string') return resp[key] as string
  }
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(resp)
  } catch {
    return ''
  }
}

/** Build a `pass` output — let the tool call proceed unchanged. */
export function passOutput(): HookOutput {
  return { hookType: 'pass' }
}

/** Build a `deny` output — block the tool call and surface `message`. */
export function denyOutput(message: string): HookOutput {
  return { hookType: 'deny', message }
}

/** Build a `context` output — let the call proceed but inject `context`. */
export function contextOutput(context: string): HookOutput {
  return { hookType: 'context', context }
}
