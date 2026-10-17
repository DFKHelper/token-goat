/** The pre-push focus decision (.lefthook-scripts/prepush-focus.sh) in a sandbox repo: a src change must add the tests `vitest related` cannot reach, and an empty range must not be counted as one change. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWindowsBash } from '../src/shell.js'
import { readsTreeOrBundle } from '../scripts/prepush-tree-readers.mjs'
import { CAN_JUNCTION } from './helpers/can-symlink.js'

const REPO = process.cwd().replace(/\\/g, '/')
const posix = (p: string): string => p.replace(/\\/g, '/')
// Git Bash on Windows, never the WSL launcher that a bare bash resolves to there; null skips the suite where no bash exists
const BASH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/bash'
// The script pipes through sort, which must be the POSIX one next to bash and not Windows sort.exe that a System32-first PATH finds
let dir = ''
let realDir = ''
afterEach(() => {
  // The real directory goes first, so removing the link can never reach into it
  if (realDir) rmSync(realDir, { recursive: true, force: true })
  if (dir) {
    try {
      unlinkSync(dir)
    } catch {
      try {
        rmdirSync(dir)
      } catch {
        // already gone
      }
    }
  }
  dir = ''
  realDir = ''
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

/** A sandbox repo with one recorded failing test, then the given files changed in a second commit. Returns the decision note and the focus list. */
function decide(change: Record<string, string>, shadowSort = false): { note: string; focus: string[] } {
  // The sandbox is reached through a symlink, as every macOS temp directory is (/var points into /private): a script that mistakes a symlinked path for a different file does nothing here
  realDir = mkdtempSync(path.join(tmpdir(), 'tg-focus-'))
  dir = `${realDir}-link`
  symlinkSync(realDir, dir, 'junction')
  const root = path.join(dir, 'repo')
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  for (const f of ['prepush-failed.mjs', 'test-durations.mjs', 'prepush-tree-readers.mjs', 'is-main-module.mjs']) copyFileSync(path.join(REPO, 'scripts', f), path.join(root, 'scripts', f))
  write(root, 'src/a.ts', 'export const a = 1\n')
  write(root, 'tests/a.test.ts', "import { a } from '../src/a'\n")
  write(root, 'tests/bundle_user.test.ts', "import { BUNDLE } from './helpers/bundle'\n")
  write(root, 'tests/guards/tree.test.ts', 'export {}\n')
  write(root, 'tests/other.test.ts', 'export {}\n')
  git(dir, 'init', '-q', 'repo')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  const base = git(root, 'rev-parse', 'HEAD')
  const log = path.join(dir, 'tests.log')
  writeFileSync(log, ' FAIL  tests/a.test.ts > a > fails\n Test Files  1 failed | 4 passed (5)\n')
  const store = path.join(dir, 'store.json')
  execFileSync(process.execPath, [path.join(root, 'scripts/prepush-failed.mjs'), 'record', store, 'win', base, log])
  for (const [rel, text] of Object.entries(change)) write(root, rel, text)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'two')
  const head = git(root, 'rev-parse', 'HEAD')
  const script = [
    `ROOT_DIR='${posix(root)}'`,
    `LOG_DIR='${posix(dir)}'`,
    `HEAD_SHA='${head}'`,
    `source '${posix(path.join(REPO, '.lefthook-scripts/prepush-focus.sh'))}'`,
    `FAILED_STORE='${posix(store)}'`,
    'focus_decide win',
    'echo "NOTE=$FOCUS_NOTE"',
    'echo "FILE=$FOCUS_FILE"',
  ].join('\n')
  // A failing sort first on PATH stands in for Windows sort.exe ahead of Git's usr/bin: a bare `sort` in the script would lose the focus list
  const shadow = path.join(dir, 'shadow')
  mkdirSync(shadow)
  writeFileSync(path.join(shadow, 'sort'), '#!/bin/sh\necho "not the POSIX sort" >&2\nexit 1\n', { mode: 0o755 })
  const lead = shadowSort ? `${shadow}${path.delimiter}` : ''
  const out = execFileSync(BASH ?? 'bash', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${lead}${path.dirname(BASH ?? '')}${path.delimiter}${process.env['PATH'] ?? ''}` } })
  const note = /^NOTE=(.*)$/m.exec(out)?.[1] ?? ''
  const file = /^FILE=(.*)$/m.exec(out)?.[1]?.trim() ?? ''
  return { note, focus: file ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [] }
}

describe.skipIf(BASH === null || !CAN_JUNCTION)('prepush focus decision', () => {
  it('adds the tree-reading and bundle tests when a src file changed', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' })
    expect(r.focus).toEqual(['src/a.ts', 'tests/a.test.ts', 'tests/bundle_user.test.ts', 'tests/guards/tree.test.ts'])
    expect(r.note).toContain('2 tree-reading or bundle tests')
  })

  it('still sorts with the POSIX sort when another sort leads PATH', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' }, true)
    expect(r.focus).toEqual(['src/a.ts', 'tests/a.test.ts', 'tests/bundle_user.test.ts', 'tests/guards/tree.test.ts'])
  })

  it('does not add them when only a test changed', () => {
    const r = decide({ 'tests/other.test.ts': 'export const x = 1\n' })
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/other.test.ts'])
  })
})

describe('readsTreeOrBundle', () => {
  it('flags a bundle spawner and an fs read of src, not a plain import', () => {
    expect(readsTreeOrBundle("import { BUNDLE } from './helpers/bundle'")).toBe(true)
    expect(readsTreeOrBundle("readFileSync(join(ROOT, 'src', 'x.ts'), 'utf8')")).toBe(true)
    expect(readsTreeOrBundle("import { x } from '../src/x'\nreadFileSync(tmpFile)")).toBe(false)
  })
})

describe.skipIf(BASH === null || !CAN_JUNCTION)('prepush focus note', () => {
  it('counts an empty range as no change', () => {
    const r = decide({})
    expect(r.note).toContain('0 changed since')
    expect(r.focus).toEqual(['tests/a.test.ts'])
  })

  it('counts each changed path once', () => {
    expect(decide({ 'tests/other.test.ts': 'export const x = 1\n' }).note).toContain('1 changed since')
  })
})
