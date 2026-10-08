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

  it('does not enqueue an edit under the OS system temp dir to the dirty-reindex queue (scratch checkouts must never become permanent index citizens)', () => {
    const scratchFile = path.join(os.tmpdir(), 'tg-scratch-checkout', 'src', 'index.ts')
    const result = postEditHandler(editEvent(scratchFile))
    expect(result.hookType).toBe('pass')
    expect(getDirtyPaths()).toEqual([])
  })

  it('still records session read-tracking for an edit under system temp, even though it is not enqueued for indexing', () => {
    const scratchFile = path.join(os.tmpdir(), 'tg-scratch-checkout', 'src', 'index.ts')
    postEditHandler(editEvent(scratchFile))
    const normalized = normalizePath(scratchFile)
    const entry = session.getSessionFiles().get(normalized)
    expect(entry).toBeDefined()
    expect(entry?.wasEdited).toBe(true)
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
      expect(result.context).toContain('token-goat read')
      expect(result.context).toContain('::1-80')
    }
  })

  // HAND-DERIVED: the hint read "Run `token-goat section \"/project/README.md::HeadingName\"` to re-read a specific section rather than the full file. README.md was edited.", the base name repeated as loose text after the command that already names the file.
  it('names the edited file only inside its command, and says "This file" in the sentence after it', () => {
    const result = postEditHandler(editEvent('/project/README.md'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toMatch(/ This file was edited\.$/)
      expect(result.context.split('README.md')).toHaveLength(2)
    }
  })

  it('returns contextOutput with markdown hint when editing .mdx files', () => {
    const result = postEditHandler(editEvent('/project/component.mdx'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('component.mdx')
      expect(result.context).toContain('token-goat read')
    }
  })

  it('returns contextOutput with markdown hint when editing .markdown files', () => {
    const result = postEditHandler(editEvent('/project/guide.markdown'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('guide.markdown')
      expect(result.context).toContain('token-goat read')
    }
  })

  it('returns contextOutput with markdown hint when editing .rst files', () => {
    const result = postEditHandler(editEvent('/project/docs.rst'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('docs.rst')
      expect(result.context).toContain('token-goat read')
    }
  })

  it('returns pass for non-markdown file edits', () => {
    const result = postEditHandler(editEvent('/project/src/index.ts'))
    expect(result.hookType).toBe('pass')
  })

  it('does not crash when appendDirtyPath throws (e.g. disk full) — still records the edit', () => {
    // Simulate a transient fs failure (disk full / permission / Windows file lock) by replacing the queue directory itself with a plain file, so the appendFileSync inside appendDirtyPath hits a real ENOTDIR error instead of a mocked one.
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

  it('single-quotes a file path holding double quotes within the markdown hint', () => {
    const rawPath = '/project/say "hi"/README.md'
    const result = postEditHandler(editEvent(rawPath))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      // HAND-DERIVED: single quotes hold a `"` literally in bash and PowerShell, so the emitted `token-goat read` command stays one argument instead of the raw quote breaking out of a double-quoted one; a backslash escape is not one PowerShell reads.
      expect(result.context).toContain(`token-goat read '/project/say "hi"/README.md::1-80'`)
      expect(result.context).not.toContain('"/project/say')
      expect(result.context).not.toContain('\\"')
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

describe('postEditHandler — section hint repeats', () => {
  // HAND-DERIVED from a transcript measurement: across one week of this machine's Claude Code sessions, the same `CHANGELOG.md was edited` hint was injected 17 times in one session with identical text, the largest exact repeat token-goat put into context.
  it('gives the section hint for one markdown file once per session, not on every edit', () => {
    expect(postEditHandler(editEvent('/project/CHANGELOG.md')).hookType).toBe('context')
    expect(postEditHandler(editEvent('/project/CHANGELOG.md')).hookType).toBe('pass')
    expect(postEditHandler(editEvent('/project/CHANGELOG.md', 'Write')).hookType).toBe('pass')
  })

  it('still gives it for a different markdown file in the same session', () => {
    expect(postEditHandler(editEvent('/project/CHANGELOG.md')).hookType).toBe('context')
    expect(postEditHandler(editEvent('/project/README.md')).hookType).toBe('context')
  })

  it('gives it again after a compaction, which takes the earlier hint out of context', () => {
    expect(postEditHandler(editEvent('/project/CHANGELOG.md')).hookType).toBe('context')
    session.markCompacted(Date.now() + 1000)
    expect(postEditHandler(editEvent('/project/CHANGELOG.md')).hookType).toBe('context')
  })

  it('still records the edit and queues the reindex when the hint is withheld', () => {
    postEditHandler(editEvent('/project/CHANGELOG.md'))
    clearDirtyQueue()
    postEditHandler(editEvent('/project/CHANGELOG.md'))
    const queued = getDirtyPaths()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatch(/\/project\/CHANGELOG\.md$/)
  })
})
