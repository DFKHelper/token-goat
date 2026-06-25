/**
 * Shared helpers for hook handlers (Layers 5+).
 *
 * Ports the small accessor + classifier surface of Python's `hooks_common.py`:
 * read tool name / input / file path off a {@link HookEvent}, classify a tool
 * name into the Read/Edit/Write/Bash families, and build the four
 * {@link HookOutput} variants. The heavier `hooks_common.py` machinery
 * (watchdog, session mutation, stat recording) belongs to later layers.
 */

import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'

/**
 * Canonical tool names per family.
 *
 * Bridges normalize harness-specific aliases (Codex `bash`, `edit_file`,
 * `write_file`; Gemini variants) to these PascalCase names before the event
 * reaches a handler, so membership checks here are exact and case-sensitive.
 */
const READ_TOOLS: ReadonlySet<string> = new Set(['Read'])
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit'])
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write'])
const BASH_TOOLS: ReadonlySet<string> = new Set(['Bash'])

/** Return the event's tool name, or `undefined` for non-tool events. */
export function getToolName(event: HookEvent): string | undefined {
  return event.toolName
}

/** Return the event's tool input object (already defaulted to `{}` upstream). */
export function getToolInput(event: HookEvent): Record<string, unknown> {
  return event.toolInput
}

/**
 * Extract `file_path` from the tool input.
 *
 * Returns the string value when present and non-empty, otherwise `undefined`.
 * A non-string `file_path` (malformed payload) is treated as absent rather
 * than coerced.
 */
export function getFilePath(event: HookEvent): string | undefined {
  const value = event.toolInput['file_path']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** True when `toolName` is a read-family tool (Read). */
export function isReadTool(toolName: string | undefined): boolean {
  return toolName !== undefined && READ_TOOLS.has(toolName)
}

/** True when `toolName` is an edit-family tool (Edit). */
export function isEditTool(toolName: string | undefined): boolean {
  return toolName !== undefined && EDIT_TOOLS.has(toolName)
}

/** True when `toolName` is a write-family tool (Write). */
export function isWriteTool(toolName: string | undefined): boolean {
  return toolName !== undefined && WRITE_TOOLS.has(toolName)
}

/** True when `toolName` is the Bash tool. */
export function isBashTool(toolName: string | undefined): boolean {
  return toolName !== undefined && BASH_TOOLS.has(toolName)
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
