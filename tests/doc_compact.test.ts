import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  isCompactFresh,
  markCompactStale,
  readCompactBody,
  writeCompact,
  buildExtractiveCompact,
  extractDocCompact,
  compactDoc,
} from '../src/doc_compact.js'

describe('doc_compact', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc_compact_test_'))
  })

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
  })

  describe('writeCompact and isCompactFresh', () => {
    it('writes compact with correct header', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      fs.writeFileSync(sourcePath, '# Title\nContent')

      writeCompact(compactPath, sourcePath, 'Compact body')

      const content = fs.readFileSync(compactPath, 'utf-8')
      expect(content).toContain('token-goat doc-compact')
      expect(content).toContain('source-hash:')
      expect(content).toContain('Compact body')
    })

    it('returns true for fresh compact', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      const sourceContent = '# Title\nContent'
      fs.writeFileSync(sourcePath, sourceContent)

      writeCompact(compactPath, sourcePath, 'Compact')

      const fresh = isCompactFresh(compactPath, sourcePath)
      expect(fresh).toBe(true)
    })

    it('returns false when source is modified', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      fs.writeFileSync(sourcePath, 'original')
      writeCompact(compactPath, sourcePath, 'Compact')

      fs.writeFileSync(sourcePath, 'modified')

      const fresh = isCompactFresh(compactPath, sourcePath)
      expect(fresh).toBe(false)
    })

    it('returns false for missing compact', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'nonexistent.md')
      fs.writeFileSync(sourcePath, 'content')

      const fresh = isCompactFresh(compactPath, sourcePath)
      expect(fresh).toBe(false)
    })
  })

  describe('markCompactStale', () => {
    it('replaces hash with STALE', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      fs.writeFileSync(sourcePath, 'content')
      writeCompact(compactPath, sourcePath, 'Body')

      const result = markCompactStale(compactPath)
      expect(result).toBe(true)

      const content = fs.readFileSync(compactPath, 'utf-8')
      expect(content).toContain('source-hash:STALE')
    })

    it('returns false for missing compact', () => {
      const result = markCompactStale(path.join(tempDir, 'missing.md'))
      expect(result).toBe(false)
    })

    it('subsequent isCompactFresh returns false after stale', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      fs.writeFileSync(sourcePath, 'content')
      writeCompact(compactPath, sourcePath, 'Body')

      markCompactStale(compactPath)

      const fresh = isCompactFresh(compactPath, sourcePath)
      expect(fresh).toBe(false)
    })
  })

  describe('readCompactBody', () => {
    it('extracts body after header', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      fs.writeFileSync(sourcePath, 'source')
      writeCompact(compactPath, sourcePath, 'Body line 1\nBody line 2')

      const body = readCompactBody(compactPath)
      expect(body).toContain('Body line 1')
      expect(body).toContain('Body line 2')
    })

    it('returns null for missing file', () => {
      const body = readCompactBody(path.join(tempDir, 'missing.md'))
      expect(body).toBeNull()
    })

    it('returns null for file with no body', () => {
      const compactPath = path.join(tempDir, 'compact.md')
      fs.writeFileSync(compactPath, '<!-- header -->')
      const body = readCompactBody(compactPath)
      expect(body).toBeNull()
    })
  })

  describe('buildExtractiveCompact', () => {
    it('preserves headings', () => {
      const md = '# Section 1\nSentence 1\nSentence 2\n## Section 2\nMore text'
      const result = buildExtractiveCompact(md)
      expect(result).toContain('# Section 1')
      expect(result).toContain('## Section 2')
    })

    it('limits sentences per section', () => {
      const md = '# Section\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5'
      const result = buildExtractiveCompact(md, 2)
      const lines = result.split('\n').filter((l) => !l.startsWith('#') && l.trim())
      expect(lines.length).toBeLessThanOrEqual(2)
    })

    it('includes code blocks', () => {
      const md = '# Title\n```\ncode block\n```\nText after'
      const result = buildExtractiveCompact(md)
      expect(result).toContain('```')
    })

    it('skips YAML front-matter', () => {
      const md = '---\ntitle: test\n---\n# Heading\nText'
      const result = buildExtractiveCompact(md)
      expect(result).not.toContain('title: test')
      expect(result).toContain('# Heading')
    })
  })

  describe('extractDocCompact', () => {
    it('extracts content after COMPACT_END marker', () => {
      const body = 'Full text\n<!-- COMPACT_END -->\nCompact text\nMore'
      const compact = extractDocCompact(body)
      expect(compact).toContain('Compact text')
      expect(compact).not.toContain('Full text')
    })

    it('extracts content after heading', () => {
      const body = 'Intro\n## Summary\nCompact content'
      const compact = extractDocCompact(body, 'Summary')
      expect(compact).toContain('Compact content')
    })

    it('does not match heading text that merely appears in prose before the real heading (fail-on-buggy: line.includes matches non-heading lines)', () => {
      const body = 'See the Setup guide below for details.\n## Setup\nCompact content here'
      const compact = extractDocCompact(body, 'Setup')
      expect(compact).toContain('Compact content here')
      expect(compact).not.toContain('See the Setup guide below')
    })

    it('returns empty string when marker not found', () => {
      const body = 'Content without marker'
      const compact = extractDocCompact(body)
      expect(compact).toBe('')
    })
  })

  describe('compactDoc', () => {
    it('reads and extracts compact from file', () => {
      const docPath = path.join(tempDir, 'doc.md')
      fs.writeFileSync(docPath, 'Intro\n<!-- COMPACT_END -->\nCompact')

      const result = compactDoc(docPath)
      expect(result).toContain('Compact')
    })

    it('returns null for missing file', () => {
      const result = compactDoc(path.join(tempDir, 'missing.md'))
      expect(result).toBeNull()
    })

    it('extracts by heading', () => {
      const docPath = path.join(tempDir, 'doc.md')
      fs.writeFileSync(docPath, 'Intro\n## API\nAPI docs')

      const result = compactDoc(docPath, 'API')
      expect(result).toContain('API docs')
    })
  })
})
