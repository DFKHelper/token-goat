/**
 * Refusing a regular expression that can stall the process that runs it.
 *
 * JavaScript's regex engine backtracks and cannot be interrupted: there is no timeout, no abort
 * signal, and no way to bound `re.test(s)` once it has started. A pattern like `^(a+)+$` against
 * forty characters of `a` followed by one non-matching character does not return -- measured here
 * on 2026-09-13, it was still running when a twenty-second kill arrived. In a CLI that is a hung
 * command the user can interrupt. In the stdio MCP server it is worse: the server is
 * single-threaded, so the wedge takes every other tool with it, and the pattern arrives from the
 * model rather than from the person at the keyboard.
 *
 * Two checks, and both are needed. {@link hasNestedQuantifier} reads the pattern's shape and gives
 * a reason a caller can act on; {@link growsExponentially} runs the compiled pattern and asks the
 * engine. A shape check alone is a list of shapes somebody thought of -- an adversarial review of
 * the first version of this found four it did not have, including `(a|a)+`, which has no nested
 * quantifier at all and is dangerous only because its two branches match the same text. Telling
 * that from `(x|y)+` by shape would refuse every ordinary alternation, so measurement catches it
 * instead. The probe alone is not enough either: it reports that a pattern is slow, not which part
 * of it is the problem.
 *
 * This is a bound on running time, not a judgement about the pattern's author. `secret_redact.ts`
 * applies it to patterns from the machine's own config, where somebody able to set them can
 * already do worse and the point is to bound the cost of a mistake; the search commands apply it
 * to patterns from a model or a command line, where it is a denial-of-service boundary.
 */

/**
 * The prefix of any group, capturing or not, consumed rather than skipped.
 *
 * The first version of this used a `\((?![?*+])` lookahead to step over `(?`-style constructs, and
 * the cost was that every non-capturing and named group became invisible to the check: `(?:a+)+`
 * and `(?<x>a+)+` both passed.
 */
const GROUP_PREFIX = String.raw`\((?:\?(?::|<?[=!]|<\w+>|[a-z]*(?:-[a-z]*)?:))?`

/**
 * A quantified group whose body itself repeats: `(a+)+`, `(?:a*)*`, `(?<x>\d{2,})+`.
 *
 * This is the shape behind almost every catastrophic-backtracking regex, because it lets the engine
 * split the same input between the inner and outer repetition in exponentially many ways. Six
 * characters are enough, so no length cap bounds it and this check exists instead. A brace form
 * counts as a repetition: `(\d{2,})+` was missed for exactly that reason.
 */
const NESTED_QUANTIFIER = new RegExp(GROUP_PREFIX + String.raw`[^()*+]*(?:[*+]|\{\d+,\d*\})[^()]*\)\s*(?:[*+]|\{\d+,\d*\})`)

/** Whether `source` repeats a group that already repeats. A heuristic, and stated as one: see the module note. */
export function hasNestedQuantifier(source: string): boolean {
  return NESTED_QUANTIFIER.test(source)
}

const PROBE_ALPHABETS = ['a', '0', 'a0'] as const

/**
 * The input lengths to try, shortest first, stopping at the first one that blows the budget.
 *
 * Three separate defects shaped this list, and each one moved a different end of it.
 *
 * A single pair of lengths could not see the middle of the curve. `^(a+)+$` doubles per character
 * and is already at 112 ms by 24, but `^(b|bb)+$` grows on the Fibonacci curve -- 0.46 ms at 24,
 * 3.7 ms at 28, 23.9 ms at 32, 161 ms at 36, 12.0 s at 44 -- so any two short lengths read it as
 * flat. Climbing in small steps answers both, and costs nothing on an ordinary pattern because the
 * ladder only climbs while the pattern is still fast.
 *
 * The rungs BELOW 16 exist because the probe was itself the weapon. `^(a|a|a|a)+$` multiplies by
 * four per character: measured 0.4 ms at 8, 6.9 ms at 10, 109 ms at 12, and 27.8 seconds at 16 --
 * which was the first length the probe tried. The guard hung inside the measurement it was taking
 * to decide whether the pattern could hang anything, and no budget check can help, because the
 * budget is only read after a synchronous `test` returns and JavaScript cannot interrupt one. The
 * only defence is to start where nothing can be slow yet and let the ladder find the wall: the same
 * pattern is now refused at rung 12, having spent about 120 ms total.
 *
 * The rungs ABOVE 36 exist because super-linear is not the same as exponential. `^(a+)(a+)(a+)(a+)b$`
 * has no nested quantifier and costs 0.55 ms at 36 -- flat, by any short measurement -- yet 50 ms at
 * 200 and 18.6 s at 800, and `token-goat grep` with it against a file holding one 3000-character
 * line did not return in two minutes. A minified bundle or a base64 blob supplies such a line
 * routinely. The long rungs cost microseconds on anything genuinely linear: the slug matcher and
 * `function\s+(\w+)` both measure 0.00 ms at 800.
 *
 * The step is what bounds the overshoot, and it has to be small at EVERY rung, not just near the
 * bottom. The ladder used to finish `36, 64, 128, 256, 512`, and an adversarial review showed what
 * those doublings cost: `^a{300}(a|aa)+$` has no lookaround and nothing nested that a short rung
 * can see, times 0.002 ms at 256 -- the count is not satisfied yet, so the repeated group never
 * runs -- and then gets 212 characters of ambiguous tail at 512 and does not return. Measured: no
 * result in 38 s, and `node dist/token-goat.mjs commands --grep '^a{300}(a|aa)+$'` timed out at 25 s
 * against the shipped bundle. The guard was the denial of service. With a fixed step of four, a
 * count that opens between two rungs can only be handed four more characters than the rung that
 * already came in under the budget, so the invariant the paragraph above claims is now true all the
 * way up. The whole 128-rung ladder costs 0.8-1.5 ms per pattern on ordinary inputs, against 0.1-0.2
 * ms for the geometric one -- the price of the guarantee, paid once per pattern and then cached.
 *
 * A rung cannot bound a ZERO-width gate, though: `(?=a{300})` consumes nothing, so the rung that
 * satisfies it hands the whole string to the ambiguous part rather than four characters of it.
 * Nothing in a ladder can answer that, and {@link detune} is what does.
 */
