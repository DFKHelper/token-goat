/** Pre-tool-use hook — `pre_screenshot`: denies MCP screenshot tool calls that don't specify a destination file, redirecting the model to re-issue the call with one. A screenshot returned in-band (no destination path) lands as a raw base64 image directly in the model's context — tens of thousands of tokens for a single call. A screenshot saved to disk and then re-read via `Read` instead flows through the existing image-shrink pipeline ({@link ./image_shrink.js}), which compresses it before it ever reaches the model. Calls that already provide a destination pass through unchanged. Ported from the retired Python implementation's `hooks_screenshot.py::pre_screenshot`. Config: `image_shrink.screenshot_redirect` (default `true`). Registration follows `hooks_mcp.ts`'s pattern for "match a family of MCP tool names": `registerHook` only does an exact, case-sensitive match on a single `toolName`, which cannot express "any tool matching this regex" — so this handler registers with no `toolName` filter (it fires on every `pre_tool_use` event) and does its own regex match against `event.toolName` inside the handler body, exactly like `preMcpHandler`/`postMcpHandler` do for `isMcpReadOnly`. It declares that same regex's source as its `toolPattern`, so the PreToolUse matcher `installHooks` writes starts the hook for exactly the tool names this handler tests for. */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, denyOutput } from './hooks_common.js'
import { loadConfig } from './config.js'
import { nameSubject, sentenceStart } from './hint_suggestion_guard.js'
import { anyCaseSource } from './mcp_tool_pattern.js'

/** Matches any MCP screenshot tool by name, e.g. `mcp__chrome-devtools-mcp_chrome-devtools__take_screenshot` (chrome-devtools-mcp) or `mcp__plugin_playwright_playwright__browser_take_screenshot` (Microsoft's `@playwright/mcp`), or `mcp__some-mcp-server_puppeteer__puppeteer_screenshot` (any tool ending in "screenshot"). Pattern matches any MCP tool ending in "screenshot" in any letter case to catch all naming conventions, spelled through anyCaseSource rather than the `i` flag so the very same source can be the PreToolUse matcher fragment, which has no flags. */
const SCREENSHOT_TOOL_PATTERN = `^${anyCaseSource('mcp__')}.*${anyCaseSource('screenshot')}$`
const SCREENSHOT_TOOL_RE = new RegExp(SCREENSHOT_TOOL_PATTERN)

/** Playwright's `browser_take_screenshot` tool (the actual `@playwright/mcp` package) takes its destination under `filename`, not `filePath`/`file_path` — confirmed against its real tool schema, which differs from chrome-devtools-mcp's `take_screenshot` tool (destination argument: `filePath`). */
const PLAYWRIGHT_SCREENSHOT_RE = /browser_take_screenshot$/i

/** Keys any known MCP screenshot tool might use for its destination-path argument. Any one being a non-empty string counts as "a destination was provided" — lenient on the read side so a caller using an unanticipated MCP server's own convention is never wrongly denied. */
const DESTINATION_KEYS = ['filePath', 'file_path', 'filename']

function hasDestinationPath(toolInput: Record<string, unknown>): boolean {
  for (const key of DESTINATION_KEYS) {
    const value = toolInput[key]
    if (typeof value === 'string' && value !== '') return true
  }
  return false
}

function preScreenshotHandler(event: HookEvent): HookOutput {
  if (!loadConfig().image_shrink.screenshot_redirect) return passOutput()

  const toolName = getToolName(event)
  if (!toolName || !SCREENSHOT_TOOL_RE.test(toolName)) return passOutput()

  const toolInput = getToolInput(event)
  if (hasDestinationPath(toolInput)) return passOutput()

  const paramName = PLAYWRIGHT_SCREENSHOT_RE.test(toolName) ? 'filename' : 'filePath'
  return denyOutput(
    `${sentenceStart(nameSubject('tool', toolName))} was called with no destination file, so the screenshot would land raw in context (tens of thousands of tokens). Re-issue it with \`${paramName}\` set to an absolute path, then Read the saved file — the read is automatically compressed by token-goat's image-shrink pipeline.`,
  )
}

// The handler's own regex, verbatim: the installed matcher starts this hook for exactly the names the handler acts on, where the bare `^mcp__` prefix it declared before started it for every MCP call.
registerHook('pre_tool_use', preScreenshotHandler, { toolPattern: SCREENSHOT_TOOL_PATTERN })
