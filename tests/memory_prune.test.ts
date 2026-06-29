import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  parseIndex,
  pruneIndex,
  findContentDuplicates,
  auditClaudeMd,
} from '../src/memory_prune.js'
import { estimateTokens } from '../src/compact.js'

describe('parseIndex', () => {
  it('parses valid index entries', () => {
    const text = '- [Title One](file_one.md)\n- [Title Two](file_two.md)\n'
    const [, entries] = parseIndex(text)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      title: 'Title One',
      target: 'file_one.md',
      lineno: 0,
    })
    expect(entries[1]).toMatchObject({
      title: 'Title Two',
      target: 'file_two.md',
      lineno: 1,
    })
  })

  it('preserves passthrough lines (headers, blanks)', () => {
    const text = '# MEMORY\n\n- [Entry](target.md)\n\nSome notes\n'
    const [passthrough, entries] = parseIndex(text)

    expect(entries).toHaveLength(1)
    expect(passthrough).toHaveLength(4)
    expect(passthrough.map((p) => p[0])).toEqual([0, 1, 3, 4])
  })

  it('handles entries with special characters in title', () => {
    const text = '- [Title with "quotes" and `code`](target.md)\n'
    const [, entries] = parseIndex(text)

    expect(entries[0]?.title).toBe('Title with "quotes" and `code`')
  })

  it('ignores non-entry lines', () => {
    const text = 'plain text\n- just dashes\n- [Title](target.txt)\n'
    const [passthrough, entries] = parseIndex(text)

    expect(entries).toHaveLength(0)
    expect(passthrough).toHaveLength(3)
  })

  it('handles entries with leading whitespace', () => {
    const text = '  - [Title](target.md)\n'
    const [, entries] = parseIndex(text)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe('Title')
  })

  it('preserves raw line content exactly', () => {
    const text = '- [T1](f1.md)\n- [T2](f2.md)'
    const [, entries] = parseIndex(text)

    expect(entries[0]?.raw).toBe('- [T1](f1.md)\n')
    expect(entries[1]?.raw).toBe('- [T2](f2.md)')
  })

  it('handles empty input', () => {
    const [passthrough, entries] = parseIndex('')
    expect(passthrough).toHaveLength(0)
    expect(entries).toHaveLength(0)
  })

  it('rejects .txt targets (only .md)', () => {
    const text = '- [Title](target.txt)\n'
    const [, entries] = parseIndex(text)
    expect(entries).toHaveLength(0)
  })
})

