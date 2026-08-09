/**
 * Real hook-registry dispatch coverage for post_tool_use edit handling.
 *
 * tests/hooks_edit.test.ts calls postEditHandler directly, never through
 * runHook -- it also resets the hook registry (clearModuleCaches, wired to
 * hook_registry.ts's clearHooks via registerReset) in beforeEach, which wipes
 * hooks_edit.ts's module-load-time registerHook calls for good and leaves
 * nothing to re-register them, so runHook can never dispatch anything there
 * even if it tried. That means a dropped or mistyped toolName in one of
 * hooks_edit.ts's four `registerHook('post_tool_use', postEditHandler, {
 * toolName: ... })` calls (Write/Edit/MultiEdit/NotebookEdit) would go
 * completely unnoticed by the existing suite -- confirmed empirically:
 * deleting the MultiEdit registration line left the full suite green.
 *
 * This file follows tests/hooks_screenshot.test.ts's precedent instead:
 * import relay.js for its side effect of registering every hook module
 * (including hooks_edit.ts) against the real production registry, and never
 * call clearModuleCaches, so runHook dispatches through real registrations
 * for the lifetime of this file.
 */

import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const _testConfigPath = tempConfigPath('tg-hooks-edit-dispatch-config.toml')

// vi.mock is hoisted -- redirect dataDir()/configPath() to an isolated location so this
// file's real dirty-queue writes never touch the shared per-worker isolated home.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

// Importing relay registers EVERY hook module (including hooks_edit) for its side
// effects, so runHook dispatches through the real production registry -- not a
// test-only handler reference. buildEvent maps a Claude Code payload onto a
// HookEvent exactly as relay() does on stdin.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { dirtyQueuePath, getDirtyPaths } from '../src/hooks_index.js'
import { normalizePath } from '../src/paths.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-edit-dispatch-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  try {
    fs.rmSync(dirtyQueuePath(), { force: true })
  } catch {
    // ok
  }
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ok
  }
})

function editPayload(toolName: string, filePath: string): Record<string, unknown> {
  return { tool_name: toolName, tool_input: { file_path: filePath }, session_id: 'edit-dispatch-test' }
}

describe('post_tool_use edit handling (real runHook dispatch)', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(
    'enqueues the edited path to the dirty queue for tool name %s',
    async (toolName) => {
      // Deliberately NOT under os.tmpdir() (unlike tmpHome, used only for TOKEN_GOAT_HOME
      // isolation above): postEditHandler skips the dirty-queue enqueue entirely for any
      // path under the OS system temp dir (see isUnderSystemTemp), which would otherwise
      // make every one of these assertions pass or fail for the wrong reason.
      const filePath = `/fake-repo/dispatch-${toolName}.ts`
      const result = await runHook(buildEvent('post_tool_use', editPayload(toolName, filePath)))
      expect(result.hookType).toBe('pass')
      expect(getDirtyPaths()).toEqual([normalizePath(filePath)])
    },
  )
})