const PROBE_STEP = 4
const PROBE_MAX_LENGTH = 512
export const PROBE_LENGTHS: readonly number[] = Array.from({ length: PROBE_MAX_LENGTH / PROBE_STEP }, (_, i) => (i + 1) * PROBE_STEP)
/** The one-line minified bundle or base64 blob the probe cannot afford to run but has to answer for. */
const PROJECTED_LINE_LENGTH = 10_000
const PROJECTION_BUDGET_MS = 1000
const PROJECTION_SIGNAL_MS = 1
const PROBE_GROWTH_FACTOR = 12
/**
 * Characters to end a probe input with, tried in order until one makes the pattern fail to match.
 *
 * The line terminators at the end are not decoration. `.` matches every printable character but
 * not a newline, so `^(.|..)+$` -- the two-branch shape spelled with a wildcard -- matched every
 * terminator on the list, the probe never forced a failure, and the pattern was accepted while
 * taking 9 ms against thirty characters and climbing. JavaScript's `$` without the `m` flag is
 * end-of-input, not before-a-final-newline, so `\n` really does make it fail; with `m` it would
 * not, which is why the terminator is chosen by trying rather than assumed. U+2028 follows it: a
 * line terminator to `.` and to `$` under `m`, an ordinary character to a class that names neither.
 */
const PROBE_TERMINATORS = ['!', 'a', '0', ' ', '￿', '\n', ' '] as const
const PROBE_BUDGET_MS = 25

/** How many repetitions a counted quantifier is cut down to, so its gate opens inside the ladder. */
const MAX_COUNTED_REPEAT = 8

/**
 * How long one run took, and whether it matched.
 *
 * The verdict travels with the timing because a run that MATCHES is not evidence of anything: the
 * engine stops at the first successful path and never backtracks, so a catastrophic pattern reads
 * as instant. Only the caller knows what to do about that, and it cannot tell from the number.
 */
type Measurement = { readonly ms: number; readonly matched: boolean }

function timeMatch(re: RegExp, input: string): Measurement {
  // A fresh regex per call: a `g`-flagged pattern carries lastIndex between calls, which would make
  // the second measurement start mid-string and read as faster.
  const probe = new RegExp(re.source, re.flags.replace('g', ''))
  const started = performance.now()
  const matched = probe.test(input)
  const first = performance.now() - started
  // A 128-rung ladder takes that many measurements per alphabet, so a garbage-collection pause
  // landing inside one of them is likely rather than rare -- and every decision this module makes
  // keys on a timing above a millisecond, so one blip is a refusal. `"([^"\\]|\\.)*"` measures
  // 0.00 ms at every rung and 0.0 ms against ten thousand characters, and was refused by a single
  // 1 ms sample. Anything that clears the noise floor is therefore measured again and the smaller
  // of the two is used. A pattern that really is slow pays one extra run of a rung that was still
  // inside the budget; past four times the budget the answer is not in doubt and is not re-run.
  if (first <= PROJECTION_SIGNAL_MS || first > PROBE_BUDGET_MS * 4) return { ms: first, matched }
  const again = new RegExp(re.source, re.flags.replace('g', ''))
  const restarted = performance.now()
  again.test(input)
  return { ms: Math.min(first, performance.now() - restarted), matched }
}

