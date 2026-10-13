/** HAND-DERIVED: the expected file names are spelled out by hand from the sidecar suffixes, not read from the implementation's path function for the shim side. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { COPILOT_SESSION_START_HELPERS } from '../src/bridges/copilot_session_start.js'
import type { HookEvent } from '../src/hook_registry.js'
import { resetSessionStartOwed } from '../src/session_start_owed.js'
import { sessionSidecarPath } from '../src/session_store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function event(sessionId: string): HookEvent {
  return { eventName: 'session_start', toolName: undefined, toolInput: {}, sessionId, agentId: undefined, raw: {} }
}

function shimReset(payload: unknown): void {
  const run = new Function('require', COPILOT_SESSION_START_HELPERS + '\nreturn resetSessionStartOwedFiles')(createRequire(import.meta.url)) as (p: unknown) => void
  run(payload)
}

function plantBoth(sessionId: string): string[] {
  const paths = ['.session-start', '.session-start-owed'].map((suffix) => sessionSidecarPath(sessionId, suffix))
  for (const path of paths) {
    expect(path).not.toBeNull()
    mkdirSync(join(path as string, '..'), { recursive: true })
    writeFileSync(path as string, '{}', 'utf8')
  }
  return paths as string[]
}

describe('the shim reset removes exactly what the TypeScript reset removes', () => {
  // Ids with characters the sanitizer rewrites, and one past the 64-character cap.
  for (const id of ['plain-id_1', 'copilot-0123456789abcdef', 'with space/and:colon.dots', 'x'.repeat(90)]) {
    it(`id ${id.slice(0, 24)} (${id.length} chars)`, () => {
      const viaShim = plantBoth(id)
      shimReset({ session_id: id })
      expect(viaShim.map((p) => existsSync(p))).toEqual([false, false])
      const viaTs = plantBoth(id)
      resetSessionStartOwed(event(id))
      expect(viaTs.map((p) => existsSync(p))).toEqual([false, false])
    })
  }

  it('leaves a subagent key alone', () => {
    const files = plantBoth('parent-1')
    shimReset({ session_id: 'parent-1', agent_id: 'sub-1' })
    expect(files.map((p) => existsSync(p))).toEqual([true, true])
  })
})

describe('the generated shim resets before it spawns the helper', () => {
  it('removes the marker and the claim even though the helper cannot start', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-owed-reset-'))
    tempDirs.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const shimPath = join(root, 'token-goat-shim.cjs')
    writeFileSync(shimPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
    const sessionId = 'shim-reset-session'
    const stems = ['.session-start', '.session-start-owed'].map((suffix) => join(home, 'sessions', `${sessionId}${suffix}`))
    mkdirSync(join(home, 'sessions'), { recursive: true })
    for (const stem of stems) writeFileSync(stem, '{}', 'utf8')
    const result = spawnSync(process.execPath, [shimPath, 'sessionStart', join(root, 'missing-entry.mjs')], {
      input: JSON.stringify({ sessionId, cwd: root }),
      env: { ...process.env, TOKEN_GOAT_HOME: home, TOKEN_GOAT_HOOK_SERVER: '0', TOKEN_GOAT_NATIVE_HOOKS: '0' },
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.stdout).toBe('{}')
    expect(stems.map((p) => existsSync(p))).toEqual([false, false])
  })
})
