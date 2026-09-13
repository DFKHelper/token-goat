/**
 * No surface may compile a caller-supplied search pattern with a bare `new RegExp`.
 *
 * `src/regex_guard.ts` exists because a regular expression a model or a command line chose can
 * wedge the process: `^(a+)+$` against a 40-character line never returns, and JS offers no way to
 * interrupt a running match -- no timeout, no abort, no worker cancellation. So the only defence is
 * refusing the pattern before it runs, which is what `compileGuardedRegex` does.
 *
 * That defence is per-call-site, and the review that added it missed three of them: `pdf-locate`,
 * `pptx-text --grep` and `transcript --grep` still compiled raw after the first pass shipped, and
 * the CHANGELOG claimed a coverage it did not have. Nothing caught that, because every test named
 * the surfaces it knew about, and the surface nobody thought of is exactly the one that gets
 * missed. This guard inverts it: instead of listing the guarded sites, it hunts the unguarded ones.
 *
 * The denylist is derived, not written: the argument expressions that reach `compileGuardedRegex`
 * today ARE the names that carry caller-supplied pattern text, so a new command that guards
 * `opts.grep` also teaches this guard that `new RegExp(opts.grep)` is a defect. A fixed shape rule
 * covers the name nobody has guarded yet -- anything ending in `pattern`, `grep`, `regex`,
 * `filter`, `search` or `query`.
 *
 * PROVENANCE: HAND-DERIVED. The population is the repo's own source text, read at test time; the
 * verdict is a structural property of it, not a comparison against any producer's output.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** The guard's own module compiles patterns raw by definition -- it is the thing doing the guarding. */
const EXEMPT = new Set(['regex_guard.ts'])

/**
 * Argument spellings that mean "a pattern the caller handed us".
 *
 * Deliberately loose on the leading qualifier (`opts.`, `where.`, bare) and strict on the tail, so
 * `new RegExp(escapeRegExp(name))` -- a pattern the code built itself out of a literal -- does not
 * trip it. Those are the overwhelming majority of the ~130 `new RegExp` sites here and none of them
 * are reachable by a caller's text.
 */
const CALLER_SUPPLIED = /^(?:[A-Za-z_$][\w$]*\.)?(?:pattern|grep|regex|filter|search|query)$/i

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The first argument of every `call(` in `text`, as written, when it is a simple expression. */
function firstArguments(text: string, call: string): string[] {
  const out: string[] = []
  const re = new RegExp(String.raw`\b${call}\(\s*([A-Za-z_$][\w$.]*)\s*[,)]`, 'g')
  for (const m of text.matchAll(re)) out.push(m[1] as string)
  return out
}

const files = pinnedPopulation({
  what: 'src/**/*.ts files scanned for an unguarded pattern compile',
  items: tsFiles(SRC).filter((f) => !EXEMPT.has(path.basename(f))),
  // 311 live at 2.9.11, one of them exempt.
  floor: 250,
})
const sources = new Map(files.map((f) => [path.relative(SRC, f).replaceAll('\\', '/'), fs.readFileSync(f, 'utf8')]))

/**
 * Every argument spelling that a guarded call site passes today -- the derived half of the rule.
 *
 * Pinned because it is the half that can silently empty: rename `compileGuardedRegex` and this set
 * goes to zero, the sweep below then finds nothing, and the suite certifies a coverage that no
 * longer exists. Nine call sites live at 2.9.11 across eight argument spellings.
 */
const guardedArguments = new Set(
  pinnedPopulation({
    what: 'argument spellings passed to compileGuardedRegex',
    items: [...sources.values()].flatMap((text) => [
      ...firstArguments(text, 'compileGuardedRegex'),
      ...firstArguments(text, 'compileGuardedRegexCached'),
    ]),
    floor: 6,
  }),
)

describe('caller-supplied search patterns', () => {
  it('the derived denylist really does name caller-supplied patterns, not incidental arguments', () => {
    expect([...guardedArguments].some((a) => CALLER_SUPPLIED.test(a)), 'no guarded argument looks like a caller-supplied pattern').toBe(true)
  })

  it('never reaches a bare new RegExp anywhere in src', () => {
    const offenders: string[] = []
    for (const [rel, text] of sources) {
      const lines = text.split('\n')
      for (const arg of firstArguments(text, 'new RegExp')) {
        if (!guardedArguments.has(arg) && !CALLER_SUPPLIED.test(arg)) continue
        const line = lines.findIndex((l) => new RegExp(String.raw`new RegExp\(\s*${arg.replaceAll('.', '\\.')}\s*[,)]`).test(l))
        offenders.push(`src/${rel}:${line + 1}  new RegExp(${arg})`)
      }
    }
    expect(offenders, `these compile a caller's pattern without the ReDoS guard -- use compileGuardedRegex from src/regex_guard.ts:\n${offenders.join('\n')}`).toEqual([])
  })
})
