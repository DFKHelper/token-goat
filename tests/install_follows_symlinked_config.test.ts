import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { installHooks, uninstallHooks } from '../src/install.js'
import { atomicWriteText } from '../src/util.js'

/** A user-scope config that is a symlink into a dotfiles repository must stay a symlink: the write goes to the link's target. PROVENANCE: HAND-DERIVED. The scenario is the one captured in the round-11 audit, 2026-10-03, built bundle with HOME pointed at a scratch dir: `settings.json` was a symlink to `dotfiles/settings.json` holding {"theme":"dark"}; after `token-goat install` the link was a 6550-byte regular file with 32 "token-goat" matches and the dotfiles file still held only {"theme":"dark"}. The expectations (link kept, target changed, outside file untouched) are computed from that description, not from the implementation. */
const THEME = '{"theme":"dark"}\n'

type Skip = (note?: string) => never

/** Creates the link, or skips the test with the reason when the platform refuses: creating a symlink on Windows needs a privilege a CI or developer account may lack, and the Linux and macOS runners exercise this file in full. */
function symlinkOrSkip(skip: Skip, target: string, link: string): void {
  try {
    fs.symlinkSync(target, link, 'file')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') skip('this account may not create symlinks (EPERM)')
    throw err
  }
}

describe('config writes follow a symlinked destination', () => {
  let base: string
  let claudeDir: string
  let dotfiles: string

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-symlink-config-'))
    claudeDir = path.join(base, 'home', '.claude')
    dotfiles = path.join(base, 'dotfiles')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.mkdirSync(dotfiles, { recursive: true })
    vi.stubEnv('HOME', path.join(base, 'home'))
    vi.stubEnv('USERPROFILE', path.join(base, 'home'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('user-scope install and uninstall keep the link and write its target', ({ skip }) => {
    const target = path.join(dotfiles, 'settings.json')
    fs.writeFileSync(target, THEME)
    const link = path.join(claudeDir, 'settings.json')
    symlinkOrSkip(skip, target, link)

    installHooks('user')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toContain('token-goat')
    expect(fs.readFileSync(target, 'utf8')).toContain('"theme"')

    uninstallHooks('user')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).not.toContain('token-goat')
    expect(fs.readFileSync(target, 'utf8')).toContain('"theme"')
  })

  it('follows a relative link and a link whose target does not exist yet', ({ skip }) => {
    const link = path.join(claudeDir, 'settings.json')
    symlinkOrSkip(skip, path.join('..', '..', 'dotfiles', 'new-settings.json'), link)
    installHooks('user')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(dotfiles, 'new-settings.json'), 'utf8')).toContain('token-goat')
  })

  it('follows a chain of links to the final file', ({ skip }) => {
    const final = path.join(dotfiles, 'final.json')
    fs.writeFileSync(final, THEME)
    const middle = path.join(dotfiles, 'middle.json')
    symlinkOrSkip(skip, final, middle)
    const link = path.join(base, 'link.json')
    symlinkOrSkip(skip, middle, link)
    atomicWriteText(link, 'chained\n')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(middle).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(final, 'utf8')).toBe('chained\n')
  })

  it('leaves no temp file beside the link or its target', ({ skip }) => {
    const target = path.join(dotfiles, 'settings.json')
    fs.writeFileSync(target, THEME)
    symlinkOrSkip(skip, target, path.join(claudeDir, 'settings.json'))
    installHooks('user')
    expect(fs.readdirSync(dotfiles).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(fs.readdirSync(claudeDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('does not write through a link another user owns', ({ skip }) => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') skip('ownership is a POSIX notion')
    const victim = path.join(dotfiles, 'victim.json')
    fs.writeFileSync(victim, THEME)
    const shared = path.join(base, 'shared')
    fs.mkdirSync(shared, { mode: 0o1777 })
    fs.chmodSync(shared, 0o1777)
    const link = path.join(shared, 'tg-fetch-1.png')
    symlinkOrSkip(skip, victim, link)
    if (process.getuid!() === 0) fs.lchownSync(link, 65534, 65534)
    else if (spawnSync('sudo', ['-n', 'chown', '-h', '65534:65534', link]).status !== 0) skip('needs root or passwordless sudo to give the link another owner')
    expect(fs.lstatSync(link).uid).toBe(65534)
    atomicWriteText(link, 'planted\n')
    expect(fs.readFileSync(victim, 'utf8')).toBe(THEME)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(link, 'utf8')).toBe('planted\n')
  })

  it('project scope writes through a link that stays inside the project and refuses one that leaves it', ({ skip }) => {
    const project = path.join(base, 'project')
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(project)
    const link = path.join(project, '.claude', 'settings.json')

    const inside = path.join(project, 'config', 'settings.json')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, THEME)
    symlinkOrSkip(skip, inside, link)
    installHooks('project')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(inside, 'utf8')).toContain('token-goat')

    fs.unlinkSync(link)
    const outside = path.join(dotfiles, 'private.json')
    fs.writeFileSync(outside, THEME)
    symlinkOrSkip(skip, outside, link)
    expect(() => installHooks('project')).toThrow(/outside the project/)
    expect(fs.readFileSync(outside, 'utf8')).toBe(THEME)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
