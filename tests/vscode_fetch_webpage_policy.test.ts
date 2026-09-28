/** VS Code's fetch_webpage takes a list of URLs, so the WebFetch policy has to judge every one of them. The pre-fetch handler read a single `url` key, which fetch_webpage never sends: mapped naively, a call naming an allowed page and a denied one would pass on the strength of the first, and a call naming several would pass unjudged. PROVENANCE: FORMAT-DERIVED, VS Code 1.137.0. The tool name is `FetchWebPage="fetch_webpage"` in the ToolName enum of resources/app/extensions/copilot/dist/extension.js, and its input `{urls: string[], query: string}` is copilot_fetchWebPage's inputSchema in resources/app/extensions/copilot/package.json. The envelope (hook_event_name, tool_name, tool_input, tool_use_id) is ChatHookService.executePreToolUseHook's in that extension.js. URLs are HAND-DERIVED. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { normalizePayload } from '../src/hooks_cli.js'
import { preFetchHandler } from '../src/hooks_fetch.js'
import { buildEvent } from '../src/relay.js'
import { clearModuleCaches } from '../src/reset.js'

function fetchWebpage(urls: string[]): ReturnType<typeof buildEvent> {
  const payload = { timestamp: '2026-09-28T00:00:00.000Z', hook_event_name: 'PreToolUse', session_id: 'vs-fetch', tool_name: 'fetch_webpage', tool_input: { urls, query: 'what does it say' }, tool_use_id: 'tu-f', cwd: process.cwd() }
  return buildEvent('pre_tool_use', normalizePayload(payload, 'vscode'))
}

beforeEach(() => {
  delete process.env['TOKEN_GOAT_WEBFETCH_DENY']
  delete process.env['TOKEN_GOAT_WEBFETCH_ALLOW']
  clearModuleCaches()
})

afterEach(() => {
  delete process.env['TOKEN_GOAT_WEBFETCH_DENY']
  delete process.env['TOKEN_GOAT_WEBFETCH_ALLOW']
  clearModuleCaches()
})

describe('fetch_webpage on VS Code is judged URL by URL', () => {
  it('denies a call when a later URL in the list matches webfetch.deny', () => {
    process.env['TOKEN_GOAT_WEBFETCH_DENY'] = 'https://blocked.example/*'
    const out = preFetchHandler(fetchWebpage(['https://fine.example/a', 'https://blocked.example/secret']))
    expect(out.hookType).toBe('deny')
  })

  it('denies a call when any URL falls outside a non-empty webfetch.allow', () => {
    process.env['TOKEN_GOAT_WEBFETCH_ALLOW'] = 'https://intra.example/*'
    const out = preFetchHandler(fetchWebpage(['https://intra.example/doc', 'https://elsewhere.example/doc']))
    expect(out.hookType).toBe('deny')
  })

  it('refuses a cloud metadata endpoint anywhere in the list, with no policy configured', () => {
    const out = preFetchHandler(fetchWebpage(['https://fine.example/a', 'http://169.254.169.254/latest/meta-data/']))
    expect(out.hookType).toBe('deny')
  })

  it('control: passes a list whose every URL the policy allows', () => {
    process.env['TOKEN_GOAT_WEBFETCH_ALLOW'] = 'https://intra.example/*'
    const out = preFetchHandler(fetchWebpage(['https://intra.example/a', 'https://intra.example/b']))
    expect(out.hookType).toBe('pass')
  })
})
