import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { getFileEntry, querySymbols } from '../src/index_reader.js'
import {
  disabledEmbedSha,
  indexFileEmbeddings,
  indexFileSync,
  isEmbedFresh,
  unavailableEmbedSha,
} from '../src/parser.js'

let TMP: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-gate-'))
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off by default (tests/setup/isolate-home.ts); these tests need
  // it on to exercise the enabled indexFileEmbeddings path. A test setting its own value wins.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
})

// Bug 2: a file skipped for policy reasons (a salesforce_metadata file >512KB, or a
// .profile-meta.xml file) called deleteFileEmbeddings but never stamped files.embed_sha. With
// embed_sha left empty, the freshness gate (worker.ts/cli.ts, which require embedSha === sha)
// could never hold, so every `token-goat index` re-reported the file as "Indexed" and every
// worker drain re-read its (potentially multi-megabyte) content into indexFileEmbeddings forever.
// The delete-and-skip IS the intended terminal state and must be recorded as done.
describe('policy-skipped files stamp embed_sha so they are not re-embedded every drain', () => {
  it('stamps the real sha for a >512KB salesforce metadata file (bug 2)', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const file = path.join(TMP, 'CustomObject__c.object-meta.xml')
    // >512KB measured in UTF-16 code units (content.length), with multi-byte UTF-8 chars mixed in
    // so the file is a realistic large generated-metadata dump.
    const body = '<é日本語 value="permission-set-entry"/>\n'.repeat(20000)
    fs.writeFileSync(file, `<?xml version="1.0"?>\n${body}`, 'utf8')
    expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(512 * 1024)

    indexFileSync(file, dbPath)
    const sha = fingerprintFile(file)
    expect(sha).not.toBeNull()

    await indexFileEmbeddings(file, dbPath, sha ?? undefined)

    const entry = getFileEntry(file, dbPath)
    expect(entry?.embedSha).toBe(sha)
    // And the freshness gate now treats it as done (would report "Skipped", not "Indexed").
    expect(isEmbedFresh(entry?.embedSha, sha ?? '', true, true)).toBe(true)
  })

  it('stamps the real sha for a .profile-meta.xml file (bug 2)', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const file = path.join(TMP, 'Admin.profile-meta.xml')
    fs.writeFileSync(file, '<?xml version="1.0"?>\n<Profile><userLicense>Salesforce</userLicense></Profile>\n', 'utf8')

    indexFileSync(file, dbPath)
    const sha = fingerprintFile(file)
    await indexFileEmbeddings(file, dbPath, sha ?? undefined)

    const entry = getFileEntry(file, dbPath)
    expect(entry?.embedSha).toBe(sha)
    expect(isEmbedFresh(entry?.embedSha, sha ?? '', true, true)).toBe(true)
  })
})

// Bug: indexing.large_file_symbol_only_kb was a fully write-path-wired config knob (declared,
// range-validated, clamped to large_file_skip_kb, persisted) with zero read-side consumers --
// a file between the symbol-only and full-skip thresholds was embedded exactly as if the field
// did not exist. indexFileEmbeddings must skip embedding (but indexFileSync must still index
// symbols normally) once content exceeds large_file_symbol_only_kb. Asserts on the chunks table
// (not just the terminal embed_sha marker, which a REAL successful embed would also stamp) so
// this test actually discriminates "embedding ran" from "embedding was skipped" in an
// environment where the optional embedding deps are installed.
describe('large_file_symbol_only_kb gates embedding independently of symbol indexing', () => {
  it('indexes symbols but skips embedding for a file between the symbol-only and skip thresholds', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const originalCfg = loadConfig()
    const originalSymbolOnly = originalCfg.indexing.large_file_symbol_only_kb
    const originalSkip = originalCfg.indexing.large_file_skip_kb
    try {
      const cfg = structuredClone(loadConfig())
      cfg.indexing.large_file_symbol_only_kb = 1
      cfg.indexing.large_file_skip_kb = 1024
      saveConfig(cfg)

      const file = path.join(TMP, 'big.ts')
      const body = Array.from({ length: 200 }, (_, i) => `export function fn${i}(): number { return ${i} }`).join('\n')
      fs.writeFileSync(file, body, 'utf8')
      expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(1024)

      indexFileSync(file, dbPath)
      // querySymbols defaults limit to 100, so this caps at 100 even though the fixture writes
      // 200 functions -- pin to the real capped count, not the fixture's total.
      const symbols = querySymbols({ filePath: file }, dbPath)
      expect(symbols.length).toBe(100)
      expect(symbols.some((s) => s.name === 'fn0')).toBe(true)

      const sha = fingerprintFile(file)
      await indexFileEmbeddings(file, dbPath, sha ?? undefined)

      const entry = getFileEntry(file, dbPath)
      expect(entry?.embedSha).toBe(sha)
      expect(isEmbedFresh(entry?.embedSha, sha ?? '', true, true)).toBe(true)

      const db = getDb(dbPath)
      const chunkRows = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE file_path = ?').get(file) as { n: number }
      expect(chunkRows.n).toBe(0)
    } finally {
      const restoreCfg = structuredClone(loadConfig())
      restoreCfg.indexing.large_file_symbol_only_kb = originalSymbolOnly
      restoreCfg.indexing.large_file_skip_kb = originalSkip
      saveConfig(restoreCfg)
    }
  })
})

