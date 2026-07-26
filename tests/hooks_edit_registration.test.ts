/**
 * Confirms postEditHandler is actually wired into the hook registry for every
 * edit-tool name via the real, production-only import side effect in
 * hooks_edit.ts — not a hand-registered stand-in that could pass even if the
 * real registerHook() call site were missing an alias.
 *
 * Isolated in its own file (rather than added to hooks_edit.test.ts) because
 * it needs a fresh, unmocked hook_registry.js module instance: importing it
 * fresh from an already-warm test file risks other tests in that file
 * silently inheriting a second registry instance whose handlers never get
 * cleared by the outer beforeEach's clearModuleCaches().
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-edit-reg-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

describe('hooks_edit.ts registration (real registry, real import side effect)', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(
    'dispatches a %s post_tool_use event to postEditHandler and enqueues the file for reindex',
    async (toolName) => {
      const { runHook } = await import('../src/hook_registry.js')
      await import('../src/hooks_edit.js')
      const { getDirtyPaths } = await import('../src/hooks_index.js')
      const { normalizePath } = await import('../src/paths.js')
      const { makeHookEvent } = await import('./helpers/hook-event.js')

      const rawPath = toolName === 'NotebookEdit' ? `/a/nb-${toolName}.ipynb` : `/a/f-${toolName}.ts`
      const toolInput =
        toolName === 'NotebookEdit' ? { notebook_path: rawPath } : { file_path: rawPath }
      const event = makeHookEvent({
        eventName: 'post_tool_use',
        toolName,
        toolInput,
        sessionId: 'test',
      })

      const result = await runHook(event)

      expect(result.hookType).toBe('pass')
      expect(getDirtyPaths()).toContain(normalizePath(rawPath))
    },
  )
})
