// Provenance: HAND-DERIVED from Ruling 50 (the class A, B, C gate for xargs) and review RGF4 of the guard.
// Each command is a shell line whose meaning follows from GNU xargs, grep, ls, du option parsing, fd, rg, git.
import { describe, expect, it } from 'vitest'
import { detectUnboundedWalk, type WalkContext } from '../src/unbounded_walk.js'

const POSIX: WalkContext = { windows: false, powershell: false }
const GIT_BASH_ON_WINDOWS: WalkContext = { windows: true, powershell: false }

function form(command: string, ctx: WalkContext): string | null {
  return detectUnboundedWalk(command, ctx)?.form ?? null
}

describe('xargs gate -- a walker spelling the detector never knew is refused with an unproven lister', () => {
  it.each<readonly [string, string]>([
    ['echo x / | xargs grep -r', 'xargs'],
    ['echo x / | xargs fd -e ts', 'xargs'],
    ['cat rootlist | xargs fd', 'xargs'],
    ['cat rootlist | xargs fd -e ts', 'xargs'],
    ['cat rootlist | xargs grep -d recurse x', 'xargs'],
    ['cat rootlist | xargs grep --directories=recurse x', 'xargs'],
    ['cat rootlist | xargs grep --rec x', 'xargs'],
    ['cat rootlist | xargs ls --recur', 'xargs'],
    ['echo rootlist | xargs du --files', 'xargs'],
    ['echo rootlist | xargs du --files0', 'xargs'],
    ['echo rootlist | xargs du --files0-f', 'xargs'],
    ['cat rootlist | xargs egrep -r x', 'xargs'],
    ['cat rootlist | xargs ls -R', 'xargs'],
    ['cat rootlist | xargs ls -lR', 'xargs'],
    ['cat rootlist | xargs dir -R', 'xargs'],
    ['cat rootlist | xargs grep -rn x', 'xargs'],
    ['cat rootlist | xargs grep -f x', 'xargs'],
    ['cat rootlist | xargs grep -e x y', 'xargs'],
    ['cat rootlist | xargs grep --include=x x', 'xargs'],
    ['cat rootlist | xargs ls --color', 'xargs'],
    ['cat rootlist | xargs ls /', 'xargs'],
    ['git ls-files | xargs vdir', 'xargs'],
    ['git ls-files | xargs fd', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })
})

describe('xargs gate -- class A: an obscured or unknown command word needs a proven lister', () => {
  it.each<readonly [string, string]>([
    ['echo / | xargs $D -s', 'xargs'],
    ['echo / | xargs "du" -s', 'xargs'],
    ["echo / | xargs $'\\x64u' -s", 'xargs'],
    ['echo / | xargs `echo du`', 'xargs'],
    ['git ls-files | xargs `echo du`', 'xargs'],
    ['git ls-files | xargs $(echo du)', 'xargs'],
    ['git ls-files | xargs -n 1 `echo du` -s', 'xargs'],
    ['cat rootlist | xargs -I{} rm {}', 'xargs'],
    ['git ls-files | xargs -a rootlist rm', 'xargs'],
    ['git ls-files | xargs --a=rootlist rm', 'xargs'],
    ['git ls-files | xargs -0a rootlist rm', 'xargs'],
    ['git ls-files | xargs --max-chars 100 du /', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })

  it.each([
    ['git ls-files | xargs -I{} rm {}'],
    ['git ls-files | xargs $D -s'],
  ])('lets %s through, since the stdin words are plain relative paths', (command) => {
    expect(form(command, POSIX)).toBeNull()
  })
})

describe('xargs gate -- class B: a walker word, in any spelling, never depends on spotting a flag', () => {
  it.each<readonly [string, string]>([
    ['echo / | xargs /usr/bin/du', 'xargs'],
    ['echo / | xargs ./du', 'xargs'],
    ['echo / | xargs du.exe', 'xargs'],
    ['echo / | xargs DU', 'xargs'],
    ['echo / | xargs env du', 'xargs'],
    ['echo / | xargs nice du', 'xargs'],
    ['echo / | xargs busybox du', 'xargs'],
    ['echo / | xargs bash -lc ls', 'xargs'],
    ['echo / | xargs timeout 5 du', 'xargs'],
    ['git ls-files | xargs sh -c wc', 'xargs'],
    ['git ls-files | xargs /usr/bin/du', 'xargs'],
    ['git ls-files | xargs du -L', 'xargs'],
    ['git ls-files | xargs du --files', 'xargs'],
    ['git ls-files | xargs tree -l', 'xargs'],
    ['git ls-files | xargs ls --color', 'xargs'],
    ['git ls-files | xargs DU', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })

  it.each([
    ['git ls-files | xargs du --max-depth=1'],
    ['git ls-files | xargs egrep -n x'],
    ['git ls-files | xargs ls -lR'],
    ['cat rootlist | xargs grep -e x'],
    ['cat rootlist | xargs grep -nH x'],
    ['cat rootlist | xargs ls'],
    ['cat rootlist | xargs ls -lahtSF'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})

describe('xargs gate -- class C and the rows that must stay allowed', () => {
  it.each([
    ['git ls-files | xargs du'],
    ['git ls-files -z | xargs -0 du -sh'],
    ['git diff --name-only | xargs ls -R'],
    ['fd -e ts src | xargs du -h'],
    ['echo src tests | xargs du -sh'],
    ["printf '%s\\n' src | xargs du"],
    ['find src -maxdepth 1 -type d | xargs du -sh'],
    ['ls src | xargs du'],
    ['ls -A src | xargs du'],
    ['git ls-files | xargs rg x'],
    ['git ls-files | xargs grep -n x'],
    ['cat rootlist | xargs grep x'],
    ['cat rootlist | xargs grep -n x'],
    ['cat rootlist | xargs ls -l'],
    ['cat list | xargs npm install'],
    ['git branch | xargs git branch -d'],
    ['cat list | xargs rm'],
    ['cat list | xargs wc -l'],
    ['echo a | xargs echo'],
    ['echo a | xargs'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})

describe('xargs gate -- lister details', () => {
  it.each<readonly [string, string]>([
    ['ls -a | xargs du', 'xargs'],
    ["printf '%s\\n' -x | xargs du", 'xargs'],
    ["printf '%s\\n' ~ | xargs du", 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })
})

describe('walk guard -- direct forms of GNU abbreviations', () => {
  it.each<readonly [string, string]>([
    ['grep --rec x /', 'grep'],
    ['grep --recur x /', 'grep'],
    ['grep --deref x /', 'grep'],
    ['grep -d recurse x /', 'grep'],
    ['grep -d rec x /', 'grep'],
    ['grep -ndrecurse x /', 'grep'],
    ['grep --directories=recurse x ~', 'grep'],
    ['grep --directories recurse x /', 'grep'],
    ['grep --dir=rec x /', 'grep'],
    ['grep --reg=x -r /', 'grep'],
    ['grep --regexp=x --rec /', 'grep'],
    ['ls --recur /', 'ls'],
    ['ls --rec ~', 'ls'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })

  it.each([
    ['grep x /etc/hosts'],
    ['ls -l /'],
    ['grep -d skip x /etc'],
    ['grep --directories=read x /etc'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})

describe('walk guard -- more root spellings', () => {
  it.each<readonly [string, string]>([
    ['du /proc/self/root', 'du'],
    ['du /proc/1234/root', 'du'],
    ['du /proc/1234/root/', 'du'],
    ['du //?/UNC/host/share', 'du'],
    ['du /mnt/wsl', 'du'],
    ['du /Volumes', 'du'],
    ['du /Volumes/Macintosh', 'du'],
    ['du ~+/..', 'du'],
    ['du ~-/..', 'du'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })

  it.each([
    ['du /proc/self/status'],
    ['du /Volumes/Macintosh/proj'],
    ['du //?/UNC/host/share/dir'],
    ['du /mnt/wsl/foo'],
    ['du ~+/x'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})
