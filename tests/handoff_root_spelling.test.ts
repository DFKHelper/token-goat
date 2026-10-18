// What this file proves about where a handoff is stored and read back: a root spelled differently (slashes, drive case, a link, the long-path prefix, a link whose target is gone) finds its own project's records and never another project's; an older copy under a previous spelling is reported; content a handoff names takes part in the normal eviction and age rules with no exemption; a loaded record is validated; an aged-out handoff is told apart from one never created; roots that differ only by a non-ASCII case variant stay two projects.

// CAPTURE: the two ids and their root spellings below are two real stored handoffs read from a user's content store (name r3-wiki-folds, same text, created five hours apart): tg_handoff_b90e697d562f5a99 recorded projectRoot "c:/Projects/claude-agents" and tg_handoff_52172d6e07a8a7aa recorded projectRoot "C:\Projects\claude-agents". The flip came from findProject returning null for a directory holding three nested repositories (REPO_CONTAINER_THRESHOLD in src/project.ts), which switched the root from the canonical form to path.resolve's form. HAND-DERIVED: the Windows rows spell one directory the way each host delivers it (Git Bash and hook payloads: lower-case drive and forward slashes, which is canonicalize's form; PowerShell cwd: upper-case drive and backslashes); the prune rows age files with utimes so no clock is waited on.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { CONTENT_MAX_BYTES, CONTENT_MAX_ITEMS, compressText, createHandoff, describeMissingHandoff, describeUnreadableContent, isContentExpired, resolveHandoff, resolveHandoffDetailed, retrieveText, unreadableRecordNote } from '../src/content_store.js'
import { shortFingerprint } from '../src/fingerprint.js'
import { canonicalize } from '../src/path_containment.js'
import { clearModuleCaches } from '../src/reset.js'
import { BUNDLE } from './helpers/bundle.js'
import { runTeardown } from './helpers/strict_teardown.js'

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
  runTeardown([() => fs.rmSync(home, { recursive: true, force: true }), () => fs.rmSync(projectDir, { recursive: true, force: true })])
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

// A record exactly as the release before this fix stored it: the id hashes the root as spelled. FORMAT-DERIVED: shape read off origin/main 3913ac9c2, src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled).
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

  // HAND-DERIVED: the two spellings are one directory written the way each host delivers it (see the file header); the expected text is the one just stored.
  it('resolves a handoff created under the forward-slash spelling from the backslash spelling', () => {
    createHandoff('notes', 'decided under git bash', forwardSpelling(projectDir))
    expect(resolveHandoff('notes', { projectRoot: backslashSpelling(projectDir), full: true })).toBe('decided under git bash')
  })

  // HAND-DERIVED: the two spellings are one directory written the way each host delivers it (see the file header); the expected text is the one just stored.
  it('resolves a handoff created under the backslash spelling from the forward-slash spelling', () => {
    createHandoff('notes', 'decided under powershell', backslashSpelling(projectDir))
    expect(resolveHandoff('notes', { projectRoot: forwardSpelling(projectDir), full: true })).toBe('decided under powershell')
  })

  // HAND-DERIVED: the two spellings are one directory written the way each host delivers it (see the file header); the expected text is the one just stored.
  it('stores both spellings under one id', () => {
    const a = createHandoff('notes', 'one', forwardSpelling(projectDir))
    const b = createHandoff('notes', 'two', backslashSpelling(projectDir))
    expect(b.id).toBe(a.id)
    expect(fs.readdirSync(contentDir()).filter((f) => f.startsWith('tg_handoff_'))).toHaveLength(1)
    expect(resolveHandoff('notes', { projectRoot: projectDir, full: true })).toBe('two')
  })

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it('resolves a record stored under the legacy forward-slash spelling', () => {
    writeLegacyRecord(forwardSpelling(projectDir), 'old-notes', 'stored by the previous release', Date.now())
    expect(resolveHandoff('old-notes', { projectRoot: backslashSpelling(projectDir), full: true })).toBe('stored by the previous release')
  })

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it('resolves a record stored under the legacy backslash spelling from the forward-slash spelling', () => {
    writeLegacyRecord(backslashSpelling(projectDir), 'old-notes', 'stored after the root flipped', Date.now())
    expect(resolveHandoff('old-notes', { projectRoot: forwardSpelling(projectDir), full: true })).toBe('stored after the root flipped')
  })
})

