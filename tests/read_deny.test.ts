// Host Read(...) deny rules gate token-goat's reads; rows follow the Claude Code permissions docs rule table.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { normalizePath } from '../src/paths.js'
import {
  assertReadAllowed,
  ReadDeniedError,
  resetReadDenyCache,
  type ReadDenyContext,
} from '../src/read_deny.js'
import { clearModuleCaches } from '../src/reset.js'
import { CAN_JUNCTION } from './helpers/can-symlink.js'

const roots: string[] = []
let savedConfigDir: string | undefined

function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-')))
  roots.push(dir)
  return dir
}

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

interface Settings {
  deny?: unknown[]
  allow?: unknown[]
  ask?: unknown[]
}

function settingsJson(s: Settings): string {
  return JSON.stringify({ permissions: s })
}

function check(proj: string, target: string, extra: Partial<ReadDenyContext> = {}): string | null {
  resetReadDenyCache()
  try {
    const home = path.join(proj, 'home')
    assertReadAllowed(target, { cwd: proj, projectDir: proj, home, enabled: true, ...extra })
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(ReadDeniedError)
    return (err as Error).message
  }
}

/** The refusal message for reading `target` under `settings` in a fresh project, or null when allowed. */
function verdict(
  settings: Settings,
  target: (proj: string) => string,
  extra: (proj: string) => Partial<ReadDenyContext> = () => ({}),
  local?: Settings,
): string | null {
  const proj = tmp()
  put(path.join(proj, '.claude', 'settings.json'), settingsJson(settings))
  if (local !== undefined) put(path.join(proj, '.claude', 'settings.local.json'), settingsJson(local))
  return check(proj, target(proj), extra(proj))
}

