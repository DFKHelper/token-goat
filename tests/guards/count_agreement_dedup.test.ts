/**
 * Guard against the "shared helper exists but callers interpolate their own copy" class, the
 * same shape require_int_dedup.test.ts and pad_dedup.test.ts already guard.
 *
 * util.ts exports excludeTestsHiddenNote() and countNoun(), which make a noun agree with the
 * count in front of it. Before they existed, seventeen call sites across the `--exclude-tests`
 * family hard-coded `in test files` and six more hard-coded `references`, so hiding or matching
 * exactly one row rendered `1 in test files hidden by --exclude-tests` and `1 references`.
 *
 * That is easy to reintroduce: the next `--exclude-tests` surface, or the next summary line, is
 * one template literal away from doing it again, and the singular branch is invisible to any
 * fixture that happens to use two or more rows -- which is why the suite carried the defect for
 * this long and even pinned `1 references` as an expected value. This asserts the literal forms
 * are gone from the command modules, so a reintroduction fails here rather than shipping.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The modules that render count-dependent summary lines. */
const FILES = ['read_commands.ts', 'graph_commands.ts']

/** `${anything} in test files hidden by --exclude-tests` -- the hard-coded plural. */
const HARDCODED_HIDDEN_NOTE = /\$\{[^}]*\} in test files hidden by --exclude-tests/

/**
 * A bare plural noun after an interpolated count. The noun list is deliberately explicit rather
 * than "any trailing word": `${n} more`, `${n} extra` and `${n} found` are adjectives or
 * participles that do not inflect, so matching every trailing word would flag them forever. The
 * first draft of this guard listed only references/callers/symbols and immediately caught two
 * live sites its own list did NOT cover (`${allLines.length} lines`, `${grouped.length} files`),
 * so extend this list whenever a new count-dependent summary line appears.
 *
 * The count expression is deliberately any `${...}`, not just `${....length}`: formatStatsSuffix
 * shipped `${refCounts.get(sym.name) ?? 0} refs` and the read/brief header shipped `${bodyLen}
 * lines`, and both were invisible to a `.length`-anchored pattern. The `#` lookbehind exempts an
 * identifier rather than a count -- `${repo}#${opts.pr} files` names one PR's file list, so `1
 * file` would be wrong there, not right. A bare SCREAMING_CASE interpolation is likewise exempt:
 * `${FIND_SCAN_LIMIT} symbols` names a compile-time cap, not a runtime count, so it can never be
 * 1 and reads correctly as a plural.
 */
const BARE_COUNT_NOUN = /(?<!#)\$\{(?![A-Z0-9_]+\})[^}]*\} (references|refs|callers|symbols|lines|files|definitions|matches|hits|events|entries)\b/

describe('count/noun agreement is centralized, not re-interpolated per call site', () => {
  it.each(FILES)('%s does not hard-code the --exclude-tests plural', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    const match = HARDCODED_HIDDEN_NOTE.exec(src)
    expect(match?.[0], `${file} interpolates the hidden-count note directly; use excludeTestsHiddenNote() so "1 in test file" agrees`).toBeUndefined()
  })

  it.each(FILES)('%s does not follow an interpolated count with a bare plural noun', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    const match = BARE_COUNT_NOUN.exec(src)
    expect(match?.[0], `${file} renders a count followed by a hard-coded plural; use countNoun() so "1 reference" agrees`).toBeUndefined()
  })

  it('the shared helpers are actually exported from util.ts', () => {
    // Negative control for the two assertions above: they pass trivially if the helpers were
    // renamed or deleted and every call site rewritten back to a literal under a new spelling.
    const util = fs.readFileSync(path.join(SRC_DIR, 'util.ts'), 'utf8')
    expect(util).toContain('export function excludeTestsHiddenNote(')
    expect(util).toContain('export function countNoun(')
  })

  it.each(FILES)('%s imports the shared helpers it needs', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(src).toContain('excludeTestsHiddenNote')
  })
})
