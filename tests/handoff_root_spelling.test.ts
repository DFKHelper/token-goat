// A handoff must be found again however its project root is spelled, and content a live handoff names must outlive the cache's age rule.

// CAPTURE: the two ids and their root spellings below are two real stored handoffs read from a user's content store (name r3-wiki-folds, same text, created five hours apart): tg_handoff_b90e697d562f5a99 recorded projectRoot "c:/Projects/claude-agents" and tg_handoff_52172d6e07a8a7aa recorded projectRoot "C:\Projects\claude-agents". The flip came from findProject returning null for a directory holding three nested repositories (REPO_CONTAINER_THRESHOLD in src/project.ts), which switched the root from the canonical form to path.resolve's form. HAND-DERIVED: the Windows rows spell one directory the way each host delivers it (Git Bash and hook payloads: lower-case drive and forward slashes, which is canonicalize's form; PowerShell cwd: upper-case drive and backslashes); the prune rows age files with utimes so no clock is waited on.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { compressText, createHandoff, resolveHandoff, resolveHandoffDetailed, retrieveText } from '../src/content_store.js'
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

function ageBlob(id: string): void {
  const aged = new Date(Date.now() - 48 * 3600 * 1000)
  fs.utimesSync(path.join(contentDir(), `${id}.json`), aged, aged)
}

describe('content a live handoff names', () => {
  it('survives a prune that removes unreferenced content of the same age, and stays retrievable', () => {
    const quoted = compressText('content quoted in the handoff text')
    const unreferenced = compressText('content nothing points at')
    const handoff = createHandoff('refs', `see ${quoted.id} for the table`, projectDir)
    for (const id of [quoted.id, unreferenced.id, handoff.contentId]) ageBlob(id)

    compressText('a later write that runs the prune')

    expect(fs.existsSync(path.join(contentDir(), `${handoff.contentId}.json`))).toBe(true)
    expect(fs.existsSync(path.join(contentDir(), `${quoted.id}.json`))).toBe(true)
    expect(fs.existsSync(path.join(contentDir(), `${unreferenced.id}.json`))).toBe(false)
    expect(retrieveText(quoted.id)).toBe('content quoted in the handoff text')
    expect(retrieveText(unreferenced.id)).toBeNull()
  })

  it('is no longer held once the handoff that names it has expired', () => {
    const quoted = compressText('content quoted in a handoff that expires')
    const handoff = createHandoff('refs', `see ${quoted.id}`, projectDir)
    for (const id of [quoted.id, handoff.contentId, handoff.id]) ageBlob(id)

    compressText('a later write that runs the prune')

    expect(fs.existsSync(path.join(contentDir(), `${quoted.id}.json`))).toBe(false)
    expect(fs.existsSync(path.join(contentDir(), `${handoff.id}.json`))).toBe(false)
  })

  it('survives the same prune when the lost ids were reported by the built bundle', () => {
    const quoted = runCli(['compress-text', 'content a handoff quotes'], projectDir)
    expect(quoted.status, quoted.stderr).toBe(0)
    const quotedId = /tg_[0-9a-f]{16}/.exec(quoted.stdout)?.[0]
    expect(quotedId).toBeDefined()
    const created = runCli(['handoff-create', 'refs', `see ${quotedId}`], projectDir)
    expect(created.status, created.stderr).toBe(0)
    ageBlob(quotedId as string)
    expect(runCli(['compress-text', 'a later write that runs the prune'], projectDir).status).toBe(0)
    const retrieved = runCli(['retrieve', quotedId as string], projectDir)
    expect(retrieved.status, retrieved.stderr).toBe(0)
    expect(retrieved.stdout).toContain('content a handoff quotes')
  })
})
