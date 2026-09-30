/** `token-goat stats --payloads`: the measured blocks agree with what the session_start hook and the installer actually produce, and the note probe counts only reads made after a note was set. The isolated TOKEN_GOAT_HOME from tests/setup/isolate-home.ts holds the notes store and config; CLAUDE_CONFIG_DIR points the installed CLAUDE.md and skill at a temp directory, so nothing here touches the real ~/.claude. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { measurePayloads, namedFiles, probeNotes, renderPayloads, type PayloadReport } from '../src/cli_payloads.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { recordEvidence } from '../src/evidence_cache.js'
import type { HookEvent } from '../src/hook_registry.js'
import { sessionStartHandler } from '../src/hooks_session_start.js'
import { installClaudeMd, installedClaudeMdBlock, installSkill } from '../src/install.js'
import { findProject } from '../src/project.js'
import { memoryPath } from '../src/project_memory.js'
import { clearModuleCaches } from '../src/reset.js'
import { runSpawned } from './helpers/batch-cli.js'
import { tempDir } from './helpers/temp-config.js'

let claudeDir: string

beforeEach(() => {
  claudeDir = tempDir()
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir)
  clearModuleCaches()
  saveConfig(defaultConfig())
  invalidateConfigCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  saveConfig(defaultConfig())
  invalidateConfigCache()
})

/** A project root (package.json marker) holding `files`, each created with a line of content. */
function project(files: readonly string[]): { root: string; hash: string } {
  const root = path.join(tempDir(), 'proj')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), 'x\n')
  }
  const found = findProject(root)
  if (found === null) throw new Error(`no project found at ${root}`)
  return { root: found.root, hash: found.hash }
}

/** Write the notes store directly, in the format project_memory.ts::saveEntries writes: a `# set <ISO>` comment dates the entry line after it. */
function writeNotes(hash: string, notes: ReadonlyArray<{ key: string; value: string; setAt?: string }>): void {
  const lines: string[] = []
  for (const n of notes) {
    if (n.setAt !== undefined) lines.push(`# set ${n.setAt}`)
    lines.push(`${n.key} = ${JSON.stringify(n.value)}`)
  }
  fs.mkdirSync(path.dirname(memoryPath(hash)), { recursive: true })
  fs.writeFileSync(memoryPath(hash), `${lines.join('\n')}\n`)
}

function sessionEvent(cwd: string): HookEvent {
  return { eventName: 'session_start', toolName: undefined, toolInput: {}, sessionId: 'payloads-test', agentId: undefined, raw: { cwd } }
}

describe('namedFiles', () => {
  // HAND-DERIVED: which of these mentions name a file that exists under the root follows from the fixture alone.
  it('resolves the existing files a note names, drops the ::symbol and :line suffix, dedupes, and refuses anything outside the root', () => {
    const { root } = project(['src/a.ts', 'docs/b.md'])
    fs.writeFileSync(path.join(path.dirname(root), 'outside.ts'), 'x\n')
    const value = 'see src/a.ts::foo and `docs/b.md`, again src/a.ts:12, not ../outside.ts or missing.ts'
    expect(namedFiles(value, root)).toEqual([path.join(root, 'src', 'a.ts'), path.join(root, 'docs', 'b.md')])
    // A dotted symbol makes the whole `file::Class.method` one path-shaped token, so the suffix has to come off before the file resolves.
    expect(namedFiles('see docs/b.md::Setup.steps', root)).toEqual([path.join(root, 'docs', 'b.md')])
  })

  // HAND-DERIVED: an absolute path counts only while it stays under the root.
  it('accepts an absolute path under the root and rejects one outside it', () => {
    const { root } = project(['src/a.ts'])
    const outside = path.join(path.dirname(root), 'outside.ts')
    fs.writeFileSync(outside, 'x\n')
    expect(namedFiles(`${path.join(root, 'src', 'a.ts')} and ${outside}`, root)).toEqual([path.join(root, 'src', 'a.ts')])
  })

  // HAND-DERIVED: a directory is not a file, and a note with no path in it names nothing.
  it('names nothing for a directory or plain prose', () => {
    const { root } = project(['src/a.ts'])
    fs.mkdirSync(path.join(root, 'lib.d'))
    expect(namedFiles('lib.d holds nothing; the registry pins the version', root)).toEqual([])
  })
})

