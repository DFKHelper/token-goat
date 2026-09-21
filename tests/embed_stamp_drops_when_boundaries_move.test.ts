/**
 * A file's embedding chunks are cut on its symbol rows (buildEmbeddingBoundaries), so a reparse that extracts a DIFFERENT symbol set from byte-identical content leaves the stored chunks -- and their vectors -- drawn on cuts that no longer exist. That is what a language adapter edit produces: it moves the language's PARSER_FINGERPRINT and reparses the file, while EMBED_FINGERPRINT deliberately stays put, and `isEmbedFresh` then reads the unchanged content sha as "already embedded" forever.
 *
 * Captured against the built bundle before the fix (dist/token-goat.mjs, isolated LOCALAPPDATA + TOKEN_GOAT_HOME, one 15-line .lua file): with src/languages/lua.ts's FUNC_RE neutered and the fingerprints regenerated, `token-goat index` reparsed the file to symbols `alpha:1-5, beta:7-10` (gamma gone) while `chunks` kept `1-6, 7-11, 12-15` all stamped kind `symbol`, and files.embed_sha stayed equal to files.sha. The same run under `--force` produced the truth: `1-6:symbol, 7-10:symbol, 11-15:window`. Two of three stored chunks were wrong, one of them claiming a symbol span with no symbol in it.
 *
 * writeParseResult now compares the boundary set across the reparse and drops the carried embed_sha when it moved, which is per-file and exact in both directions -- the global digest cannot be the answer, since moving it re-embeds every already-embedded file on the machine for what is a per-language, often per-file change.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { disabledEmbedSha, indexFileSync } from '../src/parser.js'

// PROVENANCE: HAND-DERIVED. Three Lua functions with blank lines between them, written so each gets its own symbol row and so the spans are visibly distinct; nothing here is read off the adapter's own patterns.
const LUA_SOURCE = [
  'local function alpha(x)',
  '  return x + 1',
  'end',
  '',
  'local function beta(y)',
  '  return y * 2',
  'end',
  '',
  'function gamma(z)',
  '  return z - 1',
  'end',
  '',
].join('\n')

// PROVENANCE: HAND-DERIVED. Two headings, so the markdown file has section structure of its own; its embedding boundaries come from these headings, never from symbol rows.
const MD_SOURCE = ['# One', '', 'first body', '', '## Two', '', 'second body', ''].join('\n')

let dir: string
let dbPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-boundary-stamp-'))
  dbPath = path.join(dir, 'index.db')
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

function storedStamps(): { sha: string | null; embedSha: string | null } {
  const row = getDb(dbPath).prepare('SELECT sha, embed_sha FROM files').get() as
    | { sha: string | null; embed_sha: string | null }
    | undefined
  return { sha: row?.sha ?? null, embedSha: row?.embed_sha ?? null }
}

/** Stand in for indexFileEmbeddings having really embedded this content: the stamp it writes on success is the bare content sha. */
function markReallyEmbedded(): string {
  const { sha } = storedStamps()
  expect(sha, 'indexFileSync wrote no files row, so the rest of this test would assert on nothing').not.toBeNull()
  getDb(dbPath).prepare('UPDATE files SET embed_sha = sha').run()
  return sha as string
}

/** Replace the stored symbol rows with a single span that covers the whole file, standing in for the symbol set a previous version of the language adapter wrote for the same bytes. */
function rewriteStoredSymbolsAsOneSpan(filePath: string): void {
  const db = getDb(dbPath)
  db.prepare('DELETE FROM symbols').run()
  db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(filePath, 'wholeFile', 'function', 1, 12, '', '', '')
}

describe('embed stamp vs embedding boundaries', () => {
  it('keeps the embed stamp when a reparse leaves the file symbol spans exactly where they were', () => {
    const file = path.join(dir, 'mod.lua')
    fs.writeFileSync(file, LUA_SOURCE)
    indexFileSync(file, dbPath)
    const sha = markReallyEmbedded()
    const before = getDb(dbPath).prepare('SELECT count(*) AS n FROM symbols').get() as { n: number }
    expect(before.n, 'the lua adapter extracted no symbols, so this test could not tell a moved boundary from an empty one').toBeGreaterThan(0)

    indexFileSync(file, dbPath)

    expect(storedStamps().embedSha, 'a reparse that changes nothing about the file boundaries must not throw away its embedding -- that is the waste the carried stamp exists to prevent').toBe(sha)
  })

  it('drops the embed stamp when a reparse moves the symbol spans its chunks were cut on', () => {
    const file = path.join(dir, 'mod.lua')
    fs.writeFileSync(file, LUA_SOURCE)
    indexFileSync(file, dbPath)
    markReallyEmbedded()
    const indexedPath = (getDb(dbPath).prepare('SELECT path FROM files').get() as { path: string }).path
    rewriteStoredSymbolsAsOneSpan(indexedPath)

    indexFileSync(file, dbPath)

    expect(storedStamps().embedSha, 'the stored chunks were cut on a symbol span this reparse no longer produces, so carrying the stamp forward pins vectors to boundaries that no longer exist').toBeNull()
  })

  it('keeps a marker stamp across a boundary move, since a marker describes a file with no boundary-cut chunks at all', () => {
    const file = path.join(dir, 'mod.lua')
    fs.writeFileSync(file, LUA_SOURCE)
    indexFileSync(file, dbPath)
    const { sha } = storedStamps()
    getDb(dbPath).prepare('UPDATE files SET embed_sha = ?').run(disabledEmbedSha(sha as string))
    const indexedPath = (getDb(dbPath).prepare('SELECT path FROM files').get() as { path: string }).path
    rewriteStoredSymbolsAsOneSpan(indexedPath)

    indexFileSync(file, dbPath)

    expect(storedStamps().embedSha, 'a disabled-marker stamp names no chunks, so a boundary move says nothing about it and dropping it only re-enters indexFileEmbeddings to derive the same marker again').toBe(disabledEmbedSha(sha as string))
  })

  it('keeps the embed stamp for markdown, whose boundaries come from headings in unchanged content rather than from symbol rows', () => {
    const file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, MD_SOURCE)
    indexFileSync(file, dbPath)
    const sha = markReallyEmbedded()
    const indexedPath = (getDb(dbPath).prepare('SELECT path FROM files').get() as { path: string }).path
    rewriteStoredSymbolsAsOneSpan(indexedPath)

    indexFileSync(file, dbPath)

    expect(storedStamps().embedSha, 'markdown chunks are cut on headings read out of the file content, which this reparse has already established is unchanged, so a symbol-row difference must not cost a re-embed').toBe(sha)
  })
})
