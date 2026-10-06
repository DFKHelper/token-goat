/** A suite started from inside a Claude Code session must run as it does in CI, where no session exists. Claude Code exports its session to every Bash call it makes, and tests/setup/isolate-home.ts is the one place that can drop it before a test reads it or hands it to a spawned bundle: CLAUDE_PID sends rewrite_permission.ts's hidden-rule check to read the developer's own claude command line, CLAUDE_CODE_ENTRYPOINT decides whether that check trusts the host at all, and the session id keys its cache. Checking this process's own environment alone proves nothing on a machine or CI runner that never had the session, so the end-to-end case launches a nested vitest run with the session exported and has a probe inside it look. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { CLAUDE_SESSION_ENV_KEYS, scrubClaudeSessionEnv } from '../helpers/harness-env.js'
import { removeProbe, writeProbe } from '../helpers/vitest-probe.js'
import { pinnedPopulation } from './population.js'

// Deleted by their own lines in tests/setup/isolate-home.ts, which say why.
const SCRUBBED_ELSEWHERE: readonly string[] = ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']
const PROBE_NAME = 'zz_generated_claude_session_probe.test.ts'
let probe: string | undefined

afterAll(() => {
  if (probe !== undefined) removeProbe(probe)
})

/** Every quoted `CLAUDE...` variable name in src/, the names the product can read from its environment. */
function claudeNamesReadBySrc(): string[] {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) for (const m of fs.readFileSync(full, 'utf8').matchAll(/['"`](CLAUDE(?:CODE|_[A-Z0-9_]*[A-Z0-9]))['"`]/g)) names.add(m[1] as string)
    }
  }
  walk(path.resolve('src'))
  return [...names].sort()
}

describe('the test process inherits no Claude Code session', () => {
  it('has none of the session variables Claude Code exports to its shell', () => {
    const leaked = CLAUDE_SESSION_ENV_KEYS.filter((key) => process.env[key] !== undefined)
    expect(leaked).toEqual([])
  })

  it('does not carry TERM_PROGRAM=claude-code', () => {
    expect(process.env['TERM_PROGRAM']).not.toBe('claude-code')
  })

  it('scrubs the session and keeps what the developer set', () => {
    // HAND-DERIVED: the session keys from the list itself, against a TERM_PROGRAM another terminal sets and an unrelated PATH.
    const session: NodeJS.ProcessEnv = { ...Object.fromEntries(CLAUDE_SESSION_ENV_KEYS.map((key) => [key, 'x'])), TERM_PROGRAM: 'claude-code', PATH: '/usr/bin' }
    scrubClaudeSessionEnv(session)
    expect(session).toEqual({ PATH: '/usr/bin' })
    const other: NodeJS.ProcessEnv = { TERM_PROGRAM: 'vscode', PATH: '/usr/bin' }
    scrubClaudeSessionEnv(other)
    expect(other).toEqual({ TERM_PROGRAM: 'vscode', PATH: '/usr/bin' })
  })

  it('covers every Claude Code variable src reads', () => {
    // FORMAT-DERIVED: read live from src/, so a new read of a session variable fails here until the scrub list names it.
    const read = pinnedPopulation({ what: 'Claude Code variable names quoted in src', items: claudeNamesReadBySrc(), floor: 5, mustIncludeExact: ['CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'] })
    const covered: readonly string[] = [...CLAUDE_SESSION_ENV_KEYS, ...SCRUBBED_ELSEWHERE]
    expect(read.filter((name) => !covered.includes(name))).toEqual([])
  })

  it('a test run launched from a Claude Code Bash call sees none of the session', () => {
    probe = writeProbe(PROBE_NAME, [
      "import { expect, it } from 'vitest'",
      "it('generated probe: the inherited Claude Code session is gone', () => {",
      ...CLAUDE_SESSION_ENV_KEYS.map((key) => `  expect(process.env['${key}']).toBeUndefined()`),
      "  expect(process.env['TERM_PROGRAM']).toBeUndefined()",
      "  expect(process.env['TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD']).toBe('1')",
      '})',
      '',
    ])
    // CAPTURE: CLAUDECODE, CLAUDE_CODE_ENTRYPOINT and CLAUDE_CODE_SESSION_ATTENDED as a Claude Code 2.1.x Bash call on Windows carried them (2026-10-06; session id and pid replaced by same-shaped stand-ins). FORMAT-DERIVED: CLAUDE_CODE_VERSION and TERM_PROGRAM=claude-code, which that call did not carry, from src/bridges/registry.ts::detectHarness, which reads them.
    const session = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '2ab49bbf-0000-4000-8000-000000000000', CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_VERSION: '2.1.289', CLAUDE_CODE_SESSION_ATTENDED: '1', TERM_PROGRAM: 'claude-code' }
    const res = spawnSync(process.execPath, [path.resolve('node_modules', 'vitest', 'vitest.mjs'), 'run', probe], {
      encoding: 'utf8',
      // The bundle build this config runs in globalSetup would race the outer run's readers of the same artifact.
      env: { ...process.env, CI: '', ...session, TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD: '1' },
    })
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`
    expect(res.status, combined.slice(-2000)).toBe(0)
    expect(combined).toMatch(/1 passed/)
  }, 120_000)
})
