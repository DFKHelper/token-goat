import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { checkDbExists, checkConfigValid, checkInstall, checkDiskSpace, checkCopilotCli, checkGlobalMcpConfig, checkMcpProcessHealth, checkSymbolCount, checkEmbeddingCoverage, checkSymbolBodySize, checkCompactionChannel, checkDirtyQueueHealth, checkTsCompiler, readWindowsProcesses, runDoctor, runDoctorAndExit, type ProcessInfo } from '../src/cli_doctor.js'
import { dirtyQueuePathFor, drainHeartbeatPathFor, workerPidPath } from '../src/worker.js'
import { getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { setTsModuleForTesting } from '../src/ts_refs.js'
import { setSkillOutputsDirForTesting } from '../src/skill_cache.js'
import { normalizePath } from '../src/paths.js'
import { GLOBAL_SCHEMA_SQL } from '../src/stats.js'
import { MAX_SYMBOL_BODY_CHARS } from '../src/parser.js'
import { OVERSIZED_BODY_PROBE_SQL } from '../src/cli_doctor.js'
import type * as CliContextStats from '../src/cli_context_stats.js'
import type * as ChildProcess from 'child_process'

// runContextStats is `async` (needed for --fix's confirm-gate); runDoctorAndExit's own --context
// path used to call it fire-and-forget with no await, which turned a synchronous throw into a
// silently-swallowed unhandled promise rejection instead of propagating like every other doctor
// error. Mock it to throw so we can assert runDoctorAndExit's own returned promise rejects.
vi.mock('../src/cli_context_stats.js', async (importOriginal) => {
  const original = await importOriginal<typeof CliContextStats>()
  return { ...original, runContextStats: vi.fn(original.runContextStats) }
})

// spawnSync is mocked (wrapping the real implementation by default via importOriginal, same
// pattern as the cli_context_stats mock above) only so one test below can force the df-fallback
// path's output deterministically, since fs.statfsSync itself can't be stubbed (ESM namespace
// exports are non-configurable -- see the existing "no module mocking needed" comment further
// down this file) and a real machine's actual free space can't be controlled from a test.
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>()
  return { ...original, spawnSync: vi.fn(original.spawnSync) }
})

// Passed by every runDoctor test that is not about process health. Gathering the real list shells
// out to PowerShell for a full Win32_Process listing, which measured 1.2 s of runDoctor's 1.5 s and
// was the single largest cost in this file. The default gather is still covered, once, below.
const NO_PROCESSES: ProcessInfo[] = []

