import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../../src/bridges/codex.js'
import { HOOK_EVENTS, type HookEventName } from '../../src/types.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function mkIsolated(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-test-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Extracts the quoted string literals inside a `new Set([...])` / `[...]` array literal that
 * appears in `source` right after `label`, e.g. `VALID_HOOK_EVENTS = new Set([` -> the event
 * name strings inside it. Used to check the shim's hardcoded allowlist against the real
 * HOOK_EVENTS enum without needing a JS parser.
 */
function extractQuotedList(source: string, label: string): string[] {
  const start = source.indexOf(label)
  expect(start, `expected to find "${label}" in the shim source`).toBeGreaterThanOrEqual(0)
  const openBracket = source.indexOf('[', start)
  const closeBracket = source.indexOf(']', openBracket)
  const body = source.slice(openBracket, closeBracket)
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * Runs a bridge shim's embedded script exactly as the external harness (Claude Code / Codex)
 * would: as a standalone Node process invoked with the event name as argv[2] and the hook
 * payload on stdin. Returns what it printed on stdout. An optional `env` lets a test swap out
 * what the shim's own internal `token-goat hook <event>` call resolves to (see
 * `withFakeTokenGoat` below), instead of hitting the real installed binary.
 */
function runShim(script: string, eventName: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const scriptPath = join(cwd, 'shim.js')
  writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    input: '{}',
    encoding: 'utf8',
    timeout: 15000,
    env: env ?? process.env,
  })
  return res.stdout ?? ''
}

/**
 * Writes a fake `token-goat` executable into `cwd` and returns a PATH-prepended env pointing
 * at it, so a shim's internal `spawnSync('token-goat hook ' + eventName, { shell: true })`
 * resolves to `jsonStdout` instead of the real installed binary. Windows/Linux both resolve
 * `shell: true` commands via PATH rather than the child's cwd (verified empirically -- a
 * same-named file placed only in cwd is NOT picked up), so PATH must be prepended, not just
 * the fake binary dropped next to the shim script.
 */
function withFakeTokenGoat(cwd: string, jsonStdout: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    writeFileSync(join(cwd, 'token-goat.cmd'), `@echo off\r\necho ${jsonStdout}\r\n`, 'utf8')
  } else {
    const scriptPath = join(cwd, 'token-goat')
    writeFileSync(scriptPath, `#!/bin/sh\necho '${jsonStdout}'\n`, 'utf8')
    chmodSync(scriptPath, 0o755)
  }
  return { ...process.env, PATH: cwd + delimiter + (process.env['PATH'] ?? '') }
}

describe('bridge hook shims', () => {
  describe.each([
    ['CLAUDECODE_HOOK_SCRIPT', CLAUDECODE_HOOK_SCRIPT],
    ['CODEX_HOOK_SCRIPT', CODEX_HOOK_SCRIPT],
  ])('%s', (_name, script) => {
    it('validates eventName against a closed allowlist before building the shell command', () => {
      const guardIndex = script.indexOf('VALID_HOOK_EVENTS')
      const shellCallIndex = script.indexOf("spawnSync('token-goat hook ' + eventName")
      expect(guardIndex).toBeGreaterThanOrEqual(0)
      expect(shellCallIndex).toBeGreaterThan(guardIndex)
    })

    it('still uses shell: true (needed on Windows to resolve the token-goat .cmd/.bat shim)', () => {
      expect(script).toContain('shell: true')
    })

    it('keeps its hardcoded event allowlist in sync with HOOK_EVENTS', () => {
      const allowlisted = extractQuotedList(script, 'VALID_HOOK_EVENTS')
      expect(allowlisted.sort()).toEqual([...HOOK_EVENTS].sort())
    })

    it('rejects a malicious eventName without ever reaching the shell, so no injected command runs', () => {
      const cwd = mkIsolated()
      const markerPath = join(cwd, 'INJECTED_MARKER.txt')
      const malicious = 'pre_tool_use & echo pwned>' + markerPath
      const stdout = runShim(script, malicious, cwd)
      expect(stdout.trim()).toBe('{}')
      expect(existsSync(markerPath)).toBe(false)
    })

    it('rejects an eventName that is merely a prefix/suffix of a real event', () => {
      const cwd = mkIsolated()
      const stdout = runShim(script, 'pre_tool_use_extra', cwd)
      expect(stdout.trim()).toBe('{}')
    })
  })
})

describe('CODEX_HOOK_SCRIPT hookEventName casing (regression: the shim previously injected the raw snake_case argv event name -- e.g. "pre_tool_use" -- into hookSpecificOutput.hookEventName when the child token-goat process omitted it, instead of the PascalCase spelling ("PreToolUse") that CLAUDE_CODE_EVENT_NAMES in src/hook_registry.ts actually emits on the live/wired token-goat hook <event> path)', () => {
  const EXPECTED_PASCAL_CASE: Record<HookEventName, string> = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    notification: 'Notification',
    stop: 'Stop',
    pre_compact: 'PreCompact',
    user_prompt_submit: 'UserPromptSubmit',
    subagent_stop: 'SubagentStop',
  }

  it('maps every HOOK_EVENTS entry to its PascalCase spelling when the child process omits hookEventName', () => {
    for (const eventName of HOOK_EVENTS) {
      const cwd = mkIsolated()
      const env = withFakeTokenGoat(cwd, '{"hookSpecificOutput":{"additionalContext":"x"}}')
      const stdout = runShim(CODEX_HOOK_SCRIPT, eventName, cwd, env)
      const parsed = JSON.parse(stdout)
      expect(parsed.hookSpecificOutput.hookEventName).toBe(EXPECTED_PASCAL_CASE[eventName])
      expect(parsed.hookSpecificOutput.hookEventName).not.toBe(eventName)
    }
  })

  it('does not override hookEventName when the child process already set one', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      '{"hookSpecificOutput":{"hookEventName":"AlreadySetByHandler","additionalContext":"x"}}',
    )
    const stdout = runShim(CODEX_HOOK_SCRIPT, 'pre_tool_use', cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('AlreadySetByHandler')
  })
})
