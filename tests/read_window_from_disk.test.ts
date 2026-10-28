import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizePath } from '../src/paths.js'
import { readWindowFromDisk } from '../src/hooks_read_slice.js'
import { makeHookEvent } from './helpers/hook-event.js'

describe('readWindowFromDisk', () => {
  let dir: string
  let target: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tg-read-window-'))
    target = path.join(dir, 'source.txt')
    writeFileSync(target, 'zero\none\ntwo\nthree\n', 'utf8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    { offset: 1, limit: 1, expected: 'zero' },
    { offset: 2, limit: 2, expected: 'one\ntwo' },
    { offset: 3, expected: 'two\nthree\n' },
    { offset: 5, limit: 1, expected: '' },
    { offset: 4, limit: 4, expected: 'three\n' },
  ])('returns the same line window for $offset/$limit', ({ offset, limit, expected }) => {
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset, limit } }),
      normalizePath(target),
    )
    expect(window).toBe(expected)
  })

  it.each([
    { content: '', offset: 1, limit: 1 },
    { content: 'a\n\nb\n', offset: 2, limit: 2 },
    { content: 'a\nb', offset: 2, limit: 5 },
    { content: 'a\nb', offset: 6, limit: 2 },
  ])('matches prior slicing semantics for edge content at offset $offset', ({ content, offset, limit }) => {
    writeFileSync(target, content, 'utf8')
    const expected = content.split('\n').slice(offset - 1, offset - 1 + limit).join('\n')
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset, limit } }),
      normalizePath(target),
    )
    expect(window).toBe(expected)
  })
})