describe('pruneIndex', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('detects dead links (missing target files)', () => {
    const memoryMd = `- [Entry 1](exists.md)
- [Entry 2](missing.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'exists.md'), 'content')

    const result = pruneIndex(tempDir)

    expect(result.removedDead).toHaveLength(1)
    expect(result.removedDead[0]?.target).toBe('missing.md')
    expect(result.kept).toBe(1)
    expect(result.changed).toBe(true)
  })

  it('detects duplicate targets (keeps first)', () => {
    const memoryMd = `- [First](target.md)
- [Duplicate](target.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'target.md'), 'content')

    const result = pruneIndex(tempDir)

    expect(result.removedDup).toHaveLength(1)
    expect(result.removedDup[0]?.title).toBe('Duplicate')
    expect(result.kept).toBe(1)
  })

  it('rewrites MEMORY.md when dry_run is false', () => {
    const memoryMd = `- [Entry 1](exists.md)
- [Entry 2](missing.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'exists.md'), 'content')

    const result = pruneIndex(tempDir, { dryRun: false })

    expect(result.changed).toBe(true)
    const rewritten = fs.readFileSync(path.join(tempDir, 'MEMORY.md'), 'utf-8')
    expect(rewritten).not.toContain('missing.md')
    expect(rewritten).toContain('Entry 1')
  })

  it('does not rewrite when dry_run is true', () => {
    const memoryMd = `- [Entry 1](exists.md)
- [Entry 2](missing.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'exists.md'), 'content')

    const result = pruneIndex(tempDir, { dryRun: true })

    expect(result.changed).toBe(true)
    const onDisk = fs.readFileSync(path.join(tempDir, 'MEMORY.md'), 'utf-8')
    expect(onDisk).toBe(memoryMd)
  })

  it('returns no change when MEMORY.md is absent', () => {
    const result = pruneIndex(tempDir)

    expect(result.changed).toBe(false)
    expect(result.removedDead).toHaveLength(0)
    expect(result.removedDup).toHaveLength(0)
  })

  it('returns no change when all entries are valid', () => {
    const memoryMd = `- [Entry 1](f1.md)
- [Entry 2](f2.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'f1.md'), 'content1')
    fs.writeFileSync(path.join(tempDir, 'f2.md'), 'content2')

    const result = pruneIndex(tempDir)

    expect(result.changed).toBe(false)
  })

  it('preserves non-entry lines (headers, notes)', () => {
    const memoryMd = `# MEMORY

- [Entry 1](exists.md)

Some notes here
- [Entry 2](missing.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'exists.md'), 'content')

    pruneIndex(tempDir, { dryRun: false })

    const rewritten = fs.readFileSync(path.join(tempDir, 'MEMORY.md'), 'utf-8')
    expect(rewritten).toContain('# MEMORY')
    expect(rewritten).toContain('Some notes here')
  })

  it('calculates tokens saved from removed lines', () => {
    const memoryMd = `- [Entry 1](exists.md)
- [Entry 2](missing.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'exists.md'), 'content')

    const result = pruneIndex(tempDir)

    expect(result.tokensSaved).toBeGreaterThan(0)
  })

  it('tokensSaved is sum of per-entry estimates, not estimate of concatenated string', () => {
    // Use entries whose length is a multiple of 3 so that floor arithmetic guarantees sum-of-individual > estimate-of-concatenation (difference = N-1 = 2 for N=3). "- [D](x.md)\n" is 12 chars (divisible by 3).
    const line1 = '- [D](x.md)\n'
    const line2 = '- [E](y.md)\n'
    const line3 = '- [F](z.md)\n'
    const memoryMd = line1 + line2 + line3
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)

    const result = pruneIndex(tempDir)

    expect(result.removedDead).toHaveLength(3)
    const expectedSum = estimateTokens(line1) + estimateTokens(line2) + estimateTokens(line3)
    expect(result.tokensSaved).toBe(expectedSum)
    // Verify per-entry sum > combined estimate, proving the old single-call code undercounted
    const combinedEstimate = estimateTokens(line1 + line2 + line3)
    expect(expectedSum).toBeGreaterThan(combinedEstimate)
  })

  it('handles combined dead and duplicate entries', () => {
    const memoryMd = `- [First](target.md)
- [Dup](target.md)
- [Dead](missing.md)
- [Second](f2.md)
`
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'target.md'), 'content')
    fs.writeFileSync(path.join(tempDir, 'f2.md'), 'content')

    const result = pruneIndex(tempDir)

    expect(result.removedDead).toHaveLength(1)
    expect(result.removedDup).toHaveLength(1)
    expect(result.kept).toBe(2)
  })

  it('ensures trailing newline in rewritten file', () => {
    // Include a dead link so the file will be rewritten
    const memoryMd = '- [Entry](exists.md)\n- [Dead](missing.md)' // no trailing newline
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), memoryMd)
    fs.writeFileSync(path.join(tempDir, 'exists.md'), 'content')

    pruneIndex(tempDir, { dryRun: false })

    const rewritten = fs.readFileSync(path.join(tempDir, 'MEMORY.md'), 'utf-8')
    expect(rewritten.endsWith('\n')).toBe(true)
  })
})

describe('findContentDuplicates', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dups-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns empty list for < 2 files', async () => {
    fs.writeFileSync(path.join(tempDir, 'single.md'), 'content')
    const result = await findContentDuplicates(tempDir)
    expect(result).toHaveLength(0)
  })

  it('detects similar content using jaccard', async () => {
    const content1 = 'the quick brown fox jumps over the lazy dog'
    const content2 = 'the quick brown fox jumps over the lazy cat'
    fs.writeFileSync(path.join(tempDir, 'file1.md'), content1)
    fs.writeFileSync(path.join(tempDir, 'file2.md'), content2)

    const result = await findContentDuplicates(tempDir, { threshold: 0.5 })

    expect(result.length).toBeGreaterThan(0)
    if (result.length > 0) {
      expect(result[0]?.similarity).toBeGreaterThan(0)
      expect(result[0]?.method).toBe('jaccard')
    }
  })

  it('returns empty when similarity below threshold', async () => {
    const content1 = 'completely different content one'
    const content2 = 'xyz abc def ghi jkl mno pqr stu vwx'
    fs.writeFileSync(path.join(tempDir, 'file1.md'), content1)
    fs.writeFileSync(path.join(tempDir, 'file2.md'), content2)

    const result = await findContentDuplicates(tempDir, { threshold: 0.9 })

    expect(result).toHaveLength(0)
  })

  it('ignores MEMORY.md file', async () => {
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), 'memory content')
    fs.writeFileSync(path.join(tempDir, 'other.md'), 'memory content')

    const result = await findContentDuplicates(tempDir, { threshold: 0.5 })

    expect(result.length).toBe(0)
  })

  it('includes tokens in cluster', async () => {
    fs.writeFileSync(path.join(tempDir, 'file1.md'), 'some content here')
    fs.writeFileSync(path.join(tempDir, 'file2.md'), 'some content here')

    const result = await findContentDuplicates(tempDir, { threshold: 0.5 })

    if (result.length > 0) {
      expect(result[0]?.tokens).toBeGreaterThan(0)
    }
  })

  it('handles YAML frontmatter correctly', async () => {
    const withFrontmatter = `---
description: test file
---
the quick brown fox`
    const similar = `---
description: test file
---
the quick brown fox`

    fs.writeFileSync(path.join(tempDir, 'file1.md'), withFrontmatter)
    fs.writeFileSync(path.join(tempDir, 'file2.md'), similar)

    const result = await findContentDuplicates(tempDir, { threshold: 0.5 })

    expect(result.length).toBeGreaterThan(0)
  })
})

describe('auditClaudeMd', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('detects exact duplicate lines', () => {
    const file = path.join(tempDir, 'CLAUDE.md')
    const content = `# Header
Some line
Some line
Different line
`
    fs.writeFileSync(file, content)

    const reports = auditClaudeMd([file])

    expect(reports).toHaveLength(1)
    expect(reports[0]?.exactDupLines).toHaveLength(1)
    expect(reports[0]?.exactDupLines[0]?.[2]).toBe('Some line')
  })

  it('detects duplicate section headings', () => {
    const file = path.join(tempDir, 'CLAUDE.md')
    const content = `## Section One
content
## Section One
content
`
    fs.writeFileSync(file, content)

    const reports = auditClaudeMd([file])

    expect(reports[0]?.dupSections).toHaveLength(1)
    expect(reports[0]?.dupSections[0]?.[0]).toBe('## Section One')
    expect(reports[0]?.dupSections[0]?.[1]).toHaveLength(2)
  })

  it('counts tokens correctly', () => {
    const file = path.join(tempDir, 'CLAUDE.md')
    const content = 'Short content'
    fs.writeFileSync(file, content)

    const reports = auditClaudeMd([file])

    expect(reports[0]?.tokens).toBeGreaterThan(0)
  })

  it('ignores blank lines', () => {
    const file = path.join(tempDir, 'CLAUDE.md')
    const content = `line 1

line 1
`
    fs.writeFileSync(file, content)

    const reports = auditClaudeMd([file])

    // blank line is not counted as duplicate
    expect(reports[0]?.exactDupLines).toHaveLength(1)
  })

  it('handles cross-file overlaps', () => {
    const file1 = path.join(tempDir, 'CLAUDE1.md')
    const file2 = path.join(tempDir, 'CLAUDE2.md')
    const sharedLine = 'This line appears in both files'

    fs.writeFileSync(file1, `${sharedLine}\nOther content1`)
    fs.writeFileSync(file2, `${sharedLine}\nOther content2`)

    const reports = auditClaudeMd([file1, file2])

    const file1Report = reports.find((r) => r.path === file1)
    const file2Report = reports.find((r) => r.path === file2)

    expect(file1Report?.crossFileOverlaps.length).toBeGreaterThan(0)
    expect(file2Report?.crossFileOverlaps.length).toBeGreaterThan(0)
  })

  it('caps cross-file overlaps to 10', () => {
    const file1 = path.join(tempDir, 'CLAUDE1.md')
    const file2 = path.join(tempDir, 'CLAUDE2.md')

    // Create 20 shared lines
    const lines1 = Array.from({ length: 20 }, (_, i) => `Shared line ${i}`)
    const lines2 = Array.from({ length: 20 }, (_, i) => `Shared line ${i}`)

    fs.writeFileSync(file1, lines1.join('\n'))
    fs.writeFileSync(file2, lines2.join('\n'))

    const reports = auditClaudeMd([file1, file2])

    const file1Report = reports.find((r) => r.path === file1)
    expect(file1Report?.crossFileOverlaps.length).toBeLessThanOrEqual(10)
  })

  it('skips missing files gracefully', () => {
    const file1 = path.join(tempDir, 'exists.md')
    const file2 = path.join(tempDir, 'missing.md')

    fs.writeFileSync(file1, 'content')

    const reports = auditClaudeMd([file1, file2])

    expect(reports).toHaveLength(1)
    expect(reports[0]?.path).toBe(file1)
  })

  it('handles files with no issues', () => {
    const file = path.join(tempDir, 'CLAUDE.md')
    const content = `# Header 1
Content 1

# Header 2
Content 2
`
    fs.writeFileSync(file, content)

    const reports = auditClaudeMd([file])

    expect(reports[0]?.exactDupLines).toHaveLength(0)
    expect(reports[0]?.dupSections).toHaveLength(0)
  })

  it('preserves line numbers in findings', () => {
    const file = path.join(tempDir, 'CLAUDE.md')
    const content = `line 0
line 1
line 2
line 0
`
    fs.writeFileSync(file, content)

    const reports = auditClaudeMd([file])

    const dup = reports[0]?.exactDupLines[0]
    expect(dup?.[0]).toBe(0) // first occurrence at line 0
    expect(dup?.[1]).toBe(3) // duplicate at line 3
  })

  it('handles long lines in cross-file overlaps (truncate with ellipsis)', () => {
    const file1 = path.join(tempDir, 'CLAUDE1.md')
    const file2 = path.join(tempDir, 'CLAUDE2.md')

    const longLine = 'x'.repeat(100)
    fs.writeFileSync(file1, longLine)
    fs.writeFileSync(file2, longLine)

    const reports = auditClaudeMd([file1, file2])

    const file1Report = reports.find((r) => r.path === file1)
    if (file1Report?.crossFileOverlaps.length ?? 0 > 0) {
      const overlap = file1Report?.crossFileOverlaps[0]
      expect(overlap).toContain('…')
    }
  })
})
