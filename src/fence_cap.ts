import { loadConfig } from './config.js'
import { scanForInjectionPatterns, UNTRUSTED_FILE_TAG } from './injection_scan.js'
import { estimateTokens, trimToBudget } from './overflow_guard.js'
import { guardDivisor } from './token_estimate.js'
import { redactSecrets } from './secret_redact.js'
import { fenceUntrusted, fenceWithMatches } from './untrusted_fence.js'

/** {@link guardText}, then a fence under `tag` around what the cap kept, with the cap's marker below the closing tag. The cap keeps leading lines only, so fencing first lets it cut the closing tag off and leaves token-goat's marker inside the fence. */
export function guardThenFence(text: string, command: string, tag: string): string {
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return fenceUntrusted(text, tag)
  const budget = cfg.overflow_guard.max_tokens
  // The fence's tags, its notice and the escapes it writes into the body come out of the same max_tokens as the body, so the cap is re-run with what the assembled output overshot held back, until it fits. A fixed margin would not do: the escapes grow with how many markers the body carries.
  let capped = trimToBudget(text, budget, command)
  let reserve = 0
  for (let pass = 0; pass < 8; pass++) {
    const excess = estimateTokens(fenceThenMarker(capped, text, (body) => fenceWithMatches(body, scanUnrecorded(body), tag))) - budget
    if (excess <= 0) break
    reserve += excess
    capped = trimToBudget(text, budget, command, { reserveTokens: reserve })
  }
  return fenceThenMarker(capped, text, (body) => fenceUntrusted(body, tag))
}

/** `capped` fenced by `fence`, with the cap's marker line, when the cap cut anything, below the closing tag rather than inside the fence. */
function fenceThenMarker(capped: string, text: string, fence: (body: string) => string): string {
  if (capped === text) return fence(text)
  const markerAt = capped.lastIndexOf('\n')
  return `${fence(capped.slice(0, markerAt))}\n${capped.slice(markerAt + 1)}`
}

/** The pattern names a fence's notice would carry for `text`, without booking the injection_detected stat: {@link guardThenFence} measures candidate outputs it does not print, and only the one it prints should count. */
function scanUnrecorded(text: string): string[] {
  try {
    return scanForInjectionPatterns(text)
  } catch {
    return []
  }
}

/** {@link guardThenFence} for text the user named rather than wrote, redacted before the cap can cut a secret short of its pattern: capping unredacted text first can leave a fragment the redactor no longer recognises. */
export function guardRedactAndFence(text: string, command: string, tag: string): string {
  return guardThenFence(redactSecrets(text).text, command, tag)
}

/** {@link guardRedactAndFence} under the file tag, for a document, a spreadsheet, an archive member or a database row. */
export function guardAndFenceFileText(text: string, command: string): string {
  return guardRedactAndFence(text, command, UNTRUSTED_FILE_TAG)
}

/** `obj` with its `key` list held to the cap by dropping trailing whole items, so a `--json` listing stays valid JSON, each item measured as the `indent` spaces the caller serializes with would print it; `truncated` and `totalCount` are added only when something was dropped, which leaves the shape of an uncapped result unchanged. */
export function capListField<K extends string, T extends Record<K, unknown[]>>(obj: T, key: K, indent = 0): T & { truncated?: true; totalCount?: number } {
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return obj
  const items = obj[key]
  const charBudget = Math.max(1, cfg.overflow_guard.max_tokens * guardDivisor())
  let kept = 0
  let used = 0
  for (const item of items) {
    const cost = JSON.stringify(item, null, indent).length + 2
    if (kept > 0 && used + cost > charBudget) break
    kept++
    used += cost
  }
  return kept < items.length ? { ...obj, [key]: items.slice(0, kept), truncated: true, totalCount: items.length } : obj
}
