import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeSource, encodeSource } from '../src/encoding.js'
import { normalizePath } from '../src/paths.js'
import { readWindowFromDisk } from '../src/hooks_read_slice.js'
import { makeHookEvent } from './helpers/hook-event.js'

function decodedWindow(text: string, offset: number, limit: number): string {
  const lineStarts = [0]
  const lineEnds: number[] = []
  const newline = /\r\n|\r|\n/g
  let match: RegExpExecArray | null
  while ((match = newline.exec(text)) !== null) {
    lineEnds.push(match.index)
    lineStarts.push(match.index + match[0].length)
  }
  const firstLine = offset - 1
  if (firstLine >= lineStarts.length) return ''
  const lastLine = Math.min(firstLine + limit - 1, lineStarts.length - 1)
  return text.slice(lineStarts[firstLine]!, lineEnds[lastLine] ?? text.length)
}

describe('readWindowFromDisk', () => {
  let dir: string
  let target: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tg-read-window-'))
    target = path.join(dir, 'source.txt')
    writeFileSync(target, 'zero\none\ntwo\nthree\n', 'utf8')
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('preserves small-file slicing behavior for carriage-return-only content', () => {
    writeFileSync(target, 'first\rsecond', 'utf8')

    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset: 1, limit: 1 } }),
      normalizePath(target),
    )

    expect(window).toBe('first\rsecond')
  })

  it('returns large unbounded reads intact', () => {
    const content = `first\r${'x'.repeat(256 * 1024)}\rthird`
    writeFileSync(target, content, 'utf8')

    const expected = decodeSource(fs.readFileSync(target))
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target } }),
      normalizePath(target),
    )

    expect(window).toBe(expected)
  })

  it.each([
    { offset: 1, limit: 1 },
    { offset: 1, limit: 2 },
    { offset: 2, limit: 1 },
    { offset: 3, limit: 1 },
    { offset: 5, limit: 1 },
    { offset: 6, limit: 1 },
  ])('streams a large UTF-8 window at $offset/$limit with full-decode parity', ({ offset, limit }) => {
    const content =
      '\uFEFF' +
      'a'.repeat(65_532) +
      '\r\n' +
      'b'.repeat(65_534) +
      'é' +
      'c'.repeat(128) +
      '\r' +
      'third\n' +
      'f'.repeat(200 * 1024) +
      '\nend'
    writeFileSync(target, content, 'utf8')

    const decoded = decodeSource(fs.readFileSync(target))
    const expected = decodedWindow(decoded, offset, limit)
    const fileSize = Buffer.byteLength(content, 'utf8')
    expect(fileSize).toBeGreaterThan(256 * 1024)
    expect(fileSize).toBeLessThanOrEqual(2 * 1024 * 1024)

    const readSyncSpy = vi.spyOn(fs, 'readSync')
    const closeSyncSpy = vi.spyOn(fs, 'closeSync')
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset, limit } }),
      normalizePath(target),
    )

    expect(window).toBe(expected)
    expect(readSyncSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 64 * 1024, null)
    expect(closeSyncSpy).toHaveBeenCalledTimes(1)
  })

  it('stops reading once an early bounded window is satisfied', () => {
    const content = `first\n${'x'.repeat(256 * 1024)}`
    writeFileSync(target, content, 'utf8')

    const readSyncSpy = vi.spyOn(fs, 'readSync')
    const closeSyncSpy = vi.spyOn(fs, 'closeSync')
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset: 1, limit: 1 } }),
      normalizePath(target),
    )

    expect(window).toBe('first')
    expect(readSyncSpy).toHaveBeenCalledTimes(1)
    expect(readSyncSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 64 * 1024, null)
    expect(closeSyncSpy).toHaveBeenCalledTimes(1)
  })

  it('closes the file descriptor when a streaming read fails', () => {
    writeFileSync(target, 'x'.repeat(256 * 1024 + 1), 'utf8')

    const readSyncSpy = vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw new Error('injected read failure')
    })
    const closeSyncSpy = vi.spyOn(fs, 'closeSync')

    expect(() =>
      readWindowFromDisk(
        makeHookEvent({ toolInput: { file_path: target, offset: 1, limit: 1 } }),
        normalizePath(target),
      ),
    ).toThrow('injected read failure')
    expect(readSyncSpy).toHaveBeenCalledTimes(1)
    expect(closeSyncSpy).toHaveBeenCalledTimes(1)
  })

  it('streams a UTF-16LE window with a split surrogate pair and full-decode parity', () => {
    const content =
      'a'.repeat(32_766) +
      '\r\n' +
      'b'.repeat(32_766) +
      '💖' +
      '\r' +
      'third\n' +
      'f'.repeat(130 * 1024)
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
    writeFileSync(target, bytes)

    const decoded = decodeSource(fs.readFileSync(target))
    const expected = decodedWindow(decoded, 2, 1)
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024)
    expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)

    const readSyncSpy = vi.spyOn(fs, 'readSync')
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset: 2, limit: 1 } }),
      normalizePath(target),
    )

    expect(window).toBe(expected)
    expect(readSyncSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 64 * 1024, null)
  })

  it('detects a UTF-32 BOM when the first disk read is partial', () => {
    const content = `first\r\nsecond\n${'x'.repeat(70 * 1024)}`
    const bytes = encodeSource(content, 'utf32le')
    writeFileSync(target, bytes)

    const expected = decodedWindow(decodeSource(fs.readFileSync(target)), 2, 1)
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024)

    const originalReadSync = fs.readSync.bind(fs)
    const readSyncSpy = vi.spyOn(fs, 'readSync').mockImplementationOnce(
      (fd, buffer) => originalReadSync(fd, buffer, { offset: 0, length: 1, position: null }),
    )
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset: 2, limit: 1 } }),
      normalizePath(target),
    )

    expect(window).toBe(expected)
    expect(readSyncSpy).toHaveBeenCalled()
  })

  it('treats a trailing carriage return as a line break at EOF', () => {
    const content = `first\n${'x'.repeat(256 * 1024)}\r`
    writeFileSync(target, content, 'utf8')

    const decoded = decodeSource(fs.readFileSync(target))
    const expected = decodedWindow(decoded, 3, 1)
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(256 * 1024)

    const readSyncSpy = vi.spyOn(fs, 'readSync')
    const window = readWindowFromDisk(
      makeHookEvent({ toolInput: { file_path: target, offset: 3, limit: 1 } }),
      normalizePath(target),
    )

    expect(window).toBe(expected)
    expect(readSyncSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 64 * 1024, null)
  })
})
