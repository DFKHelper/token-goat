/**
 * Regression: `indexing.skip_dirs`, `indexing.large_file_skip_kb`, and
 * `indexing.large_file_symbol_only_kb` were fully defined, validated, clamped, and surfaced in
 * `config-get`/manifest output (config.ts), and `skip_dirs` is documented in README.md as a
 * real, working `[indexing] skip_dirs = [...]` feature -- but nothing in the indexing pipeline
 * (`cmdIndex`, `indexFileSync`, `indexFileEmbeddings`, `walkProject`) ever actually read any of
 * the three. Every one of them was a silent no-op: setting `large_file_skip_kb = 1` still fully
 * indexed a multi-megabyte file, and `skip_dirs = ["generated"]` still indexed everything under
 * a `generated/` directory.
 *
 * Drives the real `cmdIndex` (the shipping `token-goat index` path) and `walkProject` against a
 * real, isolated config.toml (same convention as hooks_screenshot.test.ts: redirect
 * constants.js's configPath() to a per-test-file temp file, saveConfig() a real Config object,
 * invalidateConfigCache() so loadConfig() picks it up) -- not a mocked loadConfig() -- since the
 * whole defect was several real call sites never consulting the real config at all.
 */
import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-indexing-config-gates.toml')

import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { cmdIndex } from '../src/cli.js'
import { walkProject } from '../src/baseline.js'
import { querySymbols, getFileEntry } from '../src/index_reader.js'
import { resolveIndexPath } from '../src/paths.js'
import { closeAllDbs } from '../src/db.js'
import * as parserModule from '../src/parser.js'

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { getDb } from '../src/db.js'
import { isAvailable, mergeNearbyHits, searchSemantic } from '../src/embeddings.js'
import Database from '../src/sqlite_driver.js'

type Vec0State = 'working' | 'broken' | 'absent'

// Mirrors tests/embeddings_index_wiring.test.ts's classifyVec0()/canExerciseRealEmbeddings:
// 'absent' (sqlite-vec not installed) is a legitimate platform skip; 'broken' (installed but
// vec0 fails to load) must fail loudly, not be silently skipped.
function classifyVec0(): Vec0State {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return 'working'
  } catch {
    return 'broken'
  }
}

const vec0State = classifyVec0()
const canExerciseRealEmbeddings = vec0State === 'working' && isAvailable()

