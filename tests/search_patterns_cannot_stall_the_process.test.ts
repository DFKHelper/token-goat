/**
 * A search pattern from a model or a command line must not be able to wedge the process.
 *
 * JavaScript's regex engine backtracks and cannot be interrupted: no timeout, no abort signal.
 * `^(a+)+$` against forty `a` characters followed by one that does not match never returns --
 * measured 2026-09-13 on Node 24, still running when a 20 s kill arrived. The MCP `grep` tool took
 * its pattern straight to `new RegExp` and then ran it per line, so a model that had read a prompt
 * injection could hang the stdio server, and with it every other tool in the session. The input
 * that triggers it is ordinary text; the attacker supplies only the pattern.
 *
 * These tests are written against a WALL CLOCK, which is the only oracle that distinguishes the
 * defect from its fix: a shape check that refuses `(a+)+` looks identical in a unit test to one
 * that refuses it for the wrong reason, and `(a|a)+` -- which has no nested quantifier at all --
 * is refused by measurement alone. The budgets are loose (2 s against a defect that runs for
 * minutes) so a slow or loaded CI runner cannot fail them.
 *
 * PROVENANCE: HAND-DERIVED. The pump strings are constructed here from the pattern's own alphabet,
 * independently of anything in src/, and the timings are read off `Date.now()` in this file. The
 * catastrophic patterns are the textbook ones plus `(a|a)+`, which was added because an adversarial
 * review of the shape check found it passed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { compileGuardedRegex, growsExponentially, hasNestedQuantifier, probeAlphabets } from '../src/regex_guard.js'
import { compileGrepMatcher } from '../src/util.js'
import { runGrep } from '../src/read_commands.js'
import { sliceTranscript } from '../src/transcript_extract.js'

/** Long enough that an exponential pattern cannot finish, short enough to be an ordinary line. */
const PUMP = 'a'.repeat(40) + '!'

/** Patterns that never return against PUMP. */
const CATASTROPHIC = [
  '^(a+)+$',
  '(a+)+$',
  '^(?:a*)*$',
  '^(a|a)+$',
  String.raw`^(\w+\s?)*$`,
  // `^(b|bb)+$` is here because a fixed probe alphabet is a hole, not a bound. It has no nested
  // quantifier and finishes instantly against `aaa...`, `000...` and `a0a0...`, so the first
  // version of the probe accepted it -- and it takes 13 seconds against 44 `b` characters, doubling
  // every two after that. Only pumping the pattern's OWN literals catches it.
  '^(b|bb)+$',
  // The same defect spelled so the literal never appears. Reading escapes as characters the probe
  // can pump is what catches these; skipping them whole, as the first version did, accepts all
  // three. Measured raw: 20.9 s against 40 spaces, 2.9 s against 36 `b`s, 2.9 s against 36 `b`s.
  String.raw`^(\s|\s\s)+$`,
  String.raw`^(\x62|\x62\x62)+$`,
  '^([b-c]|[b-c][b-c])+$',
  // Super-linear without being exponential, which no short measurement can see: 0.55 ms at 36
  // characters, 50 ms at 200, 18.6 s at 800. `token-goat grep` with it against a file holding one
  // 3000-character line -- a minified bundle, a base64 blob -- did not return in two minutes.
  '^(a+)(a+)(a+)(a+)b$',
  '^a*a*a*a*b$',
  // The probe as the weapon. This multiplies by four per character and took 27.8 s at 16, which was
  // the first length the probe tried, so the guard hung inside the measurement it was taking to
  // decide whether the pattern could hang anything. Nothing downstream can help: the budget is only
  // read after a synchronous `test` returns, and JavaScript cannot interrupt one.
  '^(a|a|a|a)+$',
]

/**
 * Patterns a caller would really write, none of which may be refused.
 *
 * `^(?:[a-z]+-)+[a-z]+$` is the load-bearing one: an ordinary slug matcher whose mandatory `-`
 * makes every group boundary unambiguous. It matched a 200 KB non-match in about a millisecond,
 * yet by shape it is `(x+)+` and the static check condemned it. A refusal here is not a harmless
 * false positive -- it is a search the caller wanted and cannot run.
 */
