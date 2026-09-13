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
 * Deliberately loose on the leading qualifier (`opts.`, `where.`, `this.opts.`, bare) and strict on
 * the tail, so `new RegExp(escapeRegExp(name))` -- a pattern the code built itself out of a literal
 * -- does not trip it. Those are the overwhelming majority of the ~130 `new RegExp` sites here and
 * none of them are reachable by a caller's text. Any number of dotted levels now, because a single
 * one rejected `a.b.grep` and `this.opts.grep` while accepting `opts.grep`, which is a distinction
 * about spelling and not about exposure.
 */
const CALLER_SUPPLIED = /(?:^|\.)(?:pattern|patterns|grep|regex|rx|expr|filter|search|query|needle|include|exclude)(?:$|\.)/i

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * The first argument of every `call(` in `text`, as written -- the whole expression, not just a name.
 *
 * The first version of this matched a bare name or a single dotted level and nothing else, and an
 * adversarial review measured what that missed: of nine ways to spell the defect, it saw one.
 * `new RegExp(opts.grep.trim())`, `new RegExp(String(opts.grep))`, `new RegExp(opts.grep ?? '')`,
 * `new RegExp(patterns[0])` and `new RegExp(...args)` were not extracted at all, and `a.b.grep` and
 * `opts.include` were extracted and then rejected by the name test. None of them exist in the tree
 * today, which is exactly why the gap was invisible: an extractor that sees nothing and a tree that
 * contains nothing produce the same green. So the argument is taken whole, by balancing brackets to
 * the first top-level `,` or `)`, and the NAMES INSIDE IT are what gets judged.
 */
function firstArguments(text: string, call: string): string[] {
  const out: string[] = []
  const re = new RegExp(String.raw`${call}\(`, 'g')
  for (const m of text.matchAll(re)) {
    const arg = balancedArgument(text, m.index + m[0].length)
    if (arg !== null) out.push(arg.trim())
  }
  return out
}

/** The text from `start` to the first top-level `,` or `)`, or `null` if the call never closes. */
function balancedArgument(text: string, start: number): string | null {
  let depth = 0
  let quote = ''
  for (let i = start; i < text.length && i < start + 400; i++) {
    const c = text[i] as string
    if (quote !== '') {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ')') {
      if (depth === 0) return text.slice(start, i)
      depth--
    } else if (c === ',' && depth === 0) return text.slice(start, i)
    else if (c === '\n' && depth === 0 && text.slice(start, i).trim() === '') continue
  }
  return null
}

/**
 * Every bare name and dotted path written inside an argument expression, ignoring string contents.
 *
 * The masking is load-bearing. Reading names out of the raw text made three of the language
 * adapters offenders on their own literals -- `new RegExp('^(?:function|filter|workflow|...')`
 * names `filter` inside a quoted alternation, which is a word in a regex and not a variable. A
 * template literal keeps its `${...}` holes and loses the rest, because that is exactly the split
 * between what a caller can reach and what the file wrote itself.
 */
