/**
 * Harness detection.
 *
 * {@link detectHarness} inspects the process environment to decide which AI
 * harness token-goat is running under; {@link getHarnessName} memoizes the
 * result for the life of the process (cleared by `clearModuleCaches` so tests
 * can flip env vars between cases).
 *
 * This is the single canonical detection implementation. It used to be
 * duplicated: this file recognized only claudecode/codex/opencode via
 * `*_SESSION_ID` env vars, while `compact.ts` had its own copy recognizing
 * six harnesses (also covering gemini/hermes) via a *different*,
 * non-overlapping set of env vars for the same two shared harnesses
 * (`CODEX_SESSION` vs `CODEX_SESSION_ID`, `OPENCODE_SESSION` vs
 * `OPENCODE_SESSION_ID`). Both spellings are unioned below so a real
 * Codex/opencode invocation setting either var is detected; `compact.ts` now
 * imports this function instead of keeping its own copy. `openclaw` has no
 * install-writer yet -- see the `OPENCLAW_SESSION_ID` note below.
 */

import { ENV_KEYS } from '../constants.js'
import { registerReset } from '../reset.js'
import type { HarnessName } from './types.js'

/** Every value {@link detectHarness} can return; used to validate the override env var. */
const KNOWN_HARNESS_NAMES = new Set<string>([
  'claudecode',
  'codex',
  'opencode',
  'gemini',
  'hermes',
  'openclaw',
  'generic',
])

/**
 * Detect the running harness from environment variables.
 *
 * Checked in priority order (first match wins):
 *  1. `TOKEN_GOAT_HARNESS_OVERRIDE` -- top-priority escape hatch for tests
 *     and manual debugging; overrides every signal below when set to a
 *     recognized harness name.
 *  2. Hermes -- `HERMES_SESSION_ID` or `HERMES_HOME`. Checked ahead of Claude
 *     Code because a Hermes session can still carry an `ANTHROPIC_API_KEY`.
 *  3. Claude Code -- `TERM_PROGRAM=claude-code`, `CLAUDE_CODE_VERSION`,
 *     `CLAUDE_CODE_SESSION_ID`, or `ANTHROPIC_API_KEY`.
 *  4. Codex -- `CODEX_SESSION_ID` or `CODEX_SESSION` (both spellings; the two
 *     prior detectHarness() copies each only checked one of them).
 *  5. opencode -- `OPENCODE_SESSION_ID` or `OPENCODE_SESSION` (same reason).
 *  6. OpenClaw -- `OPENCLAW_SESSION_ID`. No install-writer exists for
 *     OpenClaw yet, and no OpenClaw env var turned up anywhere in this
 *     codebase or its docs, so this is a best-effort guess following the
 *     `*_SESSION_ID` convention the harnesses above use -- revisit if
 *     OpenClaw's actual signal turns out to differ.
 *  7. Codex, API-key fallback -- `OPENAI_API_KEY` set and no
 *     `ANTHROPIC_API_KEY`.
 *  8. Gemini -- `GEMINI_API_KEY` or `GOOGLE_API_KEY`, and no
 *     `ANTHROPIC_API_KEY`.
 *  9. `generic` -- no signal matched.
 */
export function detectHarness(): HarnessName {
  const env = process.env

  const override = (env[ENV_KEYS.HARNESS_OVERRIDE] ?? '').toLowerCase().trim()
  if (override && KNOWN_HARNESS_NAMES.has(override)) {
    return override as HarnessName
  }

  if (env['HERMES_SESSION_ID'] || env['HERMES_HOME']) {
    return 'hermes'
  }

  if (
    env['TERM_PROGRAM'] === 'claude-code' ||
    env['CLAUDE_CODE_VERSION'] !== undefined ||
    env['CLAUDE_CODE_SESSION_ID'] ||
    env['ANTHROPIC_API_KEY']
  ) {
    return 'claudecode'
  }

  if (env['CODEX_SESSION_ID'] !== undefined || env['CODEX_SESSION']) {
    return 'codex'
  }

  if (env['OPENCODE_SESSION_ID'] !== undefined || env['OPENCODE_SESSION']) {
    return 'opencode'
  }

  if (env['OPENCLAW_SESSION_ID'] !== undefined) {
    return 'openclaw'
  }

  if (env['OPENAI_API_KEY'] && !env['ANTHROPIC_API_KEY']) {
    return 'codex'
  }

  if ((env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY']) && !env['ANTHROPIC_API_KEY']) {
    return 'gemini'
  }

  return 'generic'
}

/** Memoized result of {@link detectHarness}; `null` until first resolved. */
let _cached: HarnessName | null = null

/**
 * Return the detected harness, computing it once and caching the result.
 *
 * Detection is environment-stable within a process, so memoizing avoids
 * re-scanning env on every hook. The cache is cleared by `clearModuleCaches`.
 */
export function getHarnessName(): HarnessName {
  if (_cached === null) {
    _cached = detectHarness()
  }
  return _cached
}

function resetHarnessCache(): void {
  _cached = null
}

registerReset(resetHarnessCache)
