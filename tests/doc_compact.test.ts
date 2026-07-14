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
  compactPathFor,
} from '../src/doc_compact.js'
import { dataDir } from '../src/constants.js'

describe('doc_compact', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc_compact_test_'))
  })

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
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

    it('preserves full body content on write (atomic write regression)', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      const longBody = 'Line 1\n'.repeat(100) + 'Final critical line'
      fs.writeFileSync(sourcePath, 'source content')

      writeCompact(compactPath, sourcePath, longBody)

      const content = fs.readFileSync(compactPath, 'utf-8')
      expect(content).toContain('Final critical line')
      const lines = content.split('\n')
      expect(lines.length).toBeGreaterThan(50)
      expect(lines[lines.length - 1] || lines[lines.length - 2]).toContain('Final critical line')
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

    it('preserves full body content when marking stale (atomic write regression)', () => {
      const sourcePath = path.join(tempDir, 'source.md')
      const compactPath = path.join(tempDir, 'compact.md')
      const longBody = 'Line 1\n'.repeat(100) + 'Final important line'
      fs.writeFileSync(sourcePath, 'content')
      writeCompact(compactPath, sourcePath, longBody)

      markCompactStale(compactPath)

      const content = fs.readFileSync(compactPath, 'utf-8')
      expect(content).toContain('Final important line')
      expect(content.split('\n').length).toBeGreaterThan(50)
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

    it('does not let a code block\'s closing fence eat a slot from the section\'s sentence budget (regression: the closing fence branch incremented sentencesEmitted instead of codeBlockLines, so a code block silently consumed one real trailing sentence per section from maxSentences)', () => {
      const md = '# Heading\n```js\nconsole.log("code")\n```\nFirst real sentence.\nSecond real sentence.\nThird real sentence excluded.\n'
      const result = buildExtractiveCompact(md, 2)
      expect(result).toContain('First real sentence.')
      expect(result).toContain('Second real sentence.')
      expect(result).not.toContain('Third real sentence excluded.')
    })

    it('skips YAML front-matter', () => {
      const md = '---\ntitle: test\n---\n# Heading\nText'
      const result = buildExtractiveCompact(md)
      expect(result).not.toContain('title: test')
      expect(result).toContain('# Heading')
    })

    it('does not discard the whole document when the front-matter fence is never closed', () => {
      // A leading '---' with no matching closing '---' anywhere in the document (malformed/
      // truncated front matter, or a bare '---' divider used as a horizontal rule) must not
      // cause the entire document to be skipped -- it should be treated as having no real
      // front matter, and all of the real content below must survive.
      const md = '---\n# Heading\nText that must survive'
      const result = buildExtractiveCompact(md)
      expect(result).toContain('# Heading')
      expect(result).toContain('Text that must survive')
    })

    // Regression: the naive `stripped.startsWith('```') || stripped.startsWith('~~~')` toggle
    // treated ANY fence-looking line as a closer, contradicting eachUnfencedLine's real
    // CommonMark rule (a fence only closes on the SAME character). A ~~~ line inside a ```
    // block incorrectly closed it early, corrupting the rest of the section's fence tracking
    // and silently dropping later content (here, "After text" never made it into the output).
    it('does not let a mismatched ~~~ close an open ``` fence', () => {
      const md = '# Title\n```\nline1\n~~~\nline2\n```\nAfter text'
      const result = buildExtractiveCompact(md)
      expect(result).toContain('After text')
      expect(result).toContain('```\nline1\n~~~\nline2\n```')
    })

    // Regression: same naive-toggle bug, other half of the CommonMark rule -- a fence only
    // closes on a run of the same character with length >= the opener's. A shorter ``` (3
    // backticks) nested inside an outer ```` (4-backtick) fence must not close it.
    it('does not let a shorter same-char fence run close a longer opener', () => {
      const md = '# Title\n````\nouter code\n```\nstill inside\n````\nAfter text'
      const result = buildExtractiveCompact(md)
      expect(result).toContain('After text')
      expect(result).toContain('````\nouter code\n```\nstill inside\n````')
    })

    // Regression: the closing branch checked only `ch === fence.ch && run.length >= fence.len`,
    // omitting eachUnfencedLine's third condition that the remainder after the backtick/tilde
    // run must be empty. A same-char in-fence line carrying an info string (e.g. "```json"
    // inside an already-open ``` block) was wrongly read as the closer, reopening a phantom
    // fence on the block's real closing ``` and silently dropping every heading/line after it.
    it('does not let a same-char fence-looking line with a trailing info string close an open fence', () => {
      const md = '## A\nText A.\n```\nexample markdown:\n```json\n{"x":1}\n```\n## B\nText B under a real heading.'
      const result = buildExtractiveCompact(md)
      expect(result).toContain('## B')
      expect(result).toContain('Text B under a real heading.')
    })
  })

  describe('extractDocCompact', () => {
    it('extracts content before COMPACT_END marker', () => {
      const body = 'Compact text\n<!-- COMPACT_END -->\nFull reference text\nMore'
      const compact = extractDocCompact(body)
      expect(compact).toContain('Compact text')
      expect(compact).not.toContain('Full reference text')
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

    it('matches exact heading, not a longer heading that contains it as substring', () => {
      const body = '## Setup Guide\nSetup Guide content\n## Setup\nSetup content'
      const compact = extractDocCompact(body, 'Setup')
      // Should match "## Setup" exactly, not "## Setup Guide" which merely contains "Setup"
      expect(compact).toContain('## Setup')
      expect(compact).not.toContain('## Setup Guide')
    })

    it('matches exact heading, not a longer heading that contains it as substring', () => {
      const body = '## Setup Guide\nSetup Guide content\n## Setup\nSetup content'
      const compact = extractDocCompact(body, 'Setup')
      // Should match "## Setup" exactly, not "## Setup Guide" which merely contains "Setup"
      expect(compact).toContain('## Setup')
      expect(compact).not.toContain('## Setup Guide')
    })

    it('stops at next heading of equal or shallower depth (regression: was dumping all following sections)', () => {
      const body = 'Intro\n## Summary\nSummary content here\n## Next\nNext section content'
      const compact = extractDocCompact(body, 'Summary')
      expect(compact).toContain('## Summary')
      expect(compact).toContain('Summary content here')
      expect(compact).not.toContain('## Next')
      expect(compact).not.toContain('Next section content')
    })

    it('includes nested headings under the matched section (deeper than matched heading)', () => {
      const body = '## Section\nSection intro\n### Subsection\nSub content\n## Next\nNext content'
      const compact = extractDocCompact(body, 'Section')
      expect(compact).toContain('### Subsection')
      expect(compact).toContain('Sub content')
      expect(compact).not.toContain('## Next')
    })

    it('matches a closed-ATX heading (trailing hash run) against a plain heading target', () => {
      // Regression: the greedy `(.*)` capture swallowed the closing `##`, so the captured text
      // for `## Setup ##` was "Setup ##" instead of "Setup", failing exact-equality against the
      // target and returning '' (silent not-found) for any doc using closed-ATX style.
      const body = 'Intro\n## Setup ##\nCompact content'
      const compact = extractDocCompact(body, 'Setup')
      expect(compact).toContain('Compact content')
    })

    it('returns empty string when marker not found', () => {
      const body = 'Content without marker'
      const compact = extractDocCompact(body)
      expect(compact).toBe('')
    })

    // Regression: the heading-mode end-boundary walker matched `/^(#+)\s/` line-by-line with
    // zero fence tracking, so a `#`-looking example line inside a fenced code block (e.g. a
    // doc demonstrating markdown syntax) was mistaken for a real section boundary and
    // truncated the section early, dropping everything after the fenced example.
    it('does not treat a heading-looking line inside a fenced code block as a section boundary', () => {
      const body =
        '## Setup\nHere is how it works.\n```\nExample doc:\n## usage\nSome fenced example\n```\n' +
        'More real setup content after fence.\n## Something Else\nNext section content'
      const compact = extractDocCompact(body, 'Setup')
      expect(compact).toContain('Some fenced example')
      expect(compact).toContain('More real setup content after fence.')
      expect(compact).not.toContain('## Something Else')
      expect(compact).not.toContain('Next section content')
    })

    // Same root bug on the other half of the function -- the heading FINDER must also skip
    // fenced lines, so a `## usage`-looking example line inside a fence is never mistaken for
    // the real heading being searched for.
    it('does not match a heading-looking line inside a fenced code block as the target heading', () => {
      const body = '## Real\nIntro\n```\n## usage\nfenced content\n```\nend'
      const compact = extractDocCompact(body, 'usage')
      expect(compact).toBe('')
    })
  })

  describe('compactDoc', () => {
    it('reads and extracts compact from file', () => {
      const docPath = path.join(tempDir, 'doc.md')
      fs.writeFileSync(docPath, 'Compact\n<!-- COMPACT_END -->\nFull reference text')

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

  describe('compactPathFor', () => {
    it('is deterministic for the same source path', () => {
      const docPath = path.join(tempDir, 'doc.md')
      expect(compactPathFor(docPath)).toBe(compactPathFor(docPath))
    })

    it('differs for different source paths', () => {
      const a = path.join(tempDir, 'a.md')
      const b = path.join(tempDir, 'b.md')
      expect(compactPathFor(a)).not.toBe(compactPathFor(b))
    })

    it('resolves relative paths to the same sidecar as their absolute form', () => {
      const abs = path.join(tempDir, 'doc.md')
      const cwdBefore = process.cwd()
      try {
        process.chdir(tempDir)
        expect(compactPathFor('doc.md')).toBe(compactPathFor(abs))
      } finally {
        process.chdir(cwdBefore)
      }
    })

    it('places the sidecar under the token-goat data dir', () => {
      const docPath = path.join(tempDir, 'doc.md')
      const compactPath = compactPathFor(docPath)
      expect(compactPath.startsWith(dataDir())).toBe(true)
      expect(compactPath.endsWith('.md')).toBe(true)
    })

    // Regression (#49): _compactSlug hashed the absolute source path with an unconditional
    // .toLowerCase(), not gated to case-insensitive filesystems. On a case-sensitive FS (Linux,
    // most CI runners), two genuinely distinct files whose directory names differ only in case
    // hashed to the same sidecar, so one file's compactDoc silently served the other's summary.
    it('does not collide for paths differing only in case on a case-sensitive filesystem', () => {
      const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'
      try {
        const a = path.join(tempDir, 'Project', 'foo.md')
        const b = path.join(tempDir, 'project', 'foo.md')
        expect(compactPathFor(a)).not.toBe(compactPathFor(b))
      } finally {
        if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
        else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
      }
    })

    it('control: case-insensitive filesystem still folds differently-cased paths to the same sidecar', () => {
      const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
      try {
        const a = path.join(tempDir, 'Project', 'foo.md')
        const b = path.join(tempDir, 'project', 'foo.md')
        expect(compactPathFor(a)).toBe(compactPathFor(b))
      } finally {
        if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
        else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
      }
    })

    it('round-trips through writeCompact/isCompactFresh using its own resolved path', () => {
      const docPath = path.join(tempDir, 'doc.md')
      fs.writeFileSync(docPath, '# Title\nBody text here.\n')
      const compactPath = compactPathFor(docPath)

      expect(isCompactFresh(compactPath, docPath)).toBe(false)
      writeCompact(compactPath, docPath, buildExtractiveCompact(fs.readFileSync(docPath, 'utf-8')))
      expect(isCompactFresh(compactPath, docPath)).toBe(true)

      fs.writeFileSync(docPath, '# Title\nChanged body.\n')
      expect(isCompactFresh(compactPath, docPath)).toBe(false)
    })
  })
})
