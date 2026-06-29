/**
 * Tests for the CI/security-scanner filter family (Batch H).
 *
 * Covers: GhRunLogFilter, GhFilter (including *_url stripping), ActFilter,
 * GenericCIFilter, PreCommitFilter, BanditFilter, TrivyFilter, SnykFilter,
 * SemgrepFilter.
 *
 * Ported from:
 *   tests/test_bash_compress_ci.py
 *   tests/test_bash_compress_security.py
 *   tests/test_bash_compress_gh_enhanced.py
 *   tests/test_bash_compress_pre_commit_enhanced.py
 */
import { describe, expect, it } from 'vitest'

import {
  GhRunLogFilter,
  GhFilter,
  ActFilter,
  GenericCIFilter,
  PreCommitFilter,
  BanditFilter,
  TrivyFilter,
  SnykFilter,
  SemgrepFilter,
  CI_FILTERS,
} from '../src/tool_filters/ci.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(
  filter: { compress: (a: string, b: string, c: number, d: string[]) => string },
  stdout: string,
  argv: string[],
  { stderr = '', exitCode = 0 } = {},
): string {
  return filter.compress(stdout, stderr, exitCode, argv)
}

// ---------------------------------------------------------------------------
// GhRunLogFilter — dispatch
// ---------------------------------------------------------------------------

