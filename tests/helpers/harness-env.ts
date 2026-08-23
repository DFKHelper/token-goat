/**
 * Every environment variable `detectHarness()` in src/bridges/registry.ts consults, across both
 * spellings codex/opencode ever used (`CODEX_SESSION_ID` vs `CODEX_SESSION`,
 * `OPENCODE_SESSION_ID` vs `OPENCODE_SESSION`) plus the harness-override escape hatch.
 *
 * Any suite whose result depends on which harness is detected has to clear all of these, not just
 * the one it is about: these tests run inside a real Claude Code session, which sets
 * `CLAUDE_CODE_SESSION_ID` in the ambient environment, so leaving it set makes the claudecode
 * branch (checked before codex) win over a test's own `CODEX_SESSION_ID` and silently break it.
 *
 * Kept here rather than restated per file because four copies of it already existed and a list
 * that must match a function elsewhere drifts the moment that function reads one more variable --
 * a new detection branch would then be isolated in some suites and not others, which shows up as
 * an unrelated test failing on whichever machine happens to have that variable set. Spread it and
 * append when a suite needs extra keys of its own; see tests/bridges/registry.test.ts.
 */
export const HARNESS_DETECTION_ENV_KEYS = [
  'TERM_PROGRAM',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_SESSION_ID',
  'ANTHROPIC_API_KEY',
  'CODEX_SESSION_ID',
  'CODEX_SESSION',
  'OPENCODE_SESSION_ID',
  'OPENCODE_SESSION',
  'GROK_SESSION_ID',
  'OPENCLAW_SESSION_ID',
  'HERMES_SESSION_ID',
  'HERMES_HOME',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'TOKEN_GOAT_HARNESS_OVERRIDE',
] as const