/**
 * Whether a compiled pattern's running time doubles as its input grows.
 *
 * The pattern is run against short repeated inputs that fail to match at the end -- the condition
 * that forces a backtracking engine to try every split -- and the time at 24 characters is compared
 * with the time at 16. A linear or polynomial pattern grows by a small factor over eight extra
 * characters; an exponential one grows by roughly two hundred and fifty.
 *
 * Safe to run in-process precisely because the inputs are short: `(a+)+` at 24 characters takes
 * well under a tenth of a second, which is the whole point of measuring there rather than at the length real
 * text would supply. `PROBE_BUDGET_MS` is a second floor -- a pattern already slow at 24 characters
 * is refused on that alone, without waiting for a ratio.
 */
/** One character each escape can actually match, for seeding the probe. `\b` and `\B` match no character. */
const ESCAPE_SAMPLES: Readonly<Record<string, string>> = {
  s: ' ',
  S: 'a',
  d: '0',
  D: 'a',
  w: 'a',
  W: '-',
  t: '\t',
  n: '\n',
  r: '\r',
  f: '\f',
  v: '\v',
  '0': '\0',
  b: '',
  B: '',
}

/** A lookaround's opening punctuation, anchored: `(?=`, `(?!`, `(?<=`, `(?<!`. */
const LOOKAROUND_AT = /^\(\?<?[=!]/

/**
 * One character the pattern could match, for each place in its source that names one.
 *
 * A fixed alphabet is a hole, because what makes a pattern explode is ambiguity over the text IT
 * matches: `^(b|bb)+$` finishes instantly against `aaaa...`, `0000...` and `a0a0...`, so a probe
 * that only knows those three accepts it -- and it takes 13 seconds against 44 `b` characters.
 *
 * Skipping escapes whole was the same hole one level down. `^(\s|\s\s)+$` is the identical defect
 * spelled with whitespace and takes 20.9 seconds against 40 spaces; `^(\x62|\x62\x62)+$` is it
 * spelled in hex and takes 2.9 seconds against 36 `b`s. Neither contains a literal the old reader
 * kept, so both were accepted. Every escape now contributes the character it stands for, and a
 * numeric escape contributes the character it encodes.
 *
 * Reading a character class as ordinary characters is right for `[b-c]` and exactly backwards for
 * `[^a0]`, whose two characters are the only two it will not match. `^([^a0]+)+$` was seeded with
 * `a`, `0` and `a0`, every rung failed at the first character, every rung timed at zero, and the
 * pattern was accepted -- while taking 5.1 s against thirty `x` and 113.8 s against thirty-four. A
 * class is therefore compiled and asked, rather than read: the seed is the first candidate it says
 * it matches, so the negation operator cannot be missed because nothing tries to interpret it.
 */
/**
 * Characters to offer a class that names none this reader can extract -- `[^a0]`, `[\S]`, `[\W]`.
 * Ordered commonest first so the seed is something ordinary text is made of where it can be.
 */
const CLASS_CANDIDATES = ['a', '0', ' ', 'x', '-', '!', '~', '\t', '\n', 'A', 'é', 'α', 'д', 'א', 'ا', '中', 'あ', '😀'] as const

/** The first candidate the fragment matches, or `''` -- the fragment is asked, never interpreted. */
function firstMatch(source: string, flags: string, candidates: readonly string[]): string {
  let re: RegExp
  try {
    re = new RegExp(source, flags)
  } catch {
    return ''
  }
  for (const candidate of candidates) if (re.test(candidate)) return candidate
  return ''
}

/** The index of the `]` closing the class that opens at `start`, or -1 if the source never closes it. */
function classEnd(source: string, start: number): number {
  let i = start + 1
  if (source[i] === '^') i++
  // A `]` in the first position is the literal character, not the terminator.
  if (source[i] === ']') i++
  for (; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
      continue
    }
    if (source[i] === ']') return i
  }
  return -1
}

/**
 * Every printable ASCII character, then a stride across the BMP. Built once, walked only on the
 * fallback path.
 *
 * A curated pool is a list of characters somebody thought of, and a NEGATED class is free to name
 * exactly that list: `^([^a0 x\-!~\t\nAeaadxxxx]+)+$`, spelled with the pool's own members, left
 * `sampleClass` returning nothing at all, so the class contributed no seed and the pattern was
 * accepted while taking 259 ms against twenty-six characters. Sweeping instead of guessing means a
 * class has to exclude ~1,300 code points spread over the whole BMP before it goes unsampled, and a
 * class that excludes that many by enumeration is one whose remaining members the sweep would have
 * to be unlucky to miss. It is still a search and not a proof -- what makes the residue tolerable
 * is that a class matching nothing the sweep finds is a class the pattern can barely match either.
 */
const CLASS_SWEEP: readonly string[] = [
  ...Array.from({ length: 0x5f }, (_, i) => String.fromCharCode(0x20 + i)),
  ...Array.from({ length: 0x400 }, (_, i) => String.fromCharCode(0xa0 + i * 0x3f)),
]