describe('GhRunLogFilter dispatch', () => {
  const f = new GhRunLogFilter()

  it('matches gh run view with --log', () => {
    expect(f.matches(['gh', 'run', 'view', '123456789', '--log'])).toBe(true)
  })

  it('matches with --exit-status after --log', () => {
    expect(f.matches(['gh', 'run', 'view', '123456789', '--log', '--exit-status'])).toBe(true)
  })

  it('does not match gh run view without --log', () => {
    expect(f.matches(['gh', 'run', 'view', '123456789'])).toBe(false)
  })

  it('does not match gh pr view', () => {
    expect(f.matches(['gh', 'pr', 'view', '42'])).toBe(false)
  })

  it('selectFilter returns GhRunLogFilter for gh run view --log', () => {
    expect(selectFilter(['gh', 'run', 'view', '123456789', '--log'])).toBeInstanceOf(
      GhRunLogFilter,
    )
  })

  it('plain gh run view still uses GhFilter', () => {
    expect(selectFilter(['gh', 'run', 'view', '123456789'])).toBeInstanceOf(GhFilter)
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — timestamp stripping
// ---------------------------------------------------------------------------

describe('GhRunLogFilter timestamp stripping', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('strips ISO-8601 timestamp prefix', () => {
    const out = f.compress(
      '2024-01-15T12:34:56.1234567Z Set up job\n2024-01-15T12:34:57.0000000Z Run actions/checkout@v4\n',
      '',
      0,
      argv,
    )
    expect(out).not.toContain('2024-01-15T')
    expect(out).toContain('Set up job')
  })

  it('preserves line content after timestamp', () => {
    const out = f.compress('2024-06-01T00:00:00.0000000Z hello world\n', '', 0, argv)
    expect(out).toContain('hello world')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — setup action collapsing
// ---------------------------------------------------------------------------

describe('GhRunLogFilter setup action collapsing', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('collapses setup action lines into a summary', () => {
    const lines = [
      'Run actions/checkout@v4',
      'Run actions/setup-node@v3',
      'Run actions/cache@v3',
    ].join('\n')
    const out = f.compress(lines, '', 0, argv)
    expect(out).not.toContain('Run actions/checkout@v4')
    expect(out).toContain('3 action(s) collapsed')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — boilerplate dropping
// ---------------------------------------------------------------------------

describe('GhRunLogFilter boilerplate dropping', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('drops boilerplate lines', () => {
    const out = f.compress(
      'Setting up runner\nRunner version 2.313.0\nOperating System     : Ubuntu 22.04\nActual step output here\n',
      '',
      0,
      argv,
    )
    expect(out).not.toContain('Setting up runner')
    expect(out).not.toContain('Runner version')
    expect(out).toContain('Actual step output here')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — cleanup dropping
// ---------------------------------------------------------------------------

describe('GhRunLogFilter cleanup dropping', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('drops cleanup lines', () => {
    const out = f.compress(
      'Some useful log line\nPost job cleanup.\nCleaning up orphan processes\nPost Run actions/checkout@v4\n',
      '',
      0,
      argv,
    )
    expect(out).not.toContain('Post job cleanup')
    expect(out).not.toContain('Cleaning up orphan processes')
    expect(out).not.toContain('Post Run')
    expect(out).toContain('Some useful log line')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — group collapsing
// ---------------------------------------------------------------------------

describe('GhRunLogFilter group collapsing', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('collapses a large passing group', () => {
    const groupBody = Array.from({ length: 30 }, (_, i) => `  line ${i}`).join('\n')
    const out = f.compress(`##[group]Set up Python\n${groupBody}\n##[endgroup]\n`, '', 0, argv)
    expect(out).toContain('Set up Python')
    expect(out).toContain('30 lines collapsed')
    expect(out).not.toContain('line 0')
  })

  it('preserves group that contains a failure', () => {
    const bodyLines = [
      ...Array.from({ length: 25 }, (_, i) => `  line ${i}`),
      '  Error: build failed',
    ].join('\n')
    const out = f.compress(`##[group]Build\n${bodyLines}\n##[endgroup]\n`, '', 0, argv)
    expect(out).toContain('Error: build failed')
  })

  it('preserves small groups verbatim', () => {
    const groupBody = Array.from({ length: 5 }, (_, i) => `  step ${i}`).join('\n')
    const out = f.compress(`##[group]Quick step\n${groupBody}\n##[endgroup]\n`, '', 0, argv)
    expect(out).toContain('step 0')
    expect(out).toContain('step 4')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — failure lines kept
// ---------------------------------------------------------------------------

describe('GhRunLogFilter failure lines', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('keeps failure lines verbatim', () => {
    const out = f.compress(
      '2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1\n' +
        '2024-01-01T00:00:01.0000000Z FAILED: tests/test_foo.py\n',
      '',
      0,
      argv,
    )
    expect(out).toContain('Process completed with exit code 1')
    expect(out).toContain('FAILED: tests/test_foo.py')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — ##[command] echo dropping
// ---------------------------------------------------------------------------

describe('GhRunLogFilter command echo dropping', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('drops ##[command] echo lines', () => {
    const out = f.compress(
      '##[command]echo Hello\n##[command]/bin/bash -e /runner/_temp/step.sh\nActual step output here\n',
      '',
      0,
      argv,
    )
    expect(out).not.toContain('echo Hello')
    expect(out).not.toContain('/runner/_temp/step.sh')
    expect(out).toContain('Actual step output here')
    expect(out).toContain('##[command] echo lines')
  })

  it('keeps a ##[command] line that contains an error signal', () => {
    const out = f.compress(
      "##[command]echo 'Error: something went wrong'\nNormal output\n",
      '',
      0,
      argv,
    )
    expect(out).toContain('Error: something went wrong')
  })
})

// ---------------------------------------------------------------------------
// GhRunLogFilter — step-name TAB prefix stripping
// ---------------------------------------------------------------------------

describe('GhRunLogFilter step-name TAB prefix stripping', () => {
  const f = new GhRunLogFilter()
  const argv = ['gh', 'run', 'view', '1', '--log']

  it('strips step-name TAB prefix and timestamp', () => {
    const out = f.compress(
      'build (ubuntu-latest)\t2024-01-15T12:34:56.1234567Z Hello from step\n' +
        'test (ubuntu-latest)\t2024-01-15T12:34:57.0000000Z Test line\n',
      '',
      0,
      argv,
    )
    expect(out).not.toContain('ubuntu-latest')
    expect(out).not.toContain('2024-01-15T')
    expect(out).toContain('Hello from step')
    expect(out).toContain('Test line')
  })
})

// ---------------------------------------------------------------------------
// GhFilter — gh api *_url stripping
// ---------------------------------------------------------------------------

describe('GhFilter gh api *_url stripping', () => {
  const f = new GhFilter()

  it('passes through gh api with no *_url fields unchanged', () => {
    const content = '{"id": 1, "name": "test"}'
    const out = apply(f, content, ['gh', 'api', '/user'])
    expect(out).toContain('"id": 1')
    expect(out).toContain('"name": "test"')
    expect(out).not.toContain('[token-goat]')
  })

  it('strips boilerplate *_url fields and emits a count note', () => {
    const payload = JSON.stringify({
      login: 'octocat',
      id: 1,
      followers_url: 'https://api.github.com/users/octocat/followers',
      html_url: 'https://github.com/octocat',
    })
    const out = apply(f, payload, ['gh', 'api', '/user'])
    expect(out).toContain('"login": "octocat"')
    expect(out).toContain('html_url')
    expect(out).not.toContain('followers_url')
    expect(out).toContain('stripped 1 *_url boilerplate fields')
  })

  it('keeps all preserved url fields', () => {
    const payload = JSON.stringify({
      html_url: 'h',
      avatar_url: 'a',
      clone_url: 'c',
      ssh_url: 's',
      followers_url: 'f',
    })
    const out = apply(f, payload, ['gh', 'api', '/user'])
    expect(out).toContain('html_url')
    expect(out).toContain('avatar_url')
    expect(out).toContain('clone_url')
    expect(out).toContain('ssh_url')
    expect(out).not.toContain('followers_url')
  })

  it('strips noise keys gravatar_id and site_admin', () => {
    const payload = JSON.stringify({
      login: 'octocat',
      gravatar_id: '',
      site_admin: false,
    })
    const out = apply(f, payload, ['gh', 'api', '/user'])
    expect(out).not.toContain('gravatar_id')
    expect(out).not.toContain('site_admin')
    expect(out).toContain('"login": "octocat"')
  })

  it('recursively strips *_url fields in nested objects', () => {
    const payload = JSON.stringify({
      repo: {
        name: 'myrepo',
        forks_url: 'https://api.github.com/repos/o/r/forks',
        html_url: 'https://github.com/o/r',
      },
    })
    const out = apply(f, payload, ['gh', 'api', '/repos/o/r'])
    expect(out).not.toContain('forks_url')
    expect(out).toContain('"name": "myrepo"')
    expect(out).toContain('html_url')
  })

  it('strips *_url fields in array items', () => {
    const payload = JSON.stringify([
      { login: 'a', followers_url: 'x' },
      { login: 'b', followers_url: 'y' },
    ])
    const out = apply(f, payload, ['gh', 'api', '/orgs/example/members'])
    expect(out).not.toContain('followers_url')
    expect(out).toContain('"login": "a"')
    expect(out).toContain('"login": "b"')
    expect(out).toContain('stripped 2 *_url boilerplate fields')
  })

  it('falls back gracefully on non-JSON output', () => {
    const out = apply(f, 'Not JSON at all', ['gh', 'api', '/repos/o/r'])
    expect(out).toContain('Not JSON at all')
    expect(out).not.toContain('[token-goat]')
  })
})

// ---------------------------------------------------------------------------
// GhFilter — gh run view pass/fail collapsing
// ---------------------------------------------------------------------------

describe('GhFilter gh run view pass/fail collapsing', () => {
  const f = new GhFilter()
  const argv = ['gh', 'run', 'view', '1234']

  it('removes ✓ pass-step lines', () => {
    const out = apply(f, '✓ Set up job\nJob succeeded', argv)
    expect(out).not.toContain('✓ Set up job')
  })

  it('emits collapsed-count note for three ✓ lines', () => {
    const out = apply(f, '✓ Step 1\n✓ Step 2\n✓ Step 3\nJob succeeded', argv)
    expect(out).toContain('collapsed 3 passing step headers')
  })

  it('drops indented children of pass-step', () => {
    const out = apply(f, '✓ Set up job\n  Run actions/checkout@v4\nJob succeeded', argv)
    expect(out).not.toContain('Run actions/checkout@v4')
  })

  it('keeps non-indented line after pass-step', () => {
    const out = apply(f, '✓ Set up job\nNon-indented content\nMore content', argv)
    expect(out).toContain('Non-indented content')
  })

  it('√ symbol also triggers pass-step collapse', () => {
    const out = apply(f, '√ Build\nJob succeeded', argv)
    expect(out).not.toContain('√ Build')
    expect(out).toContain('collapsed 1 passing step headers')
  })

  it('keeps ✗ fail-step lines', () => {
    const out = apply(f, '✗ Run linters\nJob failed', argv)
    expect(out).toContain('✗ Run linters')
  })

  it('keeps indented children of fail-step', () => {
    const out = apply(f, '✗ Run linters\n  Process completed with exit code 1.\n  ##[error]linter failed', argv)
    expect(out).toContain('Process completed with exit code 1.')
    expect(out).toContain('##[error]linter failed')
  })

  it('FAILED: prefix triggers fail path', () => {
    const out = apply(f, 'FAILED: something went wrong', argv)
    expect(out).toContain('FAILED: something went wrong')
  })

  it('Error: prefix triggers fail path', () => {
    const out = apply(f, 'Error: something went wrong', argv)
    expect(out).toContain('Error: something went wrong')
  })
})

// ---------------------------------------------------------------------------
// GhFilter — gh list truncation
// ---------------------------------------------------------------------------

describe('GhFilter gh list truncation', () => {
  const f = new GhFilter()

  function makeListOutput(nRows: number): string {
    const header = 'NUMBER  TITLE              BRANCH'
    const rows = Array.from({ length: nRows }, (_, i) => `${i + 1}      PR title #${i + 1}   feature/branch-${i + 1}`)
    return [header, ...rows].join('\n')
  }

  it('passes through 30 data rows without truncation', () => {
    const out = apply(f, makeListOutput(30), ['gh', 'pr', 'list'])
    expect(out).not.toContain('showing first')
  })

  it('truncates 31 data rows with count note', () => {
    const out = apply(f, makeListOutput(31), ['gh', 'pr', 'list'])
    expect(out).toContain('showing first 30 of 31 prs')
  })

  it('header is preserved after truncation', () => {
    const out = apply(f, makeListOutput(31), ['gh', 'pr', 'list'])
    expect(out).toContain('NUMBER  TITLE              BRANCH')
  })

  it('31st row is absent after truncation', () => {
    const out = apply(f, makeListOutput(31), ['gh', 'pr', 'list'])
    expect(out).not.toContain('PR title #31')
  })

  it('note pluralises subcommand name correctly for run', () => {
    const out = apply(f, makeListOutput(31), ['gh', 'run', 'list'])
    expect(out).toContain('31 runs')
  })
})

// ---------------------------------------------------------------------------
// GhFilter — pr view passthrough
// ---------------------------------------------------------------------------

describe('GhFilter gh pr view passthrough', () => {
  it('passes through pr view without emitting a note', () => {
    const f = new GhFilter()
    const out = apply(f, 'Title: foo\nBody: bar', ['gh', 'pr'])
    expect(out).toContain('Title: foo')
    expect(out).toContain('Body: bar')
    expect(out).not.toContain('[token-goat:')
  })
})

// ---------------------------------------------------------------------------
// ActFilter — dispatch
// ---------------------------------------------------------------------------

describe('ActFilter dispatch', () => {
  const f = new ActFilter()

  it('matches act', () => {
    expect(f.matches(['act'])).toBe(true)
    expect(f.matches(['act', '-j', 'test'])).toBe(true)
    expect(f.matches(['act', 'push'])).toBe(true)
  })

  it('does not match other commands', () => {
    expect(f.matches(['gh', 'run', 'view'])).toBe(false)
    expect(f.matches(['docker'])).toBe(false)
  })

  it('selectFilter returns ActFilter', () => {
    expect(selectFilter(['act', '-j', 'build'])).toBeInstanceOf(ActFilter)
  })
})

// ---------------------------------------------------------------------------
// ActFilter — prefix stripping
// ---------------------------------------------------------------------------

describe('ActFilter prefix stripping', () => {
  const f = new ActFilter()

  it('strips [job/step] | prefix from body lines', () => {
    const out = apply(f, '[build/install-deps] | npm install\n[build/install-deps] | added 100 packages\n', ['act', '-j', 'build'])
    expect(out).not.toContain('[build/install-deps]')
    expect(out).toContain('npm install')
    expect(out).toContain('added 100 packages')
  })
})

// ---------------------------------------------------------------------------
// ActFilter — status lines preserved
// ---------------------------------------------------------------------------

describe('ActFilter status lines', () => {
  const f = new ActFilter()

  it('keeps success status line ✅', () => {
    const out = apply(f, '[build/run-tests] ✅\n', ['act'])
    expect(out).toContain('✅')
  })

  it('keeps failure status line ❌', () => {
    const out = apply(f, '[build/run-tests] ❌\n', ['act'])
    expect(out).toContain('❌')
  })
})

// ---------------------------------------------------------------------------
// ActFilter — docker pull collapsing
// ---------------------------------------------------------------------------

describe('ActFilter docker pull collapsing', () => {
  const f = new ActFilter()

  it('collapses docker pull progress lines', () => {
    const lines = [
      '[build/setup] | Pulling from library/node',
      '[build/setup] | Waiting',
      '[build/setup] | Verifying Checksum',
      '[build/setup] | Pull complete',
      '[build/setup] | Digest: sha256:abc123',
      '[build/setup] | Status: Downloaded newer image',
    ].join('\n')
    const out = apply(f, lines, ['act'])
    expect(out).toContain('docker-pull progress lines')
    expect(out).not.toContain('Pull complete')
  })
})

// ---------------------------------------------------------------------------
// ActFilter — matrix expansion collapsing
// ---------------------------------------------------------------------------

describe('ActFilter matrix expansion collapsing', () => {
  const f = new ActFilter()

  it('collapses matrix expansion lines', () => {
    const lines = [
      '[build/test] Matrix: {"os":"ubuntu-latest","node":"16"}',
      '[build/test] Matrix: {"os":"ubuntu-latest","node":"18"}',
      '[build/test] Matrix: {"os":"ubuntu-latest","node":"20"}',
    ].join('\n')
    const out = apply(f, lines, ['act'])
    expect(out).toContain('matrix expansion lines')
  })
})

// ---------------------------------------------------------------------------
// ActFilter — body lines stripped of prefix
// ---------------------------------------------------------------------------

describe('ActFilter body lines stripped of prefix', () => {
  const f = new ActFilter()

  it('combined: docker collapsed, status kept, failure kept, prefix stripped', () => {
    const lines = [
      '[build/setup] | Pulling from library/python',
      '[build/setup] | Pull complete',
      '[build/setup] | Digest: sha256:abc',
      '[build/run] | Running tests...',
      '[build/run] | test_foo ... ok',
      '[build/run] | FAILED: test_bar',
      '[build/run] ❌',
    ].join('\n')
    const out = apply(f, lines, ['act'])
    expect(out).toContain('docker-pull')
    expect(out).toContain('❌')
    expect(out).toContain('FAILED: test_bar')
    expect(out).toContain('Running tests...')
    // body lines should not carry the [build/...] prefix
    const bodyLinesWithPrefix = out
      .split('\n')
      .filter((ln) => ln.includes('[build/') && !ln.includes('❌') && !ln.includes('✅'))
    expect(bodyLinesWithPrefix).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GenericCIFilter — dispatch
// ---------------------------------------------------------------------------

describe('GenericCIFilter dispatch', () => {
  const f = new GenericCIFilter()

  it('matches on --log flag', () => {
    expect(f.matches(['some-ci-tool', '--log'])).toBe(true)
  })

  it('matches on logs subcommand', () => {
    expect(f.matches(['pipeline-cli', 'logs', '--job', 'build'])).toBe(true)
  })

  it('matches on pipeline keyword', () => {
    expect(f.matches(['ci-tool', 'pipeline', 'status'])).toBe(true)
  })

  it('matches on workflow keyword', () => {
    expect(f.matches(['tool', 'workflow', 'run'])).toBe(true)
  })

  it('does not match plain commands', () => {
    expect(f.matches(['pytest', '-v'])).toBe(false)
    expect(f.matches(['npm', 'install'])).toBe(false)
  })

  it('does not preempt GhRunLogFilter for gh run view --log', () => {
    expect(selectFilter(['gh', 'run', 'view', '123', '--log'])).toBeInstanceOf(GhRunLogFilter)
  })
})

// ---------------------------------------------------------------------------
// GenericCIFilter — timestamp stripping
// ---------------------------------------------------------------------------

describe('GenericCIFilter timestamp stripping', () => {
  const f = new GenericCIFilter()

  it('strips ISO-8601 timestamps', () => {
    const out = apply(f, '2024-06-15T10:30:00.000Z Build started\n2024-06-15T10:30:01.000Z Step 1\n', ['tool', '--log'])
    expect(out).not.toContain('2024-06-15T')
    expect(out).toContain('Build started')
    expect(out).toContain('Step 1')
  })

  it('strips bracket timestamps', () => {
    const out = apply(f, '[2024-06-15T10:30:00Z] log entry\n', ['tool', '--log'])
    expect(out).not.toContain('[2024')
    expect(out).toContain('log entry')
  })
})

// ---------------------------------------------------------------------------
// GenericCIFilter — ANSI stripping
// ---------------------------------------------------------------------------

describe('GenericCIFilter ANSI stripping', () => {
  const f = new GenericCIFilter()

  it('strips ANSI codes', () => {
    const out = apply(f, '\x1b[32mINFO\x1b[0m: build succeeded\n', ['tool', '--log'])
    expect(out).not.toContain('\x1b[')
    expect(out).toContain('build succeeded')
  })
})

// ---------------------------------------------------------------------------
// GenericCIFilter — DEBUG/TRACE collapsing
// ---------------------------------------------------------------------------

describe('GenericCIFilter DEBUG/TRACE collapsing', () => {
  const f = new GenericCIFilter()

  it('collapses 20 DEBUG lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `DEBUG: connecting to host ${i}`).join('\n')
    const out = apply(f, lines, ['tool', '--log'])
    expect(out).not.toContain('DEBUG: connecting')
    expect(out).toContain('collapsed 20 DEBUG/TRACE')
  })

  it('keeps INFO lines', () => {
    const out = apply(f, 'INFO: deployment complete\nINFO: pods healthy\n', ['tool', '--log'])
    expect(out).toContain('INFO: deployment complete')
    expect(out).toContain('INFO: pods healthy')
  })
})

// ---------------------------------------------------------------------------
// GenericCIFilter — heartbeat collapsing
// ---------------------------------------------------------------------------

describe('GenericCIFilter heartbeat collapsing', () => {
  const f = new GenericCIFilter()

  it('collapses heartbeat lines', () => {
    const lines = Array.from({ length: 30 }, () => 'heartbeat: alive').join('\n')
    const out = apply(f, lines, ['tool', '--log'])
    expect(out).not.toContain('heartbeat: alive')
    expect(out).toContain('heartbeat/health-check')
  })

  it('collapses health-check lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `health check #${i} OK`).join('\n')
    const out = apply(f, lines, ['tool', '--log'])
    expect(out).toContain('heartbeat/health-check')
  })

  it('keeps error lines past DEBUG/heartbeat', () => {
    const out = apply(
      f,
      'DEBUG: verbose noise\nError: failed to connect to database\nDEBUG: more noise\n',
      ['tool', '--log'],
    )
    expect(out).toContain('Error: failed to connect')
  })
})

// ---------------------------------------------------------------------------
// PreCommitFilter — dispatch
// ---------------------------------------------------------------------------

describe('PreCommitFilter dispatch', () => {
  it('selectFilter returns PreCommitFilter for pre-commit', () => {
    expect(selectFilter(['pre-commit', 'run', '--all-files'])).toBeInstanceOf(PreCommitFilter)
  })
})

// ---------------------------------------------------------------------------
// PreCommitFilter — passing hooks collapsed
// ---------------------------------------------------------------------------

const PC_ARGV = ['pre-commit', 'run', '--all-files']

describe('PreCommitFilter passing hooks collapsed', () => {
  const f = new PreCommitFilter()

  it('collapses Passed hooks into a sentinel', () => {
    const out = apply(
      f,
      'check yaml.....Passed\ncheck json.....Passed\ncheck toml.....Passed\nAll checks passed.\n',
      PC_ARGV,
    )
    expect(out).toContain('collapsed 3 Passed, 0 Skipped hook(s)')
    expect(out).not.toContain('check yaml.....Passed')
    expect(out).toContain('All checks passed.')
  })

  it('keeps Failed hook block verbatim', () => {
    const out = apply(
      f,
      'check yaml.....Passed\nflake8.....Failed\n- hook id: flake8\n- exit code: 1\n\nsrc/auth.py:10: E302 expected 2 blank lines, found 1\n',
      PC_ARGV,
      { exitCode: 1 },
    )
    expect(out).not.toContain('check yaml.....Passed')
    expect(out).toContain('flake8.....Failed')
    expect(out).toContain('- hook id: flake8')
    expect(out).toContain('- exit code: 1')
    expect(out).toContain('src/auth.py:10: E302')
  })

  it('single passing hook produces collapsed sentinel with count 1', () => {
    const out = apply(f, 'check yaml.....Passed\nAll checks passed.\n', PC_ARGV)
    expect(out).toContain('collapsed 1 Passed, 0 Skipped hook(s)')
  })

  it('Skipped hooks are counted separately', () => {
    const out = apply(
      f,
      'check yaml.....Passed\ncheck json.....(no files to check)Skipped\ncheck toml.....Passed\nAll checks passed.\n',
      PC_ARGV,
    )
    expect(out).toContain('collapsed 2 Passed, 1 Skipped hook(s)')
  })

  it('mixed pass and fail: pass count before failure is correct', () => {
    const out = apply(
      f,
      'check yaml.....Passed\ncheck json.....Passed\nflake8.....Failed\n- hook id: flake8\n- exit code: 1\n\nsrc/foo.py:1: E302\n',
      PC_ARGV,
      { exitCode: 1 },
    )
    expect(out).toContain('collapsed 2 Passed, 0 Skipped')
    expect(out).toContain('flake8.....Failed')
    expect(out).toContain('src/foo.py:1: E302')
  })
})

// ---------------------------------------------------------------------------
// PreCommitFilter — INFO line handling
// ---------------------------------------------------------------------------

describe('PreCommitFilter INFO line handling', () => {
  const f = new PreCommitFilter()

  it('drops INFO lines after the first', () => {
    const out = apply(
      f,
      '[INFO] Initializing environment for git\n[INFO] Installing environment for git\n[INFO] Restored environment from cache\ncheck yaml.....Passed\nAll checks passed.\n',
      PC_ARGV,
    )
    expect(out).not.toContain('[INFO] Installing environment for git')
    expect(out).not.toContain('[INFO] Restored environment from cache')
  })

  it('keeps the first INFO line', () => {
    const out = apply(
      f,
      '[INFO] Initializing environment for git\n[INFO] Installing environment for git\ncheck yaml.....Passed\nAll checks passed.\n',
      PC_ARGV,
    )
    expect(out).toContain('[INFO] Initializing environment for git')
  })

  it('emits count of dropped INFO lines', () => {
    const out = apply(
      f,
      '[INFO] Initializing environment for git\n[INFO] Installing environment for git\n[INFO] Restored environment from cache\ncheck yaml.....Passed\nAll checks passed.\n',
      PC_ARGV,
    )
    expect(out).toContain('dropped 2 pre-commit [INFO] env-setup lines')
  })

  it('empty output returns empty string', () => {
    const out = apply(f, '', PC_ARGV)
    expect(out).toBe('')
  })
})

// ---------------------------------------------------------------------------
// BanditFilter — fixtures
// ---------------------------------------------------------------------------

const BANDIT_HIGH =
  '>> Issue: [B301:unsafe_serialize] Unsafe deserialization detected.\n' +
  '   Severity: High   Confidence: Medium\n' +
  '   CWE: CWE-502\n' +
  '   Location: src/load.py:10:4\n'

const BANDIT_MED =
  '>> Issue: [B105:hardcoded_password_string] Hardcoded password.\n' +
  '   Severity: Medium   Confidence: Medium\n' +
  '   CWE: CWE-259\n' +
  '   Location: src/config.py:5:4\n'

function banditOutput(issues: string[], nLow = 0): string {
  const parts = [
    'Run started: 2024-01-15 12:00:00.000000',
    '',
    'Test results:',
    ...issues,
  ]
  for (let i = 0; i < nLow; i++) {
    parts.push(
      `>> Issue: [B101:assert_used] Use of assert detected.\n` +
        `   Severity: Low   Confidence: High\n` +
        `   CWE: CWE-703\n` +
        `   Location: tests/test_${i}.py:3:4\n`,
    )
  }
  parts.push(
    'Code scanned:',
    '   Total lines of code: 500',
    '',
    'Total issues (by severity):',
    '   Low: 5',
    '   High: 1',
  )
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// BanditFilter — dispatch and basic coverage
// ---------------------------------------------------------------------------

describe('BanditFilter dispatch', () => {
  it('matches bandit', () => {
    expect(new BanditFilter().matches(['bandit', '-r', 'src/'])).toBe(true)
    expect(new BanditFilter().matches(['pytest'])).toBe(false)
  })

  it('selectFilter returns BanditFilter', () => {
    expect(selectFilter(['bandit', '-r', 'src/'])).toBeInstanceOf(BanditFilter)
  })
})

describe('BanditFilter output', () => {
  const f = new BanditFilter()
  const argv = ['bandit', '-r', 'src/']

  it('preserves Run started banner', () => {
    const out = apply(f, banditOutput([]), argv)
    expect(out).toContain('Run started:')
  })

  it('preserves Test results section', () => {
    const out = apply(f, banditOutput([]), argv)
    expect(out).toContain('Test results:')
  })

  it('keeps HIGH severity issues', () => {
    const out = apply(f, banditOutput([BANDIT_HIGH]), argv)
    expect(out).toContain('B301:unsafe_serialize')
  })

  it('keeps MEDIUM severity issues', () => {
    const out = apply(f, banditOutput([BANDIT_MED]), argv)
    expect(out).toContain('B105:hardcoded_password_string')
  })

  it('collapses LOW severity issues', () => {
    const out = apply(f, banditOutput([], 5), argv)
    expect(out).not.toContain('CWE-703')
    // Either a "collapsed" note or LOW mention should appear
    expect(out.toLowerCase()).toMatch(/collapsed|low/)
  })

  it('preserves Code scanned block', () => {
    const out = apply(f, banditOutput([]), argv)
    expect(out).toContain('Code scanned:')
  })

  it('preserves Total issues block', () => {
    const out = apply(f, banditOutput([]), argv)
    expect(out).toContain('Total issues')
  })

  it('drops per-file testing progress lines', () => {
    const out = apply(f, 'testing /src/foo.py\ntesting /src/bar.py\nTest results:\n', argv)
    expect(out).not.toContain('testing /src/foo.py')
  })

  it('handles empty stdout without throwing', () => {
    expect(() => apply(f, '', argv)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// TrivyFilter — fixtures
// ---------------------------------------------------------------------------

const TRIVY_LOGS =
  '2024-01-15T12:00:00Z INFO Need to update DB\n' +
  '2024-01-15T12:00:01Z INFO Downloading DB...\n'

const TRIVY_TABLE_HEADER =
  '+---+--+--+\n' +
  '| Library | Vulnerability ID | Severity | Installed Version |\n' +
  '+---+--+--+'

const TRIVY_TABLE_ROWS =
  '| openssl | CVE-2023-0001 | CRITICAL | 1.1.1k |\n' +
  '| libssl | CVE-2023-0002 | HIGH | 1.1.1k |\n' +
  '| zlib | CVE-2023-0003 | MEDIUM | 1.2.11 |\n' +
  '| zlib | CVE-2023-0004 | LOW | 1.2.11 |'

const TRIVY_TOTAL = 'Total: 4 (CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1)'

function trivyOutput(): string {
  return TRIVY_TABLE_HEADER + '\n' + TRIVY_TABLE_ROWS + '\n+---+--+--+\n\n' + TRIVY_TOTAL
}

// ---------------------------------------------------------------------------
// TrivyFilter — dispatch and coverage
// ---------------------------------------------------------------------------

describe('TrivyFilter dispatch', () => {
  it('matches trivy', () => {
    expect(new TrivyFilter().matches(['trivy', 'image', 'nginx:latest'])).toBe(true)
    expect(new TrivyFilter().matches(['bandit'])).toBe(false)
  })

  it('selectFilter returns TrivyFilter', () => {
    expect(selectFilter(['trivy', 'fs', '.'])).toBeInstanceOf(TrivyFilter)
  })
})

describe('TrivyFilter output', () => {
  const f = new TrivyFilter()
  const argv = ['trivy', 'image', 'nginx']

  it('drops INFO/WARN log lines from stderr', () => {
    const out = apply(f, '', argv, { stderr: TRIVY_LOGS })
    // Check the actual log-line content is absent (note text may say INFO/WARN)
    expect(out).not.toContain('Need to update DB')
    expect(out).not.toContain('Downloading DB')
  })

  it('keeps CRITICAL severity rows', () => {
    const out = apply(f, trivyOutput(), argv)
    expect(out).toContain('CVE-2023-0001')
  })

  it('keeps HIGH severity rows', () => {
    const out = apply(f, trivyOutput(), argv)
    expect(out).toContain('CVE-2023-0002')
  })

  it('collapses MEDIUM severity rows', () => {
    const out = apply(f, trivyOutput(), argv)
    expect(out).not.toContain('CVE-2023-0003')
  })

  it('collapses LOW severity rows', () => {
    const out = apply(f, trivyOutput(), argv)
    expect(out).not.toContain('CVE-2023-0004')
  })

  it('preserves Total summary', () => {
    const out = apply(f, trivyOutput(), argv)
    expect(out).toContain('Total:')
  })

  it('preserves no-vulnerability message', () => {
    const out = apply(f, 'No vulnerabilities found\n', argv)
    expect(out).toContain('No vulnerabilities')
  })

  it('handles empty stdout without throwing', () => {
    expect(() => apply(f, '', argv)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// SnykFilter — fixtures
// ---------------------------------------------------------------------------

const TC = '├─ '
const TE = '└─ '
const TV = '│  '
const VX = '✗'
const CK = '✔'

function snykTree(extras = 0): string {
  const lines = [
    'my-project@1.0.0',
    TC + 'express@4.18.2',
    TV + TC + 'body-parser@1.20.1',
    TV + TE + 'debug@2.6.9',
    TC + 'lodash@4.17.21',
    TE + 'moment@2.29.4',
  ]
  for (let i = 0; i < extras; i++) {
    lines.push(TC + `extra-pkg-${i}@1.0.${i}`)
  }
  return lines.join('\n')
}

function snykOutput(extras = 0): string {
  return (
    'Testing my-project...\n\n' +
    snykTree(extras) +
    '\n\n' +
    VX +
    ' High severity vulnerability found in lodash\n' +
    '  Description: Prototype Pollution\n' +
    '  More about this vulnerability:\n' +
    '    https://snyk.io/vuln/SNYK-JS-LODASH\n\n' +
    CK +
    ' 0 unique vulnerabilities\n' +
    VX +
    ' 1 issues found\n'
  )
}

// ---------------------------------------------------------------------------
// SnykFilter — dispatch and coverage
// ---------------------------------------------------------------------------

describe('SnykFilter dispatch', () => {
  it('matches snyk', () => {
    expect(new SnykFilter().matches(['snyk', 'test'])).toBe(true)
    expect(new SnykFilter().matches(['trivy'])).toBe(false)
  })

  it('selectFilter returns SnykFilter', () => {
    expect(selectFilter(['snyk', 'test'])).toBeInstanceOf(SnykFilter)
  })
})

describe('SnykFilter output', () => {
  const f = new SnykFilter()
  const argv = ['snyk', 'test']

  it('keeps first Testing line', () => {
    const out = apply(f, snykOutput(), argv)
    expect(out).toContain('Testing my-project')
  })

  it('drops duplicate Testing lines', () => {
    const out = apply(f, 'Testing foo...\nTesting bar...\n' + CK + ' 0 unique vulnerabilities\n', argv)
    expect(out.split('Testing').length - 1).toBe(1)
  })

  it('collapses deep dependency tree', () => {
    const out = apply(f, snykOutput(30), argv)
    expect(out.toLowerCase()).toMatch(/collapsed|dependency tree/)
  })

  it('keeps vulnerability header', () => {
    const out = apply(f, snykOutput(), argv)
    expect(out).toContain('High severity')
    expect(out).toContain('lodash')
  })

  it('collapses More about URLs', () => {
    const out = apply(f, snykOutput(), argv)
    expect(out).not.toContain('More about this vulnerability:')
  })

  it('keeps summary line', () => {
    const out = apply(f, snykOutput(), argv)
    expect(out).toMatch(/unique vulnerabilities|issues found/)
  })

  it('keeps license issue lines', () => {
    const out = apply(f, 'Testing foo...\nLicense issue found in bar@1.0.0\n' + CK + ' 0 unique\n', argv)
    expect(out).toContain('License issue')
  })

  it('handles empty stdout without throwing', () => {
    expect(() => apply(f, '', argv)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// SemgrepFilter — fixtures
// ---------------------------------------------------------------------------

const SG_SCANNING = 'Scanning 42 files...'
const SG_SUMMARY = 'Ran 100 rules on 42 files: 3 findings.'

function sgOutput(n = 1): string {
  const parts = [SG_SCANNING, '']
  for (let i = 0; i < n; i++) {
    parts.push(
      'python.security.audit.exec-used.exec-used\n' +
        `  src/file_${i}.py:${10 + i}:5:\n` +
        `    ${10 + i} |     run_code(user_input)\n` +
        '    Details: https://semgrep.dev/r/python.security.audit.exec-used.exec-used\n',
    )
  }
  parts.push(SG_SUMMARY)
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// SemgrepFilter — dispatch and coverage
// ---------------------------------------------------------------------------

describe('SemgrepFilter dispatch', () => {
  it('matches semgrep', () => {
    expect(new SemgrepFilter().matches(['semgrep', '--config', 'p/python'])).toBe(true)
    expect(new SemgrepFilter().matches(['bandit'])).toBe(false)
  })

  it('selectFilter returns SemgrepFilter', () => {
    expect(selectFilter(['semgrep', '--config', 'auto'])).toBeInstanceOf(SemgrepFilter)
  })
})

describe('SemgrepFilter output', () => {
  const f = new SemgrepFilter()
  const argv = ['semgrep']

  it('keeps scanning banner', () => {
    const out = apply(f, sgOutput(), argv)
    expect(out).toContain('Scanning 42 files')
  })

  it('drops duplicate scanning banners', () => {
    const out = apply(f, 'Scanning 10 files...\nScanning 20 files...\n' + SG_SUMMARY, argv)
    expect(out.split('Scanning').length - 1).toBe(1)
  })

  it('keeps rule match snippet', () => {
    const out = apply(f, sgOutput(1), argv)
    expect(out).toContain('exec-used')
  })

  it('drops Details URLs', () => {
    const out = apply(f, sgOutput(1), argv)
    expect(out).not.toContain('Details: https://semgrep.dev')
  })

  it('collapses beyond 3 instances of the same rule', () => {
    const out = apply(f, sgOutput(10), argv)
    expect(out.toLowerCase()).toMatch(/collapsed|additional/)
  })

  it('keeps first 3 instances and drops 4th and 5th', () => {
    const out = apply(f, sgOutput(5), argv)
    expect(out).toContain('src/file_0.py')
    expect(out).toContain('src/file_1.py')
    expect(out).toContain('src/file_2.py')
    expect(out).not.toContain('src/file_3.py')
    expect(out).not.toContain('src/file_4.py')
  })

  it('keeps summary line', () => {
    const out = apply(f, sgOutput(), argv)
    expect(out).toContain('Ran 100 rules')
  })

  it('handles empty stdout without throwing', () => {
    expect(() => apply(f, '', argv)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Registry — CI_FILTERS array ordering and registration
// ---------------------------------------------------------------------------

describe('CI_FILTERS registry', () => {
  it('GhRunLogFilter precedes GhFilter in CI_FILTERS', () => {
    const runLogIdx = CI_FILTERS.findIndex((f) => f instanceof GhRunLogFilter)
    const ghIdx = CI_FILTERS.findIndex((f) => f instanceof GhFilter)
    expect(runLogIdx).toBeGreaterThanOrEqual(0)
    expect(ghIdx).toBeGreaterThan(runLogIdx)
  })

  it('GenericCIFilter is last in CI_FILTERS', () => {
    const last = CI_FILTERS[CI_FILTERS.length - 1]
    expect(last).toBeInstanceOf(GenericCIFilter)
  })

  it('all nine filters are present in CI_FILTERS', () => {
    const classes = [
      GhRunLogFilter,
      GhFilter,
      ActFilter,
      GenericCIFilter,
      PreCommitFilter,
      BanditFilter,
      TrivyFilter,
      SnykFilter,
      SemgrepFilter,
    ]
    for (const Cls of classes) {
      expect(CI_FILTERS.some((f) => f instanceof Cls)).toBe(true)
    }
  })

  it('selectFilter dispatches bandit', () => {
    expect(selectFilter(['bandit', '-r', '.'])).toBeInstanceOf(BanditFilter)
  })

  it('selectFilter dispatches trivy', () => {
    expect(selectFilter(['trivy', 'image', 'alpine:3.18'])).toBeInstanceOf(TrivyFilter)
  })

  it('selectFilter dispatches snyk', () => {
    expect(selectFilter(['snyk', 'test', '--all-projects'])).toBeInstanceOf(SnykFilter)
  })

  it('selectFilter dispatches semgrep', () => {
    expect(selectFilter(['semgrep', '--config', 'auto', '.'])).toBeInstanceOf(SemgrepFilter)
  })

  it('selectFilter dispatches pre-commit', () => {
    expect(selectFilter(['pre-commit', 'run'])).toBeInstanceOf(PreCommitFilter)
  })

  it('selectFilter dispatches act', () => {
    expect(selectFilter(['act', '-j', 'build'])).toBeInstanceOf(ActFilter)
  })
})
