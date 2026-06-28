import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  contentHash,
  outputIdFor,
  extractCompactFromMarker,
  extractNamedSection,
  extractAllHeadings,
  extractH2Headings,
  extractChecklistSection,
  storeOutput,
  getCompact,
  storeCompact,
  findCrossSessionEntry,
  getAllCachedSkills,
  setSkillOutputsDirForTesting,
} from '../src/skill_cache.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tempDir = path.resolve(__dirname, '.temp-skill-cache-test')

beforeEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true })
  } catch {
    // directory doesn't exist yet
  }
  await fs.mkdir(tempDir, { recursive: true })
  setSkillOutputsDirForTesting(tempDir)
})

afterEach(() => {
  setSkillOutputsDirForTesting(null)
})

describe('contentHash', () => {
  it('returns 16-char hex string', () => {
    const hash = contentHash('hello world')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic', () => {
    const content = 'test content'
    const hash1 = contentHash(content)
    const hash2 = contentHash(content)
    expect(hash1).toBe(hash2)
  })

  it('differs for different content', () => {
    const hash1 = contentHash('content1')
    const hash2 = contentHash('content2')
    expect(hash1).not.toBe(hash2)
  })
})

describe('outputIdFor', () => {
  it('builds filesystem-safe ID', () => {
    const id = outputIdFor('sess123456789012345', 'myskill', 'abc123')
    expect(id).toMatch(/^sess123456789012-myskill-abc123$/)
  })

  it('truncates session ID to 16 chars', () => {
    const id = outputIdFor('verylongsessionidthatexceedssixteenandshouldbetruncated', 'skill', 'sha')
    expect(id.split('-')[0]).toHaveLength(16)
  })

  it('replaces colons in skill names with underscores', () => {
    const id = outputIdFor('session123456789', 'plugin:improve', 'sha')
    expect(id).toContain('plugin_improve')
  })

  it('appends n suffix for namespaced skills', () => {
    const id = outputIdFor('session123456789', 'plugin:improve', 'sha')
    expect(id).toMatch(/plugin_improven-sha$/)
  })

  it('does not append n for non-namespaced skills', () => {
    const id = outputIdFor('session123456789', 'improve', 'sha')
    expect(id).not.toMatch(/improven/)
  })
})

describe('extractCompactFromMarker', () => {
  it('returns null when marker is absent', () => {
    const body = '# Title\n\nSome content'
    expect(extractCompactFromMarker(body)).toBeNull()
  })

  it('extracts text before marker', () => {
    const body = 'Compact text\n<!-- COMPACT_END -->\nDetailed text'
    const compact = extractCompactFromMarker(body)
    expect(compact).toBe('Compact text')
  })

  it('strips whitespace', () => {
    const body = '  Compact  \n\n<!-- COMPACT_END -->\n\nDetailed'
    const compact = extractCompactFromMarker(body)
    expect(compact).toBe('Compact')
  })

  it('ignores marker inside code blocks', () => {
    const body = '```\n<!-- COMPACT_END -->\n```\nReal content\n<!-- COMPACT_END -->'
    const compact = extractCompactFromMarker(body)
    expect(compact).toContain('Real content')
    expect(compact).toContain('```')
  })

  it('handles tilde fence markers', () => {
    const body = '~~~\n<!-- COMPACT_END -->\n~~~\nReal\n<!-- COMPACT_END -->'
    const compact = extractCompactFromMarker(body)
    expect(compact).toContain('Real')
    expect(compact).toContain('~~~')
  })

  it('returns null when marker is only content before it', () => {
    const body = '<!-- COMPACT_END -->'
    expect(extractCompactFromMarker(body)).toBeNull()
  })

  it('handles empty body', () => {
    expect(extractCompactFromMarker('')).toBeNull()
  })
})

