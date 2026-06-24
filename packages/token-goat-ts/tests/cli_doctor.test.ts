import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { checkDbExists, checkConfigValid, checkInstall, runDoctor } from '../src/cli_doctor.js'

describe('cli_doctor', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor_test_'))
  })

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
  })

  describe('checkDbExists', () => {
    it('returns ok when database exists', () => {
      const dbPath = path.join(tempDir, 'index.db')
      fs.writeFileSync(dbPath, 'mock db content')

      const result = checkDbExists(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('index.db exists')
    })

    it('returns warn when database missing', () => {
      const result = checkDbExists(tempDir)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('not found')
    })

    it('includes file size in message', () => {
      const dbPath = path.join(tempDir, 'index.db')
      fs.writeFileSync(dbPath, 'x'.repeat(2048))

      const result = checkDbExists(tempDir)
      expect(result.message).toMatch(/\d+ KB/)
    })
  })

  describe('checkConfigValid', () => {
    it('returns ok for valid JSON config', () => {
      const configPath = path.join(tempDir, 'config.json')
      fs.writeFileSync(configPath, JSON.stringify({ key: 'value' }))

      const result = checkConfigValid(configPath)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('valid')
    })

    it('returns warn when config missing', () => {
      const configPath = path.join(tempDir, 'missing.json')
      const result = checkConfigValid(configPath)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('not found')
    })

    it('returns fail for invalid JSON', () => {
      const configPath = path.join(tempDir, 'config.json')
      fs.writeFileSync(configPath, '{invalid json}')

      const result = checkConfigValid(configPath)
      expect(result.status).toBe('fail')
      expect(result.message).toContain('invalid')
    })

    it('includes file size for valid config', () => {
      const configPath = path.join(tempDir, 'config.json')
      fs.writeFileSync(configPath, '{"test":"value"}')

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
})
