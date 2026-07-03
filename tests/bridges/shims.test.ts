import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../../src/bridges/codex.js'
import { HOOK_EVENTS } from '../../src/types.js'

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
 * payload on stdin. Returns what it printed on stdout.
 */
function runShim(script: string, eventName: string, cwd: string): string {
  const scriptPath = join(cwd, 'shim.js')
  writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    input: '{}',
    encoding: 'utf8',
    timeout: 15000,
  })
  return res.stdout ?? ''
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
