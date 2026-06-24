import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead, wasFileReadThisSession } from '../src/session.js'

const tmpFiles: string[] = []

function makeTmpFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string | undefined): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
    raw: {},
  }
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
})

describe('preReadHandler', () => {
  it('returns pass when no file_path in input', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('returns a re-read context hint when the file was already read', () => {
    const p = makeTmpFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read this session')
      expect(result.context).toContain('token-goat read/section/symbol')
    }
  })

  it('returns a large-file context hint for files >100KB', () => {
    const p = makeTmpFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
      expect(result.context).toContain('token-goat skeleton')
    }
  })

  it('returns pass for a small, never-read file', () => {
    const p = makeTmpFile('small')
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('records the read on every call', () => {
    const p = makeTmpFile('small')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    preReadHandler(readEvent(p))
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)

    // A second call (now a re-read) still records, bumping the count.
    preReadHandler(readEvent(p))
    preReadHandler(readEvent(p))
    // Three handler calls => three recorded reads.
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
  })

  it('does not record when file_path is missing', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })
})