describe('probeNotes', () => {
  // HAND-DERIVED: session files in the format src/session_store.ts writes ({files: [{path, readCount, lastReadAt}]}); the expected split follows from comparing each lastReadAt with each note's set time.
  it('counts a named file only when a session read it after its note was set, and an undated note as read by none', () => {
    const { root, hash } = project(['src/a.ts', 'docs/b.md'])
    const a = path.join(root, 'src', 'a.ts')
    const b = path.join(root, 'docs', 'b.md')
    writeNotes(hash, [
      { key: 'dated', value: 'src/a.ts and docs/b.md', setAt: '2026-01-01T00:00:00.000Z' },
      { key: 'undated', value: 'src/a.ts' },
      { key: 'prose', value: 'no files here', setAt: '2026-01-01T00:00:00.000Z' },
    ])
    const sessions = tempDir()
    fs.writeFileSync(
      path.join(sessions, 's1.json'),
      JSON.stringify({ files: [
        { path: a, readCount: 1, lastReadAt: Date.parse('2026-01-02T00:00:00.000Z') },
        { path: b, readCount: 1, lastReadAt: Date.parse('2025-12-31T00:00:00.000Z') },
      ] }),
    )
    fs.writeFileSync(path.join(sessions, 'broken.json'), '{not json')
    expect(probeNotes(hash, root, sessions)).toEqual([
      { key: 'dated', setAt: '2026-01-01T00:00:00.000Z', named: [a, b], readAfter: [a] },
      { key: 'undated', setAt: null, named: [a], readAfter: [] },
    ])
  })

  // HAND-DERIVED: the latest read across sessions is the one compared, so an early read in one session does not hide a later read in another. The late read sits between two early ones in name order, so neither "first file wins" nor "last file wins" can pass by listing order.
  it('takes the latest read of a file across every session', () => {
    const { root, hash } = project(['src/a.ts'])
    const a = path.join(root, 'src', 'a.ts')
    writeNotes(hash, [{ key: 'k', value: 'src/a.ts', setAt: '2026-01-01T00:00:00.000Z' }])
    const sessions = tempDir()
    fs.writeFileSync(path.join(sessions, 'a-early.json'), JSON.stringify({ files: [{ path: a, readCount: 1, lastReadAt: Date.parse('2025-06-01T00:00:00.000Z') }] }))
    fs.writeFileSync(path.join(sessions, 'b-late.json'), JSON.stringify({ files: [{ path: a, readCount: 1, lastReadAt: Date.parse('2026-01-05T00:00:00.000Z') }] }))
    fs.writeFileSync(path.join(sessions, 'c-early.json'), JSON.stringify({ files: [{ path: a, readCount: 1, lastReadAt: Date.parse('2025-07-01T00:00:00.000Z') }] }))
    expect(probeNotes(hash, root, sessions)[0]?.readAfter).toEqual([a])
  })
})