/**
 * Tails the ladder falls back on when nothing in {@link PROBE_TERMINATORS} makes the pattern fail.
 *
 * One length, one past {@link MAX_COUNTED_REPEAT}, and that is a bound rather than a guess. The
 * guard appends a tail and an optional run swallows it, so `^(a|aa)+[\s\S]?$` needs `bb` and
 * `^(a|aa)+[\s\S]{0,2}$` needs `bbb` -- an arms race with no end, on its own. It ends because
 * {@link detune} clamps every counted bound to MAX_COUNTED_REPEAT before the rewrite is judged, so
 * nothing the guard runs can swallow more than that many characters, and a tail one longer
 * falsifies all of them at once.
 *
 * Shorter tails were here -- length one, then two -- and mutations removing each of them changed no
 * verdict, which is the whole of the argument for not having them. A tail longer than a pattern
 * needs still fails, so a shorter one can only ever reach the same answer sooner, and the sweep is
 * walked at most {@link MAX_SWEEPS} times in the one case where it reaches no answer at all.
 */
const SWEEP_TAILS: readonly string[] = CLASS_SWEEP.map((c) => c.repeat(MAX_COUNTED_REPEAT + 1))
/** Rungs per alphabet allowed to pay for a sweep that finds nothing. */
const MAX_SWEEPS = 3

/** One character the class accepts, found by asking it rather than by interpreting its contents. */
function sampleClass(cls: string): string {
  // The characters it names come first, since `[b-c]` is matched by nothing in the fallback pool.
  const named = sampleCharacters(cls.slice(1, -1))
  return firstMatch(cls, '', [...named, ...CLASS_CANDIDATES]) || firstMatch(cls, '', CLASS_SWEEP)
}

function sampleCharacters(source: string): string[] {
  const out: string[] = []
  // A `Set` beside the array, not `out.includes`: the linear scan made sampling quadratic in the
  // pattern's length, and a pattern is an argument a model supplies. Measured on a long alternation
  // of distinct characters, this term and the one `probeAlphabets` fixes together cost 4.5 s for a
  // 438 KB pattern that was then accepted -- the guard billing the caller for a stall it did not
  // even report.
  const seen = new Set<string>()
  const push = (c: string): void => {
    if (c === '' || seen.has(c)) return
    seen.add(c)
    out.push(c)
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    if (c === '[') {
      const end = classEnd(source, i)
      if (end !== -1) {
        push(sampleClass(source.slice(i, end + 1)))
        i = end
        continue
      }
    }
    if (c !== '\\') {
      // A group prefix and a repetition count leave characters here that are provably not
      // literals -- the `:` of `(?:`, the digits and comma of `{1,3}`. Skipping them was written
      // and then taken back out: with the samples ordered by how often the pattern names each
      // one, no pattern could be constructed where that noise outranked a real seed, and an
      // unreachable branch hides more than the crowding it was aimed at. `probeAlphabets` is
      // where this is actually fixed.
      if (/[^\s()[\]{}|^$*+?.-]/.test(c)) push(c)
      continue
    }
    const next = source[i + 1] ?? ''
    i++
    // `\142` is the one character 0o142 -- `b` -- and not the digits `1`, `4`, `2`. Annex B legacy
    // octal escapes are live in every pattern without the `u` flag, and reading them character by
    // character seeded the spelling instead of the character: `^(\142|\142\142)+$` was accepted
    // with alphabets `a`, `0`, `a0`, `1`, `4`, `2`, `142` -- not one of which the pattern can match
    // -- while taking 61 ms against thirty-four `b`s and climbing from there.
    if (next >= '0' && next <= '7') {
      let digits = (/^[0-7]{1,3}/.exec(source.slice(i)) as RegExpExecArray)[0]
      // `\777` is `\77` followed by a literal `7`: the escape stops at 0o377.
      if (parseInt(digits, 8) > 0o377) digits = digits.slice(0, 2)
      push(String.fromCharCode(parseInt(digits, 8)))
      // A lone `\1`-`\7` is a BACKREFERENCE wherever the pattern has that many groups and octal
      // only where it does not, and which one it is cannot be read off this fragment -- `sampleClass`
      // calls this on a class body, where it is always octal. Both readings are seeded; the wrong
      // one is a probe alphabet the pattern never matches, which costs a rung and finds nothing.
      if (digits.length === 1 && next !== '0') push(next)
      i += digits.length - 1
      continue
    }
    // `\xNN` and `\uNNNN` name a character by code point; an unparseable one is skipped rather than
    // pushed as a stray `x`, which would probe with a character the pattern cannot match.
    if (next === 'x' || next === 'u') {
      // `\u{1F600}`, the brace form the `u` flag allows, names a character above the BMP that the
      // fixed-width form cannot express. Skipping it left the (b|bb) shape spelled in emoji
      // accepted: `^(\u{1F600}|\u{1F600}\u{1F600})+$` measured 98 ms at 30 of them and 3.1 s at 42.
      // Not reachable through any command today -- no call site passes the `u` flag those escapes
      // require -- but this is the shared entry point, and a seed the reader cannot parse is the
      // same hole every other spelling of it turned out to be.
      if (next === 'u' && source[i + 1] === '{') {
        const close = source.indexOf('}', i + 2)
        const digits = close === -1 ? '' : source.slice(i + 2, close)
        if (/^[0-9a-fA-F]{1,6}$/.test(digits)) {
          push(String.fromCodePoint(parseInt(digits, 16)))
          i = close
        }
        continue
      }
      const width = next === 'x' ? 2 : 4
      const digits = source.slice(i + 1, i + 1 + width)
      i += width
      if (/^[0-9a-fA-F]+$/.test(digits) && digits.length === width) push(String.fromCharCode(parseInt(digits, 16)))
      continue
    }
    // `\cA` is the control character the letter names, not the letters `c` and `A`: seeding those
    // left `^(\ca|\ca\ca)+$` accepted and still catastrophic against a run of U+0001.
    if (next === 'c' && /[a-zA-Z]/.test(source[i + 1] ?? '')) {
      push(String.fromCharCode((source[i + 1] as string).toUpperCase().charCodeAt(0) % 32))
      i++
      continue
    }
    // `\p{Script=Greek}` names a set, and reading it character by character seeded the ASCII of the
    // property's own spelling -- the one alphabet the pattern is guaranteed not to be ambiguous
    // over. Asked instead of read, the same way a character class is. Dormant today, since no call
    // site passes the `u` flag these require, and pinned anyway: this is the shared entry point.
    if ((next === 'p' || next === 'P') && source[i + 1] === '{') {
      const close = source.indexOf('}', i + 2)
      if (close !== -1) {
        push(firstMatch(source.slice(i - 1, close + 1), 'u', CLASS_CANDIDATES))
        i = close
        continue
      }
    }
    const sample = ESCAPE_SAMPLES[next]
    // An escape not in the table is an escaped literal (`\.`, `\-`, `\/`), which stands for itself.
    push(sample ?? next)
  }
  return out
}

