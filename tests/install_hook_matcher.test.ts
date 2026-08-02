/**
 * `installHooks` must narrow the PreToolUse matcher to the tools token-goat
 * actually handles, and must leave the catch-all everywhere narrowing would
 * silently drop a handler.
 *
 * Claude Code spawns a fresh `token-goat hook ...` process for every matcher
 * hit, and roughly 90% of that process's cost is Node startup plus evaluating
 * the ~3.2 MB bundle -- not the hook's own work. A catch-all matcher therefore
 * pays full price for every tool token-goat has no handler for, which in a real
 * session is ~15% of all tool calls.
 *
 * The matcher is derived from the live hook registry rather than a hand-written
 * list, because a hand-written list is precisely what goes stale: several
 * handlers (MCP dedup, browser image shrink, screenshot redirect) register with
 * no `toolName` at all and match dynamic `mcp__*` names by regex, so omitting
 * them would silently disable MCP dedup rather than fail loudly.
 *
 * PostToolUse deliberately stays on the catch-all: hint_stats.ts registers an
 * advisory handler there that must observe every tool call for hint-expiry
 * accounting. toolMatcherFor reports that as "not narrowable" rather than
 * quietly excluding it -- which is the property these tests pin.
 *
 * These tests import `relay.js` for its side effects, exactly as `cli.ts` does,
 * so the registry is populated the way it is on the real install path. Asserting
 * against an unpopulated registry would pass trivially against any
 * implementation -- the injected-seam trap called out in CLAUDE.md.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toolMatcherFor } from '../src/hook_registry.js'
import { installHooks } from '../src/install.js'

// Side-effect import: registers every hook handler, mirroring cli.ts's own
// top-level `import { relay } from './relay.js'`. Without this the registry is
// empty and every assertion below would be vacuous.
import '../src/relay.js'

let TMP: string
let origCwd: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-matcher-'))
  origCwd = process.cwd()
  process.chdir(TMP)
})

afterEach(() => {
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

interface HookGroup {
  matcher?: string
  hooks: Array<{ type: string; command: string }>
}

function tokenGoatGroup(settingsPath: string, eventKey: string): HookGroup {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    hooks: Record<string, HookGroup[]>
  }
  const groups = settings.hooks[eventKey] ?? []
  const group = groups.find((g) => g.hooks.some((h) => h.command.includes('token-goat hook')))
  expect(group, `no token-goat group written for ${eventKey}`).toBeDefined()
  return group as HookGroup
}

describe('toolMatcherFor', () => {
  it('narrows pre_tool_use to the handled tool set', () => {
    const matcher = toolMatcherFor('pre_tool_use')
    expect(matcher).not.toBeNull()
    expect(matcher).not.toBe('')
  })

  it('covers the statically-registered tools and the dynamic mcp__ handlers', () => {
    const pre = toolMatcherFor('pre_tool_use') ?? ''

    // Representative handlers registered with an explicit toolName, anchored so a
    // name is never matched as a substring of an unrelated tool.
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'WebFetch', 'WebSearch', 'Skill', 'Agent']) {
      expect(pre.split('|'), `pre_tool_use must match ${tool}`).toContain(`^${tool}$`)
    }

    // The MCP dedup and screenshot-redirect handlers register with no toolName and
    // match dynamic mcp__ names by regex. Dropping this alternative silently
    // disables MCP dedup and the screenshot redirect rather than failing loudly.
    expect(pre.split('|')).toContain('^mcp__')
  })

  it('matches every handled tool and no unhandled one', () => {
    // Claude Code evaluates the matcher as an unanchored regex. Pin both directions:
    // a miss silently disables a handler, and a stray match reinstates the wasted
    // process spawn this narrowing exists to remove (TodoWrite vs. the Write handler
    // is the real collision that motivated anchoring).
    const re = new RegExp(toolMatcherFor('pre_tool_use') ?? '')

    for (const tool of ['Read', 'Grep', 'Glob', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Skill', 'Agent']) {
      expect(re.test(tool), `${tool} has a pre_tool_use handler and must match`).toBe(true)
    }
    for (const tool of ['mcp__chrome-devtools__take_screenshot', 'mcp__memory__search_nodes']) {
      expect(re.test(tool), `${tool} is covered by the ^mcp__ fragment`).toBe(true)
    }
    for (const tool of ['TodoWrite', 'SendMessage', 'ScheduleWakeup', 'Monitor', 'TaskUpdate', 'AskUserQuestion']) {
      expect(re.test(tool), `${tool} has no pre_tool_use handler and must not spawn`).toBe(false)
    }
  })

  it('declines to narrow post_tool_use while a handler needs every tool call', () => {
    // hint_stats.ts registers an advisory post_tool_use handler with no tool filter
    // on purpose: hint-expiry counts one unit of window per tool call, including
    // tools token-goat has no other handler for. Narrowing would silently change
    // that accounting, so toolMatcherFor must report "not narrowable" instead.
    expect(toolMatcherFor('post_tool_use')).toBeNull()
  })

  it('returns null for events that carry no tool name', () => {
    for (const event of ['pre_compact', 'user_prompt_submit', 'subagent_stop', 'session_start'] as const) {
      expect(toolMatcherFor(event), `${event} carries no tool name`).toBeNull()
    }
  })

  it('produces a matcher Claude Code evaluates as a regex, not a literal', () => {
    // Claude Code treats a matcher as an exact-name list only while it contains
    // solely [a-zA-Z0-9_-], spaces, commas and pipes; any other character makes
    // it an unanchored JS regex. The '^' in '^mcp__' is what buys us the prefix
    // match, so the assembled matcher must fall on the regex side of that rule.
    const pre = toolMatcherFor('pre_tool_use') ?? ''
    expect(/[^a-zA-Z0-9_\-, |]/.test(pre), 'matcher must contain a regex metacharacter').toBe(true)
    expect(() => new RegExp(pre)).not.toThrow()
  })
})

describe('installHooks matcher narrowing', () => {
  it('writes the narrowed matcher for PreToolUse', () => {
    const result = installHooks('project')
    const group = tokenGoatGroup(result.settingsPath, 'PreToolUse')

    expect(group.matcher, 'PreToolUse must not use the catch-all matcher').not.toBe('')
    expect(group.matcher).toBe(toolMatcherFor('pre_tool_use'))
  })

  it('leaves the catch-all wherever narrowing would drop a handler', () => {
    const result = installHooks('project')

    // PostToolUse: an unfiltered advisory handler still needs every tool call.
    // The rest carry no tool name at all.
    for (const eventKey of ['PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop', 'SessionStart']) {
      const group = tokenGoatGroup(result.settingsPath, eventKey)
      expect(group.matcher, `${eventKey} must stay on the catch-all matcher`).toBe('')
    }
  })

  it('re-narrows an existing catch-all entry from an earlier install', () => {
    // Simulates an install performed by a build that predates the narrowing. Without
    // an upgrade path this feature would only ever reach fresh installs.
    const first = installHooks('project')
    const settings = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8')) as {
      hooks: Record<string, HookGroup[]>
    }
    for (const group of settings.hooks['PreToolUse'] ?? []) group.matcher = ''
    fs.writeFileSync(first.settingsPath, JSON.stringify(settings, null, 2))

    const second = installHooks('project')
    expect(second.alreadyInstalled, 'a re-narrow counts as a change').toBe(false)
    expect(tokenGoatGroup(second.settingsPath, 'PreToolUse').matcher).toBe(toolMatcherFor('pre_tool_use'))
  })

  it('leaves a matcher group the user has added their own hooks to alone', () => {
    const first = installHooks('project')
    const settings = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8')) as {
      hooks: Record<string, HookGroup[]>
    }
    const group = (settings.hooks['PreToolUse'] ?? [])[0] as HookGroup
    group.matcher = 'Bash'
    group.hooks.push({ type: 'command', command: 'my-own-linter.sh' })
    fs.writeFileSync(first.settingsPath, JSON.stringify(settings, null, 2))

    installHooks('project')
    const after = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8')) as {
      hooks: Record<string, HookGroup[]>
    }
    const mixed = (after.hooks['PreToolUse'] ?? []).find((g) =>
      g.hooks.some((h) => h.command === 'my-own-linter.sh'),
    )
    expect(mixed?.matcher, "a user's own matcher must not be rewritten").toBe('Bash')
  })

  it('stays idempotent across repeated installs', () => {
    installHooks('project')
    const second = installHooks('project')
    expect(second.alreadyInstalled).toBe(true)

    const group = tokenGoatGroup(second.settingsPath, 'PreToolUse')
    expect(group.matcher).toBe(toolMatcherFor('pre_tool_use'))
  })
})
