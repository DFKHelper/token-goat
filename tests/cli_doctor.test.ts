import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { checkDbExists, checkConfigValid, checkInstall, checkDiskSpace, checkCopilotCli, checkSymbolCount, checkDirtyQueueHealth, checkTsCompiler, runDoctor, runDoctorAndExit } from '../src/cli_doctor.js'
import { dirtyQueuePathFor, drainHeartbeatPathFor, workerPidPath } from '../src/worker.js'
import { getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { setTsModuleForTesting } from '../src/ts_refs.js'
import type * as CliContextStats from '../src/cli_context_stats.js'

// runContextStats is `async` (needed for --fix's confirm-gate); runDoctorAndExit's own --context
// path used to call it fire-and-forget with no await, which turned a synchronous throw into a
// silently-swallowed unhandled promise rejection instead of propagating like every other doctor
// error. Mock it to throw so we can assert runDoctorAndExit's own returned promise rejects.
vi.mock('../src/cli_context_stats.js', async (importOriginal) => {
  const original = await importOriginal<typeof CliContextStats>()
  return { ...original, runContextStats: vi.fn(original.runContextStats) }
})

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

  describe('checkDbExists', () => {
    it('returns ok when database exists', () => {
      const dbPath = path.join(tempDir, 'global.db')
      fs.writeFileSync(dbPath, 'SQLite format 3\0mock db content')

      const result = checkDbExists(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('global.db exists')
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

    it('returns ok when the database is empty (no files indexed yet, nothing to expect)', () => {
      const dbPath = path.join(tempDir, 'global.db')
      getDb(dbPath) // creates the schema but inserts nothing
      const result = checkSymbolCount(dbPath)
      expect(result.status).toBe('ok')
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
      fs.writeFileSync(drainHeartbeatPathFor(tempDir), '')

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('actively draining')
    })

    it('warns when the worker is running but the drain heartbeat is stale (wedged/deadlocked)', () => {
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(workerPidPath(tempDir), String(process.pid))
      const heartbeatPath = drainHeartbeatPathFor(tempDir)
      fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true })
      fs.writeFileSync(heartbeatPath, '')
      const staleMs = Date.now() - 5 * 60 * 1000 // 5 minutes ago, well past the staleness threshold
      fs.utimesSync(heartbeatPath, new Date(staleMs), new Date(staleMs))

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('warn')
      expect(result.message).toContain("hasn't completed a drain cycle")
    })

    it('returns ok when the worker is running but has not completed its first drain cycle yet (no heartbeat file)', () => {
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(workerPidPath(tempDir), String(process.pid))
      // Deliberately no heartbeat file written -- simulates a freshly-started worker.

      const result = checkDirtyQueueHealth(tempDir)
      expect(result.status).toBe('ok')
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
      expect(result.message).toBeTruthy()
      expect(result.message.length).toBeGreaterThan(0)
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
      expect(result.message).toBeTruthy()
      expect(result.message.length).toBeGreaterThan(0)
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
    it('returns array of doctor results', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })

    it('includes installation check', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      const install = results.find((r) => r.name === 'Installation')
      expect(install).toBeDefined()
    })

    it('includes worker check', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      const worker = results.find((r) => r.name === 'Worker')
      expect(worker).toBeDefined()
    })

    it('includes TypeScript compiler check', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      const tsCompiler = results.find((r) => r.name === 'TypeScript compiler')
      expect(tsCompiler).toBeDefined()
    })

    it('includes database check', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      const db = results.find((r) => r.name === 'Database')
      expect(db).toBeDefined()
    })

    it('includes config check', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      const config = results.find((r) => r.name === 'Config')
      expect(config).toBeDefined()
    })

    it('marks results with ok/warn/fail status', () => {
      const results = runDoctor(tempDir, path.join(tempDir, 'config.json'))
      for (const result of results) {
        expect(['ok', 'warn', 'fail']).toContain(result.status)
      }
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
      await expect(runDoctorAndExit({ dataDir: tempDir, context: true })).rejects.toThrow('boom from context stats')
    })

    it('resolves normally with --context when runContextStats succeeds', async () => {
      const code = await runDoctorAndExit({ dataDir: tempDir, context: true })
      expect(typeof code).toBe('number')
    })
  })
})