describe('extractH2Headings', () => {
  it('extracts all ## headings', () => {
    const body = '# Title\n## Section1\nText\n## Section2'
    const headings = extractH2Headings(body)
    expect(headings).toEqual(['Section1', 'Section2'])
  })

  it('ignores headings in code blocks', () => {
    const body = '## Real\n```\n## Fake\n```\n## Another'
    const headings = extractH2Headings(body)
    expect(headings).toEqual(['Real', 'Another'])
  })

  it('returns empty array for no headings', () => {
    expect(extractH2Headings('No headings here')).toEqual([])
  })

  it('ignores # and ### headings', () => {
    const body = '# One\n## Two\n### Three'
    const headings = extractH2Headings(body)
    expect(headings).toEqual(['Two'])
  })

  it('strips whitespace from heading text', () => {
    const body = '##   Spaced Heading   '
    const headings = extractH2Headings(body)
    expect(headings).toEqual(['Spaced Heading'])
  })
})

describe('extractAllHeadings', () => {
  it('returns [level, title] tuples', () => {
    const body = '## H2\n### H3'
    const headings = extractAllHeadings(body)
    expect(headings).toEqual([
      [2, 'H2'],
      [3, 'H3'],
    ])
  })

  it('respects maxLevel parameter', () => {
    const body = '## H2\n### H3\n#### H4'
    const headings = extractAllHeadings(body, 3)
    expect(headings).toEqual([
      [2, 'H2'],
      [3, 'H3'],
    ])
  })

  it('ignores headings in code blocks', () => {
    const body = '## Real\n```\n## Fake\n```'
    const headings = extractAllHeadings(body)
    expect(headings).toEqual([[2, 'Real']])
  })

  it('returns empty array for empty body', () => {
    expect(extractAllHeadings('')).toEqual([])
  })

  it('ignores H1 and H5+', () => {
    const body = '# H1\n## H2\n### H3\n#### H4\n##### H5'
    const headings = extractAllHeadings(body, 4)
    expect(headings).toEqual([
      [2, 'H2'],
      [3, 'H3'],
      [4, 'H4'],
    ])
  })
})

describe('extractNamedSection', () => {
  it('extracts content under a named ## heading', () => {
    const body = '## Getting Started\nStep 1\nStep 2\n## Next Section\nOther'
    const section = extractNamedSection(body, 'Getting Started')
    expect(section).toContain('Step 1')
    expect(section).toContain('Step 2')
    expect(section).not.toContain('Next Section')
  })

  it('is case-insensitive prefix match', () => {
    const body = '## HELLO WORLD\nContent here'
    const section = extractNamedSection(body, 'hello')
    expect(section).toContain('Content')
  })

  it('returns null when section not found', () => {
    const body = '## Section1\nContent'
    expect(extractNamedSection(body, 'Nonexistent')).toBeNull()
  })

  it('handles ordinal selection with #2 suffix', () => {
    const body = '## Item\nFirst\n## Item\nSecond'
    const first = extractNamedSection(body, 'Item#1')
    const second = extractNamedSection(body, 'Item#2')
    expect(first).toContain('First')
    expect(second).toContain('Second')
  })

  it('stops at next ## heading', () => {
    const body = '## Section\nLine1\nLine2\n## Next\nLine3'
    const section = extractNamedSection(body, 'Section')
    expect(section).toContain('Line1')
    expect(section).not.toContain('Next')
  })

  it('returns null for empty body or heading', () => {
    expect(extractNamedSection('', 'test')).toBeNull()
    expect(extractNamedSection('## test', '')).toBeNull()
  })

  it('does not truncate at ## inside a code block in body', () => {
    const body =
      '## Section\nSome text\n```\n## Not a heading\ncode\n```\nmore text\n## Real End\nafter'
    const section = extractNamedSection(body, 'Section')
    expect(section).toContain('## Not a heading')
    expect(section).toContain('more text')
    expect(section).not.toContain('after')
  })

  it('treats ordinal #0 as #1 (first occurrence)', () => {
    const body = '## Item\nFirst\n## Item\nSecond'
    const section = extractNamedSection(body, 'Item#0')
    expect(section).toContain('First')
    expect(section).not.toContain('Second')
  })
})

