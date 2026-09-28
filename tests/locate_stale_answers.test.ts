/** `locate` answers with line spans read from index rows, and used to serve a span from a file that had changed on disk or been deleted with no sign of it, in text and in --json, and without booking the answer in the stale_served ledger the other read commands feed. It now warns on stderr through warnIfFilesStale, books `stale_served:<state> locate`, tags a deleted hit (DELETED_TAG in text, `deleted: true` in JSON, the refs shapes), and lists live hits ahead of deleted ones. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Parser from '../src/parser.js'

// The only way a changed file's rows stay stale past locate's own self-heal is a reparse that fails (or a read-only index). This forces that failure through the real healStaleIndex catch path by failing the parser it calls, only while `heal.fail` is set, so the fixtures still index for real.
const heal = vi.hoisted(() => ({ fail: false }))
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Parser>()
  return {
    ...actual,
    indexFileSync: (...args: Parameters<typeof actual.indexFileSync>) => {
      if (heal.fail) throw new Error('simulated reparse failure')
      return actual.indexFileSync(...args)
    },
  }
})

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runLocate } from '../src/read_inspect.js'
import { getGlobalDb } from '../src/stats.js'
import { captureStdout } from './helpers/capture-stdout.js'

let root: string
let origCwd: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-locate-stale-')))
  origCwd = process.cwd()
  process.chdir(root)
  heal.fail = false
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  heal.fail = false
  vi.restoreAllMocks()
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

function warnings(): string {
  return warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
}

function staleRows(): string[] {
  const rows = getGlobalDb().prepare(`SELECT kind, detail FROM stats WHERE kind LIKE 'stale_served:%' ORDER BY rowid`).all() as Array<{ kind: string; detail: string | null }>
  return rows.map((r) => `${r.kind} ${r.detail ?? ''}`)
}

// HAND-DERIVED: a one-function module; the name is unique to this file so the project-scoped scan finds only these rows.
function indexedModule(name: string, fn: string, body = 'return 1'): string {
  const file = join(root, name)
  writeFileSync(file, `export function ${fn}(): number {\n  ${body}\n}\n`)
  indexFileSync(normalizePath(file))
  return file
}

function locate(spec: string, json = false): { out: string; code: number } {
  let code = -1
  const out = captureStdout(() => {
    code = runLocate({ spec, projectRoot: root, ...(json ? { json: true } : {}) })
  })
  return { out, code }
}

describe('locate on a deleted file', () => {
  it('tags the hit, warns on stderr and books one deleted answer, in text', () => {
    rmSync(indexedModule('gone_loc3m.ts', 'locGone3m'))
    const before = staleRows().length
    const r = locate('locGone3m')
    expect(r.code).toBe(0)
    expect(r.out).toContain('gone_loc3m.ts:1-3 [function] locGone3m  ⚠ DELETED: file no longer on disk')
    expect(warnings()).toMatch(/1 file behind these results is no longer on disk/)
    expect(staleRows().slice(before)).toEqual(['stale_served:deleted locate'])
  })

  it('carries deleted: true on the hit, warns and books the answer, in --json', () => {
    rmSync(indexedModule('gone_json_loc3m.ts', 'locGoneJson3m'))
    const before = staleRows().length
    const r = locate('locGoneJson3m', true)
    const payload = JSON.parse(r.out) as { items: Array<{ name: string; deleted?: boolean }> }
    expect(payload.items).toEqual([expect.objectContaining({ name: 'locGoneJson3m', deleted: true })])
    expect(warnings()).toMatch(/no longer on disk/)
    expect(staleRows().slice(before)).toEqual(['stale_served:deleted locate'])
  })

  it('lists the live definition ahead of the deleted one', () => {
    // HAND-DERIVED: `a_` sorts ahead of `b_`, the same shape as a deleted `proj-wt/` sorting ahead of `proj/`.
    rmSync(indexedModule('a_gone_loc3m.ts', 'locTwin3m'))
    indexedModule('b_live_loc3m.ts', 'locTwin3m')
    const payload = JSON.parse(locate('locTwin3m', true).out) as { items: Array<{ filePath: string; deleted?: boolean }> }
    expect(payload.items.map((i) => [i.filePath, i.deleted ?? false])).toEqual([
      ['b_live_loc3m.ts', false],
      ['a_gone_loc3m.ts', true],
    ])
  })
})

describe('locate on a file that changed on disk and could not be reindexed', () => {
  it('warns and books one stale answer in text and in --json', () => {
    const file = indexedModule('stale_loc3m.ts', 'locStale3m')
    writeFileSync(file, 'export function locStale3m(): number {\n  return 2\n}\n')
    heal.fail = true
    const before = staleRows().length
    expect(locate('locStale3m').code).toBe(0)
    expect(locate('locStale3m', true).code).toBe(0)
    expect(warnings()).toMatch(/changed on disk since the index last saw it/)
    expect(staleRows().slice(before)).toEqual(['stale_served:stale locate', 'stale_served:stale locate'])
  })
})

describe('locate on a current file', () => {
  it('stays silent, books nothing and adds no deleted key', () => {
    indexedModule('fresh_loc3m.ts', 'locFresh3m')
    const before = staleRows().length
    const payload = JSON.parse(locate('locFresh3m', true).out) as { items: Array<Record<string, unknown>> }
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).not.toHaveProperty('deleted')
    expect(locate('locFresh3m').out).not.toContain('DELETED')
    expect(warnings()).toBe('')
    expect(staleRows().slice(before)).toEqual([])
  })
})
