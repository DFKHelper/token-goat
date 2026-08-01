import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeBlob } from '../src/disk_cache.js'
import { SESSIONS_SUBDIR } from '../src/session_store.js'
import { storeBashOutput } from '../src/bash_output_cache.js'
import { storeOutput, setSkillOutputsDirForTesting } from '../src/skill_cache.js'

// Only runGit (used for the "## Uncommitted changes (git diff --stat)" section) is mocked --
// resolveProjectRoot resolves the real project root normally, but every git subprocess call
// resume.ts makes goes through this mock so no test depends on the real repo's working-tree
// state. Default: no diff output, matching the pre-existing tests' expectations (that section
// absent) unless a test overrides the mock.
const runGitMock = vi.fn((..._args: unknown[]) => ({ exitCode: 1, stdout: '', stderr: '' }))
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, runGit: (...args: unknown[]) => runGitMock(...(args as [string[], unknown])) }
})

const { buildResumePacket } = await import('../src/resume.js')

describe('buildResumePacket', () => {
  beforeEach(() => {
    runGitMock.mockReset()
    runGitMock.mockReturnValue({ exitCode: 1, stdout: '', stderr: '' })
  })

  it('returns null for an invalid (empty) session id', async () => {
    const packet = await buildResumePacket('')
    expect(packet).toBeNull()
  })

  it('returns null for a nonexistent session id', async () => {
    const packet = await buildResumePacket('nonexistent-session')
    expect(packet).toBeNull()
  })

  it('returns null for an arbitrary unknown session id', async () => {
    const packet = await buildResumePacket('abc123')
    expect(packet).toBeNull()
  })

  it('collapses a multi-line bash command onto one markdown list line (regression: bashEntry.command was pushed raw, so a heredoc/multi-line command\'s embedded newlines split into separate top-level lines, only the first prefixed with "- ", breaking the "## Recent bash commands" list structure the model reading the resume packet assumes)', async () => {
    const sessionId = 'sid-multiline-bash'
    const multilineCommand = "cat <<'EOF'\nfoo\nEOF"
    const id = await storeBashOutput(multilineCommand, 'foo\n', 0)
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [[multilineCommand, id]] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    if (packet !== null) {
      const lines = packet.split('\n')
      const bashLines = lines.filter((l) => l.startsWith('- cat'))
      // The whole command collapses onto a single "- " line, not one line per embedded newline.
      expect(bashLines).toHaveLength(1)
      expect(lines).not.toContain('foo')
      expect(lines).not.toContain('EOF')
    }
  })

  it('lists edited files, capped at 10, dropping an empty-path entry', async () => {
    const sessionId = 'sid-edited-files'
    const files = [
      ...Array.from({ length: 12 }, (_, i) => ({ path: `edited-${i}.ts`, wasEdited: true })),
      { path: '', wasEdited: true }, // empty path, must be filtered out
    ]
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files, bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    if (packet !== null) {
      expect(packet).toContain('## Edited files')
      const editedLines = packet.split('\n').filter((l) => l.startsWith('- edited-'))
      expect(editedLines).toHaveLength(10)
    }
  })

  it('lists the top-read files by readCount descending, excluding edited files from that section, capped at 8', async () => {
    const sessionId = 'sid-top-read'
    const files = [
      { path: 'edited.ts', wasEdited: true, readCount: 999 }, // excluded from Top files read despite highest count
      ...Array.from({ length: 10 }, (_, i) => ({ path: `read-${i}.ts`, wasEdited: false, readCount: i })),
    ]
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files, bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    if (packet !== null) {
      expect(packet).toContain('## Top files read')
      // edited.ts belongs to the "## Edited files" section, not "## Top files read".
      const topReadSection = packet.split('## Top files read')[1] ?? ''
      expect(topReadSection).not.toContain('edited.ts')
      const readLines = packet.split('\n').filter((l) => l.startsWith('- read-'))
      expect(readLines).toHaveLength(8)
      // Highest readCount (read-9.ts, count 9) must come first.
      expect(readLines[0]).toBe('- read-9.ts')
      expect(readLines[7]).toBe('- read-2.ts')
    }
  })

  it('treats a missing/non-numeric readCount as 0 for sort purposes', async () => {
    const sessionId = 'sid-missing-readcount'
    const files = [
      { path: 'has-count.ts', wasEdited: false, readCount: 5 },
      { path: 'no-count.ts', wasEdited: false },
    ]
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files, bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    if (packet !== null) {
      const readLines = packet.split('\n').filter((l) => l.startsWith('- '))
      const countIdx = readLines.indexOf('- has-count.ts')
      const noCountIdx = readLines.indexOf('- no-count.ts')
      expect(countIdx).toBeGreaterThanOrEqual(0)
      expect(noCountIdx).toBeGreaterThan(countIdx)
    }
  })

  it('includes the git diff --stat section when runGit succeeds with non-empty output', async () => {
    runGitMock.mockReturnValue({ exitCode: 0, stdout: ' src/foo.ts | 2 +-\n', stderr: '' })
    const sessionId = 'sid-git-diff-present'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).toContain('## Uncommitted changes (git diff --stat)')
    expect(packet).toContain('src/foo.ts')
  })

  it('omits the git diff --stat section when runGit exits non-zero, even with non-empty stdout', async () => {
    // stdout is deliberately non-empty here so this isolates the exitCode check from the
    // separate empty-stdout check below -- a mutation that dropped the exitCode gate entirely
    // (leaving only the stdout-length check) would otherwise slip past undetected.
    runGitMock.mockReturnValue({ exitCode: 128, stdout: 'fatal: not a git repository', stderr: 'not a git repo' })
    const sessionId = 'sid-git-diff-error'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).not.toContain('## Uncommitted changes')
  })

  it('omits the git diff --stat section when the diff is clean (exit 0, empty stdout)', async () => {
    runGitMock.mockReturnValue({ exitCode: 0, stdout: '   \n', stderr: '' })
    const sessionId = 'sid-git-diff-clean'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).not.toContain('## Uncommitted changes')
  })

  it('never throws and omits the git section when runGit itself throws (fail-soft)', async () => {
    runGitMock.mockImplementation(() => {
      throw new Error('git not available')
    })
    const sessionId = 'sid-git-throws'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).not.toContain('## Uncommitted changes')
  })

  it('truncates to MAX_RESUME_CHARS and appends a truncation marker when the packet is oversized', async () => {
    const sessionId = 'sid-truncation'
    // Only the first 10 edited paths and 8 top-read paths ever make it into the packet, so
    // truncation has to come from the git-diff --stat section instead -- that's the one part
    // of the packet with no length cap of its own.
    runGitMock.mockReturnValue({ exitCode: 0, stdout: 'a'.repeat(9000), stderr: '' })
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    if (packet !== null) {
      expect(packet.length).toBeLessThanOrEqual(8000 + 40) // MAX_RESUME_CHARS + truncation marker slack
      expect(packet).toContain('... (truncated to cap)')
    }
  })
})

