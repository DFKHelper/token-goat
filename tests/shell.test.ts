// Regression guard for the bash_compress Windows-shell fix (src/shell.ts).
//
// The bug: `token-goat compress` re-ran the inner bash command via spawnSync `shell: true`,
// which on Windows is cmd.exe — so $VAR/$(...)/redirects/quoting broke and commands failed
// with "The system cannot execute the specified program". The fix resolves the harness's
// Git-Bash and runs the command under it. The load-bearing, platform-independent piece is
// locateBashOnPath: it must pick a Git-Bash on PATH while skipping the WSL launcher dirs
// (System32 / SysWOW64 / WindowsApps), whose bash.exe runs the Linux filesystem and would
// resolve a Windows cwd against the WSL root. These tests drive that real function with a
// synthetic PATH + injected existence check, so they run and fail on every platform.
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  canRunWrappedShell,
  locateBashOnPath,
  resolveWindowsBash,
  wrappedShell,
} from '../src/shell.js'

// Colon-free synthetic dirs so the string survives a POSIX PATH split (delimiter ':') while
// still exercising the backslash-segment logic. Candidates are built with path.join so the
// injected existence check matches regardless of the host separator.
const WSL_DIR = 'root\\Windows\\System32'
const APPS_DIR = 'root\\Microsoft\\WindowsApps'
const GIT_DIR = 'root\\Git\\usr\\bin'
const wslBash = path.join(WSL_DIR, 'bash.exe')
const appsBash = path.join(APPS_DIR, 'bash.exe')
const gitBash = path.join(GIT_DIR, 'bash.exe')

const PATH_OF = (...dirs: string[]): string => dirs.join(path.delimiter)
const exists = (...present: string[]) => (p: string) => present.includes(p)

describe('locateBashOnPath', () => {
  it('returns the Git-Bash on PATH', () => {
    expect(locateBashOnPath(PATH_OF(GIT_DIR), exists(gitBash))).toBe(gitBash)
  })

  it('skips WSL-launcher dirs even when their bash.exe exists and precedes Git-Bash', () => {
    // Both a System32 and a WindowsApps bash.exe "exist" and sit before Git-Bash on PATH.
    // The resolver must skip both and return Git-Bash. This is the mutation anchor: drop the
    // WSL-launcher skip and this returns the System32 launcher instead.
    const found = locateBashOnPath(PATH_OF(WSL_DIR, APPS_DIR, GIT_DIR), exists(wslBash, appsBash, gitBash))
    expect(found).toBe(gitBash)
  })

  it('returns null when the only bash.exe is a WSL launcher', () => {
    expect(locateBashOnPath(PATH_OF(WSL_DIR, APPS_DIR), exists(wslBash, appsBash))).toBeNull()
  })

  it('does not treat a dir merely containing "system32" as a launcher', () => {
    // Segment matching, not substring: a real dir named e.g. system32-compat must not be skipped.
    const compatDir = 'root\\tools\\system32-compat'
    const compatBash = path.join(compatDir, 'bash.exe')
    expect(locateBashOnPath(PATH_OF(compatDir), exists(compatBash))).toBe(compatBash)
  })

  it('returns null for an empty or undefined PATH', () => {
    expect(locateBashOnPath('', exists(gitBash))).toBeNull()
    expect(locateBashOnPath(undefined, exists(gitBash))).toBeNull()
  })

  it('skips empty PATH entries without throwing', () => {
    expect(locateBashOnPath(PATH_OF('', GIT_DIR, ''), exists(gitBash))).toBe(gitBash)
  })
})

describe('shell resolution by platform', () => {
  const isWin = process.platform === 'win32'

  it('off Windows: resolveWindowsBash is null and the wrapper uses the POSIX shell', () => {
    if (isWin) return // POSIX-only assertions
    expect(resolveWindowsBash()).toBeNull()
    expect(wrappedShell()).toBe(true)
    expect(canRunWrappedShell()).toBe(true)
  })

  it('on Windows with Git-Bash present: wrapper runs under a resolved bash.exe', () => {
    if (!isWin) return
    const bash = resolveWindowsBash()
    if (bash === null) return // tri-state: skip only when no bash is installed, never silently pass
    expect(bash.toLowerCase()).toContain('bash')
    expect(wrappedShell()).toBe(bash)
    expect(canRunWrappedShell()).toBe(true)
  })
})
