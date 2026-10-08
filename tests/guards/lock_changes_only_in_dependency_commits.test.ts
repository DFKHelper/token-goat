/** A commit that changes a package-lock.json must be a dependency or release commit. The lefthook commit-msg hook (`scripts/lock-commit-subject.mjs`) stops one arriving through `git commit`; this scans what is about to be pushed, which also covers a rebase, an amend, or a clone that never installed the hooks. Both apply the one predicate, `lockSubjectProblem`. Commits already on origin/main are not rescanned: the rule is new, and history is not rewritten to satisfy it. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { lockSubjectProblem } from '../../scripts/lock-commit-subject.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RECORD = String.fromCharCode(0x1e)
const FIELD = String.fromCharCode(0x00)

/** Isolated from the user's git configuration and hooks, so a global template directory or hooksPath cannot run anything here. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

function git(cwd: string, home: string, args: string[]): string {
  return execFileSync('git', ['-c', `core.hooksPath=${path.join(home, 'no-hooks')}`, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Subjects of the commits in `range` that change a lock file under a subject the predicate refuses, or null when `base` does not exist. */
function offenders(cwd: string, env: NodeJS.ProcessEnv, base: string): string[] | null {
  const run = (args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    run(['rev-parse', '--verify', '--quiet', base])
  } catch {
    return null
  }
  const raw = run(['log', "--format=%x1e%H%x00%s%x00", '--name-only', `${base}..HEAD`])
  const found: string[] = []
  for (const record of raw.split(RECORD).filter((part) => part.trim() !== '')) {
    const [, subject, files] = record.split(FIELD)
    const changed = (files ?? '').split(/[\n\0]/).filter(Boolean)
    if (lockSubjectProblem(subject, changed) !== null) found.push(subject)
  }
  return found
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('lockSubjectProblem', () => {
  // HAND-DERIVED: the allowed prefixes are the ones git log shows this repository using, plus Dependabot's own chore(deps-dev); the refused ones are ordinary conventional subjects.
  it.each(['chore(deps): update lefthook to 2.1.15', 'chore(deps-dev): bump zod from 4.5.4 to 4.6.1', 'release: 2.9.30', 'chore(release): 2.9.19', 'Merge branch main'])('lets %s change a lock file', (subject) => {
    expect(lockSubjectProblem(subject, ['package-lock.json'])).toBeNull()
  })

  it.each(['fix: resync the lock file', 'fix(vscode): auto-repair a conflict', 'feat: a thing', 'chore: tidy', 'chore(deps)fix', 'releases: 2.9.30'])('refuses %s changing a lock file', (subject) => {
    expect(lockSubjectProblem(subject, ['src/a.ts', 'package-lock.json'])).toMatch(/package-lock\.json/)
  })

  it('also covers a lock file in a subdirectory, and ignores commits that touch none', () => {
    expect(lockSubjectProblem('fix: x', ['vscode-extension/package-lock.json'])).not.toBeNull()
    expect(lockSubjectProblem('fix: x', ['src/package-lock.json.ts', 'docs/package-lock.json.md'])).toBeNull()
  })
})

describe('unpushed commits', () => {
  it('change a lock file only under a dependency or release subject', (ctx) => {
    const found = offenders(ROOT, process.env, 'origin/main')
    // No origin/main (a fresh clone of a fork, a CI checkout of a detached ref) leaves nothing to compare against, which is a skip rather than a pass.
    if (found === null) return ctx.skip()
    expect(found, 'move the lock change into its own chore(deps) commit').toEqual([])
  })

  it('scan sees a lock change hidden in a fix commit and passes a dependency commit', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lock-subject-'))
    dirs.push(home)
    fs.writeFileSync(path.join(home, 'gitconfig'), '')
    const repo = path.join(home, 'repo')
    fs.mkdirSync(repo)
    git(repo, home, ['init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    git(repo, home, ['add', '.'])
    git(repo, home, ['commit', '-q', '-m', 'base'])
    git(repo, home, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}')
    git(repo, home, ['add', '.'])
    git(repo, home, ['commit', '-q', '-m', 'fix(x): touch the lock'])
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"a":1}')
    git(repo, home, ['add', '.'])
    git(repo, home, ['commit', '-q', '-m', 'chore(deps): bump a'])
    expect(offenders(repo, gitEnv(home), 'origin/main')).toEqual(['fix(x): touch the lock'])
    expect(offenders(repo, gitEnv(home), 'origin/missing')).toBeNull()
  })
})

describe('lefthook wiring', () => {
  it('runs the lock subject check on every commit message, handing it the message path', () => {
    const config = loadYaml(fs.readFileSync(path.join(ROOT, 'lefthook.yml'), 'utf8')) as { 'commit-msg'?: { commands?: Record<string, { run?: string; glob?: string }> } }
    const command = config['commit-msg']?.commands?.['lock-commit-subject']
    expect(command?.run).toBe('node scripts/lock-commit-subject.mjs {1}')
    // A glob would skip the commits whose files it does not match, and this check reads the staged list itself.
    expect(command?.glob).toBeUndefined()
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'lock-commit-subject.mjs'))).toBe(true)
  })
})
