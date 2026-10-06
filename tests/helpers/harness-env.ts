/** Every environment variable `detectHarness()` in src/bridges/registry.ts consults, across both spellings codex/opencode ever used (`CODEX_SESSION_ID` vs `CODEX_SESSION`, `OPENCODE_SESSION_ID` vs `OPENCODE_SESSION`) plus the harness-override escape hatch. Any suite whose result depends on which harness is detected has to clear all of these, not just the one it is about: these tests run inside a real Claude Code session, which sets `CLAUDE_CODE_SESSION_ID` in the ambient environment, so leaving it set makes the claudecode branch (checked before codex) win over a test's own `CODEX_SESSION_ID` and silently break it. Kept here rather than restated per file because four copies of it already existed and a list that must match a function elsewhere drifts the moment that function reads one more variable -- a new detection branch would then be isolated in some suites and not others, which shows up as an unrelated test failing on whichever machine happens to have that variable set. Spread it and append when a suite needs extra keys of its own; see tests/bridges/registry.test.ts. */
export const HARNESS_DETECTION_ENV_KEYS = [
  'TERM_PROGRAM',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_SESSION_ID',
  'ANTHROPIC_API_KEY',
  'CODEX_SESSION_ID',
  'CODEX_SESSION',
  'OPENCODE_SESSION_ID',
  'OPENCODE_SESSION',
  'OPENCODE_PID',
  'GROK_SESSION_ID',
  'OPENCLAW_SESSION_ID',
  'HERMES_SESSION_ID',
  'HERMES_HOME',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'TOKEN_GOAT_HARNESS_OVERRIDE',
] as const

/** The variables Claude Code exports to every Bash call it makes (CAPTURE: `env` in a Bash call of Claude Code 2.1.x on Windows, 2026-10-05), plus CLAUDE_CODE_VERSION, which src/bridges/registry.ts::detectHarness reads as a Claude Code signal (FORMAT-DERIVED). TERM_PROGRAM is handled apart in {@link scrubClaudeSessionEnv}: only its `claude-code` value belongs to the session. */
export const CLAUDE_SESSION_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_VERSION', 'CLAUDE_CODE_SESSION_ATTENDED'] as const

/** Drop the Claude Code session from `env`: every {@link CLAUDE_SESSION_ENV_KEYS} entry, and TERM_PROGRAM when Claude Code set it (another terminal's TERM_PROGRAM is the developer's own and stays). Used by tests/setup/isolate-home.ts, so a suite launched from a Claude Code Bash call runs as it does in CI. */
export function scrubClaudeSessionEnv(env: NodeJS.ProcessEnv): void {
  for (const key of CLAUDE_SESSION_ENV_KEYS) delete env[key]
  if (env['TERM_PROGRAM'] === 'claude-code') delete env['TERM_PROGRAM']
}

/** Run `fn` with `TOKEN_GOAT_HARNESS_OVERRIDE` set to `harness`, restoring the prior value (or its absence) afterwards even when `fn` throws. */
export async function withHarnessOverride<T>(harness: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = harness
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prior
  }
}
