// A handoff must be found again however its project root is spelled, and content a live handoff names must outlive the cache's age rule.

// CAPTURE: the two ids and their root spellings below are two real stored handoffs read from a user's content store (name r3-wiki-folds, same text, created five hours apart): tg_handoff_b90e697d562f5a99 recorded projectRoot "c:/Projects/claude-agents" and tg_handoff_52172d6e07a8a7aa recorded projectRoot "C:\Projects\claude-agents". The flip came from findProject returning null for a directory holding three nested repositories (REPO_CONTAINER_THRESHOLD in src/project.ts), which switched the root from the canonical form to path.resolve's form. HAND-DERIVED: the Windows rows spell one directory the way each host delivers it (Git Bash and hook payloads: lower-case drive and forward slashes, which is canonicalize's form; PowerShell cwd: upper-case drive and backslashes); the prune rows age files with utimes so no clock is waited on.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { CONTENT_MAX_BYTES, CONTENT_MAX_ITEMS, compressText, createHandoff, isContentExpired, resolveHandoff, resolveHandoffDetailed, retrieveText } from '../src/content_store.js'
import { shortFingerprint } from '../src/fingerprint.js'
import { canonicalize } from '../src/path_containment.js'
import { clearModuleCaches } from '../src/reset.js'
import { BUNDLE } from './helpers/bundle.js'

const BACKSLASH = String.fromCharCode(92)
const isWin = process.platform === 'win32'

let home: string
let envRoot: string
let projectDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME']) saved[key] = process.env[key]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-root-'))
  const dataRoot = dataDirForHome(home)
  envRoot = isWin ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  // No project marker: findProject finds no root here, so the root is whatever spelling the caller delivered, which is the path the incident took.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-project-'))
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// The spelling Git Bash and hook payloads deliver, and the one a PowerShell cwd delivers.
function forwardSpelling(dir: string): string {
  return canonicalize(dir)
}
function backslashSpelling(dir: string): string {
  const forward = canonicalize(dir)
  return forward.replace(/^[a-z]:/, (drive) => drive.toUpperCase()).split('/').join(BACKSLASH)
}

function contentDir(): string {
  return path.join(home, 'content')
}

function legacyId(spelling: string, name: string): string {
  return `tg_handoff_${shortFingerprint(`${spelling}\x00${name}`)}`
}