beforeEach(() => {
  savedConfigDir = process.env['CLAUDE_CONFIG_DIR']
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
  delete process.env['TOKEN_GOAT_READS_HONOR_HOST_DENY']
  clearModuleCaches()
  resetReadDenyCache()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('rule forms', () => {
  it('//path is absolute from the filesystem root', () => {
    const proj = tmp()
    const posix = normalizePath(path.join(proj, 'secrets')).replace(/^([A-Za-z]):/, '/$1')
    put(path.join(proj, '.claude', 'settings.json'), settingsJson({ deny: [`Read(/${posix}/*)`] }))
    expect(check(proj, path.join(proj, 'secrets', 'x.txt'))).toContain('denied by')
    expect(check(proj, path.join(proj, 'other', 'x.txt'))).toBeNull()
  })

  it('~/path is relative to the home directory', () => {
    const settings = { deny: ['Read(~/Documents/*.pdf)'] }
    expect(verdict(settings, (p) => path.join(p, 'home', 'Documents', 'a.pdf'))).toContain('~/Documents/*.pdf')
    expect(verdict(settings, (p) => path.join(p, 'home', 'Documents', 'a.txt'))).toBeNull()
    expect(verdict(settings, (p) => path.join(p, 'elsewhere', 'Documents', 'a.pdf'))).toBeNull()
  })

  it('/path in project settings is relative to the project root', () => {
    const settings = { deny: ['Read(/secrets/*)'] }
    expect(verdict(settings, (p) => path.join(p, 'secrets', 'x'))).toContain('settings.json')
    expect(verdict(settings, (p) => path.join(p, 'sub', 'secrets', 'x'))).toBeNull()
  })

  it('/path in user settings is relative to the config directory, not the project', () => {
    const proj = tmp()
    const cfg = path.join(tmp(), '.claude')
    process.env['CLAUDE_CONFIG_DIR'] = cfg
    put(path.join(cfg, 'settings.json'), settingsJson({ deny: ['Read(/secrets/*)'] }))
    expect(check(proj, path.join(cfg, 'secrets', 'x'))).toContain(path.join(cfg, 'settings.json'))
    expect(check(proj, path.join(proj, 'secrets', 'x'))).toBeNull()
  })

  it.each([['.env'], ['./.env']])('%s matches a bare filename at any depth under the cwd', (rule) => {
    const settings = { deny: [`Read(${rule})`] }
    expect(verdict(settings, (p) => path.join(p, '.env'))).toContain(rule)
    expect(verdict(settings, (p) => path.join(p, 'a', 'b', '.env'))).toContain(rule)
    expect(verdict(settings, (p) => path.join(p, 'a', '.envrc'))).toBeNull()
  })

  it('a bare filename matches the project root from a subdirectory but not another project', () => {
    const settings = { deny: ['Read(.env)'] }
    const sub = (p: string): Partial<ReadDenyContext> => ({ cwd: path.join(p, 'sub') })
    // Ruling 75: a relative rule is anchored to the project root of its settings file and to cwd, as a union.
    expect(verdict(settings, (p) => path.join(p, '.env'), sub)).toContain('.env')
    expect(verdict(settings, () => path.join(tmp(), '.env'))).toBeNull()
  })

  it('a bare filename rule does not match a file above the project root', () => {
    const settings = { deny: ['Read(.env)'] }
    const above = (p: string): string => path.join(path.dirname(p), '.env')
    const sub = (p: string): Partial<ReadDenyContext> => ({ cwd: path.join(p, 'sub') })
    expect(verdict(settings, above), 'cwd at the project root').toBeNull()
    expect(verdict(settings, above, sub), 'cwd in a subdirectory').toBeNull()
    const inside = (p: string): string => path.join(p, 'sub', '.env')
    expect(verdict(settings, inside, sub), 'a file under the anchors is denied').toContain('.env')
  })

  it('a bare filename rule does not match a file outside the cwd', () => {
    expect(verdict({ deny: ['Read(.env)'] }, () => path.join(tmp(), '.env'))).toBeNull()
  })

  it('a directory glob matches that directory at any depth, as a whole segment only', () => {
    const settings = { deny: ['Read(secrets/**)'] }
    expect(verdict(settings, (p) => path.join(p, 'secrets', 'k'))).toContain('secrets/')
    expect(verdict(settings, (p) => path.join(p, 'a', 'b', 'secrets', 'k'))).toContain('secrets/')
    expect(verdict(settings, (p) => path.join(p, 'secretsX', 'k'))).toBeNull()
    expect(verdict(settings, (p) => path.join(p, 'a', 'mysecrets', 'k'))).toBeNull()
  })

  it('*.env matches by extension in one segment', () => {
    const settings = { deny: ['Read(*.env)'] }
    expect(verdict(settings, (p) => path.join(p, 'prod.env'))).toContain('*.env')
    expect(verdict(settings, (p) => path.join(p, 'prod.envx'))).toBeNull()
  })

  it.runIf(process.platform === 'win32')('a drive rule spells the drive in either letter case', () => {
    const drive = path.parse(os.tmpdir()).root.slice(0, 1).toLowerCase()
    const rule = (d: string): Settings => ({ deny: [`Read(//${d}/**/.env)`] })
    expect(verdict(rule(drive), (p) => path.join(p, '.env'))).toContain('.env')
    const upper = (p: string): string => path.join(p, '.env').replace(/^./, drive.toUpperCase())
    expect(verdict(rule(drive), upper)).toContain('.env')
    expect(verdict(rule(drive), (p) => path.join(p, '.env').replace(/^./, drive))).toContain('.env')
    expect(verdict(rule(drive === 'c' ? 'd' : 'c'), (p) => path.join(p, '.env'))).toBeNull()
  })

  it.runIf(process.platform === 'win32')('a backslash path is the same file as its slash spelling', () => {
    const settings = { deny: ['Read(secrets/**)'] }
    const back = (p: string): string => path.join(p, 'secrets', 'x').replace(/\//g, path.sep)
    expect(verdict(settings, back)).toContain('secrets/')
    expect(verdict(settings, (p) => back(p).replace(/\\/g, '/'))).toContain('secrets/')
  })

  it('a bare Read rule denies every read', () => {
    expect(verdict({ deny: ['Read'] }, (p) => path.join(p, 'any.txt'))).toContain('denied by')
  })
})

describe('precedence', () => {
  it('deny beats allow for the same path', () => {
    const msg = verdict({ allow: ['Read(.env)'], deny: ['Read(.env)'] }, (p) => path.join(p, '.env'))
    expect(msg).toContain('Read(.env)')
  })

  it('an allow rule alone denies nothing', () => {
    expect(verdict({ allow: ['Read(.env)'] }, (p) => path.join(p, '.env'))).toBeNull()
  })

  it('ask rules and non-Read deny rules do not deny a read', () => {
    const settings = { ask: ['Read(.env)'], deny: ['Edit(.env)', 'Grep(.env)', 'Bash(cat .env)'] }
    expect(verdict(settings, (p) => path.join(p, '.env'))).toBeNull()
  })

  it('a ! negation reopens one file under a pattern within the same source', () => {
    const settings = { deny: ['Read(logs/**)', 'Read(!logs/keep.txt)'] }
    expect(verdict(settings, (p) => path.join(p, 'logs', 'keep.txt'))).toBeNull()
    expect(verdict(settings, (p) => path.join(p, 'logs', 'other.txt'))).toContain('logs/')
  })

  it('a ! negation cannot reopen a file inside a directory a rule blocks as a whole', () => {
    const settings = { deny: ['Read(logs)', 'Read(!logs/keep.txt)'] }
    expect(verdict(settings, (p) => path.join(p, 'logs', 'keep.txt'))).toContain('logs')
  })

  it('a ! negation in one source does not reach a rule of another source', () => {
    const envFile = (p: string): string => path.join(p, '.env')
    const msg = verdict({ deny: ['Read(.env)'] }, envFile, () => ({}), { deny: ['Read(!.env)'] })
    expect(msg).toContain('settings.json')
  })
})

describe('symlinks', () => {
  it('an injected realpath that resolves into a denied directory refuses', () => {
    const settings = { deny: ['Read(secrets/**)'] }
    const link = (p: string): string => path.join(p, 'open', 'x.txt')
    const resolved = (p: string): Partial<ReadDenyContext> => ({
      realpath: (q: string) => (q === link(p) ? path.join(p, 'secrets', 'x.txt') : q),
    })
    expect(verdict(settings, link, resolved)).toContain('denied by')
    expect(verdict(settings, (p) => path.join(p, 'open', 'y.txt'), resolved)).toBeNull()
  })

  it.runIf(CAN_JUNCTION)('a real junction or symlink to a denied directory refuses', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), settingsJson({ deny: ['Read(secrets/**)'] }))
    put(path.join(proj, 'secrets', 'x.txt'), 'hidden')
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    fs.symlinkSync(path.join(proj, 'secrets'), path.join(proj, 'open'), kind)
    expect(check(proj, path.join(proj, 'open', 'x.txt'))).toContain('denied by')
    put(path.join(proj, 'plain', 'x.txt'), 'fine')
    expect(check(proj, path.join(proj, 'plain', 'x.txt'))).toBeNull()
  })
})

