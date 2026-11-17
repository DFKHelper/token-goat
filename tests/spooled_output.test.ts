import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  extractCopilotSpooledPath,
  isCopilotSpooledNotice,
  readConfinedSpoolFile,
  readCopilotSpooledBashOutput,
} from '../src/spooled_output.js'
import { normalizePath } from '../src/paths.js'
import { CAN_SYMLINK } from './helpers/can-symlink.js'

describe('spooled_output', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spool-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('isCopilotSpooledNotice', () => {
    it('matches standard Copilot SDK/CLI notice with path and size', () => {
      const notice = 'Output too large to read at once (121.1 KB). Saved to: C:\\TEMP\\123-copilot-tool-output-456.txt\n\nPreview (first 500 characters):'
      expect(isCopilotSpooledNotice(notice)).toBe(true)
    })

    it('returns false for ordinary text or empty strings', () => {
      expect(isCopilotSpooledNotice('Hello world')).toBe(false)
      expect(isCopilotSpooledNotice('')).toBe(false)
      expect(isCopilotSpooledNotice(null)).toBe(false)
      expect(isCopilotSpooledNotice({ foo: 'bar' })).toBe(false)
    })
  })

  describe('extractCopilotSpooledPath', () => {
    it('extracts unquoted Windows path', () => {
      const notice = 'Output too large to read at once (121.1 KB). Saved to: C:\\Users\\User\\AppData\\Local\\Temp\\1794481520586-copilot-tool-output-3744-3fefc038-c1a5-4c88-a06c-1e7fdcfdcea9.txt\n\nPreview (first 500 characters):\nfoo'
      expect(extractCopilotSpooledPath(notice)).toBe(
        'C:\\Users\\User\\AppData\\Local\\Temp\\1794481520586-copilot-tool-output-3744-3fefc038-c1a5-4c88-a06c-1e7fdcfdcea9.txt',
      )
    })

    it('strips surrounding quotes if present', () => {
      const notice = 'Output too large to read at once (50 KB). Saved to: "C:\\TEMP\\copilot-tool-output.txt"\nPreview...'
      expect(extractCopilotSpooledPath(notice)).toBe('C:\\TEMP\\copilot-tool-output.txt')
    })

    it('returns null when notice does not contain Saved to: line', () => {
      const notice = 'Output too large to read at once. Preview:\n{ "data": 1 }'
      expect(extractCopilotSpooledPath(notice)).toBeNull()
    })
  })

  describe('readConfinedSpoolFile', () => {
    it('reads a valid spooled file bounded in directory', () => {
      const content = 'line 1\nline 2\nline 3\n'.repeat(500)
      const filePath = path.join(tempDir, '1794481520586-copilot-tool-output-3744-abc.txt')
      fs.writeFileSync(filePath, content, 'utf-8')

      const result = readConfinedSpoolFile(filePath, tempDir)
      expect(result).toBe(content)
    })

    it('rejects files outside the specified root directory', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outside-'))
      try {
        const filePath = path.join(outsideDir, '123-copilot-tool-output-456.txt')
        fs.writeFileSync(filePath, 'sensitive outside data', 'utf-8')

        expect(readConfinedSpoolFile(filePath, tempDir)).toBeNull()
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('rejects path traversal climbing out of root', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outside-'))
      try {
        const filePath = path.join(outsideDir, '123-copilot-tool-output-456.txt')
        fs.writeFileSync(filePath, 'data', 'utf-8')

        const climbed = path.join(tempDir, '..', '..', path.relative(path.parse(outsideDir).root, filePath))
        expect(readConfinedSpoolFile(climbed, tempDir)).toBeNull()
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('rejects files not matching copilot tool output naming pattern', () => {
      const invalidNames = [
        'output.txt',
        'passwords.txt',
        'copilot-tool-output.txt.bat',
        'copilot-tool-output.exe',
        'something-else.txt',
      ]

      for (const name of invalidNames) {
        const filePath = path.join(tempDir, name)
        fs.writeFileSync(filePath, 'some data', 'utf-8')
        expect(readConfinedSpoolFile(filePath, tempDir)).toBeNull()
      }
    })

    it('rejects empty files or files exceeding maxBytes', () => {
      const emptyFile = path.join(tempDir, 'copilot-tool-output-empty.txt')
      fs.writeFileSync(emptyFile, '', 'utf-8')
      expect(readConfinedSpoolFile(emptyFile, tempDir)).toBeNull()

      const largeFile = path.join(tempDir, 'copilot-tool-output-large.txt')
      fs.writeFileSync(largeFile, 'a'.repeat(200), 'utf-8')
      expect(readConfinedSpoolFile(largeFile, tempDir, { maxBytes: 100 })).toBeNull()
    })

    it.skipIf(!CAN_SYMLINK)('rejects symlink pointing outside root directory', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outside-symlink-'))
      try {
        const outsideFile = path.join(outsideDir, 'real.txt')
        fs.writeFileSync(outsideFile, 'secret data', 'utf-8')

        const symlinkPath = path.join(tempDir, '123-copilot-tool-output-symlink.txt')
        fs.symlinkSync(outsideFile, symlinkPath, 'file')

        expect(readConfinedSpoolFile(symlinkPath, tempDir)).toBeNull()
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  describe('readCopilotSpooledBashOutput', () => {
    it('extracts notice and reads file from temp root', () => {
      const fullText = 'Generated tool output line 1\nGenerated tool output line 2\n'.repeat(100)
      const filePath = path.join(tempDir, '1794481520586-copilot-tool-output-3744-test.txt')
      fs.writeFileSync(filePath, fullText, 'utf-8')

      const notice = `Output too large to read at once (12.3 KB). Saved to: ${filePath}\n\nPreview (first 500 characters):\nGenerated tool output line 1...`
      const result = readCopilotSpooledBashOutput(notice, tempDir)
      expect(result).toBe(fullText)
    })

    it('returns null if notice has invalid file path', () => {
      const notice = 'Output too large to read at once (10 KB). Saved to: /non/existent/path/copilot-tool-output.txt\nPreview...'
      expect(readCopilotSpooledBashOutput(notice, tempDir)).toBeNull()
    })

    it('rejects posix shell mount paths that escape outside root', () => {
      // e.g. /c/windows/temp/copilot-tool-output.txt when root is tempDir
      const notice = 'Output too large to read at once (10 KB). Saved to: /c/windows/system32/copilot-tool-output.txt\nPreview...'
      expect(readCopilotSpooledBashOutput(notice, tempDir)).toBeNull()
    })

    it.skipIf(process.platform !== 'win32')('reads posix shell mount path when contained inside root on win32', () => {
      const filePath = path.join(tempDir, '1794481520586-copilot-tool-output-3744-mount.txt')
      fs.writeFileSync(filePath, 'mounted output', 'utf-8')
      const drive = filePath[0]!.toLowerCase()
      const posixMount = '/' + drive + normalizePath(filePath).slice(2)
      const notice = `Output too large to read at once (10 KB). Saved to: ${posixMount}\nPreview...`
      expect(readCopilotSpooledBashOutput(notice, tempDir)).toBe('mounted output')
    })

    it.skipIf(!CAN_SYMLINK)('rejects symbolic links even if pointing within temp directory', () => {
      const realFile = path.join(tempDir, 'real-target.txt')
      fs.writeFileSync(realFile, 'real content', 'utf-8')
      const symlinkFile = path.join(tempDir, '1794481520586-copilot-tool-output-symlink.txt')
      fs.symlinkSync(realFile, symlinkFile)
      expect(readConfinedSpoolFile(symlinkFile, tempDir)).toBeNull()
    })
  })
})
