/** The `prepare` script must satisfy two requirements that pull in opposite directions: 1. A dev checkout gets its git hooks wired up. Before lefthook was added as a devDependency with a `prepare` script, `.git/hooks` was empty and every guard in lefthook.yml was decorative -- so a `prepare` that quietly does nothing is a real regression, not a nit. 2. `npm install -g .` still succeeds. npm runs `prepare` in a context without this project's node_modules/.bin on PATH, where a bare `lefthook install` fails with "'lefthook' is not recognized" -- which broke the global install CLAUDE.md prescribes as the dogfood step for every CLI/hook change. Both are asserted against the real script, spawned as npm spawns it, with a fake lefthook shim standing in for the real binary so the assertion is about *invocation*, not about lefthook. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const SCRIPT_SRC = path.resolve(__dirname, '..', 'scripts', 'install-git-hooks.mjs')

let root: string

/** Lay out a fake project containing the real script, so `projectRoot` resolves inside the temp dir. */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prepare-'))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(SCRIPT_SRC, path.join(root, 'scripts', 'install-git-hooks.mjs'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** The environment minus git's repo-pointing variables, so a spawned git finds the repo in its cwd. */
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

/** Run git in `cwd` with the fixture-safe config: a fixed identity, no signing, no background gc or maintenance. */
function gitIn(cwd: string, args: string[]): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
    { cwd, encoding: 'utf8', env: CLEAN_ENV },
  )
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

/** Write a fake lefthook shim into <projectDir>/node_modules/.bin that records its argv to a marker file. On Windows npm creates a `.cmd` shim, elsewhere an extensionless shell script. */
function writeFakeLefthook(projectDir: string, markerPath: string): void {
  const binDir = path.join(projectDir, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'lefthook.cmd'), `@echo %* > "${markerPath}"\r\n`)
  } else {
    const shim = path.join(binDir, 'lefthook')
    fs.writeFileSync(shim, `#!/bin/sh\necho "$@" > "${markerPath}"\n`)
    fs.chmodSync(shim, 0o755)
  }
}

function runPrepare(projectDir: string = root): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(projectDir, 'scripts', 'install-git-hooks.mjs')], {
    cwd: projectDir,
    encoding: 'utf8',
    env: CLEAN_ENV,
  })
  return { status: r.status, stderr: r.stderr }
}

describe('prepare / install-git-hooks.mjs', () => {
  it('runs `lefthook install` when lefthook is present (a dev checkout)', () => {
    const marker = path.join(root, 'invoked.txt')
    writeFakeLefthook(root, marker)

    const { status } = runPrepare()

    expect(status).toBe(0)
    // The point of the script: lefthook must actually be invoked, with `install`.
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.readFileSync(marker, 'utf8')).toContain('install')
  })

  it('exits 0 without error when lefthook is absent (global / published install)', () => {
    // No node_modules/.bin at all -- the shape npm presents during `npm install -g .`.
    const { status, stderr } = runPrepare()

    expect(status).toBe(0)
    expect(stderr).toBe('')
  })

  it('propagates a failure when lefthook is present but fails', () => {
    // Absence is the only thing that may be skipped; a broken lefthook must still fail loudly, otherwise the hooks silently go back to being decorative.
    const binDir = path.join(root, 'node_modules', '.bin')
    fs.mkdirSync(binDir, { recursive: true })
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'lefthook.cmd'), '@exit /b 3\r\n')
    } else {
      const shim = path.join(binDir, 'lefthook')
      fs.writeFileSync(shim, '#!/bin/sh\nexit 3\n')
      fs.chmodSync(shim, 0o755)
    }

    expect(runPrepare().status).toBe(3)
  })

  it('skips lefthook install inside a linked worktree, and still invokes it in the main checkout', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prepare-wt-'))
    try {
      const main = path.join(base, 'main')
      const linked = path.join(base, 'linked')
      fs.mkdirSync(main)
      gitIn(main, ['init', '-q'])
      gitIn(main, ['commit', '-q', '--allow-empty', '-m', 'init'])
      gitIn(main, ['worktree', 'add', '-q', '--detach', linked])
      for (const dir of [main, linked]) {
        fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
        fs.copyFileSync(SCRIPT_SRC, path.join(dir, 'scripts', 'install-git-hooks.mjs'))
      }
      const markerMain = path.join(base, 'invoked-main.txt')
      const markerLinked = path.join(base, 'invoked-linked.txt')
      writeFakeLefthook(main, markerMain)
      writeFakeLefthook(linked, markerLinked)

      // Control: the main checkout still runs lefthook install, so the skip below is not a detector that always skips.
      expect(runPrepare(main).status).toBe(0)
      expect(fs.existsSync(markerMain)).toBe(true)

      // The linked worktree shares the main checkout's hooks, so installing from it must not run.
      expect(runPrepare(linked).status).toBe(0)
      expect(fs.existsSync(markerLinked)).toBe(false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
