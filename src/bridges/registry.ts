/**
 * Harness detection.
 *
 * {@link detectHarness} inspects the process environment to decide which AI
 * harness token-goat is running under; {@link getHarnessName} memoizes the
 * result for the life of the process (cleared by `clearModuleCaches` so tests
 * can flip env vars between cases).
 */

import { registerReset } from '../reset.js'
import type { HarnessName } from './types.js'

/**
 * Detect the running harness from environment variables.
 *
 * Checked in priority order so a more specific signal wins over a generic one:
 * Claude Code's `TERM_PROGRAM=claude-code` / `CLAUDE_CODE_VERSION`, then
 * Codex's `CODEX_SESSION_ID`, then opencode's `OPENCODE_SESSION_ID`. Falls
 * back to `'generic'` when no signal is present.
 */
export function detectHarness(): HarnessName {
  const env = process.env
  if (env['TERM_PROGRAM'] === 'claude-code' || env['CLAUDE_CODE_VERSION'] !== undefined) {
    return 'claudecode'
  }
  if (env['CODEX_SESSION_ID'] !== undefined) return 'codex'
  if (env['OPENCODE_SESSION_ID'] !== undefined) return 'opencode'
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
