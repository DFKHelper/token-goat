// Provenance: HAND-DERIVED. Each layout is a made-up directory tree of empty files, written here from Git for Windows' install layout (cmd/git.exe or bin/git.exe beside mingw64/bin/git.exe) and from Scoop's shim format (git.shim holding `path = "<target>"`); the expected answer is worked out from that layout, not from the matcher. Real-install behaviour is covered by run_git_timeout_reaps_git.test.ts.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CAN_JUNCTION } from './helpers/can-symlink.js'
import { gitExecutable, realGitBehindLauncher, runGit } from '../src/util.js'

let root = ''
let savedPath: string | undefined

function touch(...parts: string[]): string {
  const file = path.join(root, ...parts)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '')
  return file
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tg-gitexe-layout-'))
  savedPath = process.env['PATH']
})

afterEach(() => {
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  rmSync(root, { recursive: true, force: true })
})

describe('realGitBehindLauncher', () => {
  it('maps cmd/git.exe to the mingw64 git beside it', () => {
    const launcher = touch('Git', 'cmd', 'git.exe')
    const real = touch('Git', 'mingw64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(real)
  })

  it('maps bin/git.exe of an older install to the mingw64 git beside it', () => {
    const launcher = touch('Git', 'bin', 'git.exe')
    const real = touch('Git', 'mingw64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(real)
  })

  it('prefers mingw64, then ucrt64, then clangarm64, then clang64, then mingw32', () => {
    const launcher = touch('Git', 'cmd', 'git.exe')
    const mingw32 = touch('Git', 'mingw32', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(mingw32)
    const clang = touch('Git', 'clang64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(clang)
    const arm = touch('Git', 'clangarm64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(arm)
    const ucrt = touch('Git', 'ucrt64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(ucrt)
    const mingw64 = touch('Git', 'mingw64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(mingw64)
  })

  // CAPTURE: the windows-latest image of 2026-10-17 (Git 2.56.0.windows.2), CI run 39003789603: `where git` listed C:/Program Files/Git/bin/git.exe, C:/Program Files/Git/cmd/git.exe and C:/Program Files/Git/ucrt64/bin/git.exe, and the real git of a timed-out run (pid 5456, ppid=5180) was alive after the call.
  it('maps the launchers of a Git for Windows that keeps its real git in ucrt64 (no mingw64 folder)', () => {
    const real = touch('Git', 'ucrt64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(touch('Git', 'cmd', 'git.exe'))).toBe(real)
    expect(realGitBehindLauncher(touch('Git', 'bin', 'git.exe'))).toBe(real)
  })

  // HAND-DERIVED from the fixed list in src/util.ts (mingw64 is named before ucrt64); which of the two Git's own launcher prefers when both exist is unverified.
  it('takes mingw64 over ucrt64 when both folders hold a git.exe', () => {
    const launcher = touch('Git', 'cmd', 'git.exe')
    touch('Git', 'ucrt64', 'bin', 'git.exe')
    const mingw64 = touch('Git', 'mingw64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(mingw64)
  })

  // HAND-DERIVED: a junction (symlink off Windows) to a folder holding bin/git.exe, under a name the fixed list does not carry, is the only real-git sibling; the expected path is the one through the link.
  it.skipIf(!CAN_JUNCTION)('follows a folder that is a junction or symlink when it is the only real git beside the launcher', () => {
    const launcher = touch('Git', 'cmd', 'git.exe')
    touch('Elsewhere', 'bin', 'git.exe')
    symlinkSync(path.join(root, 'Elsewhere'), path.join(root, 'Git', 'futuresys64'), 'junction')
    expect(realGitBehindLauncher(launcher)).toBe(path.join(root, 'Git', 'futuresys64', 'bin', 'git.exe'))
  })

  it('finds a real git in a folder it has no name for, and ignores the tool folders', () => {
    const launcher = touch('Git', 'cmd', 'git.exe')
    touch('Git', 'usr', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBeNull()
    const future = touch('Git', 'futuresys64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(launcher)).toBe(future)
  })

  it('answers null for a launcher with no real git beside it', () => {
    expect(realGitBehindLauncher(touch('Git', 'cmd', 'git.exe'))).toBeNull()
    expect(realGitBehindLauncher(touch('Other', 'bin', 'git.exe'))).toBeNull()
  })

  it('answers null for the real git itself and for a layout it does not know', () => {
    const real = touch('Git', 'mingw64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(real)).toBeNull()
    touch('Tools', 'mingw64', 'bin', 'git.exe')
    expect(realGitBehindLauncher(touch('Tools', 'apps', 'git.exe'))).toBeNull()
    expect(realGitBehindLauncher(touch('Git', 'cmd', 'gitk.exe'))).toBeNull()
  })
})

describe('gitExecutable', () => {
  it('is plain git off Windows, whatever the layout', () => {
    const launcher = touch('Git', 'cmd', 'git.exe')
    touch('Git', 'mingw64', 'bin', 'git.exe')
    expect(gitExecutable('linux', () => launcher)).toBe('git')
    expect(gitExecutable('darwin', () => launcher)).toBe('git')
  })

  it('starts the real git behind a cmd launcher, a bin launcher and a Scoop shim', () => {
    process.env['PATH'] = 'cmd-layout'
    const cmdLauncher = touch('GitCmd', 'cmd', 'git.exe')
    const cmdReal = touch('GitCmd', 'mingw64', 'bin', 'git.exe')
    expect(gitExecutable('win32', () => cmdLauncher)).toBe(cmdReal)

    process.env['PATH'] = 'bin-layout'
    const binLauncher = touch('GitBin', 'bin', 'git.exe')
    const binReal = touch('GitBin', 'mingw64', 'bin', 'git.exe')
    expect(gitExecutable('win32', () => binLauncher)).toBe(binReal)

    process.env['PATH'] = 'scoop-layout'
    const scoopCmd = touch('scoop', 'apps', 'git', 'current', 'cmd', 'git.exe')
    const scoopReal = touch('scoop', 'apps', 'git', 'current', 'mingw64', 'bin', 'git.exe')
    const shim = touch('scoop', 'shims', 'git.exe')
    writeFileSync(path.join(path.dirname(shim), 'git.shim'), `path = "${scoopCmd}"\r\n`)
    expect(gitExecutable('win32', () => shim)).toBe(scoopReal)
  })

  it('starts the target of a Scoop shim whose target is not a launcher', () => {
    process.env['PATH'] = 'shim-target'
    const target = touch('scoop', 'apps', 'git', 'current', 'git.exe')
    const shim = touch('scoop', 'shims', 'git.exe')
    writeFileSync(path.join(path.dirname(shim), 'git.shim'), `path = ${target}\n`)
    expect(gitExecutable('win32', () => shim)).toBe(target)
  })

  it('keeps plain git for a shim with arguments, a missing target or no shim file, and for an unmatched layout', () => {
    process.env['PATH'] = 'args'
    const withArgs = touch('s1', 'shims', 'git.exe')
    const target = touch('s1', 'apps', 'git.exe')
    writeFileSync(path.join(path.dirname(withArgs), 'git.shim'), `path = "${target}"\nargs = -c x=y\n`)
    expect(gitExecutable('win32', () => withArgs)).toBe('git')

    process.env['PATH'] = 'missing'
    const missing = touch('s2', 'shims', 'git.exe')
    writeFileSync(path.join(path.dirname(missing), 'git.shim'), `path = "${path.join(root, 's2', 'nowhere', 'git.exe')}"\n`)
    expect(gitExecutable('win32', () => missing)).toBe('git')

    process.env['PATH'] = 'noshim'
    expect(gitExecutable('win32', () => touch('s3', 'shims', 'git.exe'))).toBe('git')

    process.env['PATH'] = 'unmatched'
    expect(gitExecutable('win32', () => touch('Tools', 'git', 'git.exe'))).toBe('git')
    process.env['PATH'] = 'notfound'
    expect(gitExecutable('win32', () => null)).toBe('git')
  })

  it('looks again when PATH changes and not while it stays the same', () => {
    const first = touch('A', 'cmd', 'git.exe')
    const firstReal = touch('A', 'mingw64', 'bin', 'git.exe')
    const second = touch('B', 'bin', 'git.exe')
    const secondReal = touch('B', 'mingw64', 'bin', 'git.exe')
    let finds = 0

    process.env['PATH'] = 'path-one'
    expect(gitExecutable('win32', () => { finds++; return first })).toBe(firstReal)
    // Same PATH: the finder that would now answer differently is never asked.
    expect(gitExecutable('win32', () => { finds++; return second })).toBe(firstReal)
    expect(finds).toBe(1)

    process.env['PATH'] = 'path-two'
    expect(gitExecutable('win32', () => { finds++; return second })).toBe(secondReal)
    expect(finds).toBe(2)
  })

  // HAND-DERIVED: a spawn into a directory that does not exist fails with ENOENT on every platform, the same code a vanished git file gives.
  it('looks again after a spawn fails with ENOENT, though PATH is unchanged', () => {
    const first = touch('A', 'cmd', 'git.exe')
    const firstReal = touch('A', 'mingw64', 'bin', 'git.exe')
    const second = touch('B', 'bin', 'git.exe')
    const secondReal = touch('B', 'mingw64', 'bin', 'git.exe')

    process.env['PATH'] = 'enoent-path'
    expect(gitExecutable('win32', () => first)).toBe(firstReal)
    expect(gitExecutable('win32', () => second)).toBe(firstReal)

    const missingCwd = path.join(os.tmpdir(), 'tg-no-such-dir-for-enoent', 'x')
    expect(runGit(['--version'], { cwd: missingCwd }).exitCode).toBe(-1)

    expect(gitExecutable('win32', () => second)).toBe(secondReal)
  })
})
