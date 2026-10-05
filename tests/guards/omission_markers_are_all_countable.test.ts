/** Every mid-trim omission marker a tool filter writes has to be countable by the census that reports them, or the lines it discarded are simply missing from the report with nothing saying so. That is not hypothetical: the cloud filter's `[token-goat: N plan detail lines omitted]` spelling lacked the literal ` more ` the census pattern required, so every plan-detail trim was omitted from the omission census -- an under-count that looks exactly like a filter that never fired. FORMAT-DERIVED: the marker strings are read out of the producers' own source at run time rather than transcribed here, so a new filter spelling is picked up the moment it is written. That is the weaker provenance tier -- it proves the census agrees with the source, not that a shipped build emits these bytes -- but it is the tier that matters for this defect, which is precisely a consumer disagreeing with its producers. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { OMISSION_MARKER_RE } from '../../src/session_audit.js'
import { pinnedPopulation } from './population.js'

// Scoped to the filters on purpose. The census counts lines a filter removed from a tool result the model was about to read. read_commands.ts writes a similar-looking `... (N more lines omitted)` note, but that is a CLI run declining to print lines to its own caller, which is a saving rather than a trim, and folding it in would double-count one against the other.
const FILTER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tool_filters')

/** A `${countNoun(count, 'singular'[, 'plural'])}` interpolation, the shared helper a marker uses so its noun agrees with the count. */
const COUNT_NOUN_RE = /\$\{countNoun\([^,]+, '([^']*)'(?:, '([^']*)')?\)\}/g

/** A marker template rendered with `n` in place of each count: a countNoun call renders as the helper would, every other interpolation as the bare number. */
function render(template: string, n: number): string {
  return template
    .replace(COUNT_NOUN_RE, (_m, singular: string, plural: string | undefined) => `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`)
    .replace(/\$\{[^}]*\}/g, String(n))
    .replace(/\\n/g, '\n')
}

/** Every backtick template in the filter sources whose text mentions an omitted-line count, rendered with a concrete number in place of each interpolation, once with a plural count and once with a count of one (which renders the noun singular). */
function renderedMarkers(): { file: string; template: string; rendered: string; n: number }[] {
  const found: { file: string; template: string; rendered: string; n: number }[] = []
  for (const file of fs.readdirSync(FILTER_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(FILTER_DIR, file), 'utf8')
    for (const match of src.matchAll(/`([^`]*(?:lines omitted|line'\)\} omitted)[^`]*)`/g)) {
      const template = match[1] ?? ''
      for (const n of [7, 1]) found.push({ file, template, rendered: render(template, n), n })
    }
  }
  // A scan that finds nothing would pass every per-marker case below by registering none of them, so the population is pinned before it is used. Eight when this guard was written, across four filter files; the two anchors are the spellings that bracket the pattern's tolerance -- the one that omits `more` (the defect this guard was written for) and the one that carries a `+` before its digits.
  pinnedPopulation({
    what: 'omission markers written by tool filters',
    items: found.filter((m) => m.n === 7).map((m) => `${m.file} :: ${m.template}`),
    floor: 8,
    mustInclude: ['cloud.ts :: [token-goat: ${omitted} plan detail lines omitted]', "git.ts :: [token-goat: +${countNoun(elided, 'more stat line')} omitted]"],
  })
  return found
}

describe('omission markers are all countable', () => {
  const markers = renderedMarkers()

  it.each(markers.map((m) => [`${m.file} (n=${m.n}): ${m.template}`, m.rendered, m.n] as const))('counts %s', (_label, rendered, n) => {
    OMISSION_MARKER_RE.lastIndex = 0
    const hits = [...rendered.matchAll(OMISSION_MARKER_RE)]
    expect(hits).toHaveLength(1)
    const count = hits[0]?.slice(1).find((g) => g !== undefined)
    expect(count).toBe(String(n))
  })

  it('renders a countNoun marker singular at one, so the census pattern is tested against the spelling a one-line trim really prints', () => {
    // HAND-DERIVED: countNoun(1, 'more stat line') is "1 more stat line" by the helper's own contract in src/util.ts.
    expect(render("[token-goat: +${countNoun(elided, 'more stat line')} omitted]", 1)).toBe('[token-goat: +1 more stat line omitted]')
  })
})