describe('failure policy', () => {
  it('no settings file means no rules', () => {
    const proj = tmp()
    expect(check(proj, path.join(proj, '.env'))).toBeNull()
  })

  it('a settings file that is not valid JSON refuses and names the file', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), '{ not json')
    const msg = check(proj, path.join(proj, 'a.txt'))
    expect(msg).toContain(path.join(proj, '.claude', 'settings.json'))
    expect(msg).toContain('refused')
  })

  it('a deny list that is not an array refuses and names the file', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: 'Read(.env)' } }))
    expect(check(proj, path.join(proj, 'a.txt'))).toContain('settings.json')
  })

  it.each([['Read(foo'], ['Read()'], ['Read(!)']])('unparseable deny entry %s refuses every read', (entry) => {
    const msg = verdict({ deny: [entry] }, (p) => path.join(p, 'unrelated.txt'))
    expect(msg).toContain('refused')
    expect(msg).toContain(entry)
  })

  it('an unparseable entry for another tool is ignored', () => {
    expect(verdict({ deny: ['Bash(rm'] }, (p) => path.join(p, 'a.txt'))).toBeNull()
  })

  it('enabled:false turns the check off', () => {
    const msg = verdict({ deny: ['Read(.env)'] }, (p) => path.join(p, '.env'), () => ({ enabled: false }))
    expect(msg).toBeNull()
  })

  it('the env override turns the check off and the default keeps it on', () => {
    const proj = tmp()
    put(path.join(proj, '.claude', 'settings.json'), settingsJson({ deny: ['Read(.env)'] }))
    const ask = (): string | null => {
      clearModuleCaches()
      resetReadDenyCache()
      try {
        assertReadAllowed(path.join(proj, '.env'), { cwd: proj, projectDir: proj })
        return null
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(ask()).toContain('denied by')
    process.env['TOKEN_GOAT_READS_HONOR_HOST_DENY'] = '0'
    expect(ask()).toBeNull()
  })

  it('a loader that throws refuses with the cause', () => {
    const throwing = (): Partial<ReadDenyContext> => ({
      loadSnapshot: () => {
        throw new Error('boom from the loader')
      },
    })
    expect(verdict({ deny: [] }, (p) => path.join(p, 'a.txt'), throwing)).toContain('boom from the loader')
  })
})

