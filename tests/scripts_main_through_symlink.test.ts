/** A script that runs its CLI only when it is the entry module must still do so when it is started through a symlinked directory. Node resolves the entry module's symlinks for import.meta.url but leaves process.argv[1] as written, so comparing the two straight skips the CLI silently with exit 0: on macOS every temp directory and /tmp sit behind a symlink (/var and /tmp point into /private), which made the pre-push focus decision see an empty record on the macOS CI job. Provenance is FORMAT-DERIVED: the Node ESM documentation ("import.meta.url", "--preserve-symlinks-main": the main module is resolved to its real path unless that flag is set) and macOS hier(7) (/tmp, /var and /etc are symbolic links into /private). Windows has no unprivileged file symlink, so a directory junction stands in; the check that proves it is the red run against the old comparison, quoted in the commit. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPTS = path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts')

let real = ''
let link = ''
afterEach(() => {
  // The real directory goes first, so removing the link can never reach into it
  if (real) rmSync(real, { recursive: true, force: true })
  if (link) {
    try {
      unlinkSync(link)
    } catch {
      try {
        rmdirSync(link)
      } catch {
        // already gone
      }
    }
  }
  real = ''
  link = ''
})

/** Copies the named scripts into a fresh directory and returns it by its real path and by a symlinked one. */
function stage(...names: string[]): { real: string; link: string } {
  real = mkdtempSync(path.join(tmpdir(), 'tg-symlink-main-'))
  link = `${real}-link`
  symlinkSync(real, link, 'junction')
  for (const n of names) copyFileSync(path.join(SCRIPTS, n), path.join(real, n))
  return { real, link }
}

function run(script: string, args: string[], cwd?: string): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout }
}

describe('a script started through a symlinked directory still runs its CLI', () => {
  it('prepush-failed.mjs records and reads a failing file', () => {
    const d = stage('prepush-failed.mjs', 'test-durations.mjs')
    const log = path.join(d.real, 'tests.log')
    writeFileSync(log, ' FAIL  tests/a.test.ts > a > fails\n Test Files  1 failed | 4 passed (5)\n')
    const store = path.join(d.real, 'store.json')
    const rec = run(path.join(d.link, 'prepush-failed.mjs'), ['record', store, 'win', 'abc123', log])
    expect(rec.stdout).toContain('recorded 1 failing file(s) for win')
    expect(JSON.parse(readFileSync(store, 'utf8')).win).toEqual({ sha: 'abc123', files: ['tests/a.test.ts'] })
    const read = run(path.join(d.link, 'prepush-failed.mjs'), ['read', store, 'win'])
    expect(read.stdout).toBe('abc123\ntests/a.test.ts\n')
  })

  it('test-durations.mjs rejects a missing log argument', () => {
    const d = stage('test-durations.mjs')
    expect(run(path.join(d.link, 'test-durations.mjs'), []).status).toBe(2)
  })

  it('prepush-tree-readers.mjs exits 1 for a tree with no readers', () => {
    const d = stage('prepush-tree-readers.mjs')
    expect(run(path.join(d.link, 'prepush-tree-readers.mjs'), [d.real]).status).toBe(1)
  })

  it('lock-commit-subject.mjs refuses a lock change under a plain subject', () => {
    const d = stage('lock-commit-subject.mjs')
    const repo = path.join(d.real, 'repo')
    mkdirSync(repo)
    const git = (...a: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: repo, stdio: 'ignore' })
    }
    git('init', '-q')
    writeFileSync(path.join(repo, 'package-lock.json'), '{}\n')
    git('add', '.')
    const msg = path.join(d.real, 'COMMIT_EDITMSG')
    writeFileSync(msg, 'feat: add a thing\n')
    expect(run(path.join(d.link, 'lock-commit-subject.mjs'), [msg], repo).status).toBe(1)
  })
})