describe('extractChecklistSection', () => {
  it('finds Checklist section', () => {
    const body = '## Checklist\n- [ ] Item 1\n- [ ] Item 2'
    const section = extractChecklistSection(body)
    expect(section).toContain('Item 1')
  })

  it('finds Check List variant', () => {
    const body = '## Check List\n- [ ] Task'
    const section = extractChecklistSection(body)
    expect(section).toContain('Task')
  })

  it('finds To-Do variant', () => {
    const body = '## To-Do\n- [ ] Task'
    const section = extractChecklistSection(body)
    expect(section).toContain('Task')
  })

  it('finds TODO variant', () => {
    const body = '## TODO\n- [ ] Task'
    const section = extractChecklistSection(body)
    expect(section).toContain('Task')
  })

  it('returns null when no checklist section', () => {
    const body = '## Other Section\nContent'
    expect(extractChecklistSection(body)).toBeNull()
  })

  it('truncates long content with ellipsis', () => {
    const longTask = 'a'.repeat(2500)
    const body = `## Checklist\n${longTask}`
    const section = extractChecklistSection(body)
    expect(section).toMatch(/…$/)
  })

  it('stops at next ## heading', () => {
    const body = '## Checklist\n- [ ] Item1\n## Next\n- [ ] Item2'
    const section = extractChecklistSection(body)
    expect(section).toContain('Item1')
    expect(section).not.toContain('Item2')
  })

  it('does not truncate at ## inside a code block in body', () => {
    const body = '## Checklist\n- [ ] Task1\n```\n## Inside code\n```\n- [ ] Task2\n## Done\nafter'
    const section = extractChecklistSection(body)
    expect(section).toContain('Task1')
    expect(section).toContain('## Inside code')
    expect(section).toContain('Task2')
    expect(section).not.toContain('after')
  })
})

describe('storeOutput and getCompact round trip', () => {
  it('stores and retrieves skill body', async () => {
    const body = 'This is a skill body\nWith multiple lines'
    const meta = await storeOutput('sess123', 'testskill', body)

    expect(meta).not.toBeNull()
    expect(meta!.skillName).toContain('testskill')
    expect(meta!.contentSha).toMatch(/^[0-9a-f]{16}$/)
    expect(meta!.bodyBytes).toBeGreaterThan(0)
  })

  it('marks truncated when body exceeds 256KB', async () => {
    const largeBody = 'x'.repeat(300 * 1024)
    const meta = await storeOutput('sess123', 'largeskill', largeBody)

    expect(meta).not.toBeNull()
    expect(meta!.truncated).toBe(true)
  })

  it('correctly truncates UTF-8 multi-byte characters when body exceeds 256KB', async () => {
    const emoji = '🎉'
    const largeBody = emoji.repeat(300 * 1024 / 4)
    const meta = await storeOutput('sess123', 'emojiskill', largeBody)

    expect(meta).not.toBeNull()
    expect(meta!.truncated).toBe(true)
    expect(meta!.bodyBytes).toBeGreaterThan(256 * 1024)
  })

  it('cross-session dedup returns existing entry', async () => {
    const body = 'Shared skill body'
    const meta1 = await storeOutput('sess1', 'skill', body)
    const meta2 = await storeOutput('sess2', 'skill', body)

    expect(meta1!.outputId).toBe(meta2!.outputId)
  })

  it('stores and retrieves compact', async () => {
    const compact = 'Compact text\nWith content'
    await storeCompact('sess123', 'skill', compact)
    const retrieved = await getCompact('sess123', 'skill')

    expect(retrieved).toBe(compact)
  })

  it('stores compact with source SHA header', async () => {
    const compact = 'Compact text'
    const sha = 'abc123def456'
    await storeCompact('sess123', 'skill', compact, sha)
    const retrieved = await getCompact('sess123', 'skill')

    expect(retrieved).toContain('source_sha')
    expect(retrieved).toContain('abc123')
  })
})

