/**
 * The single decision point for "should this text be fenced, and under what notice".
 *
 * Every surface that emits third-party text routes through here so the rule lives in one place.
 * It previously lived, restated, in eight separate call sites -- and all eight got it wrong the
 * same way: each gated the fence on `scanForInjectionPatterns` returning a hit, so any payload the
 * eight deliberately-narrow patterns miss was emitted bare. That is the shape CLAUDE.arch.md's
 * Security Boundaries prohibits: a fence gated on a detector re-prices the payload, because a miss
 * then costs the whole protection rather than just the label.
 *
 * The rule, stated once:
 *
 * - `injection.enabled === false` is the documented one-line opt-out for the whole subsystem, so
 *   it returns the text untouched. That is a user's explicit configuration, not a heuristic -- the
 *   invariant is "not gated on a detector", not "not gated on anything". It also stays the escape
 *   hatch for a downstream consumer that cannot handle fence tags.
 * - Otherwise the text is fenced, always. The scan runs only to decide whether the notice names
 *   matched pattern(s) and whether an `injection_detected` stat is recorded.
 * - An unreadable config must not cost the fence: it falls back to enabled, with no scan. Failing
 *   open on the security action is the wrong direction, and this mirrors `fenceOcrText`, the one
 *   site in the codebase that already had this shape before the rest were brought into line.
 */
import { loadConfig } from './config.js'
import { fenceUntrustedContent, scanForInjectionPatterns } from './injection_scan.js'
import { recordStat } from './stats.js'

/** Whether the injection subsystem is on. False only when the user set `injection.enabled=false`. */
export function injectionFencingEnabled(): boolean {
  try {
    return loadConfig().injection.enabled
  } catch {
    // An unreadable config must not silently disable a security boundary.
    return true
  }
}

/**
 * Scan `text` for the stat/notice, then fence it under `tag` regardless of the result.
 * Returns `text` unchanged only when the subsystem is switched off.
 */
export function fenceUntrusted(text: string, tag: string): string {
  if (!injectionFencingEnabled()) return text
  return fenceUntrustedContent(text, scanAndRecord(text), tag)
}

/**
 * {@link fenceUntrusted} for a caller that already ran {@link scanAndRecord} and must not scan the
 * same text twice -- the hook handlers, which need the matches in hand to pick a return shape
 * before they know which string they are fencing. Same opt-out, same unconditional fence.
 */
export function fenceWithMatches(text: string, matches: readonly string[], tag?: string): string {
  if (!injectionFencingEnabled()) return text
  return tag === undefined
    ? fenceUntrustedContent(text, matches)
    : fenceUntrustedContent(text, matches, tag)
}

/**
 * The scan half on its own, for the hook handlers that need the matches before choosing a return
 * shape (pass through, redact-only, or fence). Returns `[]` when the subsystem is switched off, so
 * a caller that gates its own fence on {@link injectionFencingEnabled} sees no matches either way.
 */
export function scanAndRecord(text: string): string[] {
  if (!injectionFencingEnabled()) return []
  let matches: string[]
  try {
    matches = scanForInjectionPatterns(text)
  } catch {
    matches = []
  }
  if (matches.length > 0) recordStat('injection_detected', 0, 0, undefined, matches.join(','))
  return matches
}
