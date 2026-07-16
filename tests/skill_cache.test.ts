// Regression (SKILL-HIT-LOCK-TOCTOU): incrementSkillHit used to do a plain read-modify-write on
// its <skill>.hits sidecar with no concurrency protection -- two callers hitting the same skill
// at nearly the same time could both read count:N, both increment to N+1 locally, and whichever
// wrote last silently dropped the other caller's hit. The fix wraps the read-modify-write in an
// mkdir-based lock (acquireSkillHitLock in skill_cache.ts).
//
// To prove the race deterministically instead of hoping real scheduling happens to interleave,
// this guards fs.readFile for one specific hits file with a synchronization barrier: every
// concurrent read of that path is held open until `expectedConcurrent` reads are simultaneously
// pending, then all are released together -- forcing every unlocked caller to observe the same
// pre-increment count before any of them writes. A short escape-hatch timeout releases a solo
// pending read on its own so the locked (fixed) case -- where a correct lock never lets more than
// one caller reach this read at a time -- doesn't hang waiting for a concurrency level the fix is
// specifically designed to prevent. vi.spyOn cannot patch fs/promises exports (non-configurable),
// so a module mock with hoisted state is the portable way to inject this, matching
// pack_toctou_race.test.ts, parser_sha_race.test.ts, and worker_draining_rmfail.test.ts.
const mockState = vi.hoisted(() => ({
  delayReadPath: '' as string,
  expectedConcurrent: 0,
  pending: [] as Array<() => void>,
  failMkdirPath: '' as string,
}))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedReadFile = (async (p: unknown, ...rest: unknown[]) => {
    if (mockState.delayReadPath && typeof p === 'string' && p === mockState.delayReadPath) {
      await new Promise<void>((resolve) => {
        mockState.pending.push(resolve)
        if (mockState.pending.length >= mockState.expectedConcurrent) {
          const toRelease = mockState.pending.splice(0, mockState.pending.length)
          toRelease.forEach((r) => r())
        } else {
          setTimeout(() => {
            const idx = mockState.pending.indexOf(resolve)
            if (idx !== -1) {
              mockState.pending.splice(idx, 1)
              resolve()
            }
          }, 15)
        }
      })
    }
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(p, ...rest)
  }) as typeof actual.readFile
  // Fails the first mkdir attempt against a specific path with a non-EEXIST error, simulating
  // the transient Windows race where a just-rmdir'd lock directory briefly rejects an immediate
  // re-mkdir with e.g. EPERM/EBUSY instead of ENOENT/success.
  const guardedMkdir = (async (p: unknown, ...rest: unknown[]) => {
    if (mockState.failMkdirPath && typeof p === 'string' && p === mockState.failMkdirPath) {
      mockState.failMkdirPath = ''
      const err = new Error('EPERM: operation not permitted, mkdir') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    }
    return (actual.mkdir as (...args: unknown[]) => Promise<unknown>)(p, ...rest)
  }) as typeof actual.mkdir
  return { ...actual, default: actual, readFile: guardedReadFile, mkdir: guardedMkdir }
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  setSkillsSourceDirForTesting,
  getSkillFilePath,
  installedSkillPath,
  listSkills,
  incrementSkillHit,
  readSkillHits,
  extractSourceShaFromCompact,
  isCompactStale,
  formatAge,
  hasSessionOutput,
  getCompactAnySession,
  getCompactAnySessionSync,
  pruneSkillOutputs,
} from '../src/skill_cache.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tempDir = path.resolve(__dirname, '.temp-skill-cache-test')

beforeEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true })
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

  it('replaces colons in skill names with tildes', () => {
    const id = outputIdFor('session123456789', 'plugin:improve', 'sha')
    expect(id).toContain('plugin~improve')
  })

  it('does not need a discriminator suffix for namespaced skills (tilde substitution is already injective)', () => {
    const id = outputIdFor('session123456789', 'plugin:improve', 'sha')
    expect(id).toMatch(/plugin~improve-sha$/)
  })

  it('leaves a skill name with no colon unaffected', () => {
    const id = outputIdFor('session123456789', 'improve', 'sha')
    expect(id).not.toMatch(/improven/)
    expect(id).toContain('improve-sha')
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

  it('is case-insensitive exact match (not prefix)', () => {
    const body = '## HELLO WORLD\nContent here'
    const section = extractNamedSection(body, 'hello')
    expect(section).toBeNull()
  })

  it('does exact match on the full heading text (not prefix), regression for Setup vs Setup Guide', () => {
    const body = '## Setup\nSetup content\n## Setup Guide\nGuide content'
    const setupSection = extractNamedSection(body, 'Setup')
    const guideSection = extractNamedSection(body, 'Setup Guide')
    expect(setupSection).toContain('Setup content')
    expect(setupSection).not.toContain('Guide content')
    expect(guideSection).toContain('Guide content')
    expect(guideSection).not.toContain('Setup content')
  })

  it('matches case-insensitive full text', () => {
    const body = '## HELLO WORLD\nContent here'
    const section = extractNamedSection(body, 'hello world')
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

  it('does not introduce replacement characters when truncating multi-byte UTF-8 at arbitrary boundaries', async () => {
    // Regression test: truncation must find valid UTF-8 character boundaries.
    // Using a 3-byte character (中) repeated such that the truncation point
    // lands in the middle of a character, not at a boundary.
    const char = '中' // 3 bytes in UTF-8
    // Create body of ~300KB. 300*1024 / 3 = 102400, so we get exactly 307200 bytes
    const largeBody = char.repeat(102400)
    const meta = await storeOutput('sess123', 'utf8skill', largeBody)

    expect(meta).not.toBeNull()
    expect(meta!.truncated).toBe(true)

    // Verify the stored body doesn't contain replacement characters (U+FFFD).
    // If truncation happened at a character boundary, no replacements would appear.
    const storedPath = path.resolve(tempDir, `${meta!.outputId}.txt`)
    const stored = await fs.readFile(storedPath, 'utf-8')
    expect(stored).not.toContain('�')
    expect(stored.length).toBeGreaterThan(0)
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

describe('sanitizeSkillId collision regression', () => {
  it('does not let a colon-containing skill id collide with a literal-underscore skill id in the compact cache (fail-on-buggy: both sanitize to the same filename)', async () => {
    const sessionId = 'session123456789'
    await storeCompact(sessionId, 'foo:bar', 'Content for foo:bar')
    await storeCompact(sessionId, 'foo_bar', 'Content for foo_bar')

    const compactColon = await getCompact(sessionId, 'foo:bar')
    const compactUnderscore = await getCompact(sessionId, 'foo_bar')

    expect(compactColon).toContain('Content for foo:bar')
    expect(compactUnderscore).toContain('Content for foo_bar')
  })

  it('does not let "test:a" and "test_an" collide (fail-on-buggy: the prior colon-to-underscore-plus-discriminator scheme mapped both to "test_an")', async () => {
    const sessionId = 'session123456789'
    await storeCompact(sessionId, 'test:a', 'Content for test:a')
    await storeCompact(sessionId, 'test_an', 'Content for test_an')

    const compactColon = await getCompact(sessionId, 'test:a')
    const compactLiteral = await getCompact(sessionId, 'test_an')

    expect(compactColon).toContain('Content for test:a')
    expect(compactLiteral).toContain('Content for test_an')
  })

  it('storing in the opposite order still keeps both skills distinct', async () => {
    const sessionId = 'session987654321'
    await storeCompact(sessionId, 'foo_bar', 'Content for foo_bar')
    await storeCompact(sessionId, 'foo:bar', 'Content for foo:bar')

    const compactUnderscore = await getCompact(sessionId, 'foo_bar')
    const compactColon = await getCompact(sessionId, 'foo:bar')

    expect(compactUnderscore).toContain('Content for foo_bar')
    expect(compactColon).toContain('Content for foo:bar')
  })
})

describe('listSkills regression - hyphenated session id', () => {
  it('resolves compactLen correctly when the session id contains embedded hyphens (fail-on-buggy: splitting the outputId on the first hyphen truncated a UUID-shaped session fragment)', async () => {
    // A realistic UUID session id: safeSessionFragment keeps all 16 leading chars,
    // several of which are hyphens, since UUIDs are alphanumeric-and-hyphen throughout.
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const skillName = 'myskill'
    await storeOutput(sessionId, skillName, 'Body content')
    await storeCompact(sessionId, skillName, 'Compact content')

    const skills = await listSkills(sessionId)
    const skill = skills.find((s) => s.name === skillName)
    expect(skill).toBeDefined()
    expect(skill!.compactLen).toBeGreaterThan(0)
  })
})

describe('hasSessionOutput', () => {
  it('returns true for a skill actually cached in this session', async () => {
    const sessionId = 'session123456789'
    await storeOutput(sessionId, 'myskill', 'Body content')
    expect(await hasSessionOutput(sessionId, 'myskill')).toBe(true)
  })

  it('returns false for a skill never cached in this session', async () => {
    const sessionId = 'session123456789'
    expect(await hasSessionOutput(sessionId, 'nonexistent')).toBe(false)
  })

  it('does not false-positive on a differently-named skill sharing a hyphen-delimited prefix (fail-on-buggy: raw outputId.startsWith(prefix) let "ralph-loop" match a stored "ralph-loop-extended" entry)', async () => {
    const sessionId = 'session123456789'
    await storeOutput(sessionId, 'ralph-loop-extended', 'Body for the extended skill')

    expect(await hasSessionOutput(sessionId, 'ralph-loop')).toBe(false)
    expect(await hasSessionOutput(sessionId, 'ralph-loop-extended')).toBe(true)
  })
})

describe('getCompactAnySession / getCompactAnySessionSync', () => {
  it('finds a compact stored by a different session', async () => {
    await storeCompact('otherSession1234', 'myskill', 'Cross-session compact')
    expect(await getCompactAnySession('myskill')).toContain('Cross-session compact')
    expect(getCompactAnySessionSync('myskill')).toContain('Cross-session compact')
  })

  it('does not substring-match a differently-named skill whose sanitized name is a hyphen-bounded suffix of this one (fail-on-buggy: filename.includes(name) let "loop" match a stored "ralph-loop" compact)', async () => {
    await storeCompact('sessionABC12345', 'ralph-loop', 'Compact for ralph-loop')

    expect(await getCompactAnySession('loop')).toBeNull()
    expect(getCompactAnySessionSync('loop')).toBeNull()
    // sanity: the actual name still resolves
    expect(await getCompactAnySession('ralph-loop')).toContain('Compact for ralph-loop')
  })
})

describe('incrementSkillHit / readSkillHits - safeSkillName routing', () => {
  it('rejects a skill name that safeSkillName would reject, consistent with every other cache-writing path (fail-on-buggy: bypassing safeSkillName let an invalid name write its own hits file anyway)', async () => {
    const skillName = 'my skill' // a space is outside safeSkillName's allowed charset
    await incrementSkillHit(skillName)
    const hits = await readSkillHits(skillName)
    expect(hits.count).toBe(0)

    const files = await fs.readdir(tempDir)
    expect(files.some((f) => f.includes('my skill'))).toBe(false)
  })

  it('still tracks hits normally for a plain skill name', async () => {
    await incrementSkillHit('plainskill')
    const hits = await readSkillHits('plainskill')
    expect(hits.count).toBe(1)
  })
})

describe('pruneSkillOutputs', () => {
  async function setMetaTs(outputId: string, ts: number): Promise<void> {
    const metaPath = path.join(tempDir, `${outputId}.meta`)
    const raw = await fs.readFile(metaPath, 'utf-8')
    const parsed = JSON.parse(raw) as { ts: number }
    parsed.ts = ts
    await fs.writeFile(metaPath, JSON.stringify(parsed, null, 2))
  }

  it('evicts entries beyond maxCount, keeping the newest', async () => {
    const now = Date.now()
    const metaA = await storeOutput('sess1', 'skillA', 'Body A')
    const metaB = await storeOutput('sess1', 'skillB', 'Body B')
    const metaC = await storeOutput('sess1', 'skillC', 'Body C')
    await setMetaTs(metaA!.outputId, now - 3000)
    await setMetaTs(metaB!.outputId, now - 2000)
    await setMetaTs(metaC!.outputId, now - 1000)

    const removed = pruneSkillOutputs(2, 365 * 24 * 3600 * 1000)
    expect(removed).toBe(1)

    const remaining = await getAllCachedSkills()
    const names = remaining.map((s) => s.name).sort()
    expect(names).toEqual(['skillB', 'skillC'])
  })

  it('evicts entries older than maxAgeMs', async () => {
    const meta = await storeOutput('sess1', 'oldskill', 'Old body')
    await setMetaTs(meta!.outputId, Date.now() - 48 * 3600 * 1000)

    const removed = pruneSkillOutputs(200, 24 * 3600 * 1000)
    expect(removed).toBe(1)

    const remaining = await getAllCachedSkills()
    expect(remaining.find((s) => s.name === 'oldskill')).toBeUndefined()
  })

  it('removes the paired .txt body along with .meta', async () => {
    const meta = await storeOutput('sess1', 'skill', 'Body content')

    pruneSkillOutputs(0, 365 * 24 * 3600 * 1000)

    const files = await fs.readdir(tempDir)
    expect(files.some((f) => f.startsWith(meta!.outputId))).toBe(false)
  })

  it('returns 0 when the skills dir does not exist', () => {
    setSkillOutputsDirForTesting(path.resolve(__dirname, '.temp-skill-cache-test-missing'))
    expect(pruneSkillOutputs()).toBe(0)
  })
})

describe('outputIdFor regression - colon handling', () => {
  it('substitutes colons with tildes, with no discriminator suffix needed', () => {
    const id1 = outputIdFor('session123456789', 'plugin:improve', 'sha')
    const id2 = outputIdFor('session123456789', 'improve', 'sha')
    expect(id1).toContain('plugin~improve-sha')
    expect(id2).toContain('improve-sha')
  })

  it('handles multiple colons correctly', () => {
    const id = outputIdFor('session123456789', 'org:plugin:skill', 'sha')
    expect(id).toContain('org~plugin~skill')
  })

  it('leaves a skill name with no colon unchanged', () => {
    const id = outputIdFor('session123456789', 'myskill', 'sha')
    expect(id).toContain('myskill-sha')
  })
})

describe('getSkillFilePath / installedSkillPath disk fallback', () => {
  const sourceDir = path.resolve(__dirname, '.temp-skill-source')

  beforeEach(async () => {
    try {
      await fs.rm(sourceDir, { recursive: true, force: true })
    } catch {
      // not present yet
    }
    await fs.mkdir(path.join(sourceDir, 'ollama'), { recursive: true })
    await fs.writeFile(
      path.join(sourceDir, 'ollama', 'SKILL.md'),
      'Ollama skill body\n<!-- COMPACT_END -->\nrules'
    )
    setSkillsSourceDirForTesting(sourceDir)
  })

  afterEach(() => {
    setSkillsSourceDirForTesting(null)
  })

  // Regression: getSkillFilePath used to resolve ONLY from cached metas, so a skill installed on disk but never loaded via the Skill hook this session returned null -> `skill 'ollama' not found`. The empty (isolated) cache here forces the disk fallback. Pre-fix: returns null and this expectation fails.
  it('resolves an installed skill from disk when the cache is empty', async () => {
    const resolved = await getSkillFilePath('ollama')
    expect(resolved).not.toBeNull()
    expect(resolved).toBe(path.join(sourceDir, 'ollama', 'SKILL.md'))
  })

  it('returns null for a skill that is neither cached nor installed', async () => {
    expect(await getSkillFilePath('does-not-exist')).toBeNull()
  })

  it('installedSkillPath returns the SKILL.md path when present, null otherwise', async () => {
    expect(await installedSkillPath('ollama')).toBe(
      path.join(sourceDir, 'ollama', 'SKILL.md')
    )
    expect(await installedSkillPath('absent')).toBeNull()
  })

  it('installedSkillPath rejects an unsafe (traversal) name', async () => {
    expect(await installedSkillPath('../etc')).toBeNull()
  })
})

describe('Hit count tracking', () => {
  const hitDir = path.resolve(__dirname, '.temp-skill-hits-test')

  beforeEach(async () => {
    try {
      await fs.rm(hitDir, { recursive: true, force: true })
    } catch {
      // not present yet
    }
    setSkillOutputsDirForTesting(hitDir)
  })

  afterEach(() => {
    setSkillOutputsDirForTesting(null)
  })

  it('incrementSkillHit creates or updates hit count', async () => {
    await incrementSkillHit('myskill')
    const hits1 = await readSkillHits('myskill')
    expect(hits1.count).toBe(1)

    await incrementSkillHit('myskill')
    const hits2 = await readSkillHits('myskill')
    expect(hits2.count).toBe(2)
  })

  it('readSkillHits returns zero for nonexistent skills', async () => {
    const hits = await readSkillHits('nonexistent')
    expect(hits.count).toBe(0)
  })

  it('listSkills includes hit count', async () => {
    const sessionId = 'test-session'
    const body = 'Test skill body'
    await storeOutput(sessionId, 'myskill', body)
    await incrementSkillHit('myskill')
    await incrementSkillHit('myskill')

    const skills = await listSkills(sessionId)
    const skill = skills.find((s) => s.name === 'myskill')
    expect(skill).toBeDefined()
    expect(skill!.hitCount).toBe(2)
  })
})

describe('incrementSkillHit concurrency (regression: unlocked read-modify-write lost updates)', () => {
  const raceDir = path.resolve(__dirname, '.temp-skill-hits-race-test')

  beforeEach(async () => {
    try {
      await fs.rm(raceDir, { recursive: true, force: true })
    } catch {
      // not present yet
    }
    setSkillOutputsDirForTesting(raceDir)
  })

  afterEach(() => {
    setSkillOutputsDirForTesting(null)
    mockState.delayReadPath = ''
    mockState.expectedConcurrent = 0
    mockState.pending = []
    mockState.failMkdirPath = ''
  })

  it(
    'does not lose updates when many callers increment the same skill concurrently',
    async () => {
      const SKILL = 'race-skill'
      const CONCURRENCY = 5
      const hitsPath = path.join(raceDir, `${SKILL}.hits`)

      // Force every concurrent read of this skill's hits file to pause until CONCURRENCY reads
      // are simultaneously pending, then release them all together -- guaranteeing every
      // unlocked caller observes the same pre-increment count instead of relying on real
      // scheduling luck. A correct lock never lets more than one caller reach this read at a
      // time, so under the fix each read hits the barrier's escape-hatch timeout and proceeds
      // solo instead of ever reaching the CONCURRENCY threshold.
      mockState.delayReadPath = hitsPath
      mockState.expectedConcurrent = CONCURRENCY

      await Promise.all(Array.from({ length: CONCURRENCY }, () => incrementSkillHit(SKILL)))

      const hits = await readSkillHits(SKILL)
      expect(hits.count).toBe(CONCURRENCY)
    },
    15000,
  )

  it(
    'does not perform an unlocked read-modify-write when lock acquisition fails (regression: acquireSkillHitLock returning false was ignored, so a caller that failed to acquire the lock still read-modified-wrote the hits file unprotected)',
    async () => {
      const SKILL = 'lock-exhausted-skill'
      const hitsPath = path.join(raceDir, `${SKILL}.hits`)
      const lockPath = `${hitsPath}.lock`

      // Simulate the transient Windows race this bug actually surfaces from: mkdir on the lock
      // path fails with a non-EEXIST error (e.g. EPERM/EBUSY right after a prior holder's rmdir),
      // which acquireSkillHitLock treats as "give up immediately" rather than retrying. Seed the
      // hits file with a known value first so an unprotected write is directly observable.
      await fs.mkdir(raceDir, { recursive: true })
      await fs.writeFile(hitsPath, JSON.stringify({ count: 1, lastTs: 0 }), 'utf-8')
      mockState.failMkdirPath = lockPath

      await incrementSkillHit(SKILL)

      const raw = await fs.readFile(hitsPath, 'utf-8')
      expect(JSON.parse(raw).count).toBe(1)
    },
    15000,
  )
})

describe('Compact staleness tracking', () => {
  const staleDir = path.resolve(__dirname, '.temp-skill-stale-test')

  beforeEach(async () => {
    try {
      await fs.rm(staleDir, { recursive: true, force: true })
    } catch {
      // not present yet
    }
    setSkillOutputsDirForTesting(staleDir)
  })

  afterEach(() => {
    setSkillOutputsDirForTesting(null)
  })

  it('extractSourceShaFromCompact parses the source SHA comment', () => {
    const compact = '<!-- source_sha: abc123def456 -->\nCompact content'
    const sha = extractSourceShaFromCompact(compact)
    expect(sha).toBe('abc123def456')
  })

  it('extractSourceShaFromCompact returns null when no SHA present', () => {
    const compact = 'Compact content without SHA'
    const sha = extractSourceShaFromCompact(compact)
    expect(sha).toBeNull()
  })

  it('storeCompact with sourceSha embeds the SHA', async () => {
    const sessionId = 'test-session'
    const sourceSha = contentHash('test body').slice(0, 12)
    await storeCompact(sessionId, 'myskill', 'Compact content', sourceSha)
    const compact = await getCompact(sessionId, 'myskill')
    expect(compact).toBeDefined()
    expect(compact).toContain(`<!-- source_sha: ${sourceSha} -->`)
  })

  it('isCompactStale detects when compact is stale', async () => {
    const oldSha = 'abc123def456'
    const newSha = 'xyz789uvw012'
    const compact = `<!-- source_sha: ${oldSha} -->\nOld content`
    const stale = await isCompactStale(compact, 'myskill', newSha)
    expect(stale).toBe(true)
  })

  it('isCompactStale returns false when compact is fresh', async () => {
    const sha = 'abc123def456'
    const compact = `<!-- source_sha: ${sha} -->\nCurrent content`
    const stale = await isCompactStale(compact, 'myskill', sha)
    expect(stale).toBe(false)
  })

  it('isCompactStale returns null when no embedded SHA', async () => {
    const compact = 'Content without SHA'
    const stale = await isCompactStale(compact, 'myskill', 'abc123def456')
    expect(stale).toBeNull()
  })

  it('listSkills includes compactStale field', async () => {
    const sessionId = 'test-session'
    const body = 'Test skill body with content'
    const bodySha = contentHash(body)
    await storeOutput(sessionId, 'myskill', body)
    await storeCompact(sessionId, 'myskill', 'Old compact', bodySha.slice(0, 12))
    // Now modify body to make compact stale.
    await storeOutput(sessionId, 'myskill', body + ' more content')

    const skills = await listSkills(sessionId)
    const skill = skills.find((s) => s.name === 'myskill')
    expect(skill).toBeDefined()
    // compactStale should be false since we stored with matching SHA.
    expect(skill!.compactStale).toBeDefined()
  })
})

describe('Age formatting', () => {
  it('formatAge formats seconds', () => {
    expect(formatAge(30 * 1000)).toBe('30s')
  })

  it('formatAge formats minutes', () => {
    expect(formatAge(5 * 60 * 1000)).toBe('5m')
  })

  it('formatAge formats hours', () => {
    expect(formatAge(3 * 60 * 60 * 1000)).toBe('3h')
  })

  it('formatAge formats days', () => {
    expect(formatAge(2 * 24 * 60 * 60 * 1000)).toBe('2d')
  })
})
