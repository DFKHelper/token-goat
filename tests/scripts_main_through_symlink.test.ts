/** A script that runs its CLI only when it is the entry module must still do so when it is started through a symlinked directory, and must not crash when the entry path cannot be resolved. Node resolves the entry module's symlinks for import.meta.url but leaves process.argv[1] as written, so comparing the two straight skips the CLI silently with exit 0: on macOS every temp directory and /tmp sit behind a symlink (/var and /tmp point into /private), which made the pre-push focus decision see an empty record on the macOS CI job. Provenance is FORMAT-DERIVED: the Node ESM documentation ("import.meta.url", "--preserve-symlinks-main": the main module is resolved to its real path unless that flag is set) and macOS hier(7) (/tmp, /var and /etc are symbolic links into /private). Windows has no unprivileged file symlink, so a directory junction stands in, and a box that cannot create one skips these tests; the check that proves them is the red run against the old comparison, quoted in the commit. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isMainModule } from '../scripts/is-main-module.mjs'
import { CAN_JUNCTION } from './helpers/can-symlink.js'

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

/** Copies the named scripts and the entry-module helper into a fresh directory and returns it by its real path and by a symlinked one. */
function stage(...names: string[]): { real: string; link: string } {
  real = mkdtempSync(path.join(tmpdir(), 'tg-symlink-main-'))
  link = `${real}-link`
  if (CAN_JUNCTION) symlinkSync(real, link, 'junction')
  for (const n of [...names, 'is-main-module.mjs']) copyFileSync(path.join(SCRIPTS, n), path.join(real, n))
  return { real, link }
}

function run(script: string, args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe.skipIf(!CAN_JUNCTION)('a script started through a symlinked directory still runs its CLI', () => {
  it('prepush-failed.mjs records and reads a failing file', () => {
    const d = stage('prepush-failed.mjs', 'test-durations.mjs')
    const log = path.join(d.real, 'tests.log')
    writeFileSync(log, ' FAIL  tests/a.test.ts > a > fails\n Test Files  1 failed | 4 passed (5)\n')
    const store = path.join(d.real, 'store.json')
    const rec = run(path.join(d.link, 'prepush-failed.mjs'), ['record', store, 'win', 'abc123', log])
    expect(rec.stderr).toBe('')
    expect(rec.stdout).toContain('recorded 1 failing file(s) for win')
    expect(JSON.parse(readFileSync(store, 'utf8')).win).toEqual({ sha: 'abc123', files: ['tests/a.test.ts'] })
    const read = run(path.join(d.link, 'prepush-failed.mjs'), ['read', store, 'win'])
    expect(read.stdout).toBe('abc123\ntests/a.test.ts\n')
  })

  it('test-durations.mjs prints its usage and exits 2 for a missing log argument', () => {
    const d = stage('test-durations.mjs')
    const r = run(path.join(d.link, 'test-durations.mjs'), [])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage: node scripts/test-durations.mjs LOG')
  })

  it('prepush-graph.mjs lists a test that imports a changed module', () => {
    const d = stage('prepush-graph.mjs')
    for (const sub of ['src', 'tests', 'scripts']) mkdirSync(path.join(d.real, sub))
    writeFileSync(path.join(d.real, 'src', 'a.ts'), 'export {}\n')
    writeFileSync(path.join(d.real, 'tests', 'b.test.ts'), "import '../src/a.js'\n")
    const r = run(path.join(d.link, 'prepush-graph.mjs'), [d.real, 'src/a.ts'])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('1\ttests/b.test.ts\n')
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
    const r = run(path.join(d.link, 'lock-commit-subject.mjs'), [msg], repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('its subject must start with chore(deps), chore(release) or release; got: feat: add a thing')
  })
})

describe('importing a script whose entry path does not exist', () => {
  for (const name of ['prepush-failed.mjs', 'prepush-graph.mjs', 'test-durations.mjs', 'lock-commit-subject.mjs']) {
    it(`${name} imports cleanly and runs no CLI`, () => {
      const d = stage(name, 'test-durations.mjs')
      const url = pathToFileURL(path.join(d.real, name)).href
      const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(() => console.log('imported'))`, 'no-such-entry-script'], { encoding: 'utf8' })
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('imported\n')
      expect(r.status).toBe(0)
    })
  }
})

describe('isMainModule', () => {
  const here = pathToFileURL(path.join(SCRIPTS, 'is-main-module.mjs')).href
  it('is true for the module started directly', () => {
    expect(isMainModule(here, path.join(SCRIPTS, 'is-main-module.mjs'))).toBe(true)
  })
  it('is false for another entry, a missing entry and no entry at all', () => {
    expect(isMainModule(here, path.join(SCRIPTS, 'test-durations.mjs'))).toBe(false)
    expect(isMainModule(here, path.join(SCRIPTS, 'no-such-script.mjs'))).toBe(false)
    expect(isMainModule(here, '')).toBe(false)
    expect(isMainModule(here, undefined)).toBe(false)
  })
  it('is false rather than a throw for a module URL that is not a file URL', () => {
    expect(isMainModule('data:text/javascript,0', path.join(SCRIPTS, 'is-main-module.mjs'))).toBe(false)
  })
  it.skipIf(!CAN_JUNCTION)('is true when the entry is reached through a symlinked directory', () => {
    const d = stage()
    expect(isMainModule(pathToFileURL(path.join(d.real, 'is-main-module.mjs')).href, path.join(d.link, 'is-main-module.mjs'))).toBe(true)
  })
})
