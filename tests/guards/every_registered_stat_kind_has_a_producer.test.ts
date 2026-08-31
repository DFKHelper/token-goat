import { describe, it, expect } from 'vitest'
import { pinnedPopulation } from './population.js'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { _registeredKinds, _registeredKindPrefixes } from '../../src/stats.js'

/**
 * The mirror of guards/every_recorded_stat_kind_is_registered.test.ts.
 *
 * That guard checks one direction: a kind some src/ call site records must be registered in
 * stats.ts, or kindToSource() silently files it under "other". Nothing checked the reverse, and
 * the reverse failure is the invisible one: SOURCE_MCP sat in KIND_PREFIX_TO_SOURCE with zero
 * producers, so an entire shipped mechanism contributed nothing to `token-goat stats` and no test
 * noticed, because a registry entry nobody records is indistinguishable from a mechanism nobody
 * runs. Every registered name here must either have a producer in src/ or an allowlist entry
 * stating why it deliberately has none.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * `walk('src')` with its population pinned. The floor cannot live inside `walk` -- the recursion
 * calls it once per subdirectory -- so it lives on the single entry point the scans below use. An
 * empty walk here reports "every kind is registered" / "every kind has a producer" for the same
 * reason a correct tree does.
 */
function scannedSrcFiles(): readonly string[] {
  return pinnedPopulation({
    what: 'src/**/*.ts files scanned for stat-kind call sites',
    items: walk('src'),
    floor: 150,
    mustInclude: ['stats.ts', 'read_commands.ts'],
  })
}

