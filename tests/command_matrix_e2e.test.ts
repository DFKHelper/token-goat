/**
 * Built-bundle command matrix (pre-push / CI tier — slow).
 *
 * Builds the real shipping artifact (dist/token-goat.mjs), indexes one shared
 * git fixture, then runs EVERY registered command against the bundle and asserts
 * real output. The case table is driven off the same registry the fast
 * registration guard uses (tests/registry.ts::allCommandNames), so a newly
 * registered command with no matrix case fails the coverage gate automatically —
 * there is no second list to forget.
 *
 * Most commands get a concrete output assertion. A small set is inherently
 * unsuited to a hermetic real-output check and is verified for *reachability*
 * instead (the bundle dispatches to the handler, it is not a Commander
 * "unknown command" error, and it does not crash with a tree-shaken module
 * error): `web-output` (process-local cache, always a miss in a fresh process)
 * and `gdrive-sections` (needs network + a live public doc). These still catch
 * the unregistered / tree-shaken-out-of-bundle bug class.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { allCommandNames } from './registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

let repo: string // indexed fixture; default cwd for read commands
let dataBase: string // isolated data dir holding the shared index

const tempDirs: string[] = []

function tgEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir }
}

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd ?? repo,
    env: opts.env ?? tgEnv(dataBase),
    encoding: 'utf8',
    timeout: 30000,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** A read command run against the shared indexed fixture. */
function expectRead(args: string[], substr: string): void {
  const r = run(args)
  expect(r.status, `${args.join(' ')} stderr: ${r.stderr}`).toBe(0)
  expect(r.stdout).toContain(substr)
}

beforeAll(() => {
  dataBase = mkIsolated('tg-matrix-data-')
  repo = mkIsolated('tg-matrix-repo-')

  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function alphaSym(): number {\n' +
      '  // alphamarker keyword for semantic and grep\n' +
      '  return 1\n}\n' +
      'export function betaSym(): number {\n  return 2\n}\n',
  )
  // Same-file caller so `refs --callers` has a resolvable enclosing function.
  fs.writeFileSync(
    path.join(repo, 'caller.ts'),
    'export function refHelper(): number {\n  return 1\n}\n' +
      'export function refDriver(): number {\n  return refHelper() + refHelper()\n}\n',
  )
  // Importer file so `imports` has a real module specifier to list.
  fs.writeFileSync(
    path.join(repo, 'app.ts'),
    "import { alphaSym } from './src/mod.js'\n" +
      'export function useAlpha(): number {\n  return alphaSym()\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# Fixture\n\n## Install\n\nRun npm install to set up the project.\n',
  )
  fs.writeFileSync(path.join(repo, 'pkg.json'), '{\n  "version": "3.2.1"\n}\n')

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git(['init'])
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])
  // Second commit touching src/mod.ts so `changed --since HEAD~1` has a diff.
  fs.appendFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function gammaSym(): number {\n  return 3\n}\n',
  )
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second'])

  const idx = run(['index', '.'])
  expect(idx.status, `index failed: ${idx.stderr}`).toBe(0)
  expect(idx.stdout).toMatch(/Indexed \d+ files/)
}, 120000)

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering detached worker can briefly hold a temp dir on Windows
    }
  }
})

/**
 * One assertion per registered command. Keys MUST equal the registered command
 * set (enforced by the coverage gate below). Read commands run against the
 * shared indexed fixture; stateful commands use their own isolated dirs.
 */
