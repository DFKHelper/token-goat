/** A suite started from inside a Claude Code session must run as it does in CI, where no session exists. Claude Code exports its session to every Bash call it makes, and tests/setup/isolate-home.ts is the one place that can drop it before a test reads it or hands it to a spawned bundle: CLAUDE_PID sends rewrite_permission.ts's hidden-rule check to read the developer's own claude command line, CLAUDE_CODE_ENTRYPOINT decides whether that check trusts the host at all, and the session id keys its cache. */
import { describe, expect, it } from 'vitest'

// CAPTURE: the variables present in a Bash call made by Claude Code 2.1.x on Windows (`env` in this repo's dev session, 2026-10-05), plus CLAUDE_CODE_VERSION and TERM_PROGRAM=claude-code, which src/bridges/registry.ts::detectHarness and src/doctor_probe.ts read as Claude Code signals (FORMAT-DERIVED).
const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_VERSION', 'CLAUDE_CODE_SESSION_ATTENDED'] as const

describe('the test process inherits no Claude Code session', () => {
  it('has none of the session variables Claude Code exports to its shell', () => {
    const leaked = SESSION_VARS.filter((key) => process.env[key] !== undefined)
    expect(leaked).toEqual([])
  })

  it('does not carry TERM_PROGRAM=claude-code', () => {
    expect(process.env['TERM_PROGRAM']).not.toBe('claude-code')
  })
})
