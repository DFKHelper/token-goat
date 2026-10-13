/** The installed PreToolUse matcher used to carry `^mcp__`, so Claude Code started a hook process for every MCP call although the two PreToolUse handlers that look at MCP tools act only on read-verb methods (preMcpHandler, through isMcpReadOnly) and on screenshot tools (preScreenshotHandler): all 1,409 measured PreToolUse mcp__* runs printed `{}`. Each handler's matcher fragment is now built from the same source as its own decision, so these tests pin both directions: the tools neither handler acts on stay out of the matcher, and a sweep over names generated from the read-verb list proves every tool either handler really acts on (driven through runHook, not a predicate restated here) is still matched. Importing relay registers every hook module, so toolMatcherFor reads the production registry. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEvent } from '../src/relay.js'
import { runHook, toolMatcherFor } from '../src/hook_registry.js'
import { READ_VERBS } from '../src/mcp_cache.js'

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pre-mcp-matcher-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `pre-mcp-${path.basename(tmpHome)}`
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

/** Claude Code evaluates a matcher holding any regex metacharacter as an unanchored, case-sensitive JavaScript regex. */
function preMatcher(): RegExp {
  const matcher = toolMatcherFor('pre_tool_use')
  expect(matcher).not.toBeNull()
  return new RegExp(matcher ?? '')
}

/** Whether some PreToolUse handler acts on `toolName`: a read-only call is seeded through the real post hook first, so preMcpHandler's dedup has something to deny, and a screenshot call carries no destination, so preScreenshotHandler has something to redirect. */
async function preActsOn(toolName: string): Promise<boolean> {
  const toolInput = { q: toolName }
  await runHook(buildEvent('post_tool_use', { tool_name: toolName, tool_input: toolInput, session_id: sessionId, tool_response: `result of ${toolName}` }))
  const pre = await runHook(buildEvent('pre_tool_use', { tool_name: toolName, tool_input: toolInput, session_id: sessionId }))
  return pre.hookType !== 'pass'
}

describe('PreToolUse matcher for MCP tools', () => {
  it('leaves out the MCP tools neither PreToolUse handler acts on', async () => {
    const re = preMatcher()
    for (const tool of [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_evaluate',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_run_code_unsafe',
      'mcp__gmail__gmail_create_draft',
      'mcp__claude_ai_Google_Drive__copy_file',
    ]) {
      expect(await preActsOn(tool), `${tool} is acted on, so this list is wrong`).toBe(false)
      expect(re.test(tool), `${tool} has no PreToolUse handler that acts on it and must not spawn one`).toBe(false)
    }
  })

  it('still matches the MCP tools they do act on', async () => {
    const re = preMatcher()
    for (const tool of ['mcp__gmail__gmail_search', 'mcp__x__get_thing', 'mcp__x__take_screenshot', 'mcp__claude_ai_Google_Drive__read_file_content']) {
      expect(await preActsOn(tool), `${tool} should be acted on`).toBe(true)
      expect(re.test(tool), `${tool} is acted on and must be matched`).toBe(true)
    }
  })

  it('matches every name a PreToolUse handler acts on, swept from the read-verb list in every case and position', async () => {
    const re = preMatcher()
    const candidates: string[] = []
    for (const verb of READ_VERBS) {
      const upper = verb.toUpperCase()
      const title = verb[0]?.toUpperCase() + verb.slice(1)
      candidates.push(
        `mcp__srv__${verb}`,
        `mcp__srv__${verb}_things`,
        `mcp__srv__things_${verb}`,
        `mcp__srv__a_${verb}_b`,
        `mcp__${verb}_things`,
        `mcp__claude_ai_Gmail__${verb}_message`,
        `mcp__plugin_x_y__${verb}`,
        `mcp__SRV__${upper}_THINGS`,
        `mcp__srv__${title}_things`,
        `mcp__srv__${verb}things`,
      )
    }
    candidates.push(
      'mcp__x__screenshot',
      'mcp__x__TAKE_SCREENSHOT',
      'mcp__x__Screenshot',
      'MCP__x__screenshot',
      'mcp__plugin_playwright_playwright__browser_take_screenshot',
      'mcp__chrome-devtools-mcp_chrome-devtools__take_screenshot',
      'mcp__some-mcp-server_puppeteer__puppeteer_screenshot',
    )
    const acted: string[] = []
    for (const tool of candidates) {
      if (!(await preActsOn(tool))) continue
      acted.push(tool)
      expect(re.test(tool), `${tool} is acted on by a PreToolUse handler but the installed matcher would never fire it`).toBe(true)
    }
    // Non-vacuous: every verb in every handled shape, plus all seven screenshot names, reached a handler.
    expect(acted.length).toBeGreaterThanOrEqual(READ_VERBS.length * 9 + 7)
  })

  it('keeps ^mcp__ on PostToolUse, where the handlers rewrite most MCP results', () => {
    const post = new RegExp(toolMatcherFor('post_tool_use') ?? '')
    for (const tool of ['mcp__playwright__browser_navigate', 'mcp__gmail__gmail_create_draft', 'mcp__x__anything']) {
      expect(post.test(tool), `${tool} reaches a PostToolUse handler`).toBe(true)
    }
  })
})
