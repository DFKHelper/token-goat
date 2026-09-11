/**
 * Regression: raising `indexing.large_file_symbol_only_kb` must actually re-embed the files it
 * just admitted.
 *
 * indexFileEmbeddings skips embedding for any file over that threshold and stamps `files.embed_sha`
 * so the worker stops re-reading it on every drain. It used to stamp the file's BARE content sha,
 * which is the same value a genuinely successful embed writes -- so once the user raised the
 * threshold (exactly what `token-goat doctor`'s embedding-coverage remediation tells them to do),
 * the freshness gate still read "already embedded, unchanged" and the background worker never
 * re-embedded any of them. The index reported itself fresh while `semantic` stayed blind to that
 * content until something edited it; `symbol` and `read` worked normally, so nothing looked wrong.
 * The same class was already fixed twice with marker prefixes -- `disabled:` for the config-off case
 * and `unavailable:` for the missing-deps case -- and the size threshold is the third condition of
 * that shape.
 *
 * Driven through the REAL default worker path: `drainOnce(DIR)` with no injected index callback, so
 * this exercises makeIndexer's shipping default rather than a test-supplied stand-in. See CLAUDE.md
 * on the injected-seam trap.
 *
 * The embedding backend is the one thing stubbed (setPipelineFnForTesting, the same seam
 * tests/embeddings_non_finite_vector.test.ts uses): it is not what this test is about, and leaving
 * it real would make the second drain fetch a model over the network.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { closeAllDbs } from '../src/db.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { getFileEntry, querySymbols } from '../src/index_reader.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { normalizePath } from '../src/paths.js'
import { oversizeEmbedSha } from '../src/parser.js'

let DIR: string
let prevEmbeddingsEnv: string | undefined
let originalSymbolOnly: number
let originalSkip: number

// HAND-DERIVED: 200 one-line exported functions, sized to clear a 1 KB large_file_symbol_only_kb
// threshold and stay well under a 1024 KB large_file_skip_kb. Computed from the thresholds under
// test, not read off any producer's output.
const OVERSIZE_SOURCE =
  Array.from({ length: 200 }, (_, i) => `export function oversizeGateFn${i}(): number { return ${i} }`).join('\n') + '\n'

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-oversize-regate-'))
  fs.mkdirSync(path.join(DIR, 'queue'), { recursive: true })
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts); the oversize branch under test
  // only runs with them on, because the disabled branch short-circuits above it.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  const cfg = structuredClone(loadConfig())
  originalSymbolOnly = cfg.indexing.large_file_symbol_only_kb
  originalSkip = cfg.indexing.large_file_skip_kb
  cfg.indexing.large_file_symbol_only_kb = 1
  cfg.indexing.large_file_skip_kb = 1024
  saveConfig(cfg)
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  setPipelineFnForTesting(null)
  const cfg = structuredClone(loadConfig())
  cfg.indexing.large_file_symbol_only_kb = originalSymbolOnly
  cfg.indexing.large_file_skip_kb = originalSkip
  saveConfig(cfg)
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
  closeAllDbs()
  fs.rmSync(DIR, { recursive: true, force: true })
})

function enqueue(absPath: string): void {
  fs.writeFileSync(path.join(DIR, 'queue', 'dirty.txt'), `${absPath}\n`)
}

describe('raising large_file_symbol_only_kb re-embeds the files it admits', () => {
  it('stamps a threshold-bearing marker and re-examines the file once the threshold moves', async () => {
    const src = normalizePath(path.join(DIR, 'oversize.ts'))
    fs.writeFileSync(src, OVERSIZE_SOURCE, 'utf8')
    expect(fs.statSync(src).size).toBeGreaterThan(1024)

    enqueue(src)
    // Real shipping path: no injected index callback, so makeIndexer's default runs.
    expect(drainOnce(DIR)).toBe(1)
    await pendingEmbeddings()

    const dbPath = path.join(DIR, 'global.db')
    // The parse side really ran, so this is the whole drain -> index -> symbols chain, not a
    // freshness check in isolation.
    expect(querySymbols({ name: 'oversizeGateFn0', limit: 10 }, dbPath).length).toBe(1)

    const skipped = getFileEntry(src, dbPath)
    const sha = skipped?.sha ?? ''
    expect(sha).not.toBe('')
    const stampWhileOversize = skipped?.embedSha
    // The marker, not the bare sha. A bare sha here is indistinguishable from a real embed.
    expect(skipped?.embedSha).toBe(oversizeEmbedSha(sha, 1))

    // The user follows `token-goat doctor`'s advice and raises the threshold. Content unchanged.
    const raised = structuredClone(loadConfig())
    raised.indexing.large_file_symbol_only_kb = 500
    saveConfig(raised)
    expect(loadConfig().indexing.large_file_symbol_only_kb).toBe(500)

    enqueue(src)
    drainOnce(DIR)
    await pendingEmbeddings()

    const after = getFileEntry(src, dbPath)
    // Same content, so the sha must not have moved -- what must move is the embed stamp.
    expect(after?.sha).toBe(sha)
    // The file was re-examined rather than left permanently skipped. Compared against the value
    // actually stored before the raise, not against a constructed marker: pre-fix both stamps were
    // the same bare sha, so this is the assertion that discriminates -- it is byte-identical either
    // side of the raise when the gate wrongly holds. Whether the re-examination lands on a real
    // embed (bare sha) or on an `unavailable:` marker depends on whether the optional sqlite-vec
    // table is usable on this machine, and neither is what this test is about.
    expect(after?.embedSha).not.toBe(stampWhileOversize)
    expect(after?.embedSha?.startsWith('oversize:')).toBe(false)
  })
})