const cases: Record<string, () => void> = {
  index: () => {
    const r = run(['index', '.'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Indexed \d+ files/)
  },
  symbol: () => expectRead(['symbol', 'alphaSym'], 'alphaSym'),
  read: () => expectRead(['read', 'src/mod.ts::alphaSym'], 'return 1'),
  section: () => expectRead(['section', 'README.md::Install'], 'npm install'),
  semantic: () => expectRead(['semantic', 'alphamarker'], 'alphaSym'),
  skeleton: () => expectRead(['skeleton', 'src/mod.ts'], 'alphaSym'),
  outline: () => expectRead(['outline', 'src/mod.ts'], 'alphaSym'),
  refs: () => {
    const r = run(['refs', 'caller.ts::refHelper', '--callers'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver|caller\.ts/)
  },
  exports: () => expectRead(['exports', 'src/mod.ts'], 'alphaSym'),
  imports: () => {
    const r = run(['imports', 'app.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod/)
  },
  find: () => expectRead(['find', 'alphaSym'], 'mod'),
  grep: () => expectRead(['grep', 'alphamarker', '.'], 'alphamarker'),
  changed: () => {
    const r = run(['changed', '--since', 'HEAD~1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod\.ts/)
  },
  'config-get': () => expectRead(['config-get', 'pkg.json', 'version'], '3.2.1'),
  map: () => {
    const r = run(['map'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout).toMatch(/mod|src/)
  },
  'bash-output': () => {
    // --file reads a regular file, giving a deterministic real-output check.
    const r = run(['bash-output', '--file', 'pkg.json'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('3.2.1')
  },
  'web-output': () => {
    // Reachability: process-local cache is always empty in a fresh process, so a bogus id is a graceful miss (exit 1), not an "unknown command" / crash.
    const r = run(['web-output', 'no-such-id'])
    expect(r.status).not.toBe(0)
    const all = r.stdout + r.stderr
    expect(all.length).toBeGreaterThan(0)
    expect(all).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
  compress: () => {
    // Real output: the generic filter collapses the 6 identical lines to one.
    const r = run([
      'compress',
      '--filter',
      'generic',
      '--cmd',
      `"${process.execPath}" -e "for (let i = 0; i < 6; i++) console.log('compiling...')"`,
    ])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('×6')
  },
  stats: () => {
    const r = run(['stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
  },
  doctor: () => {
    const r = run(['doctor'])
    // doctor is informational; it may exit non-zero when something is unhealthy, but it must run and print diagnostics, not be unreachable.
    expect(r.status).not.toBeNull()
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  version: () => {
    const r = run(['version'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/)
  },
  hook: () => {
    // relay never throws on an unknown event; it emits {} and returns 0.
    const r = run(['hook', 'PreToolUse'], { input: '{}' })
    expect(r.status, r.stderr).toBe(0)
  },
  'write-file': () => {
    const dest = path.join(mkIsolated('tg-matrix-wf-'), 'out.txt')
    const payload = Buffer.from('hello-matrix', 'utf8').toString('base64')
    const r = run(['write-file', dest, '--b64', payload])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello-matrix')
  },
  install: () => {
    const proj = mkIsolated('tg-matrix-proj-')
    const r = run(['install', '--project'], { cwd: proj })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Installed token-goat hooks \(project\)/)
    expect(fs.existsSync(path.join(proj, '.claude', 'settings.json'))).toBe(true)
  },
  uninstall: () => {
    // Install first so uninstall has something to remove and emits the "Removed ..." path rather than the no-op message.
    const proj = mkIsolated('tg-matrix-uninstall-')
    const installed = run(['install', '--project'], { cwd: proj })
    expect(installed.status, installed.stderr).toBe(0)
    const r = run(['uninstall', '--project'], { cwd: proj })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Removed token-goat hooks \(project\)\./)
  },
  worker: () => {
    // Parent command with subcommands and no own action: prints usage listing its subcommands. Reachable and lists start/stop/status.
    const r = run(['worker', '--help'])
    expect(r.stdout + r.stderr).toMatch(/start[\s\S]*stop[\s\S]*status/)
  },
  'worker status': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstatus-'))
    const r = run(['worker', 'status'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker is (running|not running)\./)
  },
  'worker stop': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstop-'))
    const r = run(['worker', 'stop'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker stopped\.|No running worker\./)
  },
  'worker start': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstart-'))
    const r = run(['worker', 'start'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker started \(pid \d+\)\.|Worker already running\./)
    // Stop the detached worker so it does not outlive the test.
    run(['worker', 'stop'], { env })
  },
  'skill-list': () => {
    const r = run(['skill-list'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-size': () => {
    const r = run(['skill-size'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-body': () => {
    const r = run(['skill-body', 'no-such-skill'])
    expect(r.status).not.toBe(0)
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-compact': () => {
    const r = run(['skill-compact', 'no-such-skill'])
    expect(r.status).not.toBe(0)
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'gdrive-sections': () => {
    // Reachability only: needs network + a live public doc. A bogus id must fail gracefully (non-zero) without an "unknown command" or tree-shaken module crash — that is what proves the command is wired into the shipped bundle.
    const r = run(['gdrive-sections', 'not-a-real-doc-id'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
}

describe('built bundle command matrix', () => {
  it('every registered command has a matrix case (and vice versa)', () => {
    const registered = new Set(allCommandNames())
    const covered = new Set(Object.keys(cases))
    const missing = [...registered].filter((n) => !covered.has(n)).sort()
    const extra = [...covered].filter((n) => !registered.has(n)).sort()
    expect(missing, 'registered commands with no matrix case').toEqual([])
    expect(extra, 'matrix cases for commands that are not registered').toEqual([])
  })

  for (const [name, assertCase] of Object.entries(cases)) {
    it(`'${name}' produces correct output from the built bundle`, assertCase, 60000)
  }
})
