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

/** The text a `--json` listing prints, with its `key` list held to the cap by dropping trailing whole items, so it stays valid JSON. `render` is the caller's own serializer (fence, escape, indent), and the cap is measured on what it returns, so the printed text is what is held to the budget, not an estimate of it; a cut result carries `truncated` and `totalCount`, and an uncut one is rendered unchanged. */
export function capListField<K extends string, T extends Record<K, unknown[]>>(obj: T, key: K, render: (o: T & { truncated?: true; totalCount?: number }) => string): string {
  const full = render(obj)
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return full
  const charBudget = Math.max(1, cfg.overflow_guard.max_tokens * guardDivisor())
  const items = obj[key]
  if (full.length <= charBudget || items.length <= 1) return full
  const cut = (kept: number): string => render({ ...obj, [key]: items.slice(0, kept), truncated: true, totalCount: items.length })
  let lo = 1
  let hi = items.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cut(mid).length <= charBudget) lo = mid
    else hi = mid - 1
  }
  return cut(lo)
}