// Bug 3: when the optional embedding deps are absent (no @xenova/transformers model, or no
// sqlite-vec chunk_vectors table), embedIndexFile skipped embedding and returned normally, yet
// indexFileEmbeddings stamped embed_sha = sha as if the file had really been embedded. A user who
// indexed a project without the deps, then installed them later, would find every previously
// indexed unchanged file permanently skipped, leaving the semantic index empty for that content.
describe('deps-absent embedding does not falsely stamp a file as embedded (bug 3)', () => {
  it('stamps an unavailable-marker embed_sha, not the bare sha, when chunk_vectors is absent', async () => {
    const dbPath = path.join(TMP, 'index.db')
    // Drop chunk_vectors immediately, before anything probes it, to simulate an install where
    // sqlite-vec never loaded (the vec table is the independently-optional half of the deps).
    const db = getDb(dbPath)
    db.prepare('DROP TABLE IF EXISTS chunk_vectors').run()

    const file = path.join(TMP, 'foo.ts')
    // Comfortably above MIN_CHUNK_CHARS so chunkFile yields at least one chunk (an empty/too-small
    // file has nothing to embed and is a legitimate bare-sha 'embedded' terminal state instead).
    const fn = 'export function foo(n: number): number {\n  return n * 2 + 1\n}\n\n'
    fs.writeFileSync(file, fn.repeat(12), 'utf8')
    indexFileSync(file, dbPath)
    const sha = fingerprintFile(file)
    expect(sha).not.toBeNull()

    await indexFileEmbeddings(file, dbPath, sha ?? undefined)

    const entry = getFileEntry(file, dbPath)
    // The bug stamped the bare sha here; the fix stamps the unavailable marker.
    expect(entry?.embedSha).toBe(unavailableEmbedSha(sha ?? ''))
    expect(entry?.embedSha).not.toBe(sha)

    // Gate behavior: still "fresh" while deps remain absent (so an unchanged file is not
    // re-entered on every drain), but NOT fresh once the deps become available -- forcing the
    // real first embed instead of silently masquerading as done forever.
    expect(isEmbedFresh(entry?.embedSha, sha ?? '', true, false)).toBe(true)
    expect(isEmbedFresh(entry?.embedSha, sha ?? '', true, true)).toBe(false)
  })
})

// Pure read-side gate logic shared by worker.ts::makeIndexer and cli.ts's bulk index loop.
describe('isEmbedFresh', () => {
  const sha = 'abc123'

  it('treats an undefined stored embed_sha as stale', () => {
    expect(isEmbedFresh(undefined, sha, true, true)).toBe(false)
  })

  it('when embeddings are disabled, is fresh only for the disabled marker', () => {
    expect(isEmbedFresh(disabledEmbedSha(sha), sha, false, false)).toBe(true)
    expect(isEmbedFresh(sha, sha, false, false)).toBe(false)
    expect(isEmbedFresh(unavailableEmbedSha(sha), sha, false, false)).toBe(false)
  })

  it('when enabled, a bare sha match is always fresh', () => {
    expect(isEmbedFresh(sha, sha, true, true)).toBe(true)
    expect(isEmbedFresh(sha, sha, true, false)).toBe(true)
  })

  it('an unavailable marker is fresh only while deps are still absent', () => {
    expect(isEmbedFresh(unavailableEmbedSha(sha), sha, true, false)).toBe(true)
    expect(isEmbedFresh(unavailableEmbedSha(sha), sha, true, true)).toBe(false)
  })

  it('a disabled marker never counts as fresh once embeddings are enabled', () => {
    expect(isEmbedFresh(disabledEmbedSha(sha), sha, true, true)).toBe(false)
    expect(isEmbedFresh(disabledEmbedSha(sha), sha, true, false)).toBe(false)
  })
})