/**
 * The alphabets to pump: the fixed set, then each character the pattern names, then all of them.
 *
 * Capped, because the alphabet count multiplies the probe's cost and a long pattern would otherwise
 * pay for dozens of runs. Taking the first few in order of appearance made the cap into a bypass:
 * `^(a|b|c|d|e|f|z|zz)+$` kept `a` through `f`, never probed `z`, and was accepted while being
 * catastrophic against a run of `z`. The samples are therefore ordered by how often the pattern
 * names each character, because the character it is ambiguous over is by construction the one it
 * names more than once -- `z` appears three times there and each decoy once. Ties keep appearance
 * order, so the characters that open the pattern still come first among equals.
 */
const MAX_PATTERN_ALPHABETS = 12

export function probeAlphabets(source: string): string[] {
  const samples = sampleCharacters(source)
  // One pass over the source building a count per code point, not one `source.split(c)` per sample:
  // the latter is O(samples x source) and turned a 438 KB pattern into 4.5 s of synchronous work
  // inside a pre-approval guard. Iterating by code point rather than by index so an astral seed
  // (`\u{1F600}`) is counted as the one character it is.
  const counts = new Map<string, number>()
  for (const ch of source) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  const counted = samples.map((c, i) => ({ c, i, n: counts.get(c) ?? 0 }))
  counted.sort((a, b) => b.n - a.n || a.i - b.i)
  const kept = counted.slice(0, MAX_PATTERN_ALPHABETS).map((s) => s.c)
  const extra = kept.length > 1 ? [kept.join('')] : []
  return [...PROBE_ALPHABETS, ...kept, ...extra]
}

export function growsExponentially(re: RegExp): boolean {
  const relaxed = detune(re.source)
  // The raw pattern is run at length only when nothing in it can hold an explosion shut past a
  // rung. A consuming gate is safe to walk into -- `^a{300}(a|aa)+$` hands the ambiguous tail only
  // the four characters the step added -- but a ZERO-width one is not: `^(?=a{300})(a|aa)+$` costs
  // 0.002 ms at every rung below 300 and then gives the tail the whole string. So a pattern with an
  // assertion in it is judged on {@link detune}'s rewrite instead, which has the same parts in the
  // same order and no gate to hide behind.
  if (relaxed === null || !relaxed.hadLookaround) {
    if (climbsPastBudget(re)) return true
  }
  if (relaxed === null) return false
  // A negative assertion is DELETED rather than unwrapped, because unwrapping inverts it and the
  // rest of the pattern would then only be reached by an input the original refuses. Deleting it
  // loses its own cost, though, and the engine has to run an assertion to completion to learn that
  // it fails: `^(?!(a+)+$)x` is catastrophic entirely inside the part that gets deleted.
  for (const body of relaxed.negativeBodies) {
    let inner: RegExp
    try {
      inner = new RegExp(body, re.flags)
    } catch {
      continue
    }
    if (growsExponentially(inner)) return true
  }
  let widened: RegExp
  try {
    widened = new RegExp(relaxed.source, re.flags)
  } catch {
    // Removing a group renumbers backreferences; a rewrite that no longer compiles says nothing
    // about the original, so it is dropped rather than guessed at.
    return false
  }
  return growsExponentially(widened)
}

