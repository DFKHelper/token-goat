/**
 * The suite's two retry mechanisms (vitest's CI-only `retry: 1` and the workflow's
 * nick-fields/retry around the whole run) are deliberate, but both hide flakes by construction:
 * a test that fails and then passes is reported exactly like one that passed first time. Two
 * consecutive green CI runs were audited and neither consumed a retry, so nothing is currently
 * masked -- but nothing would have SAID so if one had been, which is the gap this closes.
 *
 * The reporter is deliberately non-fatal: failing the build on a consumed retry would re-create
 * the exact problem the retry was added to solve.
 *
 * The end-to-end test at the bottom is the load-bearing one. The first draft of this reporter
 * guessed the vitest API (`onFinished`, `result.retryCount`, `state === 'pass'`) and every
 * hand-built-task-tree unit test passed against that guess while the reporter never fired on a
 * real retry -- the injected-seam trap CLAUDE.md warns about, where the test supplies the very
 * shape the shipping path gets wrong. Spawning a genuinely flaky test is what catches that.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import RetryVisibilityReporter, { collectRetriedTests, formatRetryReport } from './setup/retry-visibility-reporter.js'

/** Build one module whose single test carries the given diagnostic, matching vitest 4's shape. */
function mod(flaky: boolean, retryCount: number, name = 'some test'): Array<Record<string, unknown>> {
  return [
    {
      relativeModuleId: 'tests/example.test.ts',
      children: { allTests: () => [{ name, diagnostic: () => ({ retryCount, flaky }) }] },
    },
  ]
}

describe('collectRetriedTests', () => {
  it('reports a test that failed once and then passed', () => {
    const found = collectRetriedTests(mod(true, 1))
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('some test')
    expect(found[0]?.file).toBe('tests/example.test.ts')
    expect(found[0]?.retryCount).toBe(1)
  })

  it('stays silent on a clean pass, so a healthy run is unchanged', () => {
    expect(collectRetriedTests(mod(false, 0))).toEqual([])
  })

  it('ignores a test that retried and still failed, which is already reported as a failure', () => {
    // vitest sets flaky only for "failed then passed"; a still-failing retry would be
    // double-reported on an already-red build.
    expect(collectRetriedTests(mod(false, 2))).toEqual([])
  })

  it('tolerates a module with no tests, and an empty run', () => {
    expect(collectRetriedTests([{ relativeModuleId: 'tests/empty.test.ts', children: { allTests: () => [] } }])).toEqual([])
    expect(collectRetriedTests([])).toEqual([])
  })

  it('falls back to moduleId when relativeModuleId is absent', () => {
    const found = collectRetriedTests([
      { moduleId: '/abs/tests/x.test.ts', children: { allTests: () => [{ name: 't', diagnostic: () => ({ retryCount: 1, flaky: true }) }] } },
    ])
    expect(found[0]?.file).toBe('/abs/tests/x.test.ts')
  })
})

describe('formatRetryReport', () => {
  it('names the file, the test, and the retry count', () => {
    const text = formatRetryReport([{ name: 'flaky thing', file: 'tests/a.test.ts', retryCount: 1 }])
    expect(text).toContain('FLAKE WARNING')
    expect(text).toContain('tests/a.test.ts')
    expect(text).toContain('flaky thing')
    expect(text).toContain('retries: 1')
  })
})

describe('RetryVisibilityReporter', () => {
  /** Run the reporter with stderr captured. */
  function capture(modules: Array<Record<string, unknown>>): string {
    let written = ''
    const orig = process.stderr.write.bind(process.stderr)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = (s: string) => { written += s; return true }
    try {
      new RetryVisibilityReporter().onTestRunEnd(modules)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = orig
    }
    return written
  }

  it('writes nothing at all when no test was retried', () => {
    expect(capture(mod(false, 0))).toBe('')
  })

  it('writes the warning to stderr when a retry was consumed', () => {
    const written = capture(mod(true, 1, 'the flaky one'))
    expect(written).toContain('FLAKE WARNING')
    expect(written).toContain('the flaky one')
  })

  it('does not throw when the job-summary path is unwritable', () => {
    // A summary write failing must never take down an otherwise-green run.
    const prev = process.env.GITHUB_STEP_SUMMARY
    process.env.GITHUB_STEP_SUMMARY = path.join(path.sep, 'nonexistent-dir-for-test', 'summary.md')
    try {
      expect(() => capture(mod(true, 1))).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY
      else process.env.GITHUB_STEP_SUMMARY = prev
    }
  })
})

// ---- end-to-end against a genuinely retried test ---------------------------------------------

// Deliberately outside tests/. This file is created and deleted while the rest of the suite is
// running, and several guards walk tests/ listing every entry and then reading each one, so with it
// in there one of them would eventually list it and find it already gone: an ENOENT failure in a
// guard that has nothing to do with retries, blaming a file it never meant to read. Vitest's
// default include glob covers the whole repo apart from node_modules, dist and .claude, so a probe
// here is still collected and still matched by the filter the spawn below passes, while being
// somewhere no tests/ walker will ever look. The directory is gitignored and removed with the file.
const PROBE_DIR = path.resolve('.vitest-probe')
const TMP_FLAKY = path.join(PROBE_DIR, 'zz_generated_flaky_probe.test.ts')

afterAll(() => {
  fs.rmSync(PROBE_DIR, { recursive: true, force: true })
})

describe('reporter against the real vitest API', () => {
  // Regression: the probe used to be written into tests/ and deleted in afterAll, while
  // temp_config_isolation.test.ts lists every entry of tests/ and reads each one. Running in
  // separate workers, that guard listed the probe and then failed with ENOENT reading it, pointing
  // at a file it never meant to check. Nothing pinned where the probe lives, so this is the missing
  // half: it fails if the probe moves back under tests/, and the end-to-end test below fails if it
  // moves somewhere vitest does not collect, so the two together bracket the valid locations.
  it('writes its generated probe outside tests/, where no directory walker can race it', () => {
    expect(path.relative(path.resolve('tests'), TMP_FLAKY).startsWith('..')).toBe(true)
  })

  it('fires on a test that actually failed and passed on retry', () => {
    // A module-level counter makes attempt 1 fail and attempt 2 pass, so vitest genuinely marks
    // the test flaky rather than us asserting our own idea of its task shape.
    fs.mkdirSync(PROBE_DIR, { recursive: true })
    fs.writeFileSync(
      TMP_FLAKY,
      [
        "import { expect, it } from 'vitest'",
        'let attempts = 0',
        "it('generated probe: fails once then passes', () => {",
        '  attempts += 1',
        '  expect(attempts).toBeGreaterThan(1)',
        '})',
        '',
      ].join('\n'),
    )

    const res = spawnSync(
      process.execPath,
      [path.resolve('node_modules', 'vitest', 'vitest.mjs'), 'run', 'zz_generated_flaky_probe', '--retry=1'],
      { encoding: 'utf8', env: { ...process.env, CI: '' } },
    )
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`

    // The run itself must be GREEN -- the retry absorbed the failure, which is the whole
    // scenario. If this were red the reporter's output would prove nothing.
    expect(res.status, combined.slice(-2000)).toBe(0)
    // ...and the reporter must nonetheless have named it. This is the assertion the first draft
    // of this file could not make, and the one that catches an API-shape drift.
    expect(combined).toContain('FLAKE WARNING')
    expect(combined).toContain('generated probe: fails once then passes')
    expect(combined).toContain('retries: 1')
  }, 120_000)
})