describe.skipIf(!isWin)('the same name under two spellings', () => {
  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
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

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it('returns the legacy copy when its stored timestamp is the newer one', () => {
    createHandoff('r3-await', 'the current-id text', forwardSpelling(projectDir))
    const legacy = writeLegacyRecord(forwardSpelling(projectDir), 'r3-await', 'the newer legacy text', Date.now() + 60_000)
    const resolved = resolveHandoffDetailed('r3-await', { projectRoot: projectDir, full: true })
    expect(resolved?.result).toBe('the newer legacy text')
    expect(resolved?.olderCopies).toHaveLength(1)
    expect(fs.existsSync(legacy.file)).toBe(true)
  })

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it('reports no older copy when both hold the same text', () => {
    writeLegacyRecord(forwardSpelling(projectDir), 'same', 'identical', Date.now() - 60_000)
    createHandoff('same', 'identical', projectDir)
    expect(resolveHandoffDetailed('same', { projectRoot: projectDir, full: true })?.olderCopies).toEqual([])
  })

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
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
  // HAND-DERIVED: the root first holds a package.json, then three nested repositories, the change the CAPTURE in the file header names; the expected text is what was stored.
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

// Layout under projectDir: root-a is the real directory, root-ab a sibling whose name starts with it, link-root a link to root-a. The previous release hashed the root as the cwd spelled it, so a handoff made from root-a sits at the id of root-a's spelling while a lookup from link-root computes link-root's id first; a junction stands in for the symlink on Windows, where a symlink needs a privilege.
function linkedRoots(): { real: string; sibling: string; link: string } {
  const real = path.join(projectDir, 'root-a')
  const sibling = path.join(projectDir, 'root-ab')
  const link = path.join(projectDir, 'link-root')
  fs.mkdirSync(real)
  fs.mkdirSync(sibling)
  fs.symlinkSync(real, link, isWin ? 'junction' : 'dir')
  return { real, sibling, link }
}

type LinkedRoots = ReturnType<typeof linkedRoots>

// A record at the id of root-a's resolved spelling, carrying the projectRoot given, as the previous release would have written one. FORMAT-DERIVED: shape read off origin/main 3913ac9c2, src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled).
function plantAtResolvedId(roots: LinkedRoots, projectRoot: string, text: string): void {
  const id = legacyId(canonicalize(fs.realpathSync.native(roots.real)), 'plan')
  fs.mkdirSync(contentDir(), { recursive: true })
  fs.writeFileSync(
    path.join(contentDir(), `${id}.json`),
    JSON.stringify({ kind: 'handoff', id, name: 'plan', projectRoot, contentId: `tg_${shortFingerprint(text)}`, text, createdAt: Date.now() }),
  )
}

describe('a handoff stored under the resolved spelling of a linked root', () => {
  // HAND-DERIVED: the stored record is built the way the previous release wrote it (writeLegacyRecord: id hashed from the spelling, projectRoot the same spelling); which copy wins follows from the two createdAt numbers.
  it('is found from the link, because the key of the record own projectRoot is the key of the link target', () => {
    const { real, link } = linkedRoots()
    writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'written from the real path', Date.now())

    expect(resolveHandoff('plan', { projectRoot: link, full: true })).toBe('written from the real path')
  })

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it('returns the newer copy when the stored copy under the resolved spelling is newer, and notes the older one', () => {
    const { real, link } = linkedRoots()
    createHandoff('plan', 'written from the link', link)
    const legacy = writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'written from the real path', Date.now() + 60_000)

    const resolved = resolveHandoffDetailed('plan', { projectRoot: link, full: true })

    expect(resolved?.result).toBe('written from the real path')
    expect(resolved?.olderCopies.map((copy) => copy.contentId)).toHaveLength(1)
    expect(fs.existsSync(legacy.file)).toBe(true)
  })

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it('returns the current copy when it is the newer one, and leaves the stored copy under the resolved spelling untouched', () => {
    const { real, link } = linkedRoots()
    createHandoff('plan', 'written from the link', link)
    const legacy = writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'written from the real path', 1)
    const before = fs.readFileSync(legacy.file, 'utf8')

    const resolved = resolveHandoffDetailed('plan', { projectRoot: link, full: true })

    expect(resolved?.result).toBe('written from the link')
    expect(resolved?.olderCopies.map((copy) => copy.contentId)).toEqual([legacy.contentId])
    expect(fs.readFileSync(legacy.file, 'utf8')).toBe(before)
  })

  // HAND-DERIVED: each row plants a record at the id this directory looks under (the resolved spelling of root-a) and varies only the projectRoot the record carries; a record belongs here only if that root names the same directory.
  it.each([
    ['a trailing separator', ({ real }: LinkedRoots) => `${real}/`, true],
    ['a dot segment', ({ real }: LinkedRoots) => `${real}/./`, true],
    ['the link itself', ({ link }: LinkedRoots) => link, true],
    ['a sibling that shares a name prefix', ({ sibling }: LinkedRoots) => sibling, false],
    ['the parent directory', ({ real }: LinkedRoots) => path.dirname(real), false],
  ])('treats a record whose projectRoot is %s correctly', (_label, carried, accepted) => {
    const roots = linkedRoots()
    plantAtResolvedId(roots, carried(roots), 'stored text')

    expect(resolveHandoff('plan', { projectRoot: roots.link, full: true })).toBe(accepted ? 'stored text' : null)
  })

  // FORMAT-DERIVED: shape read off origin/main 3913ac9c2, src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled).
  it('does not hand another project record planted at this directory legacy id to it', () => {
    const roots = linkedRoots()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-other-'))
    try {
      plantAtResolvedId(roots, other, 'belongs elsewhere')

      expect(resolveHandoff('plan', { projectRoot: roots.link, full: true })).toBeNull()
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('a root that is a link whose target was deleted', () => {
  // The other-project row plants a record at the id this root looks under, carrying another project's root.
  function danglingRoot(): string {
    const { real, link } = linkedRoots()
    fs.rmSync(real, { recursive: true })
    return link
  }

  // HAND-DERIVED: the root is a link whose target is removed after the handoff is stored; the expected text is what was stored from that same spelling.
  it('still finds a record written from the same spelling before the target went', () => {
    const { real, link } = linkedRoots()
    createHandoff('plan', 'written while the target existed', link)
    fs.rmSync(real, { recursive: true })

    expect(resolveHandoff('plan', { projectRoot: link, full: true })).toBe('written while the target existed')
  })

  // HAND-DERIVED: the root is a link whose target is removed before the handoff is stored; the expected text is what was stored from that same spelling.
  it('still finds a record written from the same spelling after the target went', () => {
    const link = danglingRoot()
    createHandoff('plan', 'written to a dangling link', link)

    expect(resolveHandoff('plan', { projectRoot: link, full: true })).toBe('written to a dangling link')
  })

  // FORMAT-DERIVED: shape read off origin/main 3913ac9c2, src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled).
  it('does not hand it another project record, and does not throw', () => {
    const link = danglingRoot()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-other-'))
    try {
      const created = createHandoff('plan', 'belongs elsewhere', link)
      const file = path.join(contentDir(), `${created.id}.json`)
      fs.writeFileSync(file, JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), projectRoot: other }))

      expect(() => resolveHandoff('plan', { projectRoot: link, full: true })).not.toThrow()
      expect(resolveHandoff('plan', { projectRoot: link, full: true })).toBeNull()
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!isWin)('the extended-length prefix of a Windows path', () => {
  const extended = (dir: string): string => `${BACKSLASH}${BACKSLASH}?${BACKSLASH}${backslashSpelling(dir)}`

  // HAND-DERIVED: the extended-length prefix is another spelling of the same path (withoutLongPathPrefix in src/content_store.ts); the two roots are built from one directory.
  it('keys a root the same with and without the prefix', () => {
    createHandoff('notes', 'made from the plain spelling', projectDir)
    expect(resolveHandoff('notes', { projectRoot: extended(projectDir), full: true })).toBe('made from the plain spelling')
  })

  // FORMAT-DERIVED: shape read off origin/main 3913ac9c2, src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled).
  it('accepts a record whose projectRoot carries the prefix', () => {
    const roots = linkedRoots()
    plantAtResolvedId(roots, extended(roots.real), 'stored text')

    expect(resolveHandoff('plan', { projectRoot: roots.link, full: true })).toBe('stored text')
  })

  // FORMAT-DERIVED: origin/main 3913ac9c2, src/content_store.ts normalizeProjectRoot (line 81) is path.resolve(projectRoot ?? cwd) then findProject(candidate)?.root ?? candidate, and handoffId (line 86) hashes that string unchanged; path_containment.ts canonicalize (line 64) keeps the prefix (it becomes //?/C:/x), so a root handed in with the prefix was keyed with it. Record shape as in writeLegacyRecord.
  it.each([
    ['the backslash form that path.resolve leaves when no marker is found', (dir: string) => extended(dir)],
    ['the forward-slash form that canonicalize leaves when a marker is found', (dir: string) => `//?/${forwardSpelling(dir)}`],
  ])('resolves a record the released store keyed under %s, from the plain and the prefixed root', (_label, spell) => {
    writeLegacyRecord(spell(projectDir), 'old-notes', 'stored under the prefix', Date.now())

    expect(resolveHandoff('old-notes', { projectRoot: projectDir, full: true })).toBe('stored under the prefix')
    expect(resolveHandoff('old-notes', { projectRoot: extended(projectDir), full: true })).toBe('stored under the prefix')
  })

  // FORMAT-DERIVED: same released code as the row above; the UNC extended spelling is //?/UNC/server/share/x (the form withoutLongPathPrefix in src/content_store.ts reads). The directory is reached through the local administrative share, and the row is skipped where that share is not reachable.
  it('resolves a record the released store keyed under the extended UNC spelling', (ctx) => {
    const forward = forwardSpelling(projectDir)
    const unc = `//localhost/${forward.slice(0, 1)}$${forward.slice(2)}`
    if (!fs.existsSync(unc)) ctx.skip()
    writeLegacyRecord(`//?/UNC/${unc.slice(2)}`, 'old-notes', 'stored under the UNC prefix', Date.now())

    expect(resolveHandoff('old-notes', { projectRoot: unc, full: true })).toBe('stored under the UNC prefix')
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

  // HAND-DERIVED: setMtime ages the file with utimes, so no clock is waited on; the outcome follows from the 24 h age rule and the ids built in the row.
  it('answers retrieve of the handoff contentId from the handoff once the blob is past the age limit', () => {
    const { contentId, text } = createHandoffWithOldestBlob()
    setMtime(contentId, Date.now() - 48 * 3600 * 1000)

    expect(retrieveText(contentId)).toBe(text)
    expect(isContentExpired(contentId)).toBe(false)
  })

  // HAND-DERIVED: setMtime ages the file with utimes, so no clock is waited on; the outcome follows from the 24 h age rule and the ids built in the row.
  it('lets an id merely quoted in a handoff text expire on the normal rules', () => {
    const quoted = compressText('content quoted in the handoff text')
    createHandoff('refs', `see ${quoted.id} for the table`, projectDir)
    setMtime(quoted.id, Date.now() - 48 * 3600 * 1000)

    expect(retrieveText(quoted.id)).toBeNull()
    expect(isContentExpired(quoted.id)).toBe(true)
    compressText('a later write that runs the prune')
    expect(fs.existsSync(path.join(contentDir(), `${quoted.id}.json`))).toBe(false)
  })

  // HAND-DERIVED: setMtime ages the file with utimes, so no clock is waited on; the outcome follows from the 24 h age rule and the ids built in the row.
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

  // FORMAT-DERIVED: the record is built the way the released store wrote it (origin/main 3913ac9c2, src/content_store.ts createHandoff: kind, id, name, projectRoot, contentId, text, createdAt; id is tg_handoff_ plus the first 16 hex of sha256 of the root, NUL, the name); which copy wins follows from the createdAt numbers.
  it.skipIf(!isWin)('resolves from the current record without a note when a legacy copy carries a createdAt past the Date range', () => {
    createHandoff('plan', 'the current text', projectDir)
    const legacy = writeLegacyRecord(backslashSpelling(projectDir), 'plan', 'an older text', 1e20)

    const resolved = resolveHandoffDetailed('plan', { projectRoot: projectDir, full: true })
    expect(resolved?.result).toBe('the current text')
    expect(resolved?.olderCopies).toEqual([])
    expect(fs.existsSync(legacy.file)).toBe(true)
  })
})

describe('a handoff that aged out is told apart from one never created', () => {
  // HAND-DERIVED: the age rule reads the record file's mtime, which is set two days back; the stored createdAt is what the message must quote.
  it('says it expired and when, for a record still on disk past the age limit', () => {
    const created = createHandoff('plan', 'old plan', projectDir)
    const file = path.join(contentDir(), `${created.id}.json`)
    const storedAt = (JSON.parse(fs.readFileSync(file, 'utf8')) as { createdAt: number }).createdAt
    setMtime(created.id, Date.now() - 48 * 3600 * 1000)

    expect(resolveHandoff('plan', { projectRoot: projectDir })).toBeNull()
    expect(describeMissingHandoff('plan', projectDir)).toContain(`expired: it was stored ${new Date(storedAt).toISOString()}`)
    expect(describeMissingHandoff('never-made', projectDir)).toBe('no local handoff named "never-made" in this project')
  })

  // HAND-DERIVED: setMtime ages the file with utimes, so no clock is waited on; the outcome follows from the 24 h age rule and the ids built in the row.
  it('says so through the built bundle, and keeps the plain message for a name never created', () => {
    expect(runCli(['handoff-create', 'plan', 'old plan'], projectDir).status).toBe(0)
    const id = fs.readdirSync(contentDir()).find((file) => file.startsWith('tg_handoff_'))?.slice(0, -5) as string
    setMtime(id, Date.now() - 48 * 3600 * 1000)

    const expired = runCli(['handoff-resolve', '--', 'plan'], projectDir)
    expect(expired.status).not.toBe(0)
    expect(expired.stderr).toContain('handoff "plan" expired: it was stored')
    const never = runCli(['handoff-resolve', '--', 'never-made'], projectDir)
    expect(never.status).not.toBe(0)
    expect(never.stderr).toContain('no local handoff named "never-made" in this project')
  })
})

// HAND-DERIVED: U+212A KELVIN SIGN lowercases to ASCII k under toLowerCase() (asserted below), while NTFS keeps work and wor+U+212A as two directories (documented in src/path_containment.ts foldCaseForContainment); the character is built with fromCodePoint, never typed.
describe('roots that differ only by a non-ASCII case variant stay two projects', () => {
  const kelvin = String.fromCodePoint(0x212a)
  let savedFold: string | undefined
  beforeEach(() => {
    savedFold = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
  })
  afterEach(() => {
    if (savedFold === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = savedFold
  })

  // HAND-DERIVED: the premise is asserted on the string itself, not on a table.
  it('premise: toLowerCase merges the two names that the file system keeps apart', () => {
    expect(`wor${kelvin}`.toLowerCase()).toBe('work')
  })

  // HAND-DERIVED: the roots are a name and its U+212A variant, not stored anywhere before the row.
  it('gives the two roots different handoff ids, whether or not the file system can hold both', () => {
    const plain = createHandoff('plan', 'in work', path.join(projectDir, 'work'))
    const variant = createHandoff('plan', 'in the Kelvin root', path.join(projectDir, `wor${kelvin}`))
    expect(variant.id).not.toBe(plain.id)
  })

  // HAND-DERIVED: one handoff is stored under work; the other root holds nothing.
  it('does not resolve a handoff made under one root from the other', (ctx) => {
    fs.mkdirSync(path.join(projectDir, 'work'))
    try {
      fs.mkdirSync(path.join(projectDir, `wor${kelvin}`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') ctx.skip('this file system folds U+212A onto k, so both directories cannot exist; the id row above covers the key')
      throw error
    }
    createHandoff('plan', 'in work', path.join(projectDir, 'work'))
    expect(resolveHandoff('plan', { projectRoot: path.join(projectDir, `wor${kelvin}`), full: true })).toBeNull()
    expect(resolveHandoff('plan', { projectRoot: path.join(projectDir, 'work'), full: true })).toBe('in work')
  })

  // HAND-DERIVED: stands in for a planted or stale record the identity check exists to reject: work's own record, written by the store under work's lookup id, then rewritten so its projectRoot names the Kelvin sibling; only the record's own root can make it belong to work.
  it('rejects a record under work lookup id whose projectRoot names the Kelvin sibling', (ctx) => {
    const work = path.join(projectDir, 'work')
    const sibling = path.join(projectDir, `wor${kelvin}`)
    fs.mkdirSync(work)
    try {
      fs.mkdirSync(sibling)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') ctx.skip('this file system folds U+212A onto k, so both directories cannot exist; the id row above covers the key')
      throw error
    }
    const entries = fs.readdirSync(projectDir)
    if (!entries.includes('work') || !entries.includes(`wor${kelvin}`)) ctx.skip('this file system did not keep work and wor + U+212A as two directory entries, so the identity check cannot be told apart from a fold')
    const handoff = createHandoff('plan', 'planted text', work)
    const file = path.join(contentDir(), `${handoff.id}.json`)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(record['projectRoot'], 'the store keyed the record under work before the rewrite').toBe(canonicalize(work))
    fs.writeFileSync(file, JSON.stringify({ ...record, projectRoot: canonicalize(sibling) }))
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projectRoot, 'the planted record names the Kelvin sibling').toBe(canonicalize(sibling))

    const resolved = resolveHandoff('plan', { projectRoot: work, full: true })
    expect(resolved, 'work must not resolve a record whose projectRoot is the Kelvin sibling').toBeNull()
    expect(resolved).not.toBe('planted text')
  })
})

// HAND-DERIVED: on a case-sensitive file system Foo and foo are two directories, so they are two projects.
describe.skipIf(isWin || process.platform === 'darwin')('on a case-sensitive file system, Foo and foo stay two projects (skipped where the file system folds case)', () => {
  // HAND-DERIVED: one handoff per root, each read back from its own root only.
  it('keeps their handoffs apart', () => {
    fs.mkdirSync(path.join(projectDir, 'Foo'))
    fs.mkdirSync(path.join(projectDir, 'foo'))
    const upper = createHandoff('plan', 'in Foo', path.join(projectDir, 'Foo'))
    const lower = createHandoff('plan', 'in foo', path.join(projectDir, 'foo'))
    expect(lower.id).not.toBe(upper.id)
    expect(resolveHandoff('plan', { projectRoot: path.join(projectDir, 'foo'), full: true })).toBe('in foo')
    expect(resolveHandoff('plan', { projectRoot: path.join(projectDir, 'Foo'), full: true })).toBe('in Foo')
  })
})

// HAND-DERIVED: the stored record is overwritten with text that is not JSON, so it exists but cannot be parsed; the expected message names the error name SyntaxError that JSON.parse raises.
describe('a handoff record that exists but cannot be read is not reported as missing', () => {
  it('says it could not be read and names the code, and keeps the plain message for a name never created', () => {
    const created = createHandoff('plan', 'a plan', projectDir)
    fs.writeFileSync(path.join(contentDir(), `${created.id}.json`), '{not json', 'utf8')

    expect(resolveHandoff('plan', { projectRoot: projectDir })).toBeNull()
    const message = describeMissingHandoff('plan', projectDir)
    expect(message).toContain('handoff "plan" could not be read (SyntaxError)')
    expect(message).not.toContain('no local handoff')
    expect(describeMissingHandoff('never-made', projectDir)).toBe('no local handoff named "never-made" in this project')
  })

  it('says so through the built bundle', () => {
    expect(runCli(['handoff-create', 'plan', 'a plan'], projectDir).status).toBe(0)
    const id = fs.readdirSync(contentDir()).find((file) => file.startsWith('tg_handoff_'))?.slice(0, -5) as string
    fs.writeFileSync(path.join(contentDir(), `${id}.json`), '{not json', 'utf8')

    const resolved = runCli(['handoff-resolve', '--', 'plan'], projectDir)
    expect(resolved.status).not.toBe(0)
    expect(resolved.stderr).toContain('handoff "plan" could not be read (SyntaxError)')
    expect(resolved.stderr).not.toContain('no local handoff')
  })
})

describe('an unreadable handoff record at a legacy id is not reported as missing', () => {
  // FORMAT-DERIVED: the legacy id is the one origin/main 3913ac9c2 would have stored under (src/content_store.ts handoffId, line 86: tg_handoff_ plus the first 16 hex of sha256 of the root as spelled, NUL, name), here the resolved spelling of a linked root; the unreadable body is HAND-DERIVED (text that is not JSON).
  it('says it could not be read, naming the code, when only the legacy record is on disk', () => {
    const { real, link } = linkedRoots()
    const file = writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'the older text', Date.now()).file
    fs.writeFileSync(file, '{not json', 'utf8')

    expect(resolveHandoff('plan', { projectRoot: link })).toBeNull()
    const message = describeMissingHandoff('plan', link)
    expect(message).toContain('handoff "plan" could not be read (SyntaxError)')
    expect(message).not.toContain('no local handoff')
  })

  // HAND-DERIVED: a file with no bytes cannot be parsed, so it is a record that exists and cannot be read; the check is on the file the store wrote, truncated to zero bytes.
  it.each([
    ['current', (): { file: string; root: string } => ({ file: path.join(contentDir(), `${createHandoff('plan', 'a plan', projectDir).id}.json`), root: projectDir })],
    ['legacy', (): { file: string; root: string } => {
      const { real, link } = linkedRoots()
      return { file: writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'a plan', Date.now()).file, root: link }
    }],
  ])('treats a zero-byte %s record as unreadable, not absent', (_kind, place) => {
    const { file, root } = place()
    fs.writeFileSync(file, '')
    expect(fs.statSync(file).size).toBe(0)

    expect(resolveHandoff('plan', { projectRoot: root })).toBeNull()
    const message = describeMissingHandoff('plan', root)
    expect(message).toContain('handoff "plan" could not be read (SyntaxError)')
    expect(message).not.toContain('no local handoff')
  })
})

// FORMAT-DERIVED: a content record has the shape of origin/main 3913ac9c2 src/content_store.ts storeContent (kind content, id, text, createdAt), written by compressText; each row then overwrites it with text that is not JSON, or puts a directory where the file was, so it is on disk and cannot be read.
describe('a content record that exists but cannot be read is not reported as missing or expired', () => {
  function corruptContent(): { id: string; file: string } {
    const id = compressText('some text worth keeping').id
    const file = path.join(contentDir(), `${id}.json`)
    fs.writeFileSync(file, '{not json', 'utf8')
    return { id, file }
  }

  it('says it could not be read, naming the code, and is not called expired even when old', () => {
    const { id } = corruptContent()
    setMtime(id, Date.now() - 48 * 3600 * 1000)

    expect(retrieveText(id)).toBeNull()
    expect(isContentExpired(id)).toBe(false)
    expect(describeUnreadableContent(id)).toBe(`content ${id} could not be read (SyntaxError): a record for it is on disk, so it may exist`)
  })

  it('names EISDIR when a directory stands where the record file should be', () => {
    const { id, file } = corruptContent()
    fs.rmSync(file)
    fs.mkdirSync(file)

    expect(describeUnreadableContent(id)).toBe(`content ${id} could not be read (EISDIR): a record for it is on disk, so it may exist`)
  })

  it('says nothing about an id that was never stored', () => {
    expect(describeUnreadableContent(`tg_${shortFingerprint('never stored')}`)).toBeNull()
  })

  it('says so through the built bundle, and keeps the old wording for an id never stored', () => {
    const { id } = corruptContent()

    const unreadable = runCli(['retrieve', id], projectDir)
    expect(unreadable.status).not.toBe(0)
    expect(unreadable.stderr).toContain(`content ${id} could not be read (SyntaxError)`)
    expect(unreadable.stderr).not.toContain('no token-goat content')
    const never = runCli(['retrieve', `tg_${shortFingerprint('never stored')}`], projectDir)
    expect(never.stderr).toContain('no token-goat content for id')
  })
})

// FORMAT-DERIVED: the legacy copy has the shape of origin/main 3913ac9c2 src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled), written with writeLegacyRecord; the current-id record is the one createHandoff wrote, overwritten with text that is not JSON.
describe('an unreadable current record with a readable older copy', () => {
  it('serves the older text and says a stored record could not be read', () => {
    const { real, link } = linkedRoots()
    const current = createHandoff('plan', 'the newer text', link)
    fs.writeFileSync(path.join(contentDir(), `${current.id}.json`), '{not json', 'utf8')
    writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'the older text', Date.now() - 60_000)

    const resolved = resolveHandoffDetailed('plan', { projectRoot: link, full: true })

    expect(resolved?.result).toBe('the older text')
    expect(resolved?.unreadable).toEqual(['SyntaxError'])
    expect(unreadableRecordNote('plan', resolved?.unreadable ?? [])).toBe('note: a stored record of handoff "plan" could not be read (SyntaxError); the text shown may not be the latest')
  })

  it('has nothing to report when every record reads', () => {
    const { real, link } = linkedRoots()
    createHandoff('plan', 'the newer text', link)
    writeLegacyRecord(canonicalize(fs.realpathSync.native(real)), 'plan', 'the older text', Date.now() - 60_000)

    expect(resolveHandoffDetailed('plan', { projectRoot: link, full: true })?.unreadable).toEqual([])
    expect(unreadableRecordNote('plan', [])).toBeNull()
  })

  it.skipIf(!isWin)('prints the older text on stdout and the note on stderr through the built bundle', () => {
    expect(runCli(['handoff-create', 'plan', 'the newer text'], projectDir).status).toBe(0)
    const id = fs.readdirSync(contentDir()).find((file) => file.startsWith('tg_handoff_'))?.slice(0, -5) as string
    fs.writeFileSync(path.join(contentDir(), `${id}.json`), '{not json', 'utf8')
    writeLegacyRecord(forwardSpelling(projectDir), 'plan', 'the older text', Date.now() - 60_000)

    const resolved = runCli(['handoff-resolve', '--full', '--', 'plan'], projectDir)

    expect(resolved.status, resolved.stderr).toBe(0)
    expect(resolved.stdout.trim()).toBe('the older text')
    expect(resolved.stderr).toContain('note: a stored record of handoff "plan" could not be read (SyntaxError); the text shown may not be the latest')
  })
})