const ORDINARY = [
  'TODO',
  String.raw`function\s+(\w+)`,
  '^import .* from',
  String.raw`\bcompileGuardedRegex\b`,
  'a+b*c?',
  '(foo|bar|baz)',
  String.raw`^\s*#{1,6}\s`,
  '^(?:[a-z]+-)+[a-z]+$',
  // Added with the long rungs: these run against 512 characters now, and a rung that reads an
  // ordinary pattern as super-linear costs a real search.
  String.raw`^\d{4}-\d{2}-\d{2}$`,
  String.raw`\berror\b.*\bat\b`,
  '^(GET|POST|PUT|DELETE) /[a-z/]*$',
  '[a-zA-Z0-9+/]{40,}={0,2}',
]

let base: string
let file: string
const savedCwd = process.cwd()

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-redos-')))
  file = path.join(base, 'corpus.txt')
  // The bait: one line of plain text, no regex metacharacters, nothing unusual about it.
  fs.writeFileSync(file, `${PUMP}\nTODO: something\n`)
})

afterAll(() => {
  process.chdir(savedCwd)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('the guard refuses what the engine cannot finish', () => {
  it.each(CATASTROPHIC)('refuses %s, and the refusal is faster than the pattern is', (pattern) => {
    const started = Date.now()
    const guarded = compileGuardedRegex(pattern)
    const elapsed = Date.now() - started
    expect(guarded.ok, `${pattern} was accepted`).toBe(false)
    expect(elapsed, 'deciding took longer than running the pattern would have been worth').toBeLessThan(2000)
  })

  it('calibration: each of those really does hang the raw engine, so the refusals above mean something', () => {
    // One pattern only, and a short pump, so this test itself stays fast: at 26 characters
    // `^(a+)+$` is ~67 million steps rather than the ~10^12 of PUMP.
    const started = Date.now()
    new RegExp('^(a+)+$').test('a'.repeat(26) + '!')
    expect(Date.now() - started, 'the engine no longer backtracks catastrophically, so this suite no longer describes the defect').toBeGreaterThan(50)
  })

  it('catches (a|a)+ by measurement, not by shape', () => {
    // Pinned deliberately: telling `(a|a)+` from `(x|y)+` by shape would refuse every ordinary
    // alternation, so if the probe ever stopped running, this pattern is the one nothing else
    // would notice being accepted.
    expect(hasNestedQuantifier('^(a|a)+$'), 'the shape check now claims this one, so the probe is no longer load-bearing for it').toBe(false)
    expect(growsExponentially(new RegExp('^(a|a)+$'))).toBe(true)
  })

  it('calibration: ^(b|bb)+$ really does hang the raw engine, so refusing it means something', () => {
    // 36 `b`s rather than the 44 that took 13 seconds: the same Fibonacci curve, a sixth of a
    // second. This length is also the top rung of the probe's own ladder, which is not a
    // coincidence -- it is where the curve first clears the budget.
    const started = Date.now()
    new RegExp('^(b|bb)+$').test('b'.repeat(36) + '!')
    expect(Date.now() - started, 'this pattern no longer backtracks, so the alphabet hole it pins is gone').toBeGreaterThan(50)
  })

  it('accepts a slug matcher the shape check alone would have refused', () => {
    // Both halves are pinned. If the shape check stops claiming this pattern the test still passes
    // for the right reason, but the first assertion is what makes the second one evidence that the
    // MEASUREMENT is deciding rather than evidence that the shape check happened to agree.
    const slug = '^(?:[a-z]+-)+[a-z]+$'
    expect(hasNestedQuantifier(slug), 'the shape check no longer condemns this, so it no longer tests the override').toBe(true)
    expect(growsExponentially(new RegExp(slug)), 'the probe now condemns a pattern measured at ~1 ms on 200 KB').toBe(false)
    expect(compileGuardedRegex(slug).ok, 'the shape check is overruling the measurement again').toBe(true)
  })

  it('decides ^(a|a|a|a)+$ without ever running the input that hangs it', () => {
    // The oracle is the clock, and it is the whole finding: the pattern is refused either way, but
    // before the ladder started below 16 the refusal arrived after half a minute of the guard
    // itself backtracking. A budget cannot fix that -- it is read after `test` returns.
    const started = Date.now()
    expect(compileGuardedRegex('^(a|a|a|a)+$').ok).toBe(false)
    expect(Date.now() - started, 'the guard is running the input that hangs, not the ones below it').toBeLessThan(2000)
  })

  it('calibration: that pattern really does hang at the length the probe used to start from', () => {
    const started = Date.now()
    new RegExp('^(a|a|a|a)+$').test('a'.repeat(12) + '!')
    expect(Date.now() - started, 'the engine no longer backtracks here, so the probe-as-weapon finding is gone').toBeGreaterThan(20)
  })

  it('seeds the probe from escapes, not just from literal characters', () => {
    // Pinned directly because the refusal above cannot distinguish "caught by the space seed" from
    // "caught by some other alphabet": only this says the space is there to be pumped at all.
    expect(probeAlphabets(String.raw`^(\s|\s\s)+$`), 'whitespace escapes contribute no probe character').toContain(' ')
    expect(probeAlphabets(String.raw`^(\x62|\x62\x62)+$`), 'a hex escape contributes no probe character').toContain('b')
    expect(probeAlphabets('^([b-c]|[b-c][b-c])+$'), 'a character class contributes no probe character').toContain('b')
  })

  it.each(ORDINARY)('still accepts %s', (pattern) => {
    const guarded = compileGuardedRegex(pattern)
    expect(guarded.ok, `${pattern} was refused, so the guard is costing real searches`).toBe(true)
  })
})

describe('the surfaces that take a pattern', () => {
  it('grep refuses the pattern instead of running it, and says why', () => {
    const started = Date.now()
    const code = runGrep({ pattern: '^(a+)+$', path: [file] })
    const elapsed = Date.now() - started
    expect(code, 'grep accepted a pattern that cannot finish').toBe(1)
    expect(elapsed, 'grep ran the pattern').toBeLessThan(2000)
  })

  it('grep still finds an ordinary match in the same file', () => {
    expect(runGrep({ pattern: 'TODO', path: [file] })).toBe(0)
  })

  it('a --grep matcher degrades to a substring match rather than stalling', () => {
    const started = Date.now()
    const match = compileGrepMatcher('^(a+)+$')
    // The substring fallback: the literal text `^(a+)+$` does not occur in the pumped line.
    expect(match(PUMP)).toBe(false)
    expect(match('a line containing ^(a+)+$ literally')).toBe(true)
    expect(Date.now() - started, 'the matcher ran the pattern').toBeLessThan(2000)
  })

  it('a --grep matcher with an ordinary pattern is still a regex, not a substring match', () => {
    const match = compileGrepMatcher('^TODO')
    expect(match('TODO: something')).toBe(true)
    expect(match('  TODO: indented')).toBe(false)
  })

  it('transcript --grep refuses rather than running the pattern over the cues', () => {
    // The document readers were the three surfaces the first pass missed. This one takes plain
    // objects, so it can be driven directly; `pdf-locate` and `pptx-text --grep` are held by
    // tests/guards/caller_supplied_patterns_are_guarded.test.ts, which sweeps every call site.
    const cues = [{ index: 1, startSeconds: 0, endSeconds: 1, speaker: null, text: PUMP }]
    const started = Date.now()
    expect(() => sliceTranscript(cues, { grep: '^(a+)+$' })).toThrow(/invalid --grep pattern/)
    expect(Date.now() - started, 'the transcript slicer ran the pattern').toBeLessThan(2000)
  })

  it('transcript --grep still filters on an ordinary pattern', () => {
    const cues = [
      { index: 1, startSeconds: 0, endSeconds: 1, speaker: null, text: 'the quick brown fox' },
      { index: 2, startSeconds: 1, endSeconds: 2, speaker: null, text: 'nothing here' },
    ]
    expect(sliceTranscript(cues, { grep: 'brown' })).toHaveLength(1)
  })
})
