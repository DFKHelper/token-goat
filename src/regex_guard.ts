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
 * Two fixed lengths were not enough. `^(a+)+$` doubles per character and is already at 112 ms by 24,
 * but `^(b|bb)+$` grows on the Fibonacci curve -- measured 0.46 ms at 24, 3.7 ms at 28, 23.9 ms at
 * 32, 161 ms at 36, 12.0 s at 44 -- so any pair of short lengths reads it as flat. A ladder answers
 * both without paying for the long inputs on ordinary patterns, because it only climbs while the
 * pattern is still fast: the same slug matcher stays at 0.00 ms across every rung.
 *
 * The step is 4 rather than 8 to bound the overshoot. The rung after a rung that came in under
 * budget can only be as slow as the worst growth over 4 characters, so a pattern that doubles per
 * character costs at most 16x the budget once -- a fifth of a second -- before it is refused.
 */
const PROBE_LENGTHS = [16, 20, 24, 28, 32, 36] as const
const PROBE_GROWTH_FACTOR = 12
const PROBE_BUDGET_MS = 25

function timeMatch(re: RegExp, input: string): number {
  // A fresh regex per call: a `g`-flagged pattern carries lastIndex between calls, which would make
  // the second measurement start mid-string and read as faster.
  const probe = new RegExp(re.source, re.flags.replace('g', ''))
  const started = performance.now()
  probe.test(input)
  return performance.now() - started
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
/**
 * The characters to pump, taken from the pattern itself as well as from a fixed set.
 *
 * A fixed alphabet is a hole. `^(b|bb)+$` has no nested quantifier and finishes instantly against
 * `aaaa...`, `0000...` and `a0a0...`, so the probe saw nothing and the pattern was accepted --
 * measured, it takes 13 seconds against 44 `b` characters and doubles every two after that. What
 * makes a pattern explode is ambiguity over the text IT matches, so the text to try it on has to
 * come out of the pattern. Every literal word character in the source becomes an alphabet of its
 * own, and their concatenation becomes one more, which covers `(ab|abab)+` as well as `(b|bb)+`.
 *
 * Capped, because the alphabet count multiplies the probe's cost and a long pattern would otherwise
 * pay for dozens of runs. The literals are taken in order of appearance, so the ones that open the
 * pattern -- the ones a match has to get past first -- are the ones kept.
 */
const MAX_PATTERN_ALPHABETS = 6

export function probeAlphabets(source: string): string[] {
  // Backslash escapes are skipped whole: the `d` of `\d` is not a literal `d`, and taking it as one
  // would probe with a character the pattern cannot match.
  const literals: string[] = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    if (c === '\\') {
      i++
      continue
    }
    if (/[A-Za-z0-9_]/.test(c) && !literals.includes(c)) literals.push(c)
  }
  const kept = literals.slice(0, MAX_PATTERN_ALPHABETS)
  const extra = kept.length > 1 ? [kept.join('')] : []
  return [...PROBE_ALPHABETS, ...kept, ...extra]
}

export function growsExponentially(re: RegExp): boolean {
  for (const alphabet of probeAlphabets(re.source)) {
    const fill = (n: number): string => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n) + '!'
    let previous: number | undefined
    for (const length of PROBE_LENGTHS) {
      const elapsed = timeMatch(re, fill(length))
      if (elapsed > PROBE_BUDGET_MS) return true
      // Sub-millisecond timings are noise on every platform this runs on, so a ratio between two of
      // them means nothing. Only a long run that is also disproportionate counts. This catches a
      // machine slow enough that the curve clears the budget between two rungs rather than on one.
      if (previous !== undefined && elapsed > 1 && elapsed > previous * PROBE_GROWTH_FACTOR) return true
      previous = elapsed
    }
  }
  return false
}

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
        : 'takes time that doubles as the text grows, which can stall on a short line',
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