describe('findCrossSessionEntry', () => {
  it('returns null when no entry exists', async () => {
    const result = await findCrossSessionEntry('nonexistent', 'abc123')
    expect(result).toBeNull()
  })

  it('returns null for invalid skill name', async () => {
    const result = await findCrossSessionEntry('!!!invalid!!!', 'sha')
    expect(result).toBeNull()
  })
})

describe('getAllCachedSkills', () => {
  it('returns empty array when no skills cached', async () => {
    const skills = await getAllCachedSkills()
    expect(skills).toEqual([])
  })

  it('returns cached skills without duplication', async () => {
    await storeOutput('sess1', 'skill1', 'Body 1')
    await storeOutput('sess1', 'skill2', 'Body 2')
    await storeOutput('sess2', 'skill1', 'Body 1 again')

    const skills = await getAllCachedSkills()
    const names = skills.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('suite-named skill compact round-trip (colon in name)', () => {
  it('storeCompact and getCompact agree on path for a suite-named skill', async () => {
    // 'commit-commands:commit' has a colon. Pre-fix: storeCompact wrote '<session>-commit-commands:commit-compact' (invalid on Windows, colon in filename) while listSkills looked for '<session>-commit-commands_commit-compact'. They disagreed, so listSkills always showed compactLen=0.
    const sessionId = 'sess123456789012'
    const skillName = 'commit-commands:commit'
    const compactText = 'Compact body for suite skill'

    await storeCompact(sessionId, skillName, compactText)
    const retrieved = await getCompact(sessionId, skillName)

    // store -> get must round-trip successfully.
    expect(retrieved).not.toBeNull()
    expect(retrieved).toContain('Compact body for suite skill')
  })

  it('listSkills shows non-zero compactLen after storeCompact for a suite-named skill', async () => {
    const sessionId = 'sess123456789012'
    const skillName = 'commit-commands:commit'
    const body = 'Body for commit-commands:commit skill'
    const compactText = 'Compact for suite skill'

    await storeOutput(sessionId, skillName, body)
    await storeCompact(sessionId, skillName, compactText)

    const skills = await getAllCachedSkills(sessionId)
    const entry = skills.find((s) => s.name === 'commit-commands:commit')

    // Pre-fix: listSkills used .replace(':', '_') (no /g, only first colon) while storeCompact kept colons, so compactLen was always 0.
    expect(entry).toBeDefined()
    expect(entry!.compactLen).toBeGreaterThan(0)
  })

  it('compact filename written by storeCompact contains no colon', async () => {
    const sessionId = 'sess123456789012'
    const skillName = 'org:plugin:skill'
    const compactText = 'Some compact'

    await storeCompact(sessionId, skillName, compactText)

    // Read the skills dir and confirm no file with a colon was created.
    const files = await import('fs/promises').then((m) => m.readdir(tempDir))
    const compactFiles = files.filter((f) => f.endsWith('-compact'))
    for (const f of compactFiles) {
      expect(f).not.toContain(':')
    }
  })
})

describe('outputIdFor regression - colon handling', () => {
  it('correctly detects character replacement and appends suffix only when replaced', () => {
    const id1 = outputIdFor('session123456789', 'plugin:improve', 'sha')
    const id2 = outputIdFor('session123456789', 'improve', 'sha')
    expect(id1).toContain('plugin_improven-sha')
    expect(id2).not.toContain('improven')
    expect(id2).toContain('improve-sha')
  })

  it('handles multiple colons correctly', () => {
    const id = outputIdFor('session123456789', 'org:plugin:skill', 'sha')
    expect(id).toContain('org_plugin_skilln')
  })

  it('does not append suffix when no colon exists', () => {
    const id = outputIdFor('session123456789', 'myskill', 'sha')
    expect(id).not.toMatch(/mykilln/)
    expect(id).toContain('myskill-sha')
  })
})