/** The probe ladder itself: whether `re` blows the budget, or projects past it, at any rung. */
function climbsPastBudget(re: RegExp): boolean {
  const probe = new RegExp(re.source, re.flags.replace('g', ''))
  for (const alphabet of probeAlphabets(re.source)) {
    const body = (n: number): string => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n)
    // The input has to FAIL, or there is nothing to backtrack over: a run that matches straight
    // through is linear whatever the pattern's shape. A fixed `!` was not enough. Seeding
    // `^([^a0]+)+$` correctly, with a space, still produced `    !` -- which that class matches, so
    // the probe sailed through in zero time and the pattern was accepted while taking 113.8 s
    // against thirty-four characters. The terminator is chosen by trying it at the shortest rung
    // and keeping the first one that does not match, so no assumption is made about what a given
    // pattern rejects.
    const tail = PROBE_TERMINATORS.find((t) => !probe.test(body(PROBE_STEP) + t)) ?? PROBE_TERMINATORS[0]
    // Calibrating once, at the shortest rung, is not enough: a terminator that makes the pattern
    // fail there can start MATCHING further up the ladder, and every rung after that measures a run
    // the engine finished on its first successful path. `^((a|aa){5,})!$` cannot reach five
    // repetitions inside four characters, so `aaaa!` fails and `!` is chosen -- and from five
    // characters on `aaaaa!` matches, so the ladder read 0.0 ms at all 128 rungs and accepted a
    // pattern that costs 18.2 seconds against forty-five characters. The rung re-picks instead,
    // from the same list, and every attempt is timed and held to the same budget, so the re-pick
    // cannot become the weapon either. An ordinary pattern pays nothing for this: its calibrated
    // terminator still fails, so the first attempt is the only one.
    const candidates = [tail, ...PROBE_TERMINATORS.filter((t) => t !== tail)]
    // A tail found by sweeping, kept for the rungs above so the sweep is paid for once, and a count
    // of how many rungs have paid for a fruitless one.
    let swept: string | undefined
    let sweeps = 0
    const timings: number[] = []
    let previous: number | undefined
    for (const length of PROBE_LENGTHS) {
      let failing: Measurement | undefined
      let last: Measurement | undefined
      const attempt = (candidate: string): Measurement | 'over-budget' => {
        const m = timeMatch(re, body(length) + candidate)
        last = m
        if (m.ms > PROBE_BUDGET_MS) return 'over-budget'
        if (!m.matched) failing = m
        return m
      }
      for (const candidate of swept === undefined ? candidates : [swept, ...candidates]) {
        if (attempt(candidate) === 'over-budget') return true
        if (failing !== undefined) break
      }
      // The candidate list is finite and a pattern can simply name all of it. Every terminator
      // above sits in the optional class of `^(a|aa)+[!a0 \uFFFF\n\u2028]?$`, so no input this
      // rung can build is capable of failing, every run matched, and the ladder read 0 ms while the
      // pattern cost 16.7 seconds against forty-five characters -- 30.8 with `*` in place of `?`.
      // So the fixed list is a starting point rather than the whole vocabulary: when none of it
      // fails, the same sweep a character class is asked with is walked for one that does. Each
      // attempt is timed and held to the budget like any other, and the fixed four-character step
      // is what makes that safe -- the rung where a swept tail first costs anything is only four
      // characters past the one where it cost nothing.
      //
      // The sweep offers each character nine times over rather than singly, because the guard
      // appends a tail and an optional any-character tail eats exactly one of it: `^(a|aa)+[\s\S]?$`
      // matches `aaaa` plus any single character, so every single-character tail matched it. Nine is
      // where that stops, for the reason {@link SWEEP_TAILS} gives.
      // And the whole sweep is capped, because a pattern that really does match everything -- the
      // honest `^[\s\S]*$` -- would otherwise pay for all of it on all 128 rungs for no verdict.
      if (failing === undefined && sweeps < MAX_SWEEPS) {
        sweeps++
        for (const candidate of SWEEP_TAILS) {
          if (attempt(candidate) === 'over-budget') return true
          if (failing !== undefined) {
            swept = candidate
            break
          }
        }
      }
      // Still nothing this rung can say: the pattern matches everything, so no run backtracked.
      // Recorded as the last timing rather than skipped, because {@link projectsPastBudget} reads
      // the ladder by position and a hole would shift every rung above it.
      const elapsed = (failing ?? (last as Measurement)).ms
      // Sub-millisecond timings are noise on every platform this runs on, so a ratio between two of
      // them means nothing. Only a long run that is also disproportionate counts. This catches a
      // machine slow enough that the curve clears the budget between two rungs rather than on one.
      if (previous !== undefined && elapsed > 1 && elapsed > previous * PROBE_GROWTH_FACTOR) return true
      previous = elapsed
      timings.push(elapsed)
    }
    if (projectsPastBudget(timings)) return true
  }
  return false
}