describe('installedClaudeMdBlock', () => {
  // FORMAT-DERIVED: the block is written by the shipping installer (src/install.ts::installClaudeMd), not by this test.
  it('returns the block installClaudeMd wrote, markers included, and nothing of the user text around it', () => {
    const p = path.join(claudeDir, 'CLAUDE.md')
    expect(installedClaudeMdBlock()).toBeNull()
    fs.writeFileSync(p, '# Mine\n\nuser text\n')
    expect(installedClaudeMdBlock()).toBeNull()
    installClaudeMd()
    fs.appendFileSync(p, '\ntrailing user text\n')
    const block = installedClaudeMdBlock()
    expect(block).not.toBeNull()
    expect(block!.startsWith('<!-- token-goat-begin -->')).toBe(true)
    expect(block!.endsWith('<!-- token-goat-end -->')).toBe(true)
    expect(block).not.toContain('user text')
    expect(fs.readFileSync(p, 'utf8')).toContain(block!)
  })

  // HAND-DERIVED: a begin marker with no end marker after it is not a block.
  it('returns null when the end marker is missing', () => {
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '<!-- token-goat-begin -->\nhalf a block\n')
    expect(installedClaudeMdBlock()).toBeNull()
  })

  // HAND-DERIVED: user text that quotes the end marker above the block must not cut the block short; the end is searched for after the begin marker.
  it('ignores an end marker that appears before the block', () => {
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'I once pasted <!-- token-goat-end --> here.\n')
    installClaudeMd()
    const block = installedClaudeMdBlock()
    expect(block?.startsWith('<!-- token-goat-begin -->')).toBe(true)
    expect(block?.endsWith('<!-- token-goat-end -->')).toBe(true)
    expect(block!.length).toBeGreaterThan(100)
  })
})

describe('measurePayloads', () => {
  // FORMAT-DERIVED: the reference is the shipping session_start hook's own output for the same project, so the total is checked against the text a session actually receives.
  it('totals exactly the context the session_start hook injects, reminder and notes together', async () => {
    const { root, hash } = project(['src/a.ts'])
    writeNotes(hash, [{ key: 'where', value: 'the parser lives in src/a.ts', setAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }])
    const result = await sessionStartHandler(sessionEvent(root))
    if (result.hookType !== 'context') throw new Error(`expected context, got ${result.hookType}`)
    const report = measurePayloads(root, tempDir())
    expect(report.sessionStartTotal.chars).toBe(result.context.length)
    expect(report.sessionStartTotal.tokens).toBe(Math.round(Buffer.byteLength(result.context, 'utf8') / 4))
    expect(report.sessionStart.map((b) => b.name)).toEqual(['routing reminder', 'project notes', 'evidence delta'])
    expect(report.sessionStart[0]?.chars).not.toBeNull()
    expect(report.sessionStart[1]?.note).toBe('1 note, every session start')
    expect(report.sessionStart[2]?.chars).toBeNull()
    expect(report.projectRoot).toBe(root)
  })

  // FORMAT-DERIVED: same reference, with cached evidence whose source has since changed (the fixture shape tests/hooks_session_start.test.ts uses), so the delta capsule is part of both texts.
  it('counts the evidence delta capsule when cached evidence went stale, matching the hook', async () => {
    const { root } = project(['src/a.ts'])
    const source = path.join(root, 'src', 'a.ts')
    recordEvidence({ projectRoot: root, source, representation: 'file', text: 'an older body\n' })
    const result = await sessionStartHandler(sessionEvent(root))
    if (result.hookType !== 'context') throw new Error(`expected context, got ${result.hookType}`)
    expect(result.context).toContain('Cross-session evidence changed since it was cached')
    const report = measurePayloads(root, tempDir())
    expect(report.sessionStart[2]?.chars).toBeGreaterThan(0)
    expect(report.sessionStartTotal.chars).toBe(result.context.length)
  })

  // FORMAT-DERIVED: same reference, with the reminder turned off, where the hook emits the notes alone.
  it('counts no reminder when hints.session_start_reminder is off, matching the hook', async () => {
    const { root, hash } = project(['src/a.ts'])
    writeNotes(hash, [{ key: 'where', value: 'src/a.ts', setAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }])
    const cfg = defaultConfig()
    cfg.hints.session_start_reminder = false
    saveConfig(cfg)
    invalidateConfigCache()
    const result = await sessionStartHandler(sessionEvent(root))
    if (result.hookType !== 'context') throw new Error(`expected context, got ${result.hookType}`)
    const report = measurePayloads(root, tempDir())
    expect(report.sessionStart[0]).toMatchObject({ chars: null, note: 'off (hints.session_start_reminder = false)' })
    expect(report.sessionStartTotal.chars).toBe(result.context.length)
  })

  // FORMAT-DERIVED: the installed rows measure what installClaudeMd and installSkill wrote.
  it('measures the installed CLAUDE.md block, and reports both installed rows absent before an install', () => {
    const { root } = project([])
    const before = measurePayloads(root, tempDir())
    expect(before.installed.map((b) => b.chars)).toEqual([null, null])
    installClaudeMd()
    installSkill()
    const after = measurePayloads(root, tempDir())
    expect(after.installed[0]?.chars).toBe(installedClaudeMdBlock()!.length)
    expect(after.installed[1]?.chars).toBeGreaterThan(0)
  })

  // HAND-DERIVED: the manifest cap is the configured max_manifest_chars, and turning compaction assist off removes it.
  it('reports the compaction manifest cap from config', () => {
    const { root } = project([])
    const cfg = defaultConfig()
    cfg.compact_assist.max_manifest_chars = 2000
    saveConfig(cfg)
    invalidateConfigCache()
    expect(measurePayloads(root, tempDir()).afterCompaction[0]).toMatchObject({ chars: 2000, tokens: 500 })
    cfg.compact_assist.enabled = false
    saveConfig(cfg)
    invalidateConfigCache()
    expect(measurePayloads(root, tempDir()).afterCompaction[0]?.chars).toBeNull()
  })
})