// Collects every kind name a src/ call site can statically be seen to produce. Deliberately wider than the forward guard's scan: this direction's false positive is a dead registration that stays hidden, so each real indirection this repo uses gets its own rule rather than being waved off. The `record[A-Za-z]*Stat(` shape covers recordStat plus the recordReadStat/recordXlsxStat/recordDocStat wrappers that pass a kind straight through; `kind:`/`statName:` covers emitRewrite's RewriteSavings object and hooks_common's dedup-hint factory; `kind =` covers read_commands' `redirectedFrom ? 'section_replacement' : 'section_read'` ternary; `run*Command(` covers the generic json/yaml outline and query runners that take their kind as a plain argument.
function collectProducedKinds(): Set<string> {
  const produced = new Set<string>()
  const literals = (s: string): void => {
    for (const q of s.matchAll(/(['"])([A-Za-z_][A-Za-z0-9_:]*)\1/g)) produced.add(q[2])
  }
  for (const file of scannedSrcFiles()) {
    const text = readFileSync(file, 'utf-8')
    for (const m of text.matchAll(/record[A-Za-z]*Stat\(\s*(['"])([^'"\n]+)\1/g)) produced.add(m[2])
    for (const m of text.matchAll(/record[A-Za-z]*Stat\(\s*`([^`$\n]*)\$\{/g)) produced.add(m[1])
    for (const m of text.matchAll(/\b(?:kind|statName)\s*[:=]\s*([^\n]*)/g)) literals(m[1])
    for (const m of text.matchAll(/\brun[A-Za-z]*Command\(([^\n]*)/g)) literals(m[1])
  }
  return produced
}

// Every registered name with no producer, and the reason it is allowed to have none. A blanket allowlist would make this guard theatre, so each entry names the specific reason no code records it. Anything whose mechanism is live and saving real bytes does not belong here: that is a gap to close, not to document.
const NO_PRODUCER_ALLOWLIST: Record<string, string> = {
  // The shrink re-encode cache is live (image_shrink.ts findCachedShrink), but a cache hit still records the ordinary image_shrink saving at the same call site, so no saving is lost. This is an unwired diagnostic counter, not a missing credit.
  image_shrink_cache_hit: 'diagnostic counter for a cache whose hits already record image_shrink',
  // shrinkImage() has exactly three callers (hooks_browser_image, hooks_read, the config-commands shrink CLI). No webfetch or Drive path shrinks an image at all, so these two name a mechanism that does not exist yet. They stay registered because stats.ts's _BYTES_MODE_ONLY_KINDS and the renderer's Images group already classify them.
  webfetch_image: 'no webfetch image-shrink path exists; reserved classification only',
  gdrive_image: 'no Drive image-shrink path exists; reserved classification only',
  // Hint auto-suppression is live (hint_stats.ts), but suppressing a hint withholds the hint's own bytes rather than saving a read, and that overhead is already accounted by the live session_hint_overhead kind. Event-only counter, never wired.
  session_hint_suppressed: 'suppression overhead is already accounted by session_hint_overhead',
  // Vestigial from the Python port: neither names a mechanism that exists in this tree. Kept registered so that wiring either one later cannot silently misfile under "other".
  structured_file_hint: 'vestigial Python-port name; no such hint exists in this tree',
  predictive_prefetch_hit: 'vestigial Python-port name; no such prefetch exists in this tree',
  // The live Drive kind is the explicit gdrive_sections entry, which does not carry a colon. Nothing produces a colon-suffixed Drive kind.
  'gdrive:': 'the live Drive kind is the explicit gdrive_sections entry, not a colon-prefixed one',
  // skill-compact regenerates and caches a compact slice; it emits no substitute for a body the model would otherwise have received, so there is no saving for it to book at that moment. The saving is booked when the slice is served (skill_body:compact, skill_compact_inlined).
  'skill_compact:': 'skill-compact caches a slice and emits no substitute, so it books nothing',
}

describe('every stat kind registered in stats.ts has a producer in src/', () => {
  it('finds producers at all, so an empty scan cannot pass vacuously', () => {
    const produced = collectProducedKinds()
    expect(produced.size, 'the producer scan matched nothing -- the regexes have drifted').toBeGreaterThan(50)
  })

  it('sees the four indirection shapes a first-argument-literal scan misses', () => {
    const produced = collectProducedKinds()
    // Pinned individually. Each is a kind whose producer passes it through a variable, so losing the rule that sees it would silently move a live kind into this guard's failure list and invite it onto the allowlist as "dead".
    expect(produced.has('csv_query'), 'a kind passed through the recordReadStat wrapper must be seen').toBe(true)
    expect(produced.has('xlsx_head'), 'a kind passed through the recordXlsxStat wrapper must be seen').toBe(true)
    expect(produced.has('section_replacement'), 'a kind assigned by a ternary must be seen').toBe(true)
    expect(produced.has('yaml_query'), "a kind passed as a generic runner's argument must be seen").toBe(true)
  })

  it('leaves no registered kind without either a producer or a stated reason', () => {
    const produced = collectProducedKinds()
    const orphans = _registeredKinds().filter((k) => !produced.has(k) && NO_PRODUCER_ALLOWLIST[k] === undefined)
    expect(
      orphans,
      'these kinds are registered in KIND_TO_SOURCE but nothing in src/ records them -- either wire the producer or add an allowlist entry saying why none exists',
    ).toEqual([])
  })

  it('leaves no registered prefix without either a producer or a stated reason', () => {
    const produced = [...collectProducedKinds()]
    const orphans = _registeredKindPrefixes().filter(
      (p) => !produced.some((k) => k.startsWith(p)) && NO_PRODUCER_ALLOWLIST[p] === undefined,
    )
    expect(
      orphans,
      'these prefixes are registered in KIND_PREFIX_TO_SOURCE but nothing in src/ records a kind under them -- this is exactly how the mcp: mechanism stayed invisible',
    ).toEqual([])
  })

  it('keeps the allowlist honest: every entry names a kind that is actually registered and actually unproduced', () => {
    const produced = collectProducedKinds()
    const registered = new Set([..._registeredKinds(), ..._registeredKindPrefixes()])
    for (const [name, reason] of Object.entries(NO_PRODUCER_ALLOWLIST)) {
      expect(registered.has(name), `${name} is allowlisted but is no longer registered -- drop the entry`).toBe(true)
      const isPrefix = name.endsWith(':')
      const nowProduced = isPrefix ? [...produced].some((k) => k.startsWith(name)) : produced.has(name)
      expect(nowProduced, `${name} now has a producer -- drop its allowlist entry rather than leaving a stale excuse`).toBe(false)
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(20)
    }
  })
})
