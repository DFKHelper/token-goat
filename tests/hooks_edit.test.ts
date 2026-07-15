import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-edit-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

const { postEditHandler } = await import('../src/hooks_edit.js')
const { dirtyQueuePath, getDirtyPaths, clearDirtyQueue } = await import('../src/hooks_index.js')
const { normalizePath } = await import('../src/paths.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { compactPathFor, isCompactFresh, writeCompact, buildExtractiveCompact } = await import(
  '../src/doc_compact.js'
)
const session = await import('../src/session.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')

function editEvent(filePath: string | undefined, toolName = 'Edit'): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName,
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
  })
}

beforeEach(() => {
  clearModuleCaches()
  clearDirtyQueue()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

afterEach(() => {
  clearDirtyQueue()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
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

  it('fires for NotebookEdit and records the edit via notebook_path', () => {
    const event = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'NotebookEdit',
      toolInput: { notebook_path: '/a/notebook.ipynb' },
      sessionId: 'test',
    })

    const result = postEditHandler(event)

    expect(result.hookType).toBe('pass')
    const normalized = normalizePath('/a/notebook.ipynb')
    const entry = session.getSessionFiles().get(normalized)
    expect(entry).toBeDefined()
    expect(entry?.wasEdited).toBe(true)
    expect(getDirtyPaths()).toEqual([normalized])
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

  it('does not crash when appendDirtyPath throws (e.g. disk full) — still records the edit', () => {
    // Simulate a transient fs failure (disk full / permission / Windows file lock) by
    // replacing the queue directory itself with a plain file, so the appendFileSync
    // inside appendDirtyPath hits a real ENOTDIR error instead of a mocked one.
    const queueDir = path.dirname(dirtyQueuePath())
    fs.rmSync(queueDir, { recursive: true, force: true })
    fs.writeFileSync(queueDir, 'blocked')
    try {
      expect(() => postEditHandler(editEvent('/a/file.ts'))).not.toThrow()
      const result = postEditHandler(editEvent('/a/file.ts'))
      expect(result.hookType).toBe('pass')
      const normalized = normalizePath('/a/file.ts')
      const entry = session.getSessionFiles().get(normalized)
      expect(entry).toBeDefined()
      expect(entry?.wasEdited).toBe(true)
    } finally {
      fs.rmSync(queueDir, { force: true })
    }
  })

  it('still returns the markdown context hint when appendDirtyPath throws', () => {
    const queueDir = path.dirname(dirtyQueuePath())
    fs.rmSync(queueDir, { recursive: true, force: true })
    fs.writeFileSync(queueDir, 'blocked')
    try {
      const result = postEditHandler(editEvent('/project/README.md'))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('README.md')
      }
    } finally {
      fs.rmSync(queueDir, { force: true })
    }
  })

  it('escapes double quotes in the file path within the markdown hint (in addition to backticks)', () => {
    const rawPath = '/project/say "hi"/README.md'
    const result = postEditHandler(editEvent(rawPath))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      // Quotes inside the path must be escaped the same way backticks already are,
      // so the emitted `token-goat section "..."` command stays well-formed instead
      // of the raw quote breaking out of the surrounding quoted argument.
      expect(result.context).toContain('say \\"hi\\"')
      expect(result.context).not.toContain('say "hi"')
    }
  })

  it('suppresses the markdown re-read hint when the edited file is smaller than hints.min_session_hint_savings_bytes', () => {
    const tmpFile = path.join(DATA_DIR, 'small.md')
    fs.writeFileSync(tmpFile, '# tiny\n')
    const orig = process.env['TOKEN_GOAT_SESSION_HINT_MIN_BYTES']
    try {
      process.env['TOKEN_GOAT_SESSION_HINT_MIN_BYTES'] = '999999'
      invalidateConfigCache()
      const result = postEditHandler(editEvent(tmpFile))
      expect(result.hookType).toBe('pass')
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_SESSION_HINT_MIN_BYTES']
      } else {
        process.env['TOKEN_GOAT_SESSION_HINT_MIN_BYTES'] = orig
      }
      invalidateConfigCache()
      fs.rmSync(tmpFile, { force: true })
    }
  })
})

describe('postEditHandler — stable-doc compact staleness marking', () => {
  function makeSourceFile(content = '# Title\nBody text.\n'): string {
    const p = path.join(DATA_DIR, `src-${Math.random().toString(36).slice(2)}.md`)
    fs.writeFileSync(p, content)
    return p
  }

  it('marks a fresh compact sidecar stale after the source file is edited', () => {
    const src = makeSourceFile()
    const compactPath = compactPathFor(src)
    writeCompact(compactPath, src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))
    expect(isCompactFresh(compactPath, src)).toBe(true)

    postEditHandler(editEvent(src))

    expect(isCompactFresh(compactPath, src)).toBe(false)
  })

  it('is a no-op (does not throw) when no sidecar exists for the edited file', () => {
    const src = makeSourceFile()
    expect(() => postEditHandler(editEvent(src))).not.toThrow()
    expect(isCompactFresh(compactPathFor(src), src)).toBe(false)
  })

  it('does not mark stale when stable_doc_compacts is disabled', () => {
    fs.writeFileSync(TEST_CONFIG_PATH, '[hints]\nstable_doc_compacts = false\n')
    invalidateConfigCache()

    const src = makeSourceFile()
    const compactPath = compactPathFor(src)
    writeCompact(compactPath, src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))
    expect(isCompactFresh(compactPath, src)).toBe(true)

    postEditHandler(editEvent(src))

    expect(isCompactFresh(compactPath, src)).toBe(true)
  })
})