// A record exactly as the release before this fix stored it: the id hashes the root as spelled.
function writeLegacyRecord(spelling: string, name: string, text: string, createdAt: number): { file: string; contentId: string } {
  const id = legacyId(spelling, name)
  const contentId = `tg_${shortFingerprint(text)}`
  fs.mkdirSync(contentDir(), { recursive: true })
  const file = path.join(contentDir(), `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ kind: 'handoff', id, name, projectRoot: spelling, contentId, text, createdAt }))
  return { file, contentId }
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe.skipIf(!isWin)('a handoff is found under any spelling of its root', () => {
  it('pins the real captured ids to the legacy id formula', () => {
    expect(legacyId('c:/Projects/claude-agents', 'r3-wiki-folds')).toBe('tg_handoff_b90e697d562f5a99')
    expect(legacyId(`C:${BACKSLASH}Projects${BACKSLASH}claude-agents`, 'r3-wiki-folds')).toBe('tg_handoff_52172d6e07a8a7aa')
  })

  it('resolves a handoff created under the forward-slash spelling from the backslash spelling', () => {
    createHandoff('notes', 'decided under git bash', forwardSpelling(projectDir))
    expect(resolveHandoff('notes', { projectRoot: backslashSpelling(projectDir), full: true })).toBe('decided under git bash')
  })

  it('resolves a handoff created under the backslash spelling from the forward-slash spelling', () => {
    createHandoff('notes', 'decided under powershell', backslashSpelling(projectDir))
    expect(resolveHandoff('notes', { projectRoot: forwardSpelling(projectDir), full: true })).toBe('decided under powershell')
  })

  it('stores both spellings under one id', () => {
    const a = createHandoff('notes', 'one', forwardSpelling(projectDir))
    const b = createHandoff('notes', 'two', backslashSpelling(projectDir))
    expect(b.id).toBe(a.id)
    expect(fs.readdirSync(contentDir()).filter((f) => f.startsWith('tg_handoff_'))).toHaveLength(1)
    expect(resolveHandoff('notes', { projectRoot: projectDir, full: true })).toBe('two')
  })

  it('resolves a record stored under the legacy forward-slash spelling', () => {
    writeLegacyRecord(forwardSpelling(projectDir), 'old-notes', 'stored by the previous release', Date.now())
    expect(resolveHandoff('old-notes', { projectRoot: backslashSpelling(projectDir), full: true })).toBe('stored by the previous release')
  })

  it('resolves a record stored under the legacy backslash spelling from the forward-slash spelling', () => {
    writeLegacyRecord(backslashSpelling(projectDir), 'old-notes', 'stored after the root flipped', Date.now())
    expect(resolveHandoff('old-notes', { projectRoot: forwardSpelling(projectDir), full: true })).toBe('stored after the root flipped')
  })

  it('does not hand a legacy record of another directory to this one', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-other-'))
    try {
      writeLegacyRecord(forwardSpelling(other), 'old-notes', 'belongs elsewhere', Date.now())
      expect(resolveHandoff('old-notes', { projectRoot: projectDir })).toBeNull()
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!isWin)('the same name under two spellings', () => {
  it('returns the newer stored copy when the current id holds it, and leaves the older record untouched', () => {
    const legacy = writeLegacyRecord(forwardSpelling(projectDir), 'r3-await', 'the old text', Date.now() - 60_000)
    const before = { bytes: fs.readFileSync(legacy.file, 'utf8'), mtimeMs: fs.statSync(legacy.file).mtimeMs }
    createHandoff('r3-await', 'the new text', backslashSpelling(projectDir))
    const resolved = resolveHandoffDetailed('r3-await', { projectRoot: projectDir, full: true })
    expect(resolved?.result).toBe('the new text')
    expect(resolved?.olderCopies).toEqual([{ createdAt: expect.any(Number), contentId: legacy.contentId }])
    expect(fs.readFileSync(legacy.file, 'utf8')).toBe(before.bytes)
    expect(fs.statSync(legacy.file).mtimeMs).toBe(before.mtimeMs)
  })

  it('returns the legacy copy when its stored timestamp is the newer one', () => {
    createHandoff('r3-await', 'the current-id text', forwardSpelling(projectDir))
    const legacy = writeLegacyRecord(forwardSpelling(projectDir), 'r3-await', 'the newer legacy text', Date.now() + 60_000)
    const resolved = resolveHandoffDetailed('r3-await', { projectRoot: projectDir, full: true })
    expect(resolved?.result).toBe('the newer legacy text')
    expect(resolved?.olderCopies).toHaveLength(1)
    expect(fs.existsSync(legacy.file)).toBe(true)
  })

  it('reports no older copy when both hold the same text', () => {
    writeLegacyRecord(forwardSpelling(projectDir), 'same', 'identical', Date.now() - 60_000)
    createHandoff('same', 'identical', projectDir)
    expect(resolveHandoffDetailed('same', { projectRoot: projectDir, full: true })?.olderCopies).toEqual([])
  })

  it('prints the winner alone on stdout and the older copy on one stderr line, through the built bundle', () => {
    const legacy = writeLegacyRecord(forwardSpelling(projectDir), 'r3-queue', 'the old queue', Date.now() - 60_000)
    const created = runCli(['handoff-create', 'r3-queue', 'the new queue'], projectDir)
    expect(created.status, created.stderr).toBe(0)
    const resolved = runCli(['handoff-resolve', '--full', 'r3-queue'], projectDir)
    expect(resolved.status, resolved.stderr).toBe(0)
    expect(resolved.stdout.trim()).toBe('the new queue')
    const notes = resolved.stderr.split('\n').filter((line) => line.includes('older copy'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`token-goat retrieve "${legacy.contentId}"`)
  })
})

describe.skipIf(!isWin)('the incident through the built bundle', () => {
  it('still resolves after the project directory starts to look like a container of repositories', () => {
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}\n')
    const created = runCli(['handoff-create', 'r3-fin-notes', 'written while the root was a project'], projectDir)
    expect(created.status, created.stderr).toBe(0)
    for (const nested of ['a', 'b', 'c']) fs.mkdirSync(path.join(projectDir, `anchor-${nested}`, '.git'), { recursive: true })
    const resolved = runCli(['handoff-resolve', '--full', 'r3-fin-notes'], projectDir)
    expect(resolved.status, resolved.stderr).toBe(0)
    expect(resolved.stdout.trim()).toBe('written while the root was a project')
  })
})

// Age a blob without waiting: the cache's age rule reads the file's mtime.
function setMtime(id: string, when: number): void {
  const t = new Date(when)
  fs.utimesSync(path.join(contentDir(), `${id}.json`), t, t)
}

function contentFiles(): string[] {
  return fs.readdirSync(contentDir()).filter((file) => file.endsWith('.json'))
}

// A handoff whose content blob is the oldest thing in the cache while the record that holds the text is the newest, so the normal eviction order takes the blob first and leaves the record.
function createHandoffWithOldestBlob(): { contentId: string; text: string } {
  const text = 'the plan, written once and stored in full by the handoff'
  const handoff = createHandoff('plan', text, projectDir)
  setMtime(handoff.contentId, Date.now() - 2 * 3600 * 1000)
  setMtime(handoff.id, Date.now() + 3600 * 1000)
  return { contentId: handoff.contentId, text }
}

describe('content a handoff names gets no exemption from the cache rules', () => {
  // HAND-DERIVED: CONTENT_MAX_ITEMS - 1 fillers plus the handoff's record and blob make one more file than the count budget, so exactly the oldest one (the blob, two hours old) is evicted.
  it('evicts by the normal order at the count budget and still answers retrieve from the handoff', () => {
    const { contentId, text } = createHandoffWithOldestBlob()
    for (let i = 0; i < CONTENT_MAX_ITEMS - 1; i++) compressText(`filler ${i}`)

    expect(contentFiles().length).toBe(CONTENT_MAX_ITEMS)
    expect(fs.existsSync(path.join(contentDir(), `${contentId}.json`))).toBe(false)
    expect(retrieveText(contentId)).toBe(text)
  })

  // HAND-DERIVED: 70 fillers of 480000 characters weigh about 33.6 MB, above the 32 MiB (33554432 byte) budget, so the prune must evict; the two-hour-old blob is first in line.
  it('evicts by the normal order at the byte budget and still answers retrieve from the handoff', () => {
    const { contentId, text } = createHandoffWithOldestBlob()
    for (let i = 0; i < 70; i++) compressText(`${String(i).padStart(4, '0')}${'x'.repeat(480_000)}`)

    const total = contentFiles().reduce((sum, file) => sum + fs.statSync(path.join(contentDir(), file)).size, 0)
    expect(total).toBeLessThanOrEqual(CONTENT_MAX_BYTES)
    expect(fs.existsSync(path.join(contentDir(), `${contentId}.json`))).toBe(false)
    expect(retrieveText(contentId)).toBe(text)
  })

  it('answers retrieve of the handoff contentId from the handoff once the blob is past the age limit', () => {
    const { contentId, text } = createHandoffWithOldestBlob()
    setMtime(contentId, Date.now() - 48 * 3600 * 1000)

    expect(retrieveText(contentId)).toBe(text)
    expect(isContentExpired(contentId)).toBe(false)
  })

  it('lets an id merely quoted in a handoff text expire on the normal rules', () => {
    const quoted = compressText('content quoted in the handoff text')
    createHandoff('refs', `see ${quoted.id} for the table`, projectDir)
    setMtime(quoted.id, Date.now() - 48 * 3600 * 1000)

    expect(retrieveText(quoted.id)).toBeNull()
    expect(isContentExpired(quoted.id)).toBe(true)
    compressText('a later write that runs the prune')
    expect(fs.existsSync(path.join(contentDir(), `${quoted.id}.json`))).toBe(false)
  })

  it('says through the built bundle that an aged quoted id expired, and not so for an id never stored', () => {
    const quoted = runCli(['compress-text', 'content a handoff quotes'], projectDir)
    expect(quoted.status, quoted.stderr).toBe(0)
    const quotedId = /tg_[0-9a-f]{16}/.exec(quoted.stdout)?.[0] as string
    expect(runCli(['handoff-create', 'refs', `see ${quotedId}`], projectDir).status).toBe(0)
    setMtime(quotedId, Date.now() - 48 * 3600 * 1000)

    const expired = runCli(['retrieve', quotedId], projectDir)
    expect(expired.status).not.toBe(0)
    expect(expired.stderr).toContain(`${quotedId} expired`)
    const never = runCli(['retrieve', 'tg_0000000000000000'], projectDir)
    expect(never.status).not.toBe(0)
    expect(never.stderr).toContain('no token-goat content for id: tg_0000000000000000')
    expect(never.stderr).not.toContain('expired:')
  })
})

describe('a stored handoff record is validated when it is loaded', () => {
  function tamper(handoffId: string, change: Record<string, unknown>): void {
    const file = path.join(contentDir(), `${handoffId}.json`)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(file, JSON.stringify({ ...record, ...change }))
  }

  // HAND-DERIVED: each value is outside what createHandoff stores (tg_ plus 16 hex digits; a createdAt that new Date accepts, at most 8.64e15 ms from the epoch).
  it.each([
    ['a contentId that is not an id', { contentId: 'tg_ not an id' }],
    ['a contentId with control characters', { contentId: 'tg_0123456789abcdef\u001b[31m' }],
    ['a createdAt past the Date range', { createdAt: 1e20 }],
    ['a createdAt that is a string', { createdAt: '2026-10-18' }],
    ['a missing createdAt', { createdAt: undefined }],
  ])('skips a record with %s like a corrupt one', (_label, change) => {
    const handoff = createHandoff('plan', 'text of the plan', projectDir)
    expect(resolveHandoff('plan', { projectRoot: projectDir, full: true })).toBe('text of the plan')
    tamper(handoff.id, change)

    expect(resolveHandoff('plan', { projectRoot: projectDir, full: true })).toBeNull()
  })

  it.skipIf(!isWin)('resolves from the current record without a note when a legacy copy carries a createdAt past the Date range', () => {
    createHandoff('plan', 'the current text', projectDir)
    const legacy = writeLegacyRecord(backslashSpelling(projectDir), 'plan', 'an older text', 1e20)

    const resolved = resolveHandoffDetailed('plan', { projectRoot: projectDir, full: true })
    expect(resolved?.result).toBe('the current text')
    expect(resolved?.olderCopies).toEqual([])
    expect(fs.existsSync(legacy.file)).toBe(true)
  })
})