/** The `)` closing the group that opens at `start`, or -1 if the source never closes it. */
function groupEnd(source: string, start: number): number {
  let depth = 0
  let inClass = false
  for (let i = start; i < source.length; i++) {
    const c = source[i] as string
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}


/** A rewrite of `source` with its length gates removed, or `null` if it has none. */
type Detuned = { readonly source: string; readonly hadLookaround: boolean; readonly negativeBodies: readonly string[] }

/**
 * `source` with every length gate taken out: assertions unwrapped or dropped, big counts cut down.
 *
 * A gate is any construct that costs nothing until the input is long enough and then hands a long
 * input to an ambiguous part of the pattern. Two spellings matter, and the fix for one is not the
 * fix for the other.
 *
 * A POSITIVE assertion is unwrapped into an ordinary group rather than deleted. Deleting it was the
 * first version and it refused a pattern that provably cannot stall: `^(?=.{1,8}$)(\w+\s?)+$` is
 * the standard cap-the-length-then-parse idiom, measured at 0.07 ms against 200,000 characters
 * because the assertion makes every long input fail at once -- and stripping the assertion leaves
 * `^(\w+\s?)+$`, which is catastrophic, so the guard refused the very construct that made the
 * pattern safe. Unwrapping keeps the assertion's own work AND its length cap: `^(?:.{1,8}$)(\w+\s?)+$`
 * fails at position 0 on anything long, exactly as the original does.
 *
 * A NEGATIVE assertion is deleted, because unwrapping inverts it: `^(?!zzz)(a|aa)+$` would become
 * `^(?:zzz)(a|aa)+$`, which no probe input matches, and the ambiguous tail would never be reached.
 * Deleting only widens the set of inputs that reach it. What deletion loses is the assertion body's
 * own cost, and {@link growsExponentially} probes `negativeBodies` separately to get it back.
 *
 * A COUNT is cut to {@link MAX_COUNTED_REPEAT}. `^a{300}(a|aa)+$` carries no assertion at all, so
 * nothing above would touch it; the count alone kept the tail shut for the first 300 characters.
 */
function detune(source: string): Detuned | null {
  let out = ''
  let changed = false
  let hadLookaround = false
  const negativeBodies: string[] = []
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    if (c === '\\') {
      out += c + (source[i + 1] ?? '')
      i++
      continue
    }
    if (inClass) {
      out += c
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      out += c
      inClass = true
      continue
    }
    if (c === '{') {
      const counted = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))
      if (counted !== null) {
        const min = Math.min(parseInt(counted[1] as string, 10), MAX_COUNTED_REPEAT)
        const upper = counted[3]
        const max = upper === undefined || upper === '' ? '' : String(Math.min(parseInt(upper, 10), MAX_COUNTED_REPEAT))
        const rebuilt = counted[2] === undefined ? `{${min}}` : `{${min},${max}}`
        if (rebuilt !== counted[0]) changed = true
        out += rebuilt
        i += (counted[0] as string).length - 1
        continue
      }
    }
    if (c === '(' && LOOKAROUND_AT.test(source.slice(i, i + 4))) {
      const end = groupEnd(source, i)
      if (end === -1) return null
      const behind = source[i + 2] === '<'
      const negative = source[i + (behind ? 3 : 2)] === '!'
      const body = source.slice(i + (behind ? 4 : 3), end)
      if (negative) negativeBodies.push(body)
      else out += `(?:${body})`
      i = end
      changed = true
      hadLookaround = true
      continue
    }
    out += c
  }
  return changed ? { source: out, hadLookaround, negativeBodies } : null
}

