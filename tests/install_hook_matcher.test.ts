/**
 * `installHooks` must narrow the PreToolUse matcher to the tools token-goat
 * actually handles, and must leave the catch-all everywhere narrowing would
 * silently drop a handler.
 *
 * Claude Code spawns a fresh hook process for every matcher hit, and roughly
 * 90% of that process's cost is Node startup plus evaluating the ~3.2 MB bundle
 * -- not the hook's own work. A catch-all matcher therefore
 * pays full price for every tool token-goat has no handler for, which in a real
 * session is ~15% of all tool calls.
 *
 * The matcher is derived from the live hook registry rather than a hand-written
 * list, because a hand-written list is precisely what goes stale: several
 * handlers (MCP dedup, browser image shrink, screenshot redirect) register with
 * no `toolName` at all and match dynamic `mcp__*` names by regex, so omitting
 * them would silently disable MCP dedup rather than fail loudly.
 *
 * The safety rule is that an unfiltered handler forces the catch-all, since
 * narrowing would silently stop firing it. hint_stats.ts's advisory PostToolUse
 * handler opts out of that rule explicitly (`followsMatcher`) after weighing the
 * consequence: its hint-expiry window then counts observed tool calls rather than
 * all of them. These tests pin both halves -- that the opt-in narrows PostToolUse,
 * and that a handler which merely forgets a filter still forces the catch-all, so
 * the mechanism cannot fail open.
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

import { registerHook, toolMatcherFor } from '../src/hook_registry.js'
import { claudeHookScriptPath, installHooks } from '../src/install.js'

// Side-effect import: registers every hook handler, mirroring cli.ts's own
// top-level `import { relay } from './relay.js'`. Without this the registry is
// empty and every assertion below would be vacuous.
import '../src/relay.js'

let TMP: string
let origCwd: string
let origHome: string | undefined
let origUserProfile: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-matcher-'))
  origCwd = process.cwd()
  process.chdir(TMP)
  // installHooks writes the generated shim under os.homedir(); pin it to the temp dir so this suite cannot touch the developer's real ~/.claude/hooks.
  origHome = process.env['HOME']
  origUserProfile = process.env['USERPROFILE']
  const fakeHome = path.join(TMP, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
})

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = origHome
  if (origUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = origUserProfile
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
  // Match on the generated shim path rather than a literal command string: the wired command bakes in this node binary and entry path, neither of which this test can spell.
  const group = groups.find((g) => g.hooks.some((h) => h.command.includes(claudeHookScriptPath())))
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

  it('narrows post_tool_use to the handled tool set', () => {
    const post = toolMatcherFor('post_tool_use')
    expect(post).not.toBeNull()

    const parts = (post ?? '').split('|')
    for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'TaskOutput']) {
      expect(parts, `post_tool_use must match ${tool}`).toContain(`^${tool}$`)
    }
    expect(parts).toContain('^mcp__')
  })

  it('still refuses to narrow when an unfiltered handler has not opted in', () => {
    // The safety rule itself must stay live: hint_stats opts out explicitly via
    // followsMatcher, and that opt-out is what makes post_tool_use narrowable. A
    // handler that simply forgets a tool filter must still force the catch-all,
    // otherwise this whole mechanism fails open.
    registerHook('notification', () => ({ hookType: 'pass' }))
    expect(toolMatcherFor('notification')).toBeNull()
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
  it('writes the narrowed matcher for both tool events', () => {
    const result = installHooks('project')

    for (const [eventKey, event] of [
      ['PreToolUse', 'pre_tool_use'],
      ['PostToolUse', 'post_tool_use'],
    ] as const) {
      const group = tokenGoatGroup(result.settingsPath, eventKey)
      expect(group.matcher, `${eventKey} must not use the catch-all matcher`).not.toBe('')
      expect(group.matcher).toBe(toolMatcherFor(event))
    }
  })

  it('leaves the catch-all on events that carry no tool name', () => {
    const result = installHooks('project')

    for (const eventKey of ['PreCompact', 'UserPromptSubmit', 'SubagentStop', 'SessionStart']) {
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
