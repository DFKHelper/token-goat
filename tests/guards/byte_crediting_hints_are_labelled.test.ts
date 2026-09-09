/**
 * Guard: a `session_hint` that credits bytes must say which lever earned them.
 *
 * `recordStat` takes an optional `detail` string, and nine byte-crediting call sites passed none.
 * Every one of them booked into a single undifferentiated `session_hint` bucket, so the ledger could
 * report a total and could not attribute a byte of it. That is not a cosmetic gap: sizing any one of
 * those levers is a precondition for deciding whether to change it, and the question "how much do
 * the stable-doc-compact and notebook denies actually save" was unanswerable for exactly this
 * reason, which is how a lever gets sized by inference instead of measurement.
 *
 * Event-only hints (`0, 0`) are deliberately exempt. They credit nothing, so there are no bytes to
 * attribute, and requiring a label there would be churn rather than accounting.
 *
 * The population assertion is not decoration. A guard whose matcher silently stops matching reports
 * a clean pass over an empty set, which is indistinguishable from every site being labelled. So this
 * fails if it finds no byte-crediting sites at all, and it names each unlabelled site rather than
 * asserting a bare count, because a count is satisfied by the wrong sites being right.
 *
 * PROVENANCE
 *
 * HAND-DERIVED. The expectation is computed from the source at run time by reading the argument
 * lists, never from a checked-in list of site names or a count that would have to be maintained in
 * step. It scans only `src/`, so this file's own regex literals are outside the population it judges
 * -- a guard that scans the tree containing itself matches its own pattern text and reports findings
 * that are its own source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '..', '..', 'src')
const FILES = ['hooks_read.ts', 'hooks_skill.ts', 'hooks_bash.ts', 'hooks_agent_spawn.ts']

interface Site {
  file: string
  line: number
  args: string
}

/** Every `recordStat('session_hint', ...)` call in the scanned files, with its argument text taken to end of line so a nested call's parenthesis cannot truncate it. */
function hintSites(): Site[] {
  const out: Site[] = []
  for (const file of FILES) {
    const lines = readFileSync(join(SRC_DIR, file), 'utf-8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = /recordStat\('session_hint',(.*)$/.exec(lines[i] ?? '')
      if (m === null) continue
      out.push({ file, line: i + 1, args: (m[1] ?? '').trim() })
    }
  }
  return out
}

/** A site credits bytes unless its first two numeric arguments are literal zeros. */
function creditsBytes(site: Site): boolean {
  return !/^0\s*,\s*0\s*[),]/.test(site.args)
}

/** A detail label is a bare single-quoted kebab-case string sitting after the token estimate. */
function hasDetailLabel(site: Site): boolean {
  return /,\s*'[a-z0-9-]+'\s*\)/.test(site.args)
}

describe('byte-crediting session_hint sites carry a detail label', () => {
  it('finds a non-empty population of byte-crediting sites, so a silently-broken matcher cannot pass as full coverage', () => {
    const crediting = hintSites().filter(creditsBytes)
    expect(crediting.length).toBeGreaterThan(0)
  })

  it('labels every byte-crediting site, naming any that are unattributed', () => {
    const unlabelled = hintSites()
      .filter(creditsBytes)
      .filter((s) => !hasDetailLabel(s))
      .map((s) => `${s.file}:${s.line}`)
    expect(unlabelled).toEqual([])
  })

  it('gives each byte-crediting site a distinct label, since two levers sharing one name are as unattributable as none', () => {
    const labels = hintSites()
      .filter(creditsBytes)
      .map((s) => /,\s*'([a-z0-9-]+)'\s*\)/.exec(s.args)?.[1])
      .filter((l): l is string => l !== undefined)
    expect(labels.length).toBe(new Set(labels).size)
  })
})
