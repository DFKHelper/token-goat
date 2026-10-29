import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordRecentReadRange } from '../src/read_range_evasion.js'
import { recordFileEdit, recordFileLineRange, recordFileRead } from '../src/session.js'
import { foldPath } from '../src/util.js'
import { makeHookEvent } from './helpers/hook-event.js'

let dir: string
let target: string

function makeTarget(extension = '.ts'): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-paging-ratchet-'))
  target = path.join(dir, 'sample' + extension)
  fs.writeFileSync(target, Array.from({ length: 60 }, (_, i) => `line ${i + 1}: ${'x'.repeat(80)}`).join('\n') + '\n')
  return target
}

function event(
  eventName: 'pre_tool_use' | 'post_tool_use',
  options: { offset?: number; limit?: number; content?: string } = {},
) {
  const toolInput: Record<string, unknown> = { file_path: target }
  if (options.offset !== undefined) toolInput['offset'] = options.offset
  if (options.limit !== undefined) toolInput['limit'] = options.limit
  return makeHookEvent({
    eventName,
    toolName: 'Read',
    toolInput,
    raw: { tool_response: { content: options.content ?? '' } },
  })
}

function rendered(from: number, to: number): string {
  const lines = fs.readFileSync(target, 'utf8').split('\n')
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const number = from + index
    return `${number}\t${lines[number - 1] ?? ''}`
  }).join('\n')
}

beforeEach(() => {
  clearModuleCaches()
  makeTarget()
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('read paging ratchets', () => {
  it('uses a real symbol in the overlapping-range deny when available', () => {
    fs.writeFileSync(target, Array.from({ length: 60 }, (_, i) => `function fn${i + 1}() {}`).join('\n') + '\n')
    indexFileSync(target)
    recordFileRead(normalizePath(target))
    recordRecentReadRange(foldPath(normalizePath(target)), [10, 19])
    recordRecentReadRange(foldPath(normalizePath(target)), [100, 109])
    recordRecentReadRange(foldPath(normalizePath(target)), [200, 209])

    const result = preReadHandler(event('pre_tool_use', { offset: 12, limit: 7 }))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('overlapping line-range paging detected')
      expect(result.message).not.toContain('::Symbol')
      expect(result.message).toContain('fn12')
    }
  })

  it('adds a diff hint to sequential paging guidance for a file edited this session', () => {
    const normalized = normalizePath(target)
    recordFileEdit(normalized)
    recordFileRead(normalized, false)
    recordFileLineRange(normalized, 1, 10)
    recordFileLineRange(normalized, 11, 20)

    const result = preReadHandler(event('pre_tool_use', { offset: 21, limit: 10 }))

    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Recently edited')
      expect(result.context).toContain('git diff HEAD --')
      expect(result.context).toContain('token-goat changed --symbol')
    }
  })

  it('adds a diff hint to the hard sequential-paging denial for a file edited this session', () => {
    const normalized = normalizePath(target)
    recordFileEdit(normalized)
    recordFileRead(normalized, false)
    recordFileLineRange(normalized, 1, 10)
    recordFileLineRange(normalized, 11, 20)
    recordFileLineRange(normalized, 21, 30)

    const result = preReadHandler(event('pre_tool_use', { offset: 31, limit: 10 }))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Sequential line-range paging detected')
      expect(result.message).toContain('Recently edited')
      expect(result.message).toContain('git diff HEAD --')
    }
  })

  it('uses the content-aware reread response instead of a count-only third-read denial', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    makeTarget('.bin')
    expect(preReadHandler(event('pre_tool_use')).hookType).not.toBe('deny')
    expect(preReadHandler(event('pre_tool_use')).hookType).not.toBe('deny')

    const third = preReadHandler(event('pre_tool_use'))

    expect(third.hookType).toBe('context')
    if (third.hookType === 'context') {
      expect(third.context).toContain('already read this session')
    }
  })

  it('hard-denies instead of emitting partial redaction notices when at least half the requested rows were served', () => {
    postReadHandler(event('post_tool_use', { offset: 1, limit: 20, content: rendered(1, 20) }))

    const result = postReadHandler(event('post_tool_use', { offset: 1, limit: 40, content: rendered(1, 40) }))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('At least half of this requested line range was already served')
      expect(result.message).not.toContain('already served verbatim in this session; withheld here')
    }
  })
})