function namesIn(argument: string): string[] {
  const masked = argument
    .replaceAll(/`(?:[^`\\]|\\.)*`/g, (lit) => [...lit.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1]).join(' '))
    .replaceAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ')
  return [...masked.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)].map((m) => m[0])
}

/**
 * Every way a string becomes a running regular expression, as a source-text pattern for `call`.
 *
 * `new RegExp` is the obvious one and was the only one the first version of this guard knew. The
 * others are how the same defect gets reintroduced without the words `new RegExp` appearing:
 * `RegExp(p)` without `new` returns the identical object, a template wrapper hides the argument
 * behind an interpolation, and `String.prototype.match`, `matchAll`, `search` and `split` all
 * COMPILE a string argument as a pattern rather than matching it literally -- `line.match(pattern)`
 * is exactly as exposed as `new RegExp(pattern).test(line)` and reads as if it were not.
 * `replace`/`replaceAll` with a string argument are not sinks: those match literally.
 */
const REGEX_SINKS = [
  String.raw`\bnew\s+RegExp`,
  String.raw`(?<!new\s)\bRegExp`,
  String.raw`\.match`,
  String.raw`\.matchAll`,
  String.raw`\.search`,
  String.raw`\.split`,
] as const

/** Whether `name` is bound in `text` by destructuring a table entry, which is never a caller's string. */
function boundByDestructuring(text: string, name: string): boolean {
  return new RegExp(String.raw`for\s*\(\s*const\s*\[\s*${name}\b`).test(text)
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
    items: [...sources.values()].flatMap((text) =>
      [...firstArguments(text, String.raw`\bcompileGuardedRegex`), ...firstArguments(text, String.raw`\bcompileGuardedRegexCached`)].flatMap(
        namesIn,
      ),
    ),
    floor: 6,
  }),
)

describe('caller-supplied search patterns', () => {
  it('the derived denylist really does name caller-supplied patterns, not incidental arguments', () => {
    expect([...guardedArguments].some((a) => CALLER_SUPPLIED.test(a)), 'no guarded argument looks like a caller-supplied pattern').toBe(true)
  })

  it('never reaches an unguarded regex sink anywhere in src', () => {
    const offenders: string[] = []
    const exempt: string[] = []
    for (const [rel, text] of sources) {
      const lines = text.split('\n')
      for (const sink of REGEX_SINKS) {
        for (const argument of firstArguments(text, sink)) {
          const arg = namesIn(argument).find((n) => guardedArguments.has(n) || CALLER_SUPPLIED.test(n))
          if (arg === undefined) continue
          // Already a RegExp at this point, so nothing is being compiled. `matchAll(pattern)` inside
          // `for (const [pattern, kind] of LIQUID_TAG_IMPORTS)` reads exactly like the defect and is
          // its opposite: the name is bound by destructuring a module-level table of compiled
          // regexes, which no caller can reach. Narrow on purpose -- it recognises the binding form,
          // not the file -- and counted below, so a third one has to be looked at rather than
          // absorbed. A string argument would still be flagged even in the same file.
          if (boundByDestructuring(text, arg)) {
            exempt.push(`src/${rel}  ${arg}`)
            continue
          }
          const at = new RegExp(String.raw`${sink}\(\s*(?:\`\$\{\s*)?${arg.replaceAll('.', String.raw`\.`)}`)
          offenders.push(`src/${rel}:${lines.findIndex((l) => at.test(l)) + 1}  ${sink.replace(/\\b|\(\?<!new\\s\)/g, '')}(${argument})`)
        }
      }
    }
    expect(offenders, `these compile a caller's pattern without the ReDoS guard -- route them through compileGuardedRegex in src/regex_guard.ts:\n${offenders.join('\n')}`).toEqual([])
    // Pinned, not merely allowed: the exemption is the part of this guard that can quietly grow
    // until it covers the defect. Two live at 2.9.11, both `matchAll` over a table of compiled
    // regexes. A new one is a review, not a rubber stamp.
    expect(exempt.sort(), 'the RegExp-binding exemption changed; confirm each new site really is a compiled RegExp and not a string').toEqual([
      'src/languages/liquid.ts  pattern',
      'src/languages/sql_idx.ts  pattern',
    ])
  })

  it.each([
    ['new RegExp(opts.grep)', 'the plain form'],
    ['RegExp(opts.grep)', 'RegExp without new'],
    ['new RegExp(`${opts.grep}`)', 'a template wrapper'],
    ['line.match(opts.grep)', 'a String.prototype coercion sink'],
    // Everything below this line was missed by the extractor that shipped, and every one of them
    // is a spelling somebody writes without thinking they have changed anything.
    ['new RegExp(opts.grep.trim())', 'a call expression'],
    ['new RegExp(String(opts.grep))', 'a coercion wrapper'],
    ["new RegExp(opts.grep ?? '')", 'a default'],
    ['new RegExp(this.opts.grep)', 'two dotted levels'],
    ['new RegExp(opts.grep, flags)', 'a second argument'],
  ])('finds %s (%s) when it is the only thing in a file', (snippet) => {
    // The sweep above is only evidence if it can actually see each shape. Asserting that on the
    // real tree is impossible -- the tree has none of them, which is the point -- so each shape is
    // put in front of the same extractor here. Without this, widening the sink list to cover a
    // shape and getting the pattern subtly wrong looks exactly like the tree being clean.
    const found = REGEX_SINKS.flatMap((sink) => firstArguments(snippet, sink)).flatMap(namesIn)
    expect(found.join(' '), `the extractor did not see ${snippet}`).toContain('opts.grep')
    expect(found.some((n) => CALLER_SUPPLIED.test(n)), `the extractor saw ${snippet} and then did not judge it caller-supplied`).toBe(true)
  })
})
