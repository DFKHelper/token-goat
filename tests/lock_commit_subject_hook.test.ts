/** The commit-msg step that refuses a package-lock.json change under a non-dependency subject. It runs `scripts/lock-commit-subject.mjs` the way lefthook does (the message path as the argument, the repository as cwd) against a throwaway repository with a lock file staged. The repository is isolated from the user's git configuration and has no hooks installed, so nothing but the script under test judges the message. */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'lock-commit-subject.mjs')

let home: string
let repo: string

function env(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

function git(...args: string[]): void {
  execFileSync('git', ['-c', `core.hooksPath=${path.join(home, 'no-hooks')}`, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, env: env(), stdio: 'ignore' })
}

function hook(message: string): { status: number | null; stderr: string } {
  const file = path.join(home, 'COMMIT_EDITMSG')
  fs.writeFileSync(file, message)
  const r = spawnSync(process.execPath, [SCRIPT, file], { cwd: repo, env: env(), encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lock-hook-'))
  fs.writeFileSync(path.join(home, 'gitconfig'), '')
  repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('commit-msg: lock file changes', () => {
  it('refuses a fix commit that stages a lock file, naming the file and the subject', () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}')
    git('add', 'package-lock.json')
    const r = hook('fix(x): do a thing\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('package-lock.json')
    expect(r.stderr).toContain('fix(x): do a thing')
  })

  it('passes the same staged lock file under a chore(deps) subject', () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}')
    git('add', 'package-lock.json')
    const r = hook('chore(deps): bump a\n')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('reads the subject past comment lines and a leading blank line', () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}')
    git('add', 'package-lock.json')
    expect(hook('\n# Please enter the commit message\nchore(deps): bump a\n').status).toBe(0)
    expect(hook('\n# Please enter the commit message\nfix: a\n').status).toBe(1)
  })

  it('passes any subject when no lock file is staged', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b')
    git('add', 'a.txt')
    expect(hook('fix(x): do a thing\n').status).toBe(0)
  })

  it('refuses rather than passing when the staged files cannot be listed', () => {
    const file = path.join(home, 'COMMIT_EDITMSG')
    fs.writeFileSync(file, 'fix: a\n')
    const r = spawnSync(process.execPath, [SCRIPT, file], { cwd: home, env: env(), encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Refusing the commit')
  })
})