describe('cli_doctor', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor_test_'))
  })

  afterEach(() => {
    // checkSymbolCount opens the db via getDb, which caches an open handle per path;
    // close it before rmSync or Windows refuses to delete the locked .db/.db-wal files.
    clearModuleCaches()
    setTsModuleForTesting(undefined)
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('checkMcpProcessHealth', () => {
    it('warns about duplicate MCP launchers and orphaned Node processes without mutating them', () => {
      const result = checkMcpProcessHealth([
        { processId: 1, parentProcessId: 0, name: 'copilot.exe', commandLine: '' },
        { processId: 2, parentProcessId: 1, name: 'node.exe', commandLine: 'npx-cli.js chrome-devtools-mcp@latest' },
        { processId: 3, parentProcessId: 1, name: 'node.exe', commandLine: 'npx-cli.js chrome-devtools-mcp@latest' },
        { processId: 4, parentProcessId: 999, name: 'node.exe', commandLine: 'scripts/selfimprove-scheduler.mjs' },
      ])

      expect(result.status).toBe('warn')
      expect(result.message).toContain('2 Chrome DevTools MCP launchers')
      expect(result.message).toContain('1 orphaned Node process')
    })

    it("does not report token-goat's own detached indexing daemon as an orphan", () => {
      // The daemon is spawned detached on purpose, so it has no live parent from the moment it
      // starts. Flagging it fired this warning on nearly every install, and the advice attached to
      // it -- terminate the orphan -- would stop incremental indexing.
      const result = checkMcpProcessHealth([
        { processId: 1, parentProcessId: 0, name: 'copilot.exe', commandLine: '' },
        { processId: 7, parentProcessId: 999, name: 'node.exe', commandLine: 'C:\\dist\\token-goat.mjs --worker-daemon' },
      ])

      expect(result.status, result.message).toBe('ok')
      expect(result.message, 'the ok message states nothing was found, not a count').not.toMatch(/\d+ orphaned/)
    })

    it('still reports a genuinely parentless Node process alongside the daemon', () => {
      // The carve-out must be the daemon flag specifically, not "any parentless node.exe once a
      // daemon is present" -- otherwise running the daemon would blind the whole check.
      const result = checkMcpProcessHealth([
        { processId: 7, parentProcessId: 999, name: 'node.exe', commandLine: 'C:\\dist\\token-goat.mjs --worker-daemon' },
        { processId: 8, parentProcessId: 998, name: 'node.exe', commandLine: 'scripts/selfimprove-scheduler.mjs' },
      ])

      expect(result.status).toBe('warn')
      expect(result.message, 'only the non-daemon process should be counted').toContain('1 orphaned Node process')
    })
  })

  describe('checkGlobalMcpConfig', () => {
    it('accepts an absent global MCP configuration', () => {
      const configPath = path.join(tempDir, 'mcp-config.json')
      const result = checkGlobalMcpConfig(configPath)

      expect(result.status).toBe('ok')
      expect(result.message).toContain(configPath)
    })

    it('warns when the global configuration cannot be parsed', () => {
      const configPath = path.join(tempDir, 'mcp-config.json')
      fs.writeFileSync(configPath, '{ malformed')

      const result = checkGlobalMcpConfig(configPath)

      expect(result.status).toBe('warn')
      expect(result.message).toContain('unable to audit heavy launchers')
      expect(result.message).toContain(configPath)
    })

    it('ignores non-matching MCP servers without exposing their configuration', () => {
      const configPath = path.join(tempDir, 'mcp-config.json')
      fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          unrelated: { command: 'node', args: ['server.mjs', '--token', 'secret-value'] },
        },
      }))

      const result = checkGlobalMcpConfig(configPath)

      expect(result.status).toBe('ok')
      expect(result.message).toContain('no known heavy global MCP launchers')
      expect(result.message).not.toContain('unrelated')
      expect(result.message).not.toContain('secret-value')
    })

    it('warns only for known heavy npx MCP launchers', () => {
      const configPath = path.join(tempDir, 'mcp-config.json')
      fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          browser: { command: 'npx.cmd', args: ['-y', 'chrome-devtools-mcp@latest'] },
          playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
        },
      }))

      const result = checkGlobalMcpConfig(configPath)

      expect(result.status).toBe('warn')
      expect(result.message).toContain('1 Chrome DevTools MCP launcher')
      expect(result.message).toContain('1 Playwright MCP launcher')
      expect(result.message).toContain('Move heavy launchers to project scope')
      expect(result.message).not.toContain('browser')
      expect(result.message).not.toContain('playwright:')
    })
  })

  describe('checkDbExists', () => {
    it('returns ok when database exists', () => {
      const dbPath = path.join(tempDir, 'global.db')
      fs.writeFileSync(dbPath, 'SQLite format 3\0mock db content')

      const result = checkDbExists(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('global.db exists')
      // The healthy message must name the resolved path, exactly as the oversized-db warn branch
      // already does. TOKEN_GOAT_HOME and the data dir resolve independently, so without the path
      // a run against the real global index is indistinguishable from an isolated scratch one --
      // which is how a dogfood claim of "verified against the isolated index" once stood despite
      // that index holding zero rows.
      expect(result.message).toContain(dbPath)
    })

    it('returns warn when database missing', () => {
      const result = checkDbExists(tempDir)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('not found')
    })

    it('includes file size in message', () => {
      const dbPath = path.join(tempDir, 'global.db')
      fs.writeFileSync(dbPath, 'SQLite format 3\0' + 'x'.repeat(2048))

      const result = checkDbExists(tempDir)
      expect(result.message).toMatch(/\d+ KB/)
    })

    // Regression (task #172): checkDbExists only checked fs.existsSync + reported size,
    // so a 0-byte or truncated file (e.g. from a crash mid-creation) still reported 'ok'.
    // It now validates the SQLite magic header ("SQLite format 3\0") the same way
    // checkConfigValid parses TOML content instead of just checking file presence.
    it('returns fail (not ok) for a 0-byte global.db', () => {
      const dbPath = path.join(tempDir, 'global.db')
      fs.writeFileSync(dbPath, '')

      const result = checkDbExists(tempDir)
      expect(result.status).not.toBe('ok')
      expect(result.status).toBe('fail')
      expect(result.message).toContain('not a valid SQLite file')
    })

    it('returns fail (not ok) for a truncated global.db missing the SQLite header', () => {
      const dbPath = path.join(tempDir, 'global.db')
      fs.writeFileSync(dbPath, 'SQLite fo')

      const result = checkDbExists(tempDir)
      expect(result.status).not.toBe('ok')
      expect(result.status).toBe('fail')
      expect(result.message).toContain('not a valid SQLite file')
    })
  })

  // Regression (round 10 #37): guards against the worker-draining-to-a-stub-callback
  // failure mode documented in CLAUDE.md's "Critical path" section — a release once
  // shipped with the queue drain wired to a default stub, so files were marked
  // indexed while the parser never ran and `symbols` stayed permanently empty. No
  // existing doctor check caught this because checkDbExists only validates the
  // SQLite header, not table contents.
  describe('checkSymbolCount', () => {
    it('returns ok (no database yet) when global.db does not exist', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const result = checkSymbolCount(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no database yet')
    })

    it('returns ok when files are indexed and symbols exist', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      db.prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
        'src/main.ts',
        'sha',
        1,
        'typescript',
        1,
      )
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('src/main.ts', 'main', 'function', 1, 2, '', '')

      const result = checkSymbolCount(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('1 symbol')
    })

    // Previously reported ok ("no files indexed yet, nothing to expect"). That is the wrong
    // reading: an existing-but-empty index makes every read command return empty, which an agent
    // reads as a genuine "not found" rather than as missing data. A whole verification pass was
    // once accepted on an empty scratch index for exactly this reason -- semantic printed
    // "no matches" and that looked like a result. Warn and name the remedy instead.
    it('warns when the database exists but nothing is indexed', () => {
      const dbPath = path.join(tempDir, 'global.db')
      getDb(dbPath) // creates the schema but inserts nothing
      const result = checkSymbolCount(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('no files indexed')
      expect(result.message).toContain('token-goat index .')
    })

    it('warns when files are indexed but the symbols table is empty (stub-callback regression)', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      db.prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
        'src/main.ts',
        'sha',
        1,
        'typescript',
        1,
      )
      // Deliberately no INSERT into symbols — simulates the worker draining files
      // into a stub callback that never invoked the parser.

      const result = checkSymbolCount(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('0 symbols extracted')
    })

    // Regression: global.db is a single machine-wide index shared across every project ever
    // indexed (see the projectScopeClause fix, commit 6a5ac228, which scoped map/semantic/
    // find/dead but never touched checkSymbolCount even though it was added in that same
    // commit). Without a rootDir scope, a project whose OWN parser is broken (0 symbols for
    // its own files) gets masked by an unrelated project's symbols sharing the same global.db
    // -- the exact stub-callback failure mode this check exists to catch goes silently
    // unreported as long as some other project happens to have symbols indexed too.
    it('scopes counts to rootDir, catching a broken project masked by another project sharing global.db', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      const brokenRoot = path.join(tempDir, 'proj-broken')
      const healthyRoot = path.join(tempDir, 'proj-healthy')

      // Broken project: file indexed, but the parser never ran -- zero of ITS symbols.
      // Stored via normalizePath(), matching the invariant every real writer relies on
      // (see worker.ts's dirty-queue write doc comment, line ~138) -- a raw backslash-replace here
      // would drift from the real on-disk key on platforms where normalizePath() does more
      // than swap separators (e.g. macOS's /var -> /private/var alias, or Windows 8.3
      // short-name expansion when %TEMP% is pinned to short form), silently breaking the
      // rootDir LIKE-prefix match this test exists to exercise.
      db.prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
        normalizePath(path.join(brokenRoot, 'src', 'main.ts')),
        'sha',
        1,
        'typescript',
        1,
      )

      // Unrelated healthy project sharing the same global.db, with real symbols.
      const healthyFile = normalizePath(path.join(healthyRoot, 'src', 'main.ts'))
      db.prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
        healthyFile,
        'sha',
        1,
        'typescript',
        1,
      )
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(healthyFile, 'main', 'function', 1, 2, '', '')

      const result = checkSymbolCount(dbPath, brokenRoot)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('0 symbols extracted')
    })
  })

  // Symbol coverage and embedding coverage fail independently, and only the first was ever
  // reported. Every terminal skip in indexFileEmbeddings (a file over
  // indexing.large_file_symbol_only_kb, a .profile-meta.xml, oversized Salesforce metadata, a
  // document with no extractable text) stamps a real embed_sha so the worker stops re-reading
  // the file -- correct individually, and it also means such a file is indistinguishable from an
  // embedded one at the freshness gate and is never retried. Nothing summed those skips, so a
  // real index was found with 356 of 11000 files embedded while every doctor check read ok, and
  // `semantic` reported finding nothing using the same words it uses after searching everything.
  describe('checkEmbeddingCoverage', () => {
    // tests/setup/isolate-home.ts sets TOKEN_GOAT_EMBEDDINGS_ENABLED=false for the whole suite, so
    // without this every case below would return early down the "disabled" branch and pass while
    // asserting nothing about coverage -- the same shape of trap the check itself exists to catch.
    // Turn it on for this block, and let the disabled case turn it back off explicitly so that it
    // discriminates instead of agreeing with the ambient default.
    let prevEmbedEnv: string | undefined
    beforeEach(() => {
      prevEmbedEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      clearModuleCaches()
    })
    afterEach(() => {
      if (prevEmbedEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
      else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbedEnv
      clearModuleCaches()
    })

    const insertFile = (db: ReturnType<typeof getDb>, p: string) =>
      db
        .prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)')
        .run(p, 'sha', 1, 'typescript', 1)
    const insertChunk = (db: ReturnType<typeof getDb>, p: string) =>
      db
        .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
        .run(p, 1, 2, 'body', 'symbol')

    it('returns ok (no database yet) when global.db does not exist', () => {
      const result = checkEmbeddingCoverage(path.join(tempDir, 'global.db'))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no database yet')
    })

    it('returns ok when most indexed files have embeddings', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      for (let i = 0; i < 10; i++) insertFile(db, `src/f${i}.ts`)
      for (let i = 0; i < 8; i++) insertChunk(db, `src/f${i}.ts`)
      const result = checkEmbeddingCoverage(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('8 of 10')
    })

    it('warns when almost none of the indexed files have embeddings', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      for (let i = 0; i < 10; i++) insertFile(db, `src/f${i}.ts`)
      insertChunk(db, 'src/f0.ts')
      const result = checkEmbeddingCoverage(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('1 of 10')
      expect(result.message).toContain('10%')
      // Must name the setting that actually causes it, or the reader has a number and no action.
      expect(result.message).toContain('indexing.large_file_symbol_only_kb')
      // ...and must say the symbol side still works, so this does not read as a broken index.
      expect(result.message).toContain('Exact symbol lookups are unaffected')
    })

    // The discriminating case. One heavily-chunked file produces many chunk ROWS while covering
    // one file; counting rows instead of distinct paths would read 50 chunks against 10 files as
    // healthy coverage and hide exactly the condition this check exists to find. Replacing
    // COUNT(DISTINCT file_path) with COUNT(*) in getEmbeddingCoverage turns this test red and
    // leaves the two tests above green.
    it('counts distinct embedded files, not chunk rows', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      for (let i = 0; i < 10; i++) insertFile(db, `src/f${i}.ts`)
      for (let i = 0; i < 50; i++) insertChunk(db, 'src/f0.ts')
      const result = checkEmbeddingCoverage(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('1 of 10')
    })

    // Off on purpose is not a health problem. Warning here would be a warning that can never
    // clear while the setting stands, which is noise the reader learns to ignore.
    it('returns ok without warning when embeddings are disabled by config', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      for (let i = 0; i < 10; i++) insertFile(db, `src/f${i}.ts`)
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
      clearModuleCaches()
      const result = checkEmbeddingCoverage(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('disabled')
    })
  })

  // The manifest token-goat prints ahead of a compaction reaches the summarizing model through a
  // route Claude Code does not document, so if that route ever closes nothing throws and nothing
  // fails -- the only symptom is summaries that stop naming real paths. postCompactHandler records
  // how many sent paths came back out of each summary; this check is what turns that record into
  // something a person sees. Its whole difficulty is not crying wolf, so most of what is pinned
  // here is the cases where it must stay quiet.
  describe('checkCompactionChannel', () => {
    function seedDetails(dbPath: string, details: string[]): void {
      const db = getDb(dbPath)
      db.exec(GLOBAL_SCHEMA_SQL)
      const stmt = db.prepare("INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail) VALUES (?, 'compact_summary', 0, 0, ?)")
      for (const d of details) stmt.run(Date.now(), d)
    }

    it('returns ok when there is no database yet', () => {
      const result = checkCompactionChannel(path.join(tempDir, 'global.db'))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no database yet')
    })

    it('returns ok when no compaction has been measured', () => {
      const dbPath = path.join(tempDir, 'global.db')
      getDb(dbPath)
      const result = checkCompactionChannel(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no compaction has been measured yet')
    })

    it('reports how many paths survived when the channel is working', () => {
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, ['trigger=auto bytes=900 est_tokens=300 manifest_paths=3/4', 'trigger=auto bytes=800 est_tokens=270 manifest_paths=2/4'])
      const result = checkCompactionChannel(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('5/8 sampled paths survived')
    })

    it('warns only after a full window of compactions that each had paths to find and found none', () => {
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, Array.from({ length: 5 }, () => 'trigger=auto bytes=700 est_tokens=240 manifest_paths=0/6'))
      const result = checkCompactionChannel(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('PreCompact')
    })

    it('stays quiet when only some of the window found nothing, because one paraphrased summary is not a broken channel', () => {
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, [
        ...Array.from({ length: 4 }, () => 'trigger=auto bytes=700 est_tokens=240 manifest_paths=0/6'),
        'trigger=auto bytes=700 est_tokens=240 manifest_paths=1/6',
      ])
      expect(checkCompactionChannel(dbPath).status).toBe('ok')
    })

    it('stays quiet below a full window even when every one of them found nothing', () => {
      // Four dead compactions is suggestive, not conclusive: a run of short sessions can each
      // legitimately produce a summary that names nothing. Accusing the harness on thin evidence
      // is the failure mode that would get this check ignored.
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, Array.from({ length: 4 }, () => 'trigger=auto bytes=700 est_tokens=240 manifest_paths=0/6'))
      expect(checkCompactionChannel(dbPath).status).toBe('ok')
    })

    it('ignores compactions that had nothing to look for, rather than counting them as failures', () => {
      // manifest_paths=0/0 means the session had touched no files, so the summary could not have
      // reproduced one. Counting those as evidence would make a machine that mostly runs short
      // sessions report a dead channel forever.
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, Array.from({ length: 8 }, () => 'trigger=auto bytes=100 est_tokens=34 manifest_paths=0/0'))
      const result = checkCompactionChannel(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no compaction has been measured yet')
    })

    it('reads the most recent compactions, so a channel that recovered is not condemned by old rows', () => {
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, [
        ...Array.from({ length: 6 }, () => 'trigger=auto bytes=700 est_tokens=240 manifest_paths=0/6'),
        ...Array.from({ length: 5 }, () => 'trigger=auto bytes=700 est_tokens=240 manifest_paths=4/6'),
      ])
      const result = checkCompactionChannel(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('20/30 sampled paths survived')
    })

    it('is wired into runDoctor rather than only being callable', () => {
      const dbPath = path.join(tempDir, 'global.db')
      seedDetails(dbPath, Array.from({ length: 5 }, () => 'trigger=auto bytes=700 est_tokens=240 manifest_paths=0/6'))
      const results = runDoctor(tempDir, path.join(tempDir, 'config.toml'), tempDir, NO_PROCESSES)
      const row = results.find((r) => r.name === 'Compaction channel')
      expect(row, `no Compaction channel row in: ${results.map((r) => r.name).join(', ')}`).toBeDefined()
      expect(row?.status).toBe('warn')
    })
  })

  // Regression: total DB size (checkDbExists' DB_SIZE_WARN_BYTES) is a lagging proxy for the
  // MAX_SYMBOL_BODY_CHARS pathology -- a healthy-but-large multi-project index can stay well
  // under the 1 GB line while still containing genuinely oversized bodies from a pre-fix
  // minified/generated-file leftover. checkSymbolBodySize goes straight at the direct signal.
  describe('checkSymbolBodySize', () => {
    it('returns ok (no database yet) when global.db does not exist', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const result = checkSymbolBodySize(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no database yet')
    })

    it('returns ok when the largest stored body is within MAX_SYMBOL_BODY_CHARS', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('src/main.ts', 'main', 'function', 1, 2, 'return 1', '')

      const result = checkSymbolBodySize(dbPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('no stored symbol body exceeds the cap')
    })

    it('warns when a stored body exceeds MAX_SYMBOL_BODY_CHARS (pre-fix leftover)', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      const oversized = 'x'.repeat(200 * 1024)
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('src/generated.js', 'bloated', 'function', 1, 2, oversized, '')

      const result = checkSymbolBodySize(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('exceed the')
      expect(result.message).toContain('CANNOT remove')
      expect(result.message).toContain('reclaim-index --rebuild')
      expect(result.message).toContain('worker stop')
      // Regression: this message is surfaced verbatim in the SessionStart hook's earliest,
      // most cacheable context position, so it must not leak the specific offending file path
      // or exact char length -- neither is guaranteed stable across two runs (LIMIT 1, no
      // ORDER BY), let alone across a reindex.
      expect(result.message).not.toContain('src/generated.js')
      expect(result.message).not.toMatch(/is \d+ chars/)
    })

    it('is ok when a body is exactly MAX_SYMBOL_BODY_CHARS chars (boundary)', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      const exact = 'x'.repeat(MAX_SYMBOL_BODY_CHARS)
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('src/exact.js', 'exact', 'function', 1, 2, exact, '')

      const result = checkSymbolBodySize(dbPath)
      expect(result.status).toBe('ok')
    })

    it('warns when a body is MAX_SYMBOL_BODY_CHARS + 1 chars (boundary)', () => {
      const dbPath = path.join(tempDir, 'global.db')
      const db = getDb(dbPath)
      const overByOne = 'x'.repeat(MAX_SYMBOL_BODY_CHARS + 1)
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('src/overbyone.js', 'overbyone', 'function', 1, 2, overByOne, '')

      const result = checkSymbolBodySize(dbPath)
      expect(result.status).toBe('warn')
    })

    it('does not fail the whole doctor run when the DB is unreadable', () => {
      const dbPath = path.join(tempDir, 'global.db')
      fs.mkdirSync(dbPath) // a directory where a file is expected, so getDb() throws

      const result = checkSymbolBodySize(dbPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('could not query symbol body size')
    })

    // This check runs on every SessionStart. Its predicate cannot be served by any of the
    // name/file_path indexes, so before idx_symbols_oversized_body it read the whole symbols
    // table: 229 ms per session start on a real 226 MB / 231324-row index, and the early-exit
    // LIMIT 1 never fires on a healthy index because there is nothing to find. Every assertion
    // below guards a way of losing the index silently -- the answers stay correct, the check
    // just goes back to a full scan, which no behavioural test above would notice.
    describe('query plan', () => {
      it('creates the partial index on a fresh database', () => {
        const dbPath = path.join(tempDir, 'global.db')
        const db = getDb(dbPath)
        const idx = db
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_symbols_oversized_body'`)
          .get() as { sql: string } | undefined
        expect(idx).toBeDefined()
        // The index predicate and the probe's comparison have to agree textually for SQLite to
        // prove implication, so pin the shared threshold in both rather than the index's mere
        // existence -- an index built at a different cap would still be found by the query above.
        expect(idx?.sql).toContain(`LENGTH(body) > ${MAX_SYMBOL_BODY_CHARS}`)
        expect(OVERSIZED_BODY_PROBE_SQL).toContain(`LENGTH(body) > ${MAX_SYMBOL_BODY_CHARS}`)
      })

      it('serves the probe from the partial index instead of scanning symbols', () => {
        const dbPath = path.join(tempDir, 'global.db')
        const db = getDb(dbPath)
        db.prepare(
          'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run('src/main.ts', 'main', 'function', 1, 2, 'return 1', '')

        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${OVERSIZED_BODY_PROBE_SQL}`).all() as Array<{ detail: string }>)
          .map((r) => r.detail)
          .join(' | ')
        expect(plan).toContain('idx_symbols_oversized_body')
        // A plain `SCAN symbols` with no index named is the exact regression this pins.
        expect(plan).not.toMatch(/SCAN symbols(?! USING)/)
      })

      it('does not let the partial index hide rows from a reader using a lower threshold', () => {
        const dbPath = path.join(tempDir, 'global.db')
        const db = getDb(dbPath)
        const ins = db.prepare(
          'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        ins.run('src/small.ts', 'small', 'function', 1, 2, 'x'.repeat(2000), '')
        ins.run('src/huge.ts', 'huge', 'function', 1, 2, 'x'.repeat(200 * 1024), '')

        // The index holds only rows over the cap. A reader asking about a *lower* threshold must
        // still see both rows: SQLite falls back to a full scan because 2000 does not imply the
        // index predicate. This is the soundness half of the optimisation -- if the planner ever
        // reused this index for a threshold it does not cover, callers would silently lose rows.
        const rows = db.prepare('SELECT name FROM symbols WHERE LENGTH(body) > 1000').all() as Array<{ name: string }>
        expect(rows.map((r) => r.name).sort()).toEqual(['huge', 'small'])
      })
    })
  })

  describe('checkDirtyQueueHealth', () => {
    it('returns ok with zero pending when the queue file does not exist', () => {
      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('0 file(s) pending')
    })

    it('returns ok (worker not running) when the queue has entries but no worker process is alive', () => {
      const queuePath = dirtyQueuePathFor(tempDir)
      fs.mkdirSync(path.dirname(queuePath), { recursive: true })
      fs.writeFileSync(queuePath, 'a.ts\nb.ts\n')

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('2 file(s) pending')
      expect(result.message).toContain('worker not running')
    })

    it('warns when the backlog exceeds the threshold, even with the worker running', () => {
      const queuePath = dirtyQueuePathFor(tempDir)
      fs.mkdirSync(path.dirname(queuePath), { recursive: true })
      fs.writeFileSync(queuePath, Array.from({ length: 501 }, (_, i) => `file${i}.ts`).join('\n') + '\n')

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('501 file(s) pending')
    })

    it('returns ok when the worker is running and its heartbeat is fresh', () => {
      // A real, currently-alive pid (this test process itself) makes isWorkerRunning's
      // process.kill(pid, 0) liveness probe succeed without needing to spawn anything.
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(workerPidPath(tempDir), String(process.pid))
      fs.mkdirSync(path.dirname(drainHeartbeatPathFor(tempDir)), { recursive: true })
      fs.writeFileSync(drainHeartbeatPathFor(tempDir), `${process.pid}\n`)

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('actively draining')
    })

    it('reports a worker as not running when its heartbeat lease is stale', () => {
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(workerPidPath(tempDir), String(process.pid))
      const heartbeatPath = drainHeartbeatPathFor(tempDir)
      fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true })
      fs.writeFileSync(heartbeatPath, `${process.pid}\n`)
      const staleMs = Date.now() - 5 * 60 * 1000 // 5 minutes ago, well past the staleness threshold
      fs.utimesSync(heartbeatPath, new Date(staleMs), new Date(staleMs))

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('worker not running')
    })

    it('reports the worker as not running until it writes its first heartbeat lease', () => {
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(workerPidPath(tempDir), String(process.pid))
      // Deliberately no heartbeat file written -- the PID alone cannot prove worker ownership.

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('worker not running')
    })
  })

  describe('checkConfigValid', () => {
    it('returns ok for valid TOML config', () => {
      // Production config files are TOML (see constants.ts configPath()), not JSON.
      const configPath = path.join(tempDir, 'config.toml')
      fs.writeFileSync(configPath, 'key = "value"\n')

      const result = checkConfigValid(configPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('valid')
    })

    it('returns warn when config missing', () => {
      const configPath = path.join(tempDir, 'missing.toml')
      const result = checkConfigValid(configPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('not found')
    })

    it('returns fail for invalid TOML', () => {
      const configPath = path.join(tempDir, 'config.toml')
      fs.writeFileSync(configPath, 'key = "unterminated string\n')

      const result = checkConfigValid(configPath)
      expect(result.status).toBe('fail')
      expect(result.message).toContain('invalid')
    })

    it('includes file size for valid config', () => {
      const configPath = path.join(tempDir, 'config.toml')
      fs.writeFileSync(configPath, 'test = "value"\n')

      const result = checkConfigValid(configPath)
      expect(result.message).toMatch(/\d+ bytes/)
    })
  })

  describe('checkInstall', () => {
    it('returns result with name and status', () => {
      const result = checkInstall()
      expect(result.name).toBe('Installation')
      expect(['ok', 'fail']).toContain(result.status)
    })

    it('includes message with version or error', () => {
      const result = checkInstall()
      // message is bimodal on real, environment-dependent state (is token-goat installed
      // globally on this machine?), so an exact pin isn't possible -- but each branch has a
      // deterministic shape, so pin those instead of a bare ">0".
      if (result.status === 'ok') {
        expect(result.message).toMatch(/^\d+\.\d+\.\d+/)
      } else {
        expect(result.message).toBe('token-goat command not found; run: npm install -g token-goat-ts')
      }
    })
  })

  describe('checkDiskSpace', () => {
    it('returns a result with Disk Space name', () => {
      const result = checkDiskSpace(tempDir)
      expect(result.name).toBe('Disk Space')
    })

    it('returns ok or warn status', () => {
      const result = checkDiskSpace(tempDir)
      expect(['ok', 'warn']).toContain(result.status)
    })

    it('includes message text', () => {
      const result = checkDiskSpace(tempDir)
      // Real available-bytes count is environment-dependent, but the message's shape
      // ("<formatted size> available[ -- warn suffix]") is deterministic -- pin that instead
      // of a bare ">0".
      expect(result.message).toMatch(/^\d+\.\d (B|KB|MB|GB|TB) available( — running low.*)?$/)
    })

    it('handles invalid paths gracefully', () => {
      const result = checkDiskSpace('/nonexistent/path/xyz/abc/def')
      expect(result.name).toBe('Disk Space')
      expect(['ok', 'warn']).toContain(result.status)
    })
  })

  describe('checkTsCompiler', () => {
    it('returns ok when the typescript compiler module loads', () => {
      const result = checkTsCompiler()
      expect(result.name).toBe('TypeScript compiler')
      expect(result.status).toBe('ok')
      expect(result.message).toBe('available')
    })

    it('returns warn (not fail) when the typescript compiler module is unavailable', () => {
      setTsModuleForTesting(null)
      const result = checkTsCompiler()
      expect(result.name).toBe('TypeScript compiler')
      expect(result.status).toBe('warn')
      expect(result.message).toContain('unavailable')
    })
  })

  describe('runDoctor', () => {
    // The one test that leaves `processes` undefined, so the real gather runs. Without it the
    // gather would be dead code that no test ever reaches -- every other test here supplies the
    // argument, which is exactly the injected-seam shape where a shipping path rots unnoticed.
    // It was already untested before the argument existed: checkMcpProcessHealth had synthetic-row
    // coverage, but nothing asserted runDoctor wires it in at all.
    it.runIf(process.platform === 'win32')('gathers the Windows process list itself when none is supplied', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      const health = results.find((r) => r.name === 'MCP process health')
      expect(health, 'runDoctor did not run the MCP process-health check at all').toBeDefined()
      // This process is running right now, so a real gather cannot come back empty; an empty list
      // would have produced the "no duplicate MCP launchers" ok message with nothing behind it.
      //
      // A null gather is a different outcome from an empty one and is NOT a product defect: it
      // means the PowerShell Get-CimInstance call hit its 20s timeout, which the full suite can
      // provoke under parallel load, and returning null there is the behaviour the next case in
      // this file asserts on purpose. Observed failing exactly once in a full run and passing
      // isolated, whole-file, and in a clean full run. Skipping the null case keeps the real
      // invariant -- a gather that SUCCEEDS must contain this process -- while no longer
      // reporting an environment timeout as a defect. It is not a skip-to-green: a successful
      // gather missing our own pid still fails, which is the bug this case was written for.
      const processes = readWindowsProcesses()
      if (processes !== null) {
        expect(processes.some((p) => p.processId === process.pid)).toBe(true)
      }
    })

    it('says the process list could not be read rather than reporting a clean bill of health', () => {
      // A failed gather used to come back as an empty array, indistinguishable from a machine with
      // no processes, so doctor printed "no duplicate MCP launchers detected" backed by no data.
      const health = checkMcpProcessHealth(null)

      expect(health.status).toBe('warn')
      expect(health.message).toContain('could not read the process list')
      expect(health.message).not.toContain('no duplicate MCP launchers')
    })

    it('still reports a genuinely empty process list as ok, not as a failure', () => {
      const health = checkMcpProcessHealth([])

      expect(health.status).toBe('ok')
      expect(health.message).toContain('no duplicate MCP launchers')
    })

    // Windows-only: off Windows the function returns [] before it ever runs a command, which the
    // sibling test below pins.
    it.runIf(process.platform === 'win32')('returns null when the process-list command fails, not an empty list', () => {
      const failed = readWindowsProcesses(() => {
        throw new Error('powershell timed out')
      })

      expect(failed).toBeNull()
    })

    it.runIf(process.platform === 'win32')('returns an empty list when the command answers with nothing, which is not a failure', () => {
      expect(readWindowsProcesses(() => '')).toEqual([])
    })

    it.runIf(process.platform !== 'win32')('returns an empty list off Windows without running anything', () => {
      expect(
        readWindowsProcesses(() => {
          throw new Error('must not be called')
        }),
      ).toEqual([])
    })

    it('returns array of doctor results', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'), undefined, NO_PROCESSES)
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })

    // One run, one case, covering what six near-identical cases used to. Each of those ran a
    // whole doctor pass to assert that one name was present and nothing else about it, so a check
    // that had been reduced to a bare name with no message still passed all six. This asserts the
    // full expected set in one pass and requires each of them to actually report something.
    it('runs every check it is expected to run, and each one reports something', () => {
      const expected = [
        'Installation',
        'Worker',
        'TypeScript compiler',
        'Database',
        'Symbol body size',
        'Config',
      ]

      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'), undefined, NO_PROCESSES)

      expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(expected))
      const empty = expected.filter((name) => (results.find((r) => r.name === name)?.message ?? '') === '')
      expect(empty).toEqual([])
    })

    it('marks results with ok/warn/fail status', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'), undefined, NO_PROCESSES)
      for (const result of results) {
        expect(['ok', 'warn', 'fail']).toContain(result.status)
      }
    })

    it('scopes the Worker check to the passed-in dataDir, not the real default install dir', () => {
      // checkDbExists/checkSymbolCount/checkDirtyQueueHealth all correctly scope to the
      // dataDir runDoctor was given -- the Worker check must too, or a caller diagnosing
      // one dataDir gets a report describing an entirely different directory's worker.
      // A real, currently-alive pid (this test process itself) makes isWorkerRunning's
      // process.kill(pid, 0) liveness probe succeed without needing to spawn anything.
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(workerPidPath(tempDir), String(process.pid))
      fs.mkdirSync(path.dirname(drainHeartbeatPathFor(tempDir)), { recursive: true })
      fs.writeFileSync(drainHeartbeatPathFor(tempDir), `${process.pid}\n`)

      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'), undefined, NO_PROCESSES)
      const worker = results.find((r) => r.name === 'Worker')
      expect(worker?.status).toBe('ok')
      expect(worker?.message).toBe('running')
    })
  })

  describe('checkCopilotCli', () => {
    function writeConfig(configPath: string, hooks: unknown): void {
      fs.writeFileSync(configPath, JSON.stringify({ version: 1, hooks }))
    }

    it('returns null when Copilot CLI integration is not installed', () => {
      const configPath = path.join(tempDir, 'token-goat.json')
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      expect(checkCopilotCli(configPath, scriptPath)).toBeNull()
    })

    it('returns fail for a config that is not valid JSON', () => {
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      fs.writeFileSync(scriptPath, '// shim placeholder')
      const configPath = path.join(tempDir, 'token-goat.json')
      fs.writeFileSync(configPath, '{ not valid json')

      const result = checkCopilotCli(configPath, scriptPath)
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('not valid JSON')
    })

    it('returns fail when the config has no preToolUse entry', () => {
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      fs.writeFileSync(scriptPath, '// shim placeholder')
      const configPath = path.join(tempDir, 'token-goat.json')
      writeConfig(configPath, {})

      const result = checkCopilotCli(configPath, scriptPath)
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('no preToolUse entry')
    })

    it('returns fail when the baked node binary no longer exists (stale after an nvm/fnm/volta upgrade)', () => {
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      fs.writeFileSync(scriptPath, '// shim placeholder')
      const configPath = path.join(tempDir, 'token-goat.json')
      const staleExecPath = path.join(tempDir, 'does-not-exist-node.exe')
      writeConfig(configPath, {
        preToolUse: [{ type: 'command', command: `"${staleExecPath}" "${scriptPath}" preToolUse`, timeoutSec: 60 }],
      })

      const result = checkCopilotCli(configPath, scriptPath)
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('no longer exists')
      expect(result?.message).toContain('restart Copilot CLI')
    })

    it('returns fail when the hook process exits non-zero -- the exact condition that denies every tool call for the rest of the session', () => {
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      fs.writeFileSync(scriptPath, 'process.exit(1)')
      const configPath = path.join(tempDir, 'token-goat.json')
      writeConfig(configPath, {
        preToolUse: [{ type: 'command', command: `"${process.execPath}" "${scriptPath}"`, timeoutSec: 60 }],
      })

      const result = checkCopilotCli(configPath, scriptPath)
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('status 1')
      expect(result?.message).toContain('restart Copilot CLI')
    })

    it('returns fail when the hook does not return valid JSON on stdout', () => {
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      fs.writeFileSync(scriptPath, "process.stdout.write('not json')")
      const configPath = path.join(tempDir, 'token-goat.json')
      writeConfig(configPath, {
        preToolUse: [{ type: 'command', command: `"${process.execPath}" "${scriptPath}"`, timeoutSec: 60 }],
      })

      const result = checkCopilotCli(configPath, scriptPath)
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('did not return valid JSON')
    })

    it('returns ok when the installed hook invokes cleanly and returns valid JSON, end-to-end through a shell exactly like Copilot itself would', () => {
      const scriptPath = path.join(tempDir, 'token-goat-shim.js')
      fs.writeFileSync(scriptPath, "process.stdout.write('{}')")
      const configPath = path.join(tempDir, 'token-goat.json')
      writeConfig(configPath, {
        preToolUse: [{ type: 'command', command: `"${process.execPath}" "${scriptPath}"`, timeoutSec: 60 }],
      })

      const result = checkCopilotCli(configPath, scriptPath)
      expect(result?.status).toBe('ok')
    })
  })

  describe('checkDiskSpace shell safety', () => {
    it('returns warn rather than executing injected shell commands via dataDir', () => {
      // A path containing shell metacharacters must not cause command execution. With the spawnSync fix, the argument is passed verbatim to df — the shell never interprets it, so we get at most a warn (df can't find the path).
      const injectedPath = tempDir + '; echo INJECTED'
      const result = checkDiskSpace(injectedPath)
      expect(result.name).toBe('Disk Space')
      // The outcome is 'ok' or 'warn' — never a crash or unexpected side effect.
      expect(['ok', 'warn']).toContain(result.status)
      // The message must not contain the injected text (proof the shell didn't run it).
      expect(result.message).not.toContain('INJECTED')
    })
  })

  describe('checkDiskSpace platform coverage (task #104)', () => {
    it('reports a real, non-placeholder available size for an existing directory', () => {
      // Regression: on stock Windows (no df on PATH) the old implementation always fell
      // through to the generic "could not determine" message, silently never reporting a
      // real number. fs.statfsSync works cross-platform (including Windows), so a valid,
      // existing directory should now produce an actual size, not the placeholder text.
      const result = checkDiskSpace(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).not.toBe('could not determine')
      expect(result.message).toMatch(/[\d.]+ (B|KB|MB|GB|TB) available/)
    })

    it('warns instead of reporting ok when free space is below the low-disk threshold', async () => {
      // Regression: checkDiskSpace used to hardcode status: 'ok' on every successful read
      // regardless of how little space was actually left, making it a "check" that could
      // never flag the exact problem ("running out of disk") it exists to catch. Forces the
      // df-fallback path (statfsSync throws on a nonexistent path, and platform is pinned to
      // non-win32 so the fallback isn't skipped) with a mocked spawnSync returning a `df -k`
      // response reporting only 100MB available, well under LOW_DISK_WARN_BYTES (1 GiB).
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const { spawnSync } = await import('child_process')
      const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>
      mockedSpawnSync.mockReturnValueOnce({
        status: 0,
        error: undefined,
        stdout: 'Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/sda1      102400000 92160000    102400  90% /\n',
        stderr: '',
      })
      try {
        const result = checkDiskSpace(path.join(tempDir, 'does-not-exist-xyz'))
        expect(result.name).toBe('Disk Space')
        expect(result.status).toBe('warn')
        expect(result.message).toContain('running low')
        expect(result.message).toMatch(/[\d.]+ (B|KB|MB|GB|TB) available/)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    it('passes -P to df so a wrapped long filesystem-name line does not desync the column parse', async () => {
      // Regression: plain `df -k` (no -P) is not required to keep each entry on one line -- a
      // long filesystem/device name can wrap onto its own line, pushing the stat columns to
      // lines[2] instead of lines[1] and silently misreading `Available` as some other column.
      // `-P` forces POSIX single-line output. This test both asserts `-P` is actually passed and
      // proves the parse is still correct in the wrapped-name shape POSIX mode guarantees away.
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const { spawnSync } = await import('child_process')
      const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>
      mockedSpawnSync.mockReturnValueOnce({
        status: 0,
        error: undefined,
        stdout: 'Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1        102400000  10240000  92160000       10% /\n',
        stderr: '',
      })
      try {
        const result = checkDiskSpace(path.join(tempDir, 'does-not-exist-xyz'))
        expect(result.status).toBe('ok')
        expect(mockedSpawnSync).toHaveBeenCalledWith('df', expect.arrayContaining(['-Pk']), expect.anything())
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    it('reports an explicit unavailable message, not a silent pass, when no check path works', () => {
      // A nonexistent path makes fs.statfsSync throw a genuine ENOENT -- no module mocking
      // needed (fs's ESM namespace exports are non-configurable, so statfsSync can't be
      // stubbed directly). Forcing platform to win32 makes the df fallback correctly get
      // skipped, matching a real stock-Windows machine where df is not on PATH either.
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const result = checkDiskSpace(path.join(tempDir, 'does-not-exist-xyz'))
        expect(result.name).toBe('Disk Space')
        expect(result.status).toBe('warn')
        expect(result.message).toBe('disk space check unavailable on this platform')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })
  })

  describe('runDoctorAndExit --context error propagation', () => {
    it('propagates a runContextStats rejection instead of an unhandled promise rejection', async () => {
      const contextStats = await import('../src/cli_context_stats.js')
      const mocked = contextStats.runContextStats as unknown as ReturnType<typeof vi.fn>
      // mockRejectedValueOnce is self-limiting -- it only intercepts this one call, then falls
      // back to the wrapped real implementation for every subsequent call, so no manual restore
      // is needed.
      mocked.mockRejectedValueOnce(new Error('boom from context stats'))
      await expect(runDoctorAndExit({ dataDir: tempDir, context: true, processes: NO_PROCESSES })).rejects.toThrow('boom from context stats')
    })

    it('resolves normally with --context when runContextStats succeeds', async () => {
      const code = await runDoctorAndExit({ dataDir: tempDir, context: true, processes: NO_PROCESSES })
      expect(typeof code).toBe('number')
    })
  })

  describe('pregen-gap check (--context)', () => {
    let skillsDir: string

    beforeEach(() => {
      skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor_skills_'))
      setSkillOutputsDirForTesting(skillsDir)
    })

    afterEach(() => {
      setSkillOutputsDirForTesting(null)
      fs.rmSync(skillsDir, { recursive: true, force: true })
    })

    it('lists a skill with multiple cached .meta versions only once, not once per version', async () => {
      fs.writeFileSync(path.join(skillsDir, 'pregen.json'), JSON.stringify({ ts: Date.now(), names: [] }))
      // Two distinct cached versions of the same skill (e.g. re-read after the skill file was
      // updated between sessions) -- both missing from pregen.json's names list.
      fs.writeFileSync(
        path.join(skillsDir, 'sess1-my-skill-aaa.meta'),
        JSON.stringify({ outputId: 'sess1-my-skill-aaa', skillName: 'my-skill', contentSha: 'aaa', bodyBytes: 10, ts: 1, truncated: false, sourcePath: '' }),
      )
      fs.writeFileSync(
        path.join(skillsDir, 'sess2-my-skill-bbb.meta'),
        JSON.stringify({ outputId: 'sess2-my-skill-bbb', skillName: 'my-skill', contentSha: 'bbb', bodyBytes: 12, ts: 2, truncated: false, sourcePath: '' }),
      )

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      let calls: unknown[][]
      try {
        await runDoctorAndExit({ dataDir: tempDir, context: true, processes: NO_PROCESSES })
        // Read the call log before mockRestore() below, which resets it (mockRestore() also
        // calls mockReset() internally, wiping mock.calls) -- reading it after would always
        // see zero calls regardless of what actually logged.
        calls = logSpy.mock.calls
      } finally {
        logSpy.mockRestore()
      }

      const gapLine = calls.map((c) => String(c[0])).find((line) => line.startsWith('Missing from pregen.json:'))
      expect(gapLine).toBeDefined()
      // Regression: the old implementation pushed one entry per .meta file instead of
      // deduping by skillName, so a skill with N cached versions was listed N times.
      expect(gapLine).toBe('Missing from pregen.json: my-skill')
    })
  })
})
