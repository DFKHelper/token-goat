import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression (M31): writeParseResult computed the SHA written to the `files` table from a
// SEPARATE, LATER re-read of the file from disk (via fingerprintFile/safeSha), not from the
// content that was actually parsed. If the file changes on disk between the initial
// read-for-parsing and writeParseResult's own read, the recorded SHA does not match the
// symbols actually indexed -- and since the worker's incremental drain skips reindexing a
// file whose SHA is unchanged, a file can get permanently stuck with stale symbols.
//
// This drives the REAL shipping entry points (indexFile / indexFileSync -> writeParseResult),
// not a reimplementation. The only mocked boundary is node:fs.readFileSync itself, which is
// made to answer with two different byte sequences for the SAME path across the two reads a
// pre-fix implementation performs (once to parse, once inside writeParseResult to fingerprint).
// vi.spyOn cannot patch node:fs (its namespace exports are non-configurable), so a module mock
// with a hoisted queue is the portable way to inject this, matching the pattern already used in
// worker_draining_rmfail.test.ts.
const mockState = vi.hoisted(() => ({ target: '', queue: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedReadFileSync = (
    target: fs.PathOrFileDescriptor,
    options?: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | null,
  ): string | Buffer => {
    if (typeof target === 'string' && target === mockState.target && mockState.queue.length > 0) {
      const version = mockState.queue.shift() as string
      return options === 'utf8' ? version : Buffer.from(version, 'utf8')
    }
    return actual.readFileSync(target, options as never)
  }
  return { ...actual, default: actual, readFileSync: guardedReadFileSync }
})

import * as fs from 'node:fs'

import { closeAllDbs } from '../src/db.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { getFileEntry } from '../src/index_reader.js'
import { indexFile, indexFileSync } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'

describe('writeParseResult SHA race (M31)', () => {
  let TMP: string
  let dbPath: string
  let file: string

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parser-sha-race-'))
    dbPath = path.join(TMP, 'index.db')
    file = path.join(TMP, 'race.ts')
    mockState.target = file
    mockState.queue = []
  })

  afterEach(() => {
    mockState.target = ''
    mockState.queue = []
    closeAllDbs()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('indexFileSync records the SHA of the content it actually parsed, not a later re-read', () => {
    const parsedContent = 'export function parsedVersion(): number {\n  return 1\n}\n'
    const laterContent = 'export function laterVersion(): number {\n  return 2\n}\n'
    fs.writeFileSync(file, parsedContent)

    // First readFileSync (indexFileSync's own read, 'utf8') sees the content that gets parsed.
    // Second readFileSync (fingerprintFile's read, no encoding -> Buffer, pre-fix only) would
    // see a file that has since changed -- simulating a concurrent edit landing mid-index.
    mockState.queue = [parsedContent, laterContent]

    indexFileSync(file, dbPath)

    const entry = getFileEntry(file, dbPath)
    expect(entry).not.toBeNull()
    // The stored SHA must match the content whose symbols were actually written...
    expect(entry?.sha).toBe(fingerprintContent(parsedContent))
    // ...never the later content that was never parsed.
    expect(entry?.sha).not.toBe(fingerprintContent(laterContent))

    const hits = querySymbols({ filePath: file }, dbPath)
    expect(hits.map((s) => s.name)).toEqual(['parsedVersion'])
  })

  it('indexFile (async path) records the SHA of the content it actually parsed, not a later re-read', async () => {
    const parsedContent = 'export function asyncParsedVersion(): number {\n  return 1\n}\n'
    const laterContent = 'export function asyncLaterVersion(): number {\n  return 2\n}\n'
    // indexFile's own content read is fs.promises.readFile (a distinct API from the
    // fs.readFileSync guarded above), so it genuinely reads parsedContent straight off disk --
    // exactly like production code would before any concurrent edit lands. The only mocked
    // call left is the SYNC fs.readFileSync a pre-fix fingerprintFile performs afterward to
    // compute the SHA; queuing laterContent there simulates a concurrent edit landing between
    // the parse read and that later re-read.
    fs.writeFileSync(file, parsedContent)
    mockState.queue = [laterContent]

    await indexFile(file, dbPath)

    const entry = getFileEntry(file, dbPath)
    expect(entry).not.toBeNull()
    expect(entry?.sha).toBe(fingerprintContent(parsedContent))
    expect(entry?.sha).not.toBe(fingerprintContent(laterContent))

    const hits = querySymbols({ filePath: file }, dbPath)
    expect(hits.map((s) => s.name)).toEqual(['asyncParsedVersion'])
  })
})
