/** Cleanup of the .vitest-probe directory, several test files write generated tests into for a nested vitest run. CAPTURE, 2026-09-29: a full `npm test` failed tests/guards/test_process_inherits_no_token_goat_setting.test.ts with "No test files found, exiting with code 1" for its own probe, because retry_visibility_reporter.test.ts, running in another worker, removed the whole directory in afterAll between the probe's write and the nested run reading it. CAPTURE, 2026-10-11: two loops running `vitest run tests/guards` in one worktree failed that guard and test_process_inherits_no_harness_session_env.test.ts 6 times in 21 pairs of runs, with "No test files found" or "Cannot find module '/@id/...'", because both runs wrote the same probe name and the afterAll of one removed the file the other's nested run was about to collect. Provenance: HAND-DERIVED. The two-probe and two-process cases follow from the contract alone (removing one probe leaves the other and the directory); the source scan reads the test tree live on every run. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { PROBE_DIR, probePath, removeProbe, writeProbe } from './helpers/vitest-probe.js'

// Not *.test.ts, so a nested run that happens to start now can never collect them.
const MINE = probePath('zz_helper_probe_mine.txt')
const THEIRS = probePath('zz_helper_probe_theirs.txt')
const SHARED = 'zz_helper_probe_shared.txt'

afterAll(() => {
  removeProbe(MINE)
  removeProbe(THEIRS)
  removeProbe(probePath(SHARED))
})

function testSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Dot-prefixed entries are other tests' scratch directories, created and removed mid-run; tests_tree_walkers_skip_scratch_dirs.test.ts says why.
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'fixtures') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testSources(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Runs `body` with the real helper bound to `m` in a separate node process whose cwd is `cwd`. */
function inChild(cwd: string, body: string): SpawnSyncReturns<string> {
  const helper = pathToFileURL(path.resolve('tests', 'helpers', 'vitest-probe.ts')).href
  // tsx by absolute URL: a bare `--import tsx` resolves from the child's cwd, which may have no node_modules.
  const tsx = pathToFileURL(path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href
  return spawnSync(process.execPath, ['--import', tsx, '-e', `import(${JSON.stringify(helper)}).then((m) => { ${body} })`], { cwd, encoding: 'utf8' })
}

describe('vitest probe cleanup', () => {
  it('removes only the caller’s probe, leaving another worker’s probe and the directory', () => {
    expect(writeProbe('zz_helper_probe_mine.txt', ['mine', ''])).toBe(MINE)
    writeProbe('zz_helper_probe_theirs.txt', ['theirs', ''])
    removeProbe(MINE)
    expect(fs.existsSync(MINE)).toBe(false)
    expect(fs.readFileSync(THEIRS, 'utf8')).toBe('theirs\n')
    expect(fs.statSync(PROBE_DIR).isDirectory()).toBe(true)
  })

  it('names a probe after the process that wrote it and keeps the extension vitest collects by', () => {
    expect(probePath('zz_helper_probe_named.test.ts')).toBe(path.join(PROBE_DIR, `zz_helper_probe_named.${process.pid}.test.ts`))
  })

  it('keeps this process’s probe when another process writes and removes one of the same name, as a second run in the same checkout does', () => {
    const mine = writeProbe(SHARED, ['mine', ''])
    const res = inChild(process.cwd(), `const f = m.writeProbe(${JSON.stringify(SHARED)}, ['theirs', '']); m.removeProbe(f); process.stdout.write(f)`)
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0)
    expect(fs.readFileSync(mine, 'utf8')).toBe('mine\n')
    expect(res.stdout).not.toBe(mine)
  }, 60_000)

  it('clears a probe no running process owns before writing, since an unfiltered run would collect it', () => {
    // No process can hold pid 2**30: Linux caps pid_max at 2**22, macOS at 99999, and Windows answers ESRCH for it.
    const orphan = path.join(PROBE_DIR, 'zz_helper_probe_orphan.1073741824.txt')
    // Named as probes were before they carried a pid, so a leftover from that time goes too.
    const unnumbered = path.join(PROBE_DIR, 'zz_helper_probe_unnumbered.txt')
    fs.mkdirSync(PROBE_DIR, { recursive: true })
    fs.writeFileSync(orphan, 'orphan\n')
    fs.writeFileSync(unnumbered, 'unnumbered\n')
    expect(writeProbe('zz_helper_probe_mine.txt', ['mine', ''])).toBe(MINE)
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.existsSync(unnumbered)).toBe(false)
    expect(fs.readFileSync(MINE, 'utf8')).toBe('mine\n')
  })

  it('creates the directory when it does not exist yet, as on a fresh checkout', () => {
    // The shared directory cannot be removed here without re-creating the race this file guards, so the real helper runs in a child whose cwd is an empty temp directory.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-probe-fresh-'))
    try {
      const res = inChild(cwd, "process.stdout.write(m.writeProbe('fresh.txt', ['fresh', '']))")
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0)
      const dir = path.join(cwd, path.basename(PROBE_DIR))
      expect(fs.readdirSync(dir)).toEqual([path.basename(res.stdout)])
      expect(fs.readFileSync(path.join(dir, path.basename(res.stdout)), 'utf8')).toBe('fresh\n')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 60_000)

  it('tolerates a probe that is already gone', () => {
    expect(() => removeProbe(path.join(PROBE_DIR, 'zz_helper_probe_never_written.txt'))).not.toThrow()
  })

  it('leaves the directory to the helper: no other test names it or removes it', () => {
    const helper = path.resolve('tests', 'helpers', 'vitest-probe.ts')
    const offenders = testSources(path.resolve('tests'))
      .filter((file) => file !== helper)
      .filter((file) => {
        const src = fs.readFileSync(file, 'utf8')
        return /['"`]\.vitest-probe['"`/]/.test(src) || /\brm(?:dir)?Sync\(\s*PROBE_DIR\b/.test(src)
      })
      .map((file) => path.relative(process.cwd(), file))
    expect(offenders, 'use writeProbe/removeProbe from tests/helpers/vitest-probe.ts').toEqual([])
  })
})
