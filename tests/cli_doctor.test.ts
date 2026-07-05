import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { checkDbExists, checkConfigValid, checkInstall, checkDiskSpace, runDoctor } from '../src/cli_doctor.js'

describe('cli_doctor', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor_test_'))
  })

  afterEach(() => {
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
})
