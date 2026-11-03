import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  AV_EXCLUSION_DISCLAIMER,
  checkHarnessSessionStorage,
  checkAntivirusExclusionPosture,
  isPathExcluded,
  measureDirectoryBytes,
} from '../src/cli_doctor_harness_perf.js'

describe('cli_doctor_harness_perf', () => {
  it('disclaimer constant contains required label and wording', () => {
    expect(AV_EXCLUSION_DISCLAIMER).toContain('(disclaimer)')
    expect(AV_EXCLUSION_DISCLAIMER).toContain('blind spot')
    expect(AV_EXCLUSION_DISCLAIMER).toContain('security policy')
  })

  it('isPathExcluded correctly matches exact and parent directories case-insensitively', () => {
    const exclusions = [
      'c:\\projects',
      'c:\\users\\testuser\\.copilot',
    ]

    expect(isPathExcluded('C:\\Projects', exclusions)).toBe(true)
    expect(isPathExcluded('c:\\projects\\token-goat', exclusions)).toBe(true)
    expect(isPathExcluded('C:\\Users\\testuser\\.copilot\\session-state', exclusions)).toBe(true)
    expect(isPathExcluded('C:\\Other\\Dir', exclusions)).toBe(false)
  })

  it('measureDirectoryBytes accurately counts files and bytes without infinite loops', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-test-'))
    try {
      fs.writeFileSync(path.join(tmp, 'file1.txt'), 'hello')
      fs.mkdirSync(path.join(tmp, 'sub'))
      fs.writeFileSync(path.join(tmp, 'sub', 'file2.txt'), 'world')

      const res = measureDirectoryBytes(tmp)
      expect(res.fileCount).toBe(2)
      expect(res.sizeBytes).toBe(10)
      expect(res.truncated).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('checkHarnessSessionStorage returns null when sessions under threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-home-'))
    try {
      const copilotDir = path.join(tmp, '.copilot', 'session-state')
      fs.mkdirSync(copilotDir, { recursive: true })
      fs.writeFileSync(path.join(copilotDir, 'small.json'), '{"ok": true}')

      const res = checkHarnessSessionStorage(tmp, 1024 * 1024)
      expect(res).toBeNull()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('checkHarnessSessionStorage warns when session storage exceeds threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-home-large-'))
    try {
      const copilotDir = path.join(tmp, '.copilot', 'session-state')
      fs.mkdirSync(copilotDir, { recursive: true })
      // Create a 50KB file with threshold of 10KB
      fs.writeFileSync(path.join(copilotDir, 'events.jsonl'), Buffer.alloc(50 * 1024))

      const res = checkHarnessSessionStorage(tmp, 10 * 1024)
      expect(res).not.toBeNull()
      expect(res?.status).toBe('warn')
      expect(res?.name).toBe('Harness session storage')
      expect(res?.message).toContain('Copilot CLI')
      expect(res?.message).toContain('High session storage detected')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('checkAntivirusExclusionPosture warns and includes (disclaimer) when paths are not excluded', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-av-home-'))
    const tmpRoot = path.join(tmpHome, 'my-workspace')
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.mkdirSync(path.join(tmpHome, '.copilot'), { recursive: true })

    try {
      // Mock exclusions with completely unrelated path
      const exclusions = ['c:\\other_path']
      const res = checkAntivirusExclusionPosture(tmpRoot, tmpHome, exclusions)

      expect(res).not.toBeNull()
      expect(res?.status).toBe('warn')
      expect(res?.message).toContain('(disclaimer)')
      expect(res?.message).toContain('Not excluded from real-time AV scanning')
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('checkAntivirusExclusionPosture passes when workspace and harness paths are excluded', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-av-home-ok-'))
    const tmpRoot = path.join(tmpHome, 'my-workspace')
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.mkdirSync(path.join(tmpHome, '.copilot'), { recursive: true })

    try {
      const exclusions = [tmpRoot, path.join(tmpHome, '.copilot')]
      const res = checkAntivirusExclusionPosture(tmpRoot, tmpHome, exclusions)

      expect(res).not.toBeNull()
      expect(res?.status).toBe('ok')
      expect(res?.message).toContain('excluded from real-time Defender scanning')
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
