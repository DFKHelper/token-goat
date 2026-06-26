import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-edit-'))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR }
})

const { postEditHandler } = await import('../src/hooks_edit.js')
const { dirtyQueuePath, getDirtyPaths, clearDirtyQueue } = await import('../src/hooks_index.js')
const { normalizePath } = await import('../src/paths.js')
const { clearModuleCaches } = await import('../src/reset.js')
const session = await import('../src/session.js')

function editEvent(filePath: string | undefined, toolName = 'Edit'): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName,
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
    raw: {},
  }
}

beforeEach(() => {
  clearModuleCaches()
  clearDirtyQueue()
})

afterEach(() => {
  clearDirtyQueue()
})

describe('postEditHandler', () => {
  it('returns pass for non-markdown files and context for markdown files', () => {
    expect(postEditHandler(editEvent('/a/file.ts')).hookType).toBe('pass')
    expect(postEditHandler(editEvent(undefined)).hookType).toBe('pass')
    expect(postEditHandler(editEvent('/a/file.md')).hookType).toBe('context')
  })

  it('records the edit with the normalized path', () => {
    const raw = '/a/b/../file.ts'
    postEditHandler(editEvent(raw))
    const normalized = normalizePath(raw)
    const entry = session.getSessionFiles().get(normalized)
    expect(entry).toBeDefined()
    expect(entry?.wasEdited).toBe(true)
  })

  it('appends the normalized path to dirty.txt', () => {
    postEditHandler(editEvent('/a/one.ts'))
    expect(fs.existsSync(dirtyQueuePath())).toBe(true)
    expect(getDirtyPaths()).toEqual([normalizePath('/a/one.ts')])
  })

  it('handles a missing file_path without touching the queue', () => {
    const result = postEditHandler(editEvent(undefined))
    expect(result.hookType).toBe('pass')
    expect(getDirtyPaths()).toEqual([])
  })

  it('fires for both Write and Edit tool names', () => {
    postEditHandler(editEvent('/a/w.ts', 'Write'))
    postEditHandler(editEvent('/a/e.ts', 'Edit'))
    expect(getDirtyPaths()).toEqual([normalizePath('/a/w.ts'), normalizePath('/a/e.ts')])
  })

  it('returns contextOutput with markdown hint when editing .md files', () => {
    const result = postEditHandler(editEvent('/project/README.md'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('README.md')
      expect(result.context).toContain('was edited')
      expect(result.context).toContain('token-goat section')
      expect(result.context).toContain('HeadingName')
    }
  })

  it('returns contextOutput with markdown hint when editing .mdx files', () => {
    const result = postEditHandler(editEvent('/project/component.mdx'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('component.mdx')
      expect(result.context).toContain('token-goat section')
    }
  })

  it('returns contextOutput with markdown hint when editing .markdown files', () => {
    const result = postEditHandler(editEvent('/project/guide.markdown'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('guide.markdown')
      expect(result.context).toContain('token-goat section')
    }
  })

  it('returns contextOutput with markdown hint when editing .rst files', () => {
    const result = postEditHandler(editEvent('/project/docs.rst'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('docs.rst')
      expect(result.context).toContain('token-goat section')
    }
  })

  it('returns pass for non-markdown file edits', () => {
    const result = postEditHandler(editEvent('/project/src/index.ts'))
    expect(result.hookType).toBe('pass')
  })
})
