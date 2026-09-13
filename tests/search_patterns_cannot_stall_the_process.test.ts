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

import { compileGuardedRegex, growsExponentially, hasNestedQuantifier, PROBE_LENGTHS, probeAlphabets, projectsPastBudget } from '../src/regex_guard.js'
import { compileGrepMatcher } from '../src/util.js'
import { runGrep } from '../src/read_commands.js'
import { sliceTranscript } from '../src/transcript_extract.js'

/** Long enough that an exponential pattern cannot finish, short enough to be an ordinary line. */
const PUMP = 'a'.repeat(40) + '!'

/**
 * Patterns the engine cannot finish, each against an input of its own that this file names in the
 * comment beside it. PUMP is the input for the ones spelled with `a`; the rest need `b`, a space, a
 * control character, or five hundred characters, which is the whole point of most of them.
 */
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
  // A negated class names the characters it will NOT match, so reading it as ordinary literals
  // seeded the probe with the only two inputs guaranteed to fail at the first character. Every rung
  // timed at zero and the pattern was accepted. Measured raw against `x`: 4 ms at 20, 252 ms at 26,
  // 5.1 s at 30, 113.8 s at 34.
  String.raw`^([^a0]+)+$`,
  String.raw`^([^\w]+)+$`,
  // Quadratic: 13 ms at 512, which is the top rung, and 92 ms at 1000 -- a factor of seven over a
  // doubling, inside the ratio at every rung forever -- and 2.4 s against one 3000-character line.
  // Caught by projecting the top doubling out to a real line length rather than by running it.
  '^(a+)(a+)(a+)!$',
  // A lookaround holds the bomb shut for exactly as long as the ladder is: the assertion fails at
  // every rung, so every rung times zero, and the first 513-character line detonates it. Measured
  // raw at 513: did not return in 40 s. Lengthening the ladder cannot answer this -- the gate just
  // moves, and a rung long enough to open it is a rung long enough to hang the guard. Stripping
  // assertions, which can only ever remove inputs, exposes `^(a|aa)+$` at the usual short lengths.
  '^(?=a{513})(a|aa)+$',
  // `\cA` is a control character, not the letters `c` and `A`. Measured raw against U+0001: 5 ms at
  // 24, 9 ms at 30, 164 ms at 36, 1.1 s at 40, 12.0 s at 44.
  String.raw`^(\ca|\ca\ca)+$`,
  // The cap on how many of the pattern's characters get probed was a bypass while the kept ones
  // were the first six: `a` through `f` are decoys and `z`, named three times, is the payload.
  // Ordering the samples by how often the pattern names each one is what keeps `z`. Measured raw
  // against `z`: 3.0 s at 36, 14.4 s at 44.
  '^(a|b|c|d|e|f|z|zz)+$',
  // The same bypass padded past the raised cap, so the cap cannot be what defeats it and the
  // ordering has to be. Measured raw against `z`: 4 ms at 28, 62 ms at 34.
  '^(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|z|zz)+$',
  // Crowding by ordinary punctuation rather than by a decoy: a group prefix and three repetition
  // counts put `:`, `v`, digits and a comma ahead of the `q` this pattern is ambiguous over, in
  // appearance order. Measured raw against `q`: 670 ms at 34.
  String.raw`^(?:v\d{1,3}\.\d{1,3}\.\d{1,3}-alpha/)?(q|qq)+$`,
  // A LENGTH GATE, which is the shape the ladder itself used to detonate on. The count costs
  // nothing until the input reaches it and then hands the ambiguous tail everything past it: with
  // the ladder ending `256, 512`, this timed 0.002 ms at 256 and did not return at 512 -- inside
  // the guard, so the check was the denial of service. The consuming spelling and the zero-width
  // one need different answers: a small step for the first, a rewrite for the second.
  '^a{300}(a|aa)+$',
  '^(?=a{300})(a|aa)+$',
  // The same gates placed ABOVE the whole ladder, where no rung can reach them and only cutting
  // the count down finds the core they were hiding.
  '^a{513}(a|aa)+$',
  '^(?=a{513})(a|aa)+$',
  // The two-branch shape spelled with a wildcard. Every terminator the probe had matched `.`, so
  // the probe input always matched, nothing backtracked, and the pattern was accepted while
  // costing 9 ms at thirty characters. Measured raw with a newline terminator: 1 ms at 26, 10 ms
  // at 30.
  '^(.|..)+$',
  // A legacy octal escape: `\142` is one `b`, not the digits `1`, `4`, `2`. Reading it as its
  // spelling seeded three alphabets the pattern cannot match. Measured raw against `b`: 3 ms at
  // 28, 69 ms at 34.
  String.raw`^(\142|\142\142)+$`,
  // A negated class naming the fallback pool's own members, so asking the class produced no seed
  // at all. Measured raw against `b`: 262 ms at 26.
  '^([^a0 x\\-!~\\t\\nA\u00e9\u03b1\u0434\u05d0\u0627\u4e2d\u3042\u{1F600}]+)+$',
  // The catastrophic part living INSIDE a negative assertion. That assertion is dropped rather
  // than unwrapped, because unwrapping inverts it -- so its body has to be probed on its own, or
  // this pattern is judged by what is left, which is `^x`.
  String.raw`^(?!(a+)+$)x`,
  // A minimum repeat count that the calibration rung cannot reach. The terminator is picked at
  // four characters by keeping the first candidate the pattern REFUSES, and `{5,}` refuses `aaaa!`
  // for the one reason that stops applying immediately: it has not got five repetitions yet. From
  // five characters on, `aaaaa!` matches, a matching run never backtracks, and the ladder read
  // 0.0 ms at all 128 rungs. Measured raw: 18.2 s against forty-five characters, and the outer
  // group is not load-bearing -- `^(a|aa){5,}!$` is the same 20.0 s.
  '^((a|aa){5,})!$',
  '^(a|aa){5,}!$',
  // An optional trailing class swallows exactly one character of whatever tail is appended, so a
  // single appended character can never falsify the pattern and every run matches. `[\s\S]` is the
  // semantic spelling of "any one terminator" and covers the finite-list case without naming the
  // list the guard happens to sweep: only `bb` falsifies the first of these and `bbb` the second.
  // Sweeping single characters is not enough; the tail has to grow, and it stops growing at one
  // past the bound `detune` clamps every counted quantifier to. Measured raw: 16.7 s against
  // forty-five characters.
  String.raw`^(a|aa)+[\s\S]?$`,
  String.raw`^(a|aa)+[\s\S]{0,2}$`,
  // The same shape spelled past the clamp, which is the reason the clamp is what bounds the tail
  // rather than a number chosen to fit the cases above.
  String.raw`^(a|aa)+[\s\S]{0,500}$`,
  // A tail is a shape, not just a length. Growing the sweep to one character past the clamp is
  // enough only while every tail it builds is a uniform run, because a pattern can name that run
  // and match it -- so nothing falsifies, nothing backtracks, and the whole ladder reads 0 ms. The
  // second branch here does exactly that. The sweep answers it by also building a run whose last
  // character differs, which no repetition of one character can absorb. Measured raw: 39 ms
  // against thirty characters and a two-character tail.
  String.raw`^(a|aa)+(?:[\s\S]?|([\s\S])\2{8})$`,
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
  // A pattern that really does match every input the sweep can build. Nothing falsifies it because
  // nothing can, which is the honest version of the case above -- and the guard has to answer
  // cheaply rather than paying for the whole sweep on all 128 rungs.
  String.raw`^[\s\S]*$`,
  // The bounded sibling of the two `{5,}` patterns above, and the reason the fix had to be a
  // re-pick rather than simply distrusting a counted minimum: this one can never see more than
  // twenty characters, so it is genuinely safe and refusing it would cost a real search.
  '^((a|aa){5,10})!$',
  String.raw`^\d{4}-\d{2}-\d{2}$`,
  String.raw`\berror\b.*\bat\b`,
  '^(GET|POST|PUT|DELETE) /[a-z/]*$',
  '[a-zA-Z0-9+/]{40,}={0,2}',
  // Added with the assertion stripping: a pattern is now probed twice, once as written and once
  // with its lookarounds cut out, and the second run reaches inputs the first one never could.
  String.raw`^(?!node_modules)(?=.*\.ts$).*$`,
  String.raw`(?<=\bfoo)bar`,
  // The atomic-group idiom, where the lookaround is what PREVENTS the backtracking. Stripping it
  // leaves `\1` pointing at a group that no longer exists; the stripped pattern is dropped rather
  // than judged, which is what keeps this from being refused.
  String.raw`^(?=(a+))\1b$`,
  // A negated class that a real caller writes, to pin that asking the class rather than reading it
  // did not turn every `[^...]` into a refusal.
  String.raw`^[^,]+,[^,]+$`,
  String.raw`"([^"\\]|\\.)*"`,
  // The cap-the-length-then-parse idiom, where the assertion is the whole reason the pattern is
  // safe: measured at 0.07 ms against 200,000 characters, and refused while assertions were being
  // DELETED rather than unwrapped, because `^(\w+\s?)+$` on its own is catastrophic.
  String.raw`^(?=.{1,8}$)(\w+\s?)+$`,
  String.raw`^(?=.{1,20}$)(\w+\s?)+$`,
  // Cutting a big repetition count down must not turn an ordinary fixed-width matcher into a
  // refusal: this one is a sha256 hash and its `{64}` is probed as `{8}`.
  '^[0-9a-f]{64}$',
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

  it('calibration: a pattern that swallows one terminator really does hang the raw engine', () => {
    // 34 characters and `bb`, not the forty-five that took 16.7 s: the same Fibonacci curve, a
    // fraction of a second. Two trailing characters are the point -- the optional class absorbs
    // one of them, so a one-character tail can never falsify this and the ladder reads 0 ms.
    // Thirty was too near the floor to assert against: it measured 12-14 ms here against the
    // 83-89 ms of thirty-four, and a run of the whole suite caught it under the threshold.
    const started = Date.now()
    new RegExp(String.raw`^(a|aa)+[\s\S]?$`).test('a'.repeat(34) + 'bb')
    expect(Date.now() - started, 'the engine no longer backtracks here, so refusing this pattern means nothing').toBeGreaterThan(20)
  })

  it('answers a pattern that matches everything without paying for the whole sweep', () => {
    // `^[\s\S]*$` falsifies nothing, so the sweep runs to the end and finds no tail. Without a cap
    // that happens on every one of 128 rungs for every alphabet, and the guard becomes the cost it
    // exists to prevent. The ceiling is generous because this is about an order of magnitude, not
    // a stopwatch: uncapped it is seconds.
    const started = Date.now()
    expect(compileGuardedRegex(String.raw`^[\s\S]*$`).ok).toBe(true)
    expect(Date.now() - started, 'the sweep is running on every rung again').toBeLessThan(400)
  })

  it('pays for a fruitless sweep once per pattern, not once per alphabet it names', () => {
    // Every branch after the first names a different character, so the pattern seeds a dozen
    // alphabets -- and the leading `[\s\S]*` means none of them can ever falsify it. A budget
    // counted per alphabet buys the same fruitless sweep a dozen times over; counted per pattern
    // it is bought once. Measured: 36 ms per-alphabet, 15 ms per-pattern.
    const started = Date.now()
    expect(compileGuardedRegex(String.raw`^(?:[\s\S]*|a|b|c|d|e|f|g|h|i|j|k|l)$`).ok).toBe(true)
    expect(Date.now() - started, 'the sweep budget reset for each alphabet again').toBeLessThan(120)
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

  it('reads a braced unicode escape, so the same shape spelled above the BMP is caught', () => {
    // Needs the `u` flag, which no command passes today, so this goes through the guard directly
    // rather than through a surface. It is pinned anyway because regex_guard.ts is the shared entry
    // point: a seed its reader cannot parse has turned out to be the same hole three times running,
    // in literals, then in escapes, then here. Measured raw: 98 ms at 30 emoji, 3.1 s at 42.
    const emoji = String.raw`^(\u{1F600}|\u{1F600}\u{1F600})+$`
    expect(probeAlphabets(emoji), 'a braced unicode escape contributes no probe character').toContain('\u{1F600}')
    expect(compileGuardedRegex(emoji, 'u').ok, 'the emoji spelling of (b|bb) was accepted').toBe(false)
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

/**
 * One test per mechanism the fourth adversarial round added, so a mutation to any single one of
 * them fails something that names it. The `it.each` lists above prove the verdicts; these prove
 * WHY each verdict is reached, which is what stops a later change from keeping the verdict for a
 * reason that no longer generalises.
 */
describe('what the probe is seeded and terminated with', () => {
  it('asks a negated class what it matches instead of reading the characters it excludes', () => {
    // `[^a0]` names `a` and `0`, the only two characters it is guaranteed to reject, so reading it
    // produced the one seed set that fails at the first character of every rung.
    const alphabets = probeAlphabets(String.raw`^([^a0]+)+$`)
    expect(alphabets, 'the negated class contributed no character it actually matches').toContain(' ')
  })

  it('calibration: ^([^a0]+)+$ really does hang the raw engine', () => {
    const started = Date.now()
    new RegExp(String.raw`^([^a0]+)+$`).test('x'.repeat(26) + 'a')
    expect(Date.now() - started, 'this pattern no longer backtracks, so the negated-class hole it pins is gone').toBeGreaterThan(50)
  })

  it('ends the probe with a character the pattern rejects, chosen by trying it', () => {
    // Seeding is only half of it. With the right seed and the old fixed `!`, `^([^a0]+)+$` was
    // probed with four spaces and a `!` -- which it MATCHES, so it ran straight through in no time
    // and was accepted anyway. Both halves are pinned: the seed above, and this verdict, which no
    // fixed terminator can reach.
    expect(compileGuardedRegex(String.raw`^([^a0]+)+$`).ok, 'the probe input still matches, so nothing backtracks').toBe(false)
  })

  it('reads a control escape as the control character, not as its letters', () => {
    expect(probeAlphabets(String.raw`^(\ca|\ca\ca)+$`), 'the escape seeded the letters it is spelled with').toContain(String.fromCharCode(1))
  })

  it('asks a unicode property escape what it matches instead of reading its spelling', () => {
    // Needs the `u` flag, which no command passes today. Pinned because this is the shared entry
    // point and a seed the reader cannot parse has been the same hole in four different spellings.
    const greek = String.raw`^(\p{Script=Greek}|\p{Script=Greek}\p{Script=Greek})+$`
    expect(probeAlphabets(greek), 'the property escape seeded ASCII from its own spelling').toContain('α')
    expect(compileGuardedRegex(greek, 'u').ok).toBe(false)
  })

  it('keeps the character the pattern names most often, not the first six it names', () => {
    // The cap is a cost bound and cannot be removed; what changed is what it spends its slots on.
    // A pattern is ambiguous over a character it names more than once, which is exactly the signal
    // a decoy list of single mentions cannot fake without each decoy becoming a payload itself.
    // Padded past the cap on purpose: with sixteen decoys the cap cannot be what saves this, so a
    // pass here is evidence about the ORDERING and not about the number of slots.
    expect(probeAlphabets('^(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|z|zz)+$'), 'the payload character was crowded out by decoys').toContain('z')
  })

  it('reaches a payload buried behind a group prefix and three repetition counts', () => {
    // The same ordering, crowded by ordinary punctuation instead of by a decoy: `:`, `v`, the
    // digits of `{1,3}` and its comma all appear before the `q`, and in appearance order twelve
    // slots ran out first. Skipping that punctuation as provably-not-a-literal was written and
    // taken back out again -- it turned out to be a branch no pattern could reach once the
    // ordering existed, and this case is what pins the ordering doing that work instead.
    expect(probeAlphabets(String.raw`^(?:v\d{1,3}\.\d{1,3}\.\d{1,3}-alpha/)?(q|qq)+$`), 'the group prefix and the repetition counts crowded out the payload').toContain('q')
  })

  it('reads a legacy octal escape as the character it names, not as its digits', () => {
    // `\142` is one `b`. Seeded as `1`, `4`, `2` the probe ran three alphabets the pattern cannot
    // match, and every rung came back at zero.
    expect(probeAlphabets(String.raw`^(\142|\142\142)+$`), 'the octal escape was read as its spelling').toContain('b')
  })

  it('ends the probe with a character `.` rejects, so a wildcard alternation still has to fail', () => {
    // `.` matches every terminator on the list except a line terminator, so the probe input for
    // `^(.|..)+$` always MATCHED -- and a match never backtracks. The pattern was accepted.
    const wildcard = '^(.|..)+$'
    const started = performance.now()
    new RegExp(wildcard).test('a'.repeat(30) + '\n')
    expect(performance.now() - started, 'a newline no longer makes this fail, so it no longer tests the terminator').toBeGreaterThan(1)
    expect(new RegExp(wildcard).test('a'.repeat(30) + '!'), 'every non-newline terminator matched, which is the hole').toBe(true)
    expect(compileGuardedRegex(wildcard).ok).toBe(false)
  })

  it('sweeps for a class member when the curated pool has none, instead of giving up on the class', () => {
    // A negated class is free to name the fallback pool's own members, and one that does left the
    // class contributing no seed at all. The sweep is what finds a character it does match.
    const cls = '[^a0 x\\-!~\\t\\nA\u00e9\u03b1\u0434\u05d0\u0627\u4e2d\u3042\u{1F600}]'
    const seeds = probeAlphabets(`^(${cls}+)+$`)
    // The surrogate pair is the fixture: the guard compiles caller patterns without the `u` flag,
    // so the class has to be asked the same way, and naming an astral character in it is exactly
    // what a hostile pattern would do.
    // eslint-disable-next-line no-misleading-character-class
    const found = seeds.filter((c) => c.length === 1 && new RegExp(cls).test(c))
    expect(found, `no seed the class accepts: ${JSON.stringify(seeds)}`).not.toEqual([])
  })

  it('calibration: the decoy pattern really does hang the raw engine', () => {
    const started = Date.now()
    new RegExp('^(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|z|zz)+$').test('z'.repeat(34) + '!')
    expect(Date.now() - started, 'this pattern no longer backtracks, so the cap bypass it pins is gone').toBeGreaterThan(50)
  })
})

describe('what the probe cannot run, it projects or strips', () => {
  it('refuses a quadratic pattern whose every rung-to-rung ratio is inside the factor', () => {
    // The finding in one assertion: the ratio test is honest and says no, so something else has to
    // say yes. If the ladder ever grows a rung that makes this ratio large the test still passes,
    // but the first assertion is what makes the second one evidence about the PROJECTION.
    const quadratic = '^(a+)(a+)(a+)!$'
    const at = (n: number): number => {
      const started = performance.now()
      new RegExp(quadratic).test('a'.repeat(n) + 'b')
      return performance.now() - started
    }
    at(256)
    const ratio = at(512) / Math.max(at(256), 0.001)
    expect(ratio, 'the doubling now trips the ratio test, so this no longer tests the projection').toBeLessThan(12)
    expect(compileGuardedRegex(quadratic).ok, 'a pattern costing 2.4 s on one 3000-character line was accepted').toBe(false)
  })

  it('does not project a linear pattern into a refusal', () => {
    // A false positive here is a search the caller wanted and cannot run. A long alternation over
    // 512 characters is the ordinary shape that costs real time while growing linearly.
    expect(compileGuardedRegex('^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT) /[a-z/]*$').ok).toBe(true)
  })

  it('strips lookarounds, because an assertion can hold the bomb shut past the last rung', () => {
    // Both halves pinned: the pattern as written is invisible to the probe at every length the
    // probe can afford, and it is refused anyway. Without the first assertion the second would
    // pass for any reason at all.
    const gated = '^(?=a{513})(a|aa)+$'
    const started = performance.now()
    new RegExp(gated).test('a'.repeat(512) + '!')
    expect(performance.now() - started, 'the assertion no longer gates this, so it no longer tests the stripping').toBeLessThan(5)
    expect(compileGuardedRegex(gated).ok, 'a pattern that detonates on the first 513-character line was accepted').toBe(false)
  })

  it('does not strip a lookaround that is what prevents the backtracking', () => {
    // `(?=(a+))\1` is the standard way to emulate an atomic group -- refusing it would break the
    // idiom people use to make patterns SAFE. Unwrapping the assertion into `(?:(a+))\1b` keeps
    // the group the backreference points at, which is what lets it be judged at all.
    expect(compileGuardedRegex(String.raw`^(?=(a+))\1b$`).ok).toBe(true)
  })

  it('never hands the ambiguous part of a pattern more than one step past a gate it just opened', () => {
    // The ladder's own detonation, in one assertion. The pattern is invisible below 300 characters
    // and catastrophic above it, and the guard used to jump 256 -> 512, handing the tail 212
    // characters in a single synchronous call it could not interrupt. Both halves are pinned: the
    // gate really is shut at every length below it, and the guard answers anyway, quickly.
    const gated = '^a{300}(a|aa)+$'
    const shut = performance.now()
    new RegExp(gated).test('a'.repeat(256) + '!')
    expect(performance.now() - shut, 'the count no longer gates this, so it no longer tests the step size').toBeLessThan(5)
    const started = performance.now()
    const guarded = compileGuardedRegex(gated)
    const elapsed = performance.now() - started
    expect(guarded.ok, 'a pattern that detonates at 300 characters was accepted').toBe(false)
    expect(elapsed, 'the guard walked into the gate instead of stepping up to it').toBeLessThan(2000)
  })

  it('calibration: four more characters past that gate is affordable and two hundred is not', () => {
    // What makes the small step a bound rather than a preference. Same pattern, same gate, two
    // lengths past it: the step the ladder takes, and the step it used to take.
    const gated = new RegExp('^a{300}(a|aa)+$')
    const step = performance.now()
    gated.test('a'.repeat(304) + '!')
    expect(performance.now() - step, 'one step past the gate cost real time').toBeLessThan(5)
    const bomb = new RegExp('^a{300}(a|aa)+$')
    const wide = performance.now()
    bomb.test('a'.repeat(340) + '!')
    expect(performance.now() - wide, 'forty characters past the gate is now free, so the step size proves nothing').toBeGreaterThan(20)
  })

  it('keeps a length-capping assertion instead of cutting it, and the difference is the verdict', () => {
    // Deleting an assertion is not a safe simplification in one direction: `(?=.{1,8}$)` is the
    // whole reason this pattern cannot backtrack, and the pattern it leaves behind is the textbook
    // catastrophic one. Both are asserted, because accepting the first only means something if the
    // second is refused.
    expect(compileGuardedRegex(String.raw`^(?=.{1,8}$)(\w+\s?)+$`).ok, 'a pattern capped at eight characters was refused').toBe(true)
    expect(compileGuardedRegex(String.raw`^(\w+\s?)+$`).ok, 'the same pattern without its cap was accepted, so the cap is not what was measured').toBe(false)
  })

  it('probes the body of a negative assertion, which is dropped rather than unwrapped', () => {
    // Unwrapping `(?!X)` into `(?:X)` would invert it and leave the rest of the pattern reachable
    // only by an input the original refuses, so it is deleted -- and deleting it takes the cost of
    // running X to a failure with it. The engine pays that cost on every input.
    const inside = '^(?!(a+)+$)x'
    const started = performance.now()
    new RegExp(inside).test('a'.repeat(26) + '!')
    expect(performance.now() - started, 'the assertion body no longer backtracks, so this no longer tests it').toBeGreaterThan(20)
    expect(compileGuardedRegex(inside).ok, 'a bomb inside a negative assertion was accepted').toBe(false)
  })

  it('refuses a pattern too long to measure rather than spending the measurement on it', () => {
    // The guard runs the pattern about two thousand times, so its own cost is linear in the
    // pattern's length: a 438 KB alternation of distinct characters cost 4.5 s of synchronous work
    // in a pre-approval path and was then ACCEPTED, which is the worst of both answers. The bound
    // is on the length, and it is a refusal with a reason rather than a silent truncation.
    const long = `^(?:${Array.from({ length: 2000 }, (_, i) => `x${i}`).join('|')})$`
    expect(long.length, 'the fixture is no longer past the bound it is testing').toBeGreaterThan(4096)
    const started = performance.now()
    const guarded = compileGuardedRegex(long)
    expect(performance.now() - started, 'the guard measured a pattern it had already decided was too long').toBeLessThan(200)
    expect(guarded.ok).toBe(false)
    expect(guarded.ok === false && guarded.reason, 'the refusal did not say the length was the problem').toContain('longer than')
  })

  it('still measures a long pattern that is inside the bound, in bounded time', () => {
    const long = `^(?:${Array.from({ length: 600 }, (_, i) => `x${i}`).join('|')})$`
    expect(long.length).toBeLessThan(4096)
    const started = performance.now()
    expect(compileGuardedRegex(long).ok, 'an ordinary long alternation was refused').toBe(true)
    expect(performance.now() - started, 'sampling a long pattern is quadratic again').toBeLessThan(500)
  })
})

/**
 * The extrapolation has to read two rungs a DOUBLING apart, not the last two.
 *
 * This is the one thing in the guard a wall-clock test cannot see. The ladder used to end
 * `256, 512`, so "the last two rungs" and "a doubling" were the same pair; it steps by four now,
 * where they are 508 and 512. Reverting the selection to the adjacent pair leaves every timing
 * assertion in this file green, because on clean timings the exponent is scale-invariant and comes
 * out the same either way -- a mutation run confirmed it: 83 passed, nothing caught. What the
 * adjacent pair loses is noise tolerance. A ratio taken over four characters puts 0.0113 in the
 * denominator, so a garbage-collection pause on one rung is multiplied by eighty-eight, and the
 * verdict is then whatever the blip was. Both directions are asserted, because the dangerous one
 * is not the missed refusal, it is the ordinary pattern refused by a hiccup.
 *
 * PROVENANCE: HAND-DERIVED. The ladders are computed from `t = c * length ** k` for a stated `k`,
 * not read off a run, and the blip is inserted by hand. Nothing here is taken from the guard.
 */
describe('the growth projection', () => {
  const TOP = PROBE_LENGTHS[PROBE_LENGTHS.length - 1] as number
  const PENULTIMATE = PROBE_LENGTHS.length - 2

  /** A ladder that grows exactly as `length ** k`, scaled so the top rung costs `topMs`. */
  const ladder = (k: number, topMs: number): number[] => PROBE_LENGTHS.map((l) => topMs * (l / TOP) ** k)

  it('calibration: a clean quadratic ladder projects past the budget and a clean linear one does not', () => {
    // 10 ms at 512 characters, extrapolated to 10,000: quadratic is 10 * 19.5 ** 2 = 3.8 s, over
    // the one-second budget; linear is 10 * 19.5 = 195 ms, under it. Without this pair the two
    // assertions below could both pass on a projection that always answers the same way.
    expect(projectsPastBudget(ladder(2, 10))).toBe(true)
    expect(projectsPastBudget(ladder(1, 10))).toBe(false)
  })

  it('still sees a quadratic pattern when the second-to-last rung reads slow', () => {
    const timings = ladder(2, 10)
    timings[PENULTIMATE] = 12
    // Adjacent pair: 10 ms after 12 ms reads as SHRINKING, so the exponent goes negative and the
    // pattern is waved through. The doubling pair never looks at that rung.
    expect(projectsPastBudget(timings)).toBe(true)
  })

  it('does not condemn an ordinary pattern when the second-to-last rung reads fast', () => {
    const timings = ladder(1, 10)
    timings[PENULTIMATE] = 0.1
    // Adjacent pair: a hundredfold jump across four characters is an exponent of 587, which
    // projects to a number with no physical meaning and refuses a linear pattern.
    expect(projectsPastBudget(timings)).toBe(false)
  })
})