describe('renderPayloads', () => {
  // HAND-DERIVED: the summary line sums the per-note counts of the report below.
  it('summarises the note probe and pluralises per note', () => {
    const empty = { name: 'x', chars: null, tokens: null, note: 'n' }
    const report: PayloadReport = {
      projectRoot: '/p',
      sessionStart: [empty],
      sessionStartTotal: { chars: 0, tokens: 0 },
      installed: [],
      afterCompaction: [],
      notes: [
        { key: 'dated', setAt: '2026-01-01T00:00:00.000Z', named: ['/p/a', '/p/b'], readAfter: ['/p/a'] },
        { key: 'undated', setAt: null, named: ['/p/a'], readAfter: [] },
      ],
    }
    const text = renderPayloads(report)
    expect(text).toContain('Notes that name files: 2. Named files read after their note was set: 1 of 3.')
    expect(text).toContain('  dated: 1 of 2 named files read since (set 2026-01-01T00:00:00.000Z)')
    expect(text).toContain('  undated: 0 of 1 named file read since (undated)')
  })
})

describe('stats --payloads (built bundle)', () => {
  afterAll(() => vi.unstubAllEnvs())

  // CAPTURE: the shipping bundle run as a user runs it, from inside a project, human and --json forms.
  it('prints the report and its JSON form from the shipping bundle', () => {
    const { root, hash } = project(['src/a.ts'])
    writeNotes(hash, [{ key: 'where', value: 'src/a.ts', setAt: '2026-01-01T00:00:00.000Z' }])
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }
    const human = runSpawned(['stats', '--payloads'], { cwd: root, env })
    expect(human.status, human.stderr).toBe(0)
    expect(human.stdout).toContain('# token-goat context payloads')
    expect(human.stdout).toContain('routing reminder')
    expect(human.stdout).toContain('where: 0 of 1 named file read since (set 2026-01-01T00:00:00.000Z)')
    const json = runSpawned(['stats', '--payloads', '--json'], { cwd: root, env })
    expect(json.status, json.stderr).toBe(0)
    const parsed = JSON.parse(json.stdout) as PayloadReport
    expect(parsed.sessionStart.map((b) => b.name)).toEqual(['routing reminder', 'project notes', 'evidence delta'])
    expect(parsed.notes.map((n) => n.key)).toEqual(['where'])
  })
})
