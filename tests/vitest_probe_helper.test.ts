/** Cleanup of the .vitest-probe directory, several test files write generated tests into for a nested vitest run. CAPTURE, 2026-09-29: a full `npm test` failed tests/guards/test_process_inherits_no_token_goat_setting.test.ts with "No test files found, exiting with code 1" for its own probe, because retry_visibility_reporter.test.ts, running in another worker, removed the whole directory in afterAll between the probe's write and the nested run reading it. Provenance: HAND-DERIVED. The two-probe case follows from the contract alone (removing one probe leaves the other and the directory); the source scan reads the test tree live on every run. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { PROBE_DIR, removeProbe, writeProbe } from './helpers/vitest-probe.js'

// Not *.test.ts, so a nested run that happens to start now can never collect them.
const MINE = path.join(PROBE_DIR, 'zz_helper_probe_mine.txt')
const THEIRS = path.join(PROBE_DIR, 'zz_helper_probe_theirs.txt')

afterAll(() => {
  removeProbe(MINE)
  removeProbe(THEIRS)
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

describe('vitest probe cleanup', () => {
  it('removes only the caller’s probe, leaving another worker’s probe and the directory', () => {
    expect(writeProbe(path.basename(MINE), ['mine', ''])).toBe(MINE)
    writeProbe(path.basename(THEIRS), ['theirs', ''])
    removeProbe(MINE)
    expect(fs.existsSync(MINE)).toBe(false)
    expect(fs.readFileSync(THEIRS, 'utf8')).toBe('theirs\n')
    expect(fs.statSync(PROBE_DIR).isDirectory()).toBe(true)
  })

  it('creates the directory when it does not exist yet, as on a fresh checkout', () => {
    // The shared directory cannot be removed here without re-creating the race this file guards, so the real helper runs in a child whose cwd is an empty temp directory.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-probe-fresh-'))
    try {
      const helper = pathToFileURL(path.resolve('tests', 'helpers', 'vitest-probe.ts')).href
      // tsx by absolute URL: a bare `--import tsx` resolves from the child's cwd, which has no node_modules.
      const tsx = pathToFileURL(path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href
      const res = spawnSync(process.execPath, ['--import', tsx, '-e', `import(${JSON.stringify(helper)}).then((m) => m.writeProbe('fresh.txt', ['fresh', '']))`], {
        cwd,
        encoding: 'utf8',
      })
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0)
      expect(fs.readFileSync(path.join(cwd, path.basename(PROBE_DIR), 'fresh.txt'), 'utf8')).toBe('fresh\n')
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
