import { loadConfig } from './config.js'
import { scanForInjectionPatterns, UNTRUSTED_FILE_TAG } from './injection_scan.js'
import { estimateTokens, trimToBudget } from './overflow_guard.js'
import { GUARD_UNITS_PER_TOKEN, guardUnits } from './token_estimate.js'
import { displaySafeJson } from './paths.js'
import { redactOrWithhold, WITHHELD_PLACEHOLDER } from './redact_or_withhold.js'
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
  return guardThenFence(redactOrWithhold(text, false), command, tag)
}

export { WITHHELD_PLACEHOLDER }

/** The text of an indexed file a read command is about to print, with secret-shaped values replaced and every line break kept, so the `-n` numbering and line ranges a reader quotes still point at the same lines. The index stores file text whole and answers from any project, so a stored body is as unvetted as the file it was cut from. */
export function redactReadText(text: string): string {
  return redactOrWithhold(text, true)
}

/** {@link redactReadText} for a list of lines, redacted as the one text they came from so a block spanning several of them (a PEM key) is seen whole, and returned with the same number of elements. */
export function redactReadLines(lines: readonly string[]): string[] {
  if (lines.some((line) => line.includes('\n'))) return lines.map(redactReadText)
  const redacted = redactReadText(lines.join('\n')).split('\n')
  return redacted.length === lines.length ? redacted : lines.map(redactReadText)
}

/** The keys of a `--json` payload whose array of strings is consecutive lines of one file, so a block spanning several elements has to be redacted across them rather than one element at a time. */
const LINE_ARRAY_KEYS: ReadonlySet<string> = new Set(['lines'])

/** One string leaf of a `--json` payload, or the value a command prints for a key the user named, redacted under the key it sits at: the key-anchored patterns (`api_key`, `password`, `Authorization`) read a name and then a value, and a leaf alone carries only the value. The key is put back as a `key: ` prefix for the match and taken off again; when the key itself was rewritten the leaf is redacted bare. */
export function redactKeyedValue(key: string, leaf: string): string {
  if (key === '') return redactReadText(leaf)
  const prefix = `${key}: `
  const redacted = redactReadText(prefix + leaf)
  return redacted.startsWith(prefix) ? redacted.slice(prefix.length) : redactReadText(leaf)
}

/** A `--json` value with every string leaf redacted on its own, the way {@link redactReadText} redacts text, so a secret is matched as the characters the file holds rather than as the JSON escaping of them, a placeholder never lands unquoted in the document and the elements of a list never merge. Numbers, booleans, null and keys are left as they are. */
function redactJsonLeaves(value: unknown, key: string): unknown {
  if (typeof value === 'string') return redactKeyedValue(key, value)
  if (Array.isArray(value)) {
    if (LINE_ARRAY_KEYS.has(key) && value.every((v) => typeof v === 'string')) return redactReadLines(value as string[])
    return value.map((v) => redactJsonLeaves(v, key))
  }
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJsonLeaves(v, k)]))
  return value
}

/** {@link displaySafeJson} for a read command's `--json` payload, with each string leaf redacted by {@link redactJsonLeaves} before it is indented. Redacting the serialized text instead missed a secret inside a JSON file that the payload carries as an escaped string, because the escaped quote broke the patterns' lookbehind, and it collapsed a multi-line block to one placeholder so a `lines` list lost elements. */
export function redactReadJson(value: unknown, indent = 2, key = ''): string {
  return JSON.stringify(redactReadTree(value, key), null, indent)
}

/** The tree {@link redactReadJson} serializes, for a caller that wraps it in an envelope of its own. `key` names the property the value sits at, so a bare string a command prints for a queried key is redacted as the file spells that key; the document keys inside it are used as they are. */
export function redactReadTree(value: unknown, key = ''): unknown {
  const text: string | undefined = displaySafeJson(value, 0)
  if (text === undefined) return value
  return redactJsonLeaves(JSON.parse(text), key)
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
  const budget = cfg.overflow_guard.max_tokens * GUARD_UNITS_PER_TOKEN
  const items = obj[key]
  if (guardUnits(full) <= budget || items.length <= 1) return full
  const cut = (kept: number): string => render({ ...obj, [key]: items.slice(0, kept), truncated: true, totalCount: items.length })
  let lo = 1
  let hi = items.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (guardUnits(cut(mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  return cut(lo)
}
