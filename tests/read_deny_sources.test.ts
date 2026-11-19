// Read-deny: the opened spelling, settings freshness, refusal text, and which settings sources are parsed.
// Provenance: HAND-DERIVED. Layouts and rules are built here, in Claude Code's documented Read(...) syntax.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assertReadAllowed, readDenial, resetReadDenyCache } from '../src/read_deny.js'
import { parseRule, resetPermissionSourceCache } from '../src/rewrite_permission.js'
import type { PermissionSnapshot } from '../src/rewrite_permission.js'
import { BUNDLE } from './helpers/bundle.js'

const dirs: string[] = []
let savedConfig: string | undefined
let savedProject: string | undefined
let configDir = ''

beforeEach(() => {
  savedConfig = process.env['CLAUDE_CONFIG_DIR']
  savedProject = process.env['CLAUDE_PROJECT_DIR']
  configDir = tmp('tg-rdsrc-cfg-')
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  resetReadDenyCache()
  resetPermissionSourceCache()
})

afterEach(() => {
  if (savedConfig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = savedConfig
  if (savedProject === undefined) delete process.env['CLAUDE_PROJECT_DIR']
  else process.env['CLAUDE_PROJECT_DIR'] = savedProject
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  resetReadDenyCache()
  resetPermissionSourceCache()
})

function tmp(prefix: string): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(d)
  return d
}

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

const settings = (dir: string, rules: string[]): void =>
  put(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: rules } }))

function refusal(target: string, cwd: string): string | null {
  return readDenial(target, { cwd, projectDir: cwd, home: configDir })
}

describe('S5: the check judges the file that will really be opened', () => {
  it('denies when the raw spelling resolves through a link to a denied file (injected realpath)', () => {
    const proj = tmp('tg-rdsrc-fake-')
    settings(proj, ['Read(vault/**)'])
    const vault = path.join(proj, 'vault', 'secret.txt')
    const realpath = (p: string): string => {
      if (p.includes('link') && p.includes('..')) return vault
      if (p.includes('..')) throw new Error('unexpected spelling')
      return p
    }
    const spelling = ['work', 'link', '..', 'secret.txt'].join(path.sep)
    const text = readDenial(spelling, { cwd: proj, projectDir: proj, home: configDir, realpath })
    expect(text, 'the link spelling must be refused').not.toBeNull()
    expect(text).toContain('is denied by')
  })

  it('an undenied spelling with no link still reads (injected realpath)', () => {
    const proj = tmp('tg-rdsrc-fake2-')
    settings(proj, ['Read(vault/**)'])
    const realpath = (p: string): string => p
    const spelling = ['work', 'x', '..', 'ok.txt'].join(path.sep)
    const ctx = { cwd: proj, projectDir: proj, home: configDir, realpath }
    expect(readDenial(spelling, ctx)).toBeNull()
  })

  function layout(): { proj: string; work: string } {
    const proj = tmp('tg-rdsrc-link-')
    settings(proj, ['Read(vault/**)'])
    put(path.join(proj, 'vault', 'secret.txt'), 'VAULTBODY')
    put(path.join(proj, 'vault', 'sub', 'keep.txt'), 'x')
    put(path.join(proj, 'work', 'secret.txt'), 'WORKBODY')
    put(path.join(proj, 'open', 'ok.txt'), 'OPENBODY')
    fs.symlinkSync(path.join(proj, 'vault', 'sub'), path.join(proj, 'work', 'link'), 'junction')
    fs.symlinkSync(path.join(proj, 'open'), path.join(proj, 'work', 'open'), 'junction')
    fs.symlinkSync(path.join(proj, 'vault'), path.join(proj, 'work', 'vlink'), 'junction')
    return { proj, work: path.join(proj, 'work') }
  }

  function cli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
    delete env['CLAUDE_PROJECT_DIR']
    const run = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 })
    return { status: run.status, stdout: run.stdout, stderr: run.stderr }
  }

  it('link/../secret: refused or read according to the file the OS opens, through the real check', () => {
    const { proj, work } = layout()
    const spelling = `link${path.sep}..${path.sep}secret.txt`
    const opened = fs.realpathSync.native(`${work}${path.sep}${spelling}`)
    const inVault = opened.startsWith(path.join(proj, 'vault'))
    const text = readDenial(spelling, { cwd: work, projectDir: proj, home: configDir })
    expect(text !== null).toBe(inVault)
    expect(fs.readFileSync(`${work}${path.sep}${spelling}`, 'utf8')).toBe(inVault ? 'VAULTBODY' : 'WORKBODY')
  })

  it('a denied file reached through a link refuses; an undenied one reached through a link reads', () => {
    const { work, proj } = layout()
    const ctx = { cwd: work, projectDir: proj, home: configDir }
    expect(readDenial('vlink/secret.txt', ctx)).toContain('is denied by')
    expect(readDenial('open/ok.txt', ctx)).toBeNull()
  })

  it('the built CLI (read and recall) refuse the link spelling of a denied file, printing none of it', () => {
    const { proj, work } = layout()
    const spelling = `link${path.sep}..${path.sep}secret.txt`
    const inVault = fs.realpathSync.native(`${work}${path.sep}${spelling}`).startsWith(path.join(proj, 'vault'))
    for (const args of [['read', spelling], ['bash-output', '--file', spelling]]) {
      const run = cli(args, work)
      if (inVault) {
        expect(run.status).toBe(1)
        expect(run.stdout + run.stderr).not.toContain('VAULTBODY')
        expect(run.stderr).toContain('refused')
      } else {
        expect(run.stdout + run.stderr).toContain('WORKBODY')
      }
    }
    const open = cli(['read', 'open/ok.txt'], work)
    expect(open.stdout).toContain('OPENBODY')
  })
})

