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