let TMP: string
let dbPath: string
let tmpHome: string
let prevHome: string | undefined
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-indexing-config-gates-home-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  invalidateConfigCache()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ok — no leftover config from a previous test
  }
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-indexing-config-gates-'))
  dbPath = path.join(TMP, 'index.db')
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  // Several tests below set TOKEN_GOAT_EMBEDDINGS_ENABLED='true' to exercise the embedding
  // path; loadConfig() reads it process-wide, so leaving it set would leak into whichever test
  // runs next in this worker and silently change its embeddings-enabled behavior.
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  invalidateConfigCache()
  closeAllDbs()
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('indexing.skip_dirs', () => {
  it('excludes a configured directory from cmdIndex (walk mode) instead of indexing it like every other file', async () => {
    fs.writeFileSync(path.join(TMP, 'kept.ts'), 'export function keptSymbol(): number {\n  return 1\n}\n')
    const genDir = path.join(TMP, 'generated')
    fs.mkdirSync(genDir, { recursive: true })
    fs.writeFileSync(path.join(genDir, 'skipped.ts'), 'export function skippedSymbol(): number {\n  return 2\n}\n')

    const cfg = defaultConfig()
    cfg.indexing.skip_dirs = ['generated']
    saveConfig(cfg)

    await cmdIndex(TMP, { walk: true, dbPath })

    expect(querySymbols({ name: 'keptSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
    expect(querySymbols({ name: 'skippedSymbol', limit: 10 }, dbPath).length).toBe(0)
  })

  it('prunes a directory named in skip_dirs from a non-git walk (walkProject) instead of descending into it', () => {
    fs.writeFileSync(path.join(TMP, 'kept.ts'), 'export const x = 1\n')
    const genDir = path.join(TMP, 'generated')
    fs.mkdirSync(genDir, { recursive: true })
    fs.writeFileSync(path.join(genDir, 'skipped.ts'), 'export const y = 2\n')

    const cfg = defaultConfig()
    cfg.indexing.skip_dirs = ['generated']
    saveConfig(cfg)

    const result = walkProject(TMP)

    expect(result.files.some((f) => f.includes('kept.ts'))).toBe(true)
    expect(result.files.some((f) => f.includes('skipped.ts'))).toBe(false)
  })

  it('does not exclude anything when skip_dirs is left at its default empty list', async () => {
    const genDir = path.join(TMP, 'generated')
    fs.mkdirSync(genDir, { recursive: true })
    fs.writeFileSync(path.join(genDir, 'stillIndexed.ts'), 'export function stillIndexedSymbol(): number {\n  return 3\n}\n')

    await cmdIndex(TMP, { walk: true, dbPath })

    expect(querySymbols({ name: 'stillIndexedSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
  })
})

describe('indexing.skip_files', () => {
  it('excludes a coverage.json basename from cmdIndex by default (unchanged pre-existing behavior)', async () => {
    fs.writeFileSync(path.join(TMP, 'kept.ts'), 'export function keptSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(path.join(TMP, 'coverage.json'), '{"total":{"lines":{"pct":100}}}')

    await cmdIndex(TMP, {walk: true, dbPath})

    expect(querySymbols({name: 'keptSymbol', limit: 10}, dbPath).length).toBeGreaterThan(0)
    expect(getFileEntry(resolveIndexPath(path.join(TMP, 'coverage.json')), dbPath)).toBeNull()
  })

  it('re-includes coverage.json once skip_files is overridden to an empty list (opt-out of the default)', async () => {
    fs.writeFileSync(path.join(TMP, 'coverage.json'), '{"total":{"lines":{"pct":100}}}')

    const cfg = defaultConfig()
    cfg.indexing.skip_files = []
    saveConfig(cfg)

    await cmdIndex(TMP, {walk: true, dbPath})

    expect(getFileEntry(resolveIndexPath(path.join(TMP, 'coverage.json')), dbPath)).not.toBeNull()
  })

  it('excludes a custom generated-file basename the default list never covered (opt-in for a project-specific artifact)', async () => {
    fs.writeFileSync(path.join(TMP, 'kept.ts'), 'export function keptSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(path.join(TMP, 'lcov.json'), '{"lines":100}')

    const cfg = defaultConfig()
    cfg.indexing.skip_files = ['lcov.json']
    saveConfig(cfg)

    await cmdIndex(TMP, {walk: true, dbPath})

    expect(querySymbols({name: 'keptSymbol', limit: 10}, dbPath).length).toBeGreaterThan(0)
    expect(getFileEntry(resolveIndexPath(path.join(TMP, 'lcov.json')), dbPath)).toBeNull()
  })
})

describe('indexing.large_file_skip_kb', () => {
  it('skips a file larger than the configured cap instead of fully indexing it', async () => {
    const cfg = defaultConfig()
    cfg.indexing.large_file_skip_kb = 1 // 1 KB cap
    saveConfig(cfg)

    const big = path.join(TMP, 'big.ts')
    // Well over 1 KB: a real symbol declaration padded with a long comment.
    fs.writeFileSync(big, `// ${'x'.repeat(2000)}\nexport function bigFileSymbol(): number {\n  return 1\n}\n`)
    const small = path.join(TMP, 'small.ts')
    fs.writeFileSync(small, 'export function smallFileSymbol(): number {\n  return 2\n}\n')

    await cmdIndex(TMP, { walk: true, dbPath })

    expect(querySymbols({ name: 'bigFileSymbol', limit: 10 }, dbPath).length).toBe(0)
    expect(querySymbols({ name: 'smallFileSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
  })

  it('indexes a file at the default 2048 KB cap normally (no false-positive skip on ordinary-sized source)', async () => {
    const src = path.join(TMP, 'ordinary.ts')
    fs.writeFileSync(src, 'export function ordinarySymbol(): number {\n  return 1\n}\n')

    await cmdIndex(TMP, { walk: true, dbPath })

    expect(querySymbols({ name: 'ordinarySymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
  })

  // Regression: cmdIndex's own skip_dirs/large_file_skip_kb pre-filter (the `continue` above,
  // mirroring indexFileSync's early returns) left stale symbols/refs/files rows behind for a
  // file that was indexed while small/allowed and later grew past the cap -- and never cleared
  // files.sha, so the file's sha stayed permanently mismatched and it kept getting re-selected
  // as "changed" (never unchanged-skipped) on every subsequent `token-goat index` run without
  // the stale data ever actually being cleaned up. Drives the real shipping `token-goat index`
  // path (cmdIndex) end-to-end: index a file normally, then grow it past a newly-lowered
  // large_file_skip_kb and re-run, asserting the stale symbol no longer resolves and the files
  // row (including sha) is gone.
  it('clears stale rows and files.sha via cmdIndex when a previously-indexed file grows past large_file_skip_kb', async () => {
    const src = path.join(TMP, 'growable.ts')
    fs.writeFileSync(src, 'export function growableCliSymbol(): number {\n  return 1\n}\n')

    await cmdIndex(TMP, { walk: true, dbPath })

    expect(querySymbols({ name: 'growableCliSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
    const normSrc = resolveIndexPath(src)
    expect(getFileEntry(normSrc, dbPath)).not.toBeNull()

    // Grow the file past a newly-lowered large_file_skip_kb cap.
    const cfg = defaultConfig()
    cfg.indexing.large_file_skip_kb = 1
    saveConfig(cfg)
    fs.writeFileSync(
      src,
      `// ${'x'.repeat(2000)}\nexport function growableCliSymbol(): number {\n  return 2\n}\n`,
    )

    await cmdIndex(TMP, { walk: true, dbPath })

    expect(querySymbols({ name: 'growableCliSymbol', limit: 10 }, dbPath).length).toBe(0)
    expect(getFileEntry(normSrc, dbPath)).toBeNull()

    // A further run while still over the cap must settle at the same stable state rather than
    // endlessly re-processing or resurrecting stale rows.
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(querySymbols({ name: 'growableCliSymbol', limit: 10 }, dbPath).length).toBe(0)
    expect(getFileEntry(normSrc, dbPath)).toBeNull()
  })
})

// Regression: cmdIndex's skip_dirs/large_file_skip_kb pre-filter branches called only
// deleteFileRows (symbols/refs/files) before `continue`, never deleteFileEmbeddings --
// indexFileEmbeddings (which has its own correct embeddings cleanup) is never reached for a
// file caught by this pre-filter, so a file that was indexed with embeddings enabled, then
// later excluded via skip_dirs or large_file_skip_kb, left its chunks/chunk_vectors rows
// orphaned forever -- not reachable by pruneDeletedFiles either, since the file still exists
// on disk. `token-goat semantic` kept silently matching content from a file meant to be fully
// excluded from the index. Drives the real `cmdIndex` path with real embeddings end-to-end,
// not a mocked/injected callback -- the exact shipping path this bug lived in.
describe('cmdIndex skip pre-filter also removes orphaned embeddings (regression)', () => {
  it.skipIf(!canExerciseRealEmbeddings)(
    'removes chunk_vectors/chunks, not just symbol rows, once a file becomes skip_dirs-excluded, and semantic search stops matching it',
    async () => {
      // walkProject (behind cmdIndex's --walk fallback) already prunes skip_dirs directories
      // during the walk itself, before cmdIndex's loop ever sees the file -- so the buggy
      // pre-filter branch inside cmdIndex's loop (the actual site of this fix) is unreachable in
      // walk mode. Only the git-tracked path (getTrackedFiles / git ls-files, which does NOT
      // consult skip_dirs) still hands cmdIndex a file whose directory was added to skip_dirs
      // AFTER it was first indexed, exactly matching the real-world scenario this bug describes.
      // A bare `git init` + `git add` (no commit, no user.name/user.email needed) is enough for
      // `git ls-files` to list the file.
      execFileSync('git', ['init', '-q'], { cwd: TMP })

      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const genDir = path.join(TMP, 'toskip')
      fs.mkdirSync(genDir, { recursive: true })
      const filePath = path.join(genDir, 'orphan.ts')
      const content =
        'export function lookUpAccountByEmailAddress(address: string): { id: number } | null {\n' +
        '  const match = ACCOUNT_TABLE.find((row) => row.contact === address)\n' +
        '  return match ? { id: match.id } : null\n' +
        '}\n\n' +
        'const ACCOUNT_TABLE = [{ id: 1, contact: "a@example.com" }]\n'
      fs.writeFileSync(filePath, content)
      execFileSync('git', ['add', '-A'], { cwd: TMP })

      await cmdIndex(TMP, { dbPath })

      const key = resolveIndexPath(filePath)
      const db = getDb(dbPath)
      expect(querySymbols({ name: 'lookUpAccountByEmailAddress', limit: 10 }, dbPath).length).toBeGreaterThan(0)
      const chunksBefore = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(key) as {
        c: number
      }
      expect(chunksBefore.c).toBeGreaterThan(0)
      const vecsBefore = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)')
        .get(key) as { c: number }
      expect(vecsBefore.c).toBeGreaterThan(0)

      const query = 'look up an account using its email address'
      const hitsBefore = mergeNearbyHits(await searchSemantic(db, query, 5))
      expect(hitsBefore.some((h) => h.filePath === key)).toBe(true)

      const cfg = defaultConfig()
      cfg.indexing.skip_dirs = ['toskip']
      saveConfig(cfg)

      // The file is still git-tracked (skip_dirs only affects the walk-mode fallback and
      // cmdIndex's own pre-filter, not what git considers tracked), so getTrackedFiles still
      // hands it to cmdIndex's loop, where the isUnderSkipDir pre-filter branch now fires.
      await cmdIndex(TMP, { dbPath })

      expect(querySymbols({ name: 'lookUpAccountByEmailAddress', limit: 10 }, dbPath).length).toBe(0)
      expect(getFileEntry(key, dbPath)).toBeNull()
      const chunksAfter = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(key) as {
        c: number
      }
      expect(chunksAfter.c).toBe(0)
      const vecsAfter = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)')
        .get(key) as { c: number }
      expect(vecsAfter.c).toBe(0)

      const hitsAfter = mergeNearbyHits(await searchSemantic(db, query, 5))
      expect(hitsAfter.some((h) => h.filePath === key)).toBe(false)
    },
  )

  it.skipIf(!canExerciseRealEmbeddings)(
    'removes chunk_vectors/chunks once a previously-indexed file grows past large_file_skip_kb',
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const filePath = path.join(TMP, 'growable-orphan.ts')
      const content =
        'export function lookUpOrderByReference(reference: string): { id: number } | null {\n' +
        '  const match = ORDER_TABLE.find((row) => row.reference === reference)\n' +
        '  return match ? { id: match.id } : null\n' +
        '}\n\n' +
        'const ORDER_TABLE = [{ id: 1, reference: "A-100" }]\n'
      fs.writeFileSync(filePath, content)

      await cmdIndex(TMP, { walk: true, dbPath })

      const key = resolveIndexPath(filePath)
      const db = getDb(dbPath)
      expect(querySymbols({ name: 'lookUpOrderByReference', limit: 10 }, dbPath).length).toBeGreaterThan(0)
      const chunksBefore = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(key) as {
        c: number
      }
      expect(chunksBefore.c).toBeGreaterThan(0)

      const cfg = defaultConfig()
      cfg.indexing.large_file_skip_kb = 1
      saveConfig(cfg)
      fs.writeFileSync(
        filePath,
        `// ${'x'.repeat(2000)}\n` + content,
      )

      await cmdIndex(TMP, { walk: true, dbPath })

      expect(querySymbols({ name: 'lookUpOrderByReference', limit: 10 }, dbPath).length).toBe(0)
      expect(getFileEntry(key, dbPath)).toBeNull()
      const chunksAfter = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(key) as {
        c: number
      }
      expect(chunksAfter.c).toBe(0)
      const vecsAfter = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)')
        .get(key) as { c: number }
      expect(vecsAfter.c).toBe(0)
    },
  )
})

// Regression: indexFileSync's OWN isParseSkipEligible branch (parser.ts) called only
// deleteFileRows before its early return, never deleteFileEmbeddings -- unlike cmdIndex's and
// makeIndexer's pre-filters (both already covered above), which call removeFileFromIndex
// (deleteFileRows + deleteFileEmbeddings) BEFORE ever reaching indexFileSync, so they never
// actually exercise indexFileSync's own buggy branch. indexFileSync is also called directly,
// without that pre-filter, from runRead/runSkeleton/runOutline (read_commands.ts) behind the
// user-facing --force-refresh flag -- which imports and calls ONLY indexFileSync, never
// indexFileEmbeddings (see read_commands.ts's imports). So a file indexed with real embeddings,
// then made skip-eligible by a config change alone (no edit-hook re-index), left orphaned
// chunks/chunk_vectors forever once --force-refresh drove indexFileSync directly -- not
// reachable by pruneDeletedFiles since the file still exists on disk. Drives indexFileSync
// alone on the second pass (mirroring the real --force-refresh call shape exactly), not
// cmdIndex/indexFileEmbeddings, so this trips the specific branch the other two regression
// tests above cannot reach.
describe('indexFileSync own skip-eligible branch also removes orphaned embeddings (regression)', () => {
  it.skipIf(!canExerciseRealEmbeddings)(
    'removes chunk_vectors/chunks once a previously-indexed file grows past large_file_skip_kb, driving indexFileSync alone (the --force-refresh shape)',
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const filePath = path.join(TMP, 'force-refresh-orphan.ts')
      const content =
        'export function lookUpInvoiceByReference(reference: string): { id: number } | null {\n' +
        '  const match = INVOICE_TABLE.find((row) => row.reference === reference)\n' +
        '  return match ? { id: match.id } : null\n' +
        '}\n\n' +
        'const INVOICE_TABLE = [{ id: 1, reference: "B-200" }]\n'
      fs.writeFileSync(filePath, content)

      parserModule.indexFileSync(filePath, dbPath)
      await parserModule.indexFileEmbeddings(filePath, dbPath)

      const key = filePath
      const db = getDb(dbPath)
      expect(querySymbols({ name: 'lookUpInvoiceByReference', limit: 10 }, dbPath).length).toBeGreaterThan(0)
      const chunksBefore = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(key) as {
        c: number
      }
      expect(chunksBefore.c).toBeGreaterThan(0)
      const vecsBefore = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)')
        .get(key) as { c: number }
      expect(vecsBefore.c).toBeGreaterThan(0)

      const query = 'look up an invoice using its reference'
      const hitsBefore = mergeNearbyHits(await searchSemantic(db, query, 5))
      expect(hitsBefore.some((h) => h.filePath === key)).toBe(true)

      // Simulate a config change alone (e.g. git pull swapping in a lowered
      // large_file_skip_kb, or the user editing config directly) -- the file's own content on
      // disk is untouched by the edit hook, so nothing enqueues queue/dirty.txt; the only thing
      // that reconciles this file's index state is a direct indexFileSync call.
      const cfg = defaultConfig()
      cfg.indexing.large_file_skip_kb = 1
      saveConfig(cfg)
      // Grow the file past the newly-lowered 1 KB cap -- a plain file write, standing in for
      // an external change (git pull/checkout) that lands new bytes on disk without ever
      // going through Claude Code's own edit hook (which is what would normally enqueue
      // queue/dirty.txt).
      fs.writeFileSync(filePath, `// ${'x'.repeat(2000)}\n` + content)

      // Real-world trigger: token-goat read/skeleton/outline --force-refresh, which calls ONLY
      // indexFileSync (see read_commands.ts's resolveSymbolSpec/runSkeleton/runOutline) --
      // never indexFileEmbeddings. This is the exact call shape that must clean up embeddings
      // on its own.
      parserModule.indexFileSync(filePath, dbPath)

      expect(querySymbols({ name: 'lookUpInvoiceByReference', limit: 10 }, dbPath).length).toBe(0)
      expect(getFileEntry(key, dbPath)).toBeNull()
      const chunksAfter = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(key) as {
        c: number
      }
      expect(chunksAfter.c).toBe(0)
      const vecsAfter = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)')
        .get(key) as { c: number }
      expect(vecsAfter.c).toBe(0)

      const hitsAfter = mergeNearbyHits(await searchSemantic(db, query, 5))
      expect(hitsAfter.some((h) => h.filePath === key)).toBe(false)
    },
  )
})

// Regression: indexFileEmbeddings's early-return branches for a symbol-only-tier file (over
// large_file_symbol_only_kb but under large_file_skip_kb -- keeps symbols, intentionally skips
// embedding) called deleteFileEmbeddings and returned WITHOUT stamping files.embed_sha. Because
// the embedUnchanged gate in both cmdIndex (cli.ts) and makeIndexer (worker.ts) compares
// entry.embedSha against a real sha, embed_sha stayed perpetually unset/stale for such a file,
// so indexFileEmbeddings got re-entered -- one extra statSync + a no-op deleteFileEmbeddings call
// -- on every single subsequent `token-goat index` run, forever, even though nothing about the
// file ever changed. Drives the real cmdIndex path (not an injected callback), spying only on
// parser.js's indexFileEmbeddings to count real invocations while still calling through to the
// real implementation -- the same seam tests/cmdindex_unchanged_skip.test.ts already uses for
// this exact kind of gate regression.
describe('indexing.large_file_symbol_only_kb embed_sha stamping (regression)', () => {
  it('stamps a terminal (bare-sha) embed_sha for a symbol-only-tier file so a repeat cmdIndex run does not re-enter indexFileEmbeddings', async () => {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    const cfg = defaultConfig()
    cfg.indexing.large_file_symbol_only_kb = 1 // 1 KB cap -- keep symbols, skip embedding
    saveConfig(cfg)

    const src = path.join(TMP, 'symbolonly.ts')
    fs.writeFileSync(
      src,
      `// ${'x'.repeat(2000)}\nexport function symbolOnlySymbol(): number {\n  return 1\n}\n`,
    )

    const realIndexFileEmbeddings = parserModule.indexFileEmbeddings
    const embedSpy = vi
      .spyOn(parserModule, 'indexFileEmbeddings')
      .mockImplementation((fp, dbp, sha) => realIndexFileEmbeddings(fp, dbp, sha))

    // First run: the file is new, so indexFileEmbeddings must be entered once (it hits the
    // large_file_symbol_only_kb branch internally, deletes any embeddings, and stamps the file's
    // real content sha -- per isEmbedFresh's own contract, a bare-sha match while embeddings are
    // enabled is a terminal "nothing to embed" state regardless of deps, same as an empty file).
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(embedSpy).toHaveBeenCalledTimes(1)
    expect(querySymbols({ name: 'symbolOnlySymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)

    const key = resolveIndexPath(src)
    const entry = getFileEntry(key, dbPath)
    const fileSha = getFileEntry(key, dbPath)?.sha
    expect(entry?.embedSha).toBe(fileSha)

    embedSpy.mockClear()

    // Second run over the SAME, byte-identical file: embedUnchanged must now hold (embed_sha
    // matches the stamped bare sha), so indexFileEmbeddings must not be re-entered at all.
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(embedSpy).not.toHaveBeenCalled()
    expect(querySymbols({ name: 'symbolOnlySymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
  })
})