describe('S9: a settings edit bites at once, whatever the clock says', () => {
  const frozen = (): number => 0

  it('a deny rule written to the project file after a check is seen by the next check', () => {
    const proj = tmp('tg-rdsrc-fresh-')
    settings(proj, ['Read(a/**)'])
    put(path.join(proj, 'b', 'f.txt'), 'x')
    const ctx = { cwd: proj, projectDir: proj, home: configDir, now: frozen }
    expect(() => assertReadAllowed('b/f.txt', ctx)).not.toThrow()
    settings(proj, ['Read(a/**)', 'Read(b/**)'])
    expect(() => assertReadAllowed('b/f.txt', ctx)).toThrow(/is denied by/)
  })

  it('a settings file created after a check, where none existed, is seen', () => {
    const proj = tmp('tg-rdsrc-fresh2-')
    put(path.join(proj, 'b', 'f.txt'), 'x')
    const ctx = { cwd: proj, projectDir: proj, home: configDir, now: frozen }
    expect(() => assertReadAllowed('b/f.txt', ctx)).not.toThrow()
    settings(proj, ['Read(b/**)'])
    expect(() => assertReadAllowed('b/f.txt', ctx)).toThrow(/is denied by/)
  })

  it('a managed source (remote-settings.json) written after a check is seen with no cache reset', () => {
    const proj = tmp('tg-rdsrc-fresh3-')
    put(path.join(proj, 'b', 'f.txt'), 'x')
    const ctx = { cwd: proj, projectDir: proj, home: configDir, now: frozen }
    expect(() => assertReadAllowed('b/f.txt', ctx)).not.toThrow()
    put(path.join(configDir, 'remote-settings.json'), JSON.stringify({ permissions: { deny: ['Read(b/**)'] } }))
    expect(() => assertReadAllowed('b/f.txt', ctx)).toThrow(/is denied by/)
  })
})

describe('S6: a deny rule only a --settings flag supplies is not visible', () => {
  it('reads stay allowed in a flag-style session; a rule in a loaded file still refuses', () => {
    const proj = tmp('tg-rdsrc-flag-')
    settings(proj, ['Read(secrets/**)'])
    put(path.join(proj, 'flag.json'), JSON.stringify({ permissions: { deny: ['Read(open/**)'] } }))
    put(path.join(proj, 'open', 'doc.md'), 'x')
    const saved = { ep: process.env['CLAUDE_CODE_ENTRYPOINT'], pid: process.env['CLAUDE_PID'] }
    process.env['CLAUDE_CODE_ENTRYPOINT'] = 'sdk-ts'
    process.env['CLAUDE_PID'] = '999999'
    try {
      expect(refusal('open/doc.md', proj)).toBeNull()
      expect(refusal('secrets/doc.md', proj)).toContain('is denied by')
    } finally {
      for (const [k, v] of [['CLAUDE_CODE_ENTRYPOINT', saved.ep], ['CLAUDE_PID', saved.pid]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('S10: refusal text carries no settings text', () => {
  it('a rule with control characters and a huge tail prints stripped and capped', () => {
    const raw = `Read(vault/**)\u0007\u001b[2J\nINJECTED ${'z'.repeat(2000)}`
    const rule = { ...parseRule('Read(vault/**)', false, path.join(os.tmpdir(), 'x.json')), raw }
    const snapshot: PermissionSnapshot = {
      allow: [],
      deny: [rule],
      ask: [],
      blockReadsOutside: false,
      permissionHooks: false,
    }
    const cwd = os.tmpdir()
    const loadSnapshot = (): PermissionSnapshot => snapshot
    const text = readDenial('vault/a.txt', { cwd, projectDir: cwd, home: configDir, loadSnapshot }) ?? ''
    expect(text).toContain('is denied by')
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(text.length).toBeLessThan(600)
  })

  it('a malformed settings file names the file and not the parser excerpt or the file text', () => {
    const proj = tmp('tg-rdsrc-bad-')
    put(path.join(proj, '.claude', 'settings.json'), '{ "deny": TOPSECRETTEXT')
    const text = refusal('a.txt', proj) ?? ''
    expect(text).toContain(path.join(proj, '.claude', 'settings.json'))
    expect(text).toContain('is not valid JSON')
    expect(text).not.toContain('TOPSECRETTEXT')
    expect(text).not.toMatch(/Unexpected|position|token/)
  })
})

describe('S11: only host-loaded files are parsed', () => {
  it('a malformed ~/.claude/settings.local.json the host does not load refuses nothing', () => {
    const proj = tmp('tg-rdsrc-local-')
    settings(proj, ['Read(secrets/**)'])
    put(path.join(configDir, 'settings.local.json'), '{ nope')
    expect(refusal('open/doc.md', proj)).toBeNull()
    expect(refusal('secrets/doc.md', proj)).toContain('is denied by')
  })

  it('a malformed project settings file the host loads still refuses every read', () => {
    const proj = tmp('tg-rdsrc-loaded-')
    put(path.join(proj, '.claude', 'settings.json'), '{ nope')
    expect(refusal('open/doc.md', proj)).toContain('is not valid JSON')
  })
})