/**
 * Whether the curve the top two rungs describe is still affordable at the length real text supplies.
 *
 * A ratio between neighbouring rungs asks "is this exponential", and the answer for a quadratic
 * pattern is honestly no: `^(a+)(a+)(a+)!$` costs 13 ms at 512 characters and 92 ms at 1000, a
 * factor of seven over a doubling, comfortably inside `PROBE_GROWTH_FACTOR` at every rung forever.
 * It also costs 2.4 s against one 3000-character line, which is what a minified bundle or a base64
 * blob is, and nothing in the ladder can see that because running the ladder out to 3000 would make
 * the guard cost 2.4 s too.
 *
 * So the last doubling is extrapolated instead of run. Its two times give the exponent of the cost
 * curve directly, and the exponent gives the cost at `PROJECTED_LINE_LENGTH`. Only a top rung with
 * real signal is extrapolated: below a millisecond the two numbers are timer noise and their ratio
 * means nothing, and a linear pattern that does clear the floor projects to a fifth of the budget.
 */
export function projectsPastBudget(timings: readonly number[]): boolean {
  // The two rungs a doubling apart, found by length rather than by position: the ladder used to end
  // `256, 512` so the last two entries were the doubling, and it now steps by four, where they are
  // 508 and 512 and their ratio says nothing.
  const hi = timings.length - 1
  const hiLength = PROBE_LENGTHS[hi]
  if (hiLength === undefined) return false
  const lo = PROBE_LENGTHS.findIndex((l) => l * 2 >= hiLength)
  const loLength = PROBE_LENGTHS[lo]
  const top = timings[hi]
  const prior = timings[lo]
  if (top === undefined || prior === undefined || loLength === undefined || loLength >= hiLength) return false
  if (top <= PROJECTION_SIGNAL_MS || prior <= 0) return false
  const exponent = Math.log2(top / prior) / Math.log2(hiLength / loLength)
  return top * (PROJECTED_LINE_LENGTH / hiLength) ** exponent > PROJECTION_BUDGET_MS
}

/** The longest pattern the guard will measure. Past this the measurement is the stall. */
const MAX_PATTERN_LENGTH = 4096

/** A compiled pattern, or the reason it was refused -- phrased to complete "the pattern ...". */
export type GuardedRegex = { readonly ok: true; readonly re: RegExp } | { readonly ok: false; readonly reason: string }

/**
 * Compiles a search pattern, refusing one that will not compile or that can stall the process.
 *
 * The single entry point every surface that takes a pattern from a model or a command line uses,
 * so a new one cannot pick up the unguarded `new RegExp` by copying its neighbour. The reason is a
 * sentence fragment, so a caller can prefix its own subject ("--filter ...", "the grep pattern
 * ...") without the message reading twice.
 */
export function compileGuardedRegex(pattern: string, flags = ''): GuardedRegex {
  // The guard's own cost is linear in the pattern's length and it runs the pattern 1,920 times, so
  // a long enough pattern makes the CHECK the denial of service even after both quadratic terms in
  // the sampler were removed. A search pattern of more than a few kilobytes is outside every
  // legitimate use of these commands, and the argument arrives from a model.
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_PATTERN_LENGTH} characters, which is past what can be checked for a stall` }
  }
  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'is not a valid regular expression' }
  }
  // The measurement decides; the shape only explains. Refusing on shape alone rejected patterns
  // that are perfectly fast: `^(?:[a-z]+-)+[a-z]+$` is an ordinary slug matcher whose mandatory `-`
  // makes every group boundary unambiguous, and it matched a 200 KB non-match in 1 ms -- yet the
  // nested-quantifier check condemns it, because by shape it is indistinguishable from `(a+)+`.
  // Losing a search a caller legitimately wanted is a real cost, and this is a denial-of-service
  // bound, not a style rule. So the pattern is run first, and the static check picks the wording
  // when it fires. `secret_redact.ts` keeps its own two-stage form deliberately: there a refusal is
  // reported through `doctor` for a human to rewrite, and the conservative side is different.
  if (growsExponentially(re)) {
    return {
      ok: false,
      reason: hasNestedQuantifier(pattern)
        ? 'repeats a group that already repeats, which can take exponential time to match'
        : 'takes time that climbs steeply with the length of the line, which can stall on ordinary text',
    }
  }
  return { ok: true, re }
}

/**
 * {@link compileGuardedRegex} memoised, for a caller that would otherwise pay the probe per row.
 *
 * The probe costs a millisecond or two, which is nothing once and is the whole runtime of a query
 * when it happens per record. The cache is bounded and evicts oldest-first, because the keys can be
 * model-supplied and an unbounded map keyed on those is a slower leak than the stall this module
 * exists to prevent.
 */
const GUARDED_CACHE_LIMIT = 64
const guardedCache = new Map<string, GuardedRegex>()

export function compileGuardedRegexCached(pattern: string, flags = ''): GuardedRegex {
  const key = `${flags}/${pattern}`
  const hit = guardedCache.get(key)
  if (hit !== undefined) return hit
  const result = compileGuardedRegex(pattern, flags)
  if (guardedCache.size >= GUARDED_CACHE_LIMIT) {
    const oldest = guardedCache.keys().next()
    if (!oldest.done) guardedCache.delete(oldest.value)
  }
  guardedCache.set(key, result)
  return result
}