describe('a working directory outside the project, or no project directory', () => {
  interface Layout {
    proj: string
    elsewhere: string
    home: string
  }

  /** A project, a separate cwd that is not inside it, and a user config directory holding `userDeny`. */
  function layout(userDeny: unknown[], projectDeny: unknown[] = []): Layout {
    const proj = tmp()
    const cfg = path.join(tmp(), '.claude')
    process.env['CLAUDE_CONFIG_DIR'] = cfg
    put(path.join(cfg, 'settings.json'), settingsJson({ deny: userDeny }))
    put(path.join(proj, '.claude', 'settings.json'), settingsJson({ deny: projectDeny }))
    return { proj, elsewhere: tmp(), home: tmp() }
  }

  function ask(target: string, ctx: ReadDenyContext): string | null {
    resetReadDenyCache()
    try {
      assertReadAllowed(target, { enabled: true, ...ctx })
      return null
    } catch (err) {
      expect(err).toBeInstanceOf(ReadDeniedError)
      return (err as Error).message
    }
  }

  const outside = (l: Layout, target: string): string | null =>
    ask(target, { cwd: l.elsewhere, projectDir: l.proj, home: l.home })

  it('reads normally when no rule denies the file', () => {
    const l = layout([])
    expect(outside(l, path.join(l.elsewhere, 'a.txt'))).toBeNull()
    expect(outside(l, path.join(l.proj, 'a.txt'))).toBeNull()
  })

  it('a user-level ~/ deny refuses that file only', () => {
    const l = layout(['Read(~/secret.txt)'])
    expect(outside(l, path.join(l.home, 'secret.txt'))).toContain('settings.json')
    expect(outside(l, path.join(l.home, 'other.txt'))).toBeNull()
    expect(outside(l, path.join(l.elsewhere, 'secret.txt'))).toBeNull()
  })

  it('the project settings still apply to the project directory', () => {
    const l = layout([], ['Read(/secrets/*)'])
    const settingsFile = path.join(l.proj, '.claude', 'settings.json')
    expect(outside(l, path.join(l.proj, 'secrets', 'x'))).toContain(settingsFile)
    expect(outside(l, path.join(l.proj, 'public', 'x'))).toBeNull()
  })

  it('an unset CLAUDE_PROJECT_DIR reads normally and still honors the cwd project and user rules', () => {
    const l = layout(['Read(~/secret.txt)'])
    put(path.join(l.elsewhere, '.claude', 'settings.json'), settingsJson({ deny: ['Read(secrets/**)'] }))
    const saved = process.env['CLAUDE_PROJECT_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
    try {
      const here = (target: string): string | null => ask(target, { cwd: l.elsewhere, home: l.home })
      expect(here(path.join(l.elsewhere, 'a.txt'))).toBeNull()
      expect(here(path.join(l.elsewhere, 'secrets', 'x'))).toContain('Read(secrets/**)')
      expect(here(path.join(l.home, 'secret.txt'))).toContain('Read(~/secret.txt)')
    } finally {
      if (saved !== undefined) process.env['CLAUDE_PROJECT_DIR'] = saved
    }
  })
})