// Regression: buildResumePacket dropped the Python predecessor's entire "## Skills" section --
// a session that loaded a skill this session had zero trace of it in the resume packet, even
// though the underlying primitives (listSkills, getSkillFilePath, extractChecklistSection) were
// already fully implemented and tested, just never wired to this call site.
describe('buildResumePacket — Skills section', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const tempDir = path.resolve(__dirname, '.temp-resume-skills-test')

  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(tempDir, { recursive: true })
    setSkillOutputsDirForTesting(tempDir)
  })

  afterEach(() => {
    setSkillOutputsDirForTesting(null)
  })

  it('includes a checklist extracted from a skill loaded this session', async () => {
    const sessionId = 'sid-skills-checklist'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const skillSourcePath = path.join(tempDir, 'my-skill.md')
    const skillBody = [
      '# My Skill',
      '',
      '## Checklist',
      '- Step one',
      '- Step two',
      '',
      '## Other section',
      'Not part of the checklist.',
    ].join('\n')
    await fs.writeFile(skillSourcePath, skillBody, 'utf-8')
    await storeOutput(sessionId, 'my-skill', skillBody, { sourcePath: skillSourcePath })

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).toContain('## Skills')
    expect(packet).toContain('my-skill')
    expect(packet).toContain('Step one')
    expect(packet).toContain('Step two')
    expect(packet).not.toContain('Not part of the checklist')
  })

  it('falls back to a skill-body pointer when the skill has no extractable checklist section', async () => {
    const sessionId = 'sid-skills-no-checklist'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const skillSourcePath = path.join(tempDir, 'plain-skill.md')
    const skillBody = '# Plain Skill\n\nJust prose, no checklist heading.\n'
    await fs.writeFile(skillSourcePath, skillBody, 'utf-8')
    await storeOutput(sessionId, 'plain-skill', skillBody, { sourcePath: skillSourcePath })

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).toContain('## Skills')
    expect(packet).toContain('plain-skill')
    expect(packet).toContain('token-goat skill-body plain-skill --section DoD')
  })

  it('omits the Skills section entirely when no skill was loaded this session', async () => {
    const sessionId = 'sid-skills-none'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)

    const packet = await buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    expect(packet).not.toContain('## Skills')
  })
})
