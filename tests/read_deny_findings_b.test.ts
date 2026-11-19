// Read-deny rulings 75 to 77: relative anchors, the platform case fold and the settings files the host loads.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertReadAllowed,
  findReadDeny,
  ReadDeniedError,
  resetReadDenyCache,
  type ReadDenyContext,
} from '../src/read_deny.js'
import type { PermissionSnapshot } from '../src/rewrite_permission.js'

const roots: string[] = []

function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rdb-')))
  roots.push(dir)
  return dir
}

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

const rules = (...deny: string[]): string => JSON.stringify({ permissions: { deny } })

/** The refusal message, or null when the read is allowed; any other error fails the row. */
function verdict(
  cwd: string,
  projectDir: string,
  target: string,
  extra: Partial<ReadDenyContext> = {},
): string | null {
  resetReadDenyCache()
  try {
    assertReadAllowed(target, { cwd, projectDir, home: path.join(projectDir, 'home'), enabled: true, ...extra })
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(ReadDeniedError)
    return (err as Error).message
  }
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

describe('Ruling 75: a relative rule is anchored to the project root and to cwd', () => {
  it('Read(.env) in project settings refuses ../.env from a subdirectory', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), rules('Read(.env)'))
    fs.mkdirSync(path.join(proj, 'sub'))
    const text = verdict(path.join(proj, 'sub'), proj, '../.env')
    expect(text).toMatch(/denied by .*settings\.json: Read\(\.env\)/)
  })

  it('a relative path rule from the project root refuses the file from a subdirectory', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), rules('Read(secrets/**)'))
    fs.mkdirSync(path.join(proj, 'sub'))
    expect(verdict(path.join(proj, 'sub'), proj, '../secrets/a.txt')).not.toBeNull()
  })

  it('near misses stay allowed: another file, and a project that is not ours', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), rules('Read(secrets/**)'))
    fs.mkdirSync(path.join(proj, 'sub'))
    const sub = path.join(proj, 'sub')
    expect(verdict(sub, proj, '../open/a.txt')).toBeNull()
    expect(verdict(sub, proj, path.join(tmp(), 'secrets', 'a.txt'))).toBeNull()
  })

  it('a rule in user settings is not anchored to the home directory', () => {
    const proj = tmp()
    const home = tmp()
    put(path.join(home, '.claude', 'settings.json'), rules('Read(.env)'))
    const cfg = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = path.join(home, '.claude')
    try {
      expect(verdict(proj, proj, path.join(home, '.env'), { home })).toBeNull()
      expect(verdict(proj, proj, path.join(proj, '.env'), { home })).not.toBeNull()
    } finally {
      if (cfg === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = cfg
    }
  })
})

describe('Ruling 77: path case folds only on win32 and darwin', () => {
  const snapshot = (): PermissionSnapshot => ({
    allow: [],
    deny: [
      {
        raw: 'Read(Secret.txt)',
        tool: 'Read',
        content: 'Secret.txt',
        trustedAllow: false,
        source: '/p/.claude/settings.json',
      },
    ],
    ask: [],
    blockReadsOutside: false,
    permissionHooks: false,
  })
  const hit = (target: string, platform: NodeJS.Platform): unknown =>
    findReadDeny(snapshot(), [target], '/p', '/home/u', [], platform)

  it('a linux path keeps its case, so a different case is not the denied file', () => {
    expect(hit('/p/secret.txt', 'linux')).toBeNull()
    expect(hit('/p/Secret.txt', 'linux')).not.toBeNull()
  })

  it.each(['win32', 'darwin'] as const)('%s folds case, so a different case is denied', (platform) => {
    expect(hit('/p/secret.txt', platform)).not.toBeNull()
  })
})

describe('Ruling 76: only the settings files the host loads can deny or break a read', () => {
  it('a malformed settings file in an ancestor directory the host does not load changes nothing', () => {
    const parent = tmp()
    const proj = path.join(parent, 'proj')
    put(path.join(parent, '.claude', 'settings.json'), '{ not json')
    put(path.join(parent, '.claude', 'settings.local.json'), '{ not json')
    put(path.join(proj, '.claude', 'settings.json'), rules('Read(secrets/**)'))
    expect(verdict(proj, proj, path.join(proj, 'open.txt'))).toBeNull()
    expect(verdict(proj, proj, path.join(proj, 'secrets', 'a.txt'))).not.toBeNull()
  })

  it('a deny rule in an ancestor directory the host does not load does not deny', () => {
    const parent = tmp()
    const proj = path.join(parent, 'proj')
    put(path.join(parent, '.claude', 'settings.json'), rules('Read(//**/*.txt)'))
    put(path.join(proj, '.claude', 'settings.json'), rules())
    expect(verdict(proj, proj, path.join(proj, 'a.txt'))).toBeNull()
  })

  it('a malformed project settings file the host does load refuses', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), '{ not json')
    expect(verdict(proj, proj, path.join(proj, 'a.txt'))).toMatch(/could not read the host permission settings/)
  })

  it('a malformed project settings.local.json refuses', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), rules())
    put(path.join(proj, '.claude', 'settings.local.json'), '{ not json')
    expect(verdict(proj, proj, path.join(proj, 'a.txt'))).toMatch(/could not read the host permission settings/)
  })
})
