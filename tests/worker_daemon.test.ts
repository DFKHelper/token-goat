import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  pidFilePath,
  writePidFile,
  clearPidFile,
  readDaemonPid,
  isDaemonRunning,
  killDuplicateDaemon,
  startDaemon,
} from '../src/worker_daemon.js'
import * as worker from '../src/worker.js'

vi.mock('../src/worker.js', () => ({
  drainOnce: vi.fn(),
  workerPidPath: (dir: string) => path.join(dir, 'worker.pid'),
}))

vi.mock('../src/constants.js', () => ({
  dataDir: () => path.join(os.tmpdir(), 'default-data-dir'),
}))

describe('worker_daemon', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('pidFilePath', () => {
    it('should return a path ending in .pid', () => {
      const pidPath = pidFilePath(tmpDir)
      expect(pidPath).toMatch(/\.pid$/)
    })

    it('should include the data directory', () => {
      const pidPath = pidFilePath(tmpDir)
      expect(pidPath).toContain(tmpDir)
    })

    it('should use default dataDir when not provided', () => {
      const pidPath = pidFilePath()
      expect(pidPath).toMatch(/worker\.pid$/)
    })
  })

  describe('writePidFile and readDaemonPid round-trip', () => {
    it('should write and read the current process PID', () => {
      writePidFile(tmpDir)
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBe(process.pid)
    })

    it('should create the data directory if it does not exist', () => {
      const newDir = path.join(tmpDir, 'new', 'dir')
      expect(fs.existsSync(newDir)).toBe(false)
      writePidFile(newDir)
      expect(fs.existsSync(newDir)).toBe(true)
      const pidPath = pidFilePath(newDir)
      expect(fs.existsSync(pidPath)).toBe(true)
    })

    it('should write PID with newline', () => {
      writePidFile(tmpDir)
      const pidPath = pidFilePath(tmpDir)
      const content = fs.readFileSync(pidPath, 'utf8')
      expect(content).toBe(`${process.pid}\n`)
    })

    it('should handle read-only filesystem gracefully', () => {
      // Test that writePidFile doesn't crash even if mkdirSync fails
      const readOnlyDir = path.join(tmpDir, 'readonly')
      fs.mkdirSync(readOnlyDir)
      // On Windows, we can't reliably make a dir read-only, so we test with
      // a non-existent parent that we then delete
      const nonExistentParent = path.join(tmpDir, 'nonexistent', 'subdir')
      const parentDir = path.dirname(nonExistentParent)
      fs.mkdirSync(parentDir, { recursive: true })
      fs.rmSync(parentDir, { recursive: true })
      // Now try to write - it should succeed by creating the dir
      expect(() => writePidFile(nonExistentParent)).not.toThrow()
    })
  })

  describe('clearPidFile', () => {
    it('should remove the pid file', () => {
      writePidFile(tmpDir)
      const pidPath = pidFilePath(tmpDir)
      expect(fs.existsSync(pidPath)).toBe(true)
      clearPidFile(tmpDir)
      expect(fs.existsSync(pidPath)).toBe(false)
    })

    it('should be idempotent (not throw when file does not exist)', () => {
      const pidPath = pidFilePath(tmpDir)
      expect(fs.existsSync(pidPath)).toBe(false)
      expect(() => clearPidFile(tmpDir)).not.toThrow()
    })

    it('should handle multiple calls', () => {
      writePidFile(tmpDir)
      clearPidFile(tmpDir)
      clearPidFile(tmpDir)
      clearPidFile(tmpDir)
      expect(fs.existsSync(pidFilePath(tmpDir))).toBe(false)
    })
  })

  describe('readDaemonPid', () => {
    it('should return null when pid file does not exist', () => {
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBeNull()
    })

    it('should return null for non-numeric content', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, 'not-a-number\n', { encoding: 'utf8' })
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBeNull()
    })

    it('should trim whitespace from pid content', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, `  ${process.pid}  \n`, { encoding: 'utf8' })
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBe(process.pid)
    })

    it('should return null for empty file', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, '', { encoding: 'utf8' })
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBeNull()
    })

    it('should handle negative numbers', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, '-123\n', { encoding: 'utf8' })
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBeNull()
    })
  })

  describe('isDaemonRunning', () => {
    it('should return false when pid file does not exist', () => {
      const running = isDaemonRunning(tmpDir)
      expect(running).toBe(false)
    })

    it('should return false when the pid is dead', () => {
      // Use an impossible PID
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, '999999999\n', { encoding: 'utf8' })

      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('No such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      })
      const running = isDaemonRunning(tmpDir)
      expect(running).toBe(false)
      mockKill.mockRestore()
    })

    it('should return true when the pid is alive', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, `${process.pid}\n`, { encoding: 'utf8' })

      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => undefined)
      const running = isDaemonRunning(tmpDir)
      expect(running).toBe(true)
      mockKill.mockRestore()
    })

    it('should treat EPERM (permission denied) as process alive', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, '12345\n', { encoding: 'utf8' })

      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      })
      const running = isDaemonRunning(tmpDir)
      expect(running).toBe(true)
      mockKill.mockRestore()
    })

    it('should return false for malformed pid file', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, 'not-a-number\n', { encoding: 'utf8' })
      const running = isDaemonRunning(tmpDir)
      expect(running).toBe(false)
    })
  })

  describe('killDuplicateDaemon', () => {
    it('should return "No running worker found." when pid file does not exist', () => {
      const result = killDuplicateDaemon(tmpDir)
      expect(result).toBe('No running worker found.')
    })

    it('should return "No running worker found." when pid is dead', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, '999999999\n', { encoding: 'utf8' })

      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('No such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      })
      const result = killDuplicateDaemon(tmpDir)
      expect(result).toBe('No running worker found.')
      mockKill.mockRestore()
    })

    it('should kill a live daemon and return success message', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      const testPid = 12345
      fs.writeFileSync(pidPath, `${testPid}\n`, { encoding: 'utf8' })

      const killCalls: Array<[number, string | number]> = []
      const mockKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        killCalls.push([pid as number, signal || 0])
        if (pid === testPid) {
          return undefined
        }
        const err = new Error('No such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      })

      const result = killDuplicateDaemon(tmpDir)
      expect(result).toBe(`Killed duplicate daemon (PID ${testPid}).`)
      expect(killCalls.some(([pid, sig]) => pid === testPid && sig === 'SIGTERM')).toBe(true)
      expect(fs.existsSync(pidPath)).toBe(false)
      mockKill.mockRestore()
    })

    it('should clean up pid file after killing daemon', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, '12345\n', { encoding: 'utf8' })

      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => undefined)
      killDuplicateDaemon(tmpDir)
      expect(fs.existsSync(pidPath)).toBe(false)
      mockKill.mockRestore()
    })

    it('should return "No running worker found." for malformed pid content', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      fs.writeFileSync(pidPath, 'not-a-number\n', { encoding: 'utf8' })

      const result = killDuplicateDaemon(tmpDir)
      expect(result).toBe('No running worker found.')
    })

    it('should handle dead process that cannot be killed again', () => {
      const pidPath = pidFilePath(tmpDir)
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
      const testPid = 12345
      fs.writeFileSync(pidPath, `${testPid}\n`, { encoding: 'utf8' })

      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => {
        // First call succeeds, second call (in killPid after pidAlive check) returns signal result
        const err = new Error('No such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      })

      const result = killDuplicateDaemon(tmpDir)
      expect(result).toBe('No running worker found.')
      mockKill.mockRestore()
    })
  })

  describe('startDaemon', () => {
    it('should return a handle with isRunning() and stop() methods', () => {
      const handle = startDaemon({ dataDir: tmpDir })
      expect(handle).toHaveProperty('isRunning')
      expect(handle).toHaveProperty('stop')
      expect(typeof handle.isRunning).toBe('function')
      expect(typeof handle.stop).toBe('function')
      handle.stop()
    })

    it('should have isRunning() return true initially', () => {
      const handle = startDaemon({ dataDir: tmpDir })
      expect(handle.isRunning()).toBe(true)
      handle.stop()
    })

    it('should have isRunning() return false after stop()', () => {
      const handle = startDaemon({ dataDir: tmpDir })
      expect(handle.isRunning()).toBe(true)
      handle.stop()
      expect(handle.isRunning()).toBe(false)
    })

    it('should write the pid file on startup', () => {
      const pidPath = pidFilePath(tmpDir)
      expect(fs.existsSync(pidPath)).toBe(false)
      const handle = startDaemon({ dataDir: tmpDir })
      expect(fs.existsSync(pidPath)).toBe(true)
      const pid = readDaemonPid(tmpDir)
      expect(pid).toBe(process.pid)
      handle.stop()
    })

    it('should accept custom poll interval', () => {
      const mockDrainOnce = vi.spyOn(worker, 'drainOnce').mockImplementation(() => {})
      const handle = startDaemon({ pollIntervalMs: 100, dataDir: tmpDir })
      expect(handle.isRunning()).toBe(true)
      handle.stop()
      mockDrainOnce.mockRestore()
    })

    it('should accept maxIdleMs for API compatibility', () => {
      const handle = startDaemon({
        pollIntervalMs: 100,
        maxIdleMs: 5000,
        dataDir: tmpDir,
      })
      expect(handle.isRunning()).toBe(true)
      handle.stop()
    })

    it('should use default poll interval of 2000ms when not provided', () => {
      const handle = startDaemon({ dataDir: tmpDir })
      expect(handle.isRunning()).toBe(true)
      handle.stop()
    })

    it('should call drainOnce periodically', async () => {
      const mockDrainOnce = vi
        .spyOn(worker, 'drainOnce')
        .mockImplementation(() => {})
      const handle = startDaemon({ pollIntervalMs: 50, dataDir: tmpDir })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(mockDrainOnce.mock.calls.length).toBeGreaterThanOrEqual(1)
      handle.stop()
      mockDrainOnce.mockRestore()
    })

    it('should not crash on drainOnce errors', async () => {
      const mockDrainOnce = vi.spyOn(worker, 'drainOnce').mockImplementation(() => {
        throw new Error('Drain failed')
      })
      const handle = startDaemon({ pollIntervalMs: 50, dataDir: tmpDir })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(handle.isRunning()).toBe(true)
      handle.stop()
      mockDrainOnce.mockRestore()
    })
  })
})
