/**
 * Custom redaction patterns and strict mode: the two settings that exist for credentials whose
 * shape token-goat does not already know.
 *
 * PROVENANCE
 *
 * HAND-DERIVED. Every input here is constructed in the test from a stated shape (an in-house id
 * format, a 40-hex git SHA, a base64 run) rather than copied out of `SECRET_PATTERNS`, so these
 * assertions do not agree with the matcher by construction. That matters most for the strict-mode
 * cases: the risk there is not failing to redact, it is redacting ordinary output, and a fixture
 * derived from the implementation's own idea of "high entropy" could not detect that.
 *
 * The `SURVIVES` list below is the must-not-drop half. A redactor is trivially "safe" if it
 * redacts everything, so a test that only checks secrets disappear rates an over-eager matcher as
 * perfect. These are the strings that must come through untouched.
 */
import { describe, expect, it } from 'vitest'

import { invalidateConfigCache, loadConfig, type Config, type RedactionConfig } from '../src/config.js'
import { compileCustomPatterns, redactSecrets } from '../src/secret_redact.js'

function withRedaction(redaction: Partial<RedactionConfig>): Config {
  return { ...loadConfig(), redaction: { custom_patterns: [], strict: false, ...redaction } }
}

/**
 * Real output shapes that strict mode must leave alone.
 *
 * A git SHA and a hex digest are the two people most resent losing, and both are
 * lowercase-plus-digits -- two character classes, which is exactly why the rule counts classes
 * rather than trusting entropy alone.
 */
const SURVIVES: ReadonlyArray<readonly [string, string]> = [
  ['a 40-character git SHA', 'commit 9f2c1ab4d7e0835b6c19af23de45071b8c6a9d3e'],
  ['a sha256 digest', 'sha256:3b1f4e8a9c2d7061f5a8b3c4d9e2071a6b5c8d3e4f0a1b2c3d4e5f60718293a4'],
  ['a long ordinary identifier', 'const veryLongDescriptiveVariableNameForTesting = 1'],
  ['a file path with no secret in it', '/home/user/projects/some-application/src/components/index.ts'],
]

describe('redaction.custom_patterns', () => {
  it('redacts an in-house format the built-in patterns have never heard of', () => {
    // An employee id: no public tool knows this shape, which is the entire reason the setting exists.
    const text = 'ticket raised by SOL-EMP-48127733 against cluster 4'
    const { text: out, count } = redactSecrets(text, withRedaction({ custom_patterns: ['SOL-EMP-[0-9]{8}'] }))
    expect(count).toBe(1)
    expect(out).toBe('ticket raised by [REDACTED:custom] against cluster 4')
    expect(out).not.toContain('48127733')
  })

  it('leaves the same text alone when no custom pattern is configured, so the default really is off', () => {
    const text = 'ticket raised by SOL-EMP-48127733 against cluster 4'
    expect(redactSecrets(text, withRedaction({})).text).toBe(text)
  })

  it('reports a pattern that does not compile instead of throwing, and still runs the valid ones', () => {
    // A redaction rule the operator believes is running, but is not, is worse than no rule: it is
    // invisible. So a bad entry has to surface somewhere rather than being skipped in silence.
    const { patterns, problems } = compileCustomPatterns(['SOL-EMP-[0-9]{8}', '[unclosed'])
    expect(patterns).toHaveLength(1)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.pattern).toBe('[unclosed')
    expect(problems[0]!.reason.length).toBeGreaterThan(0)

    const cfg = withRedaction({ custom_patterns: ['SOL-EMP-[0-9]{8}', '[unclosed'] })
    expect(() => redactSecrets('id SOL-EMP-48127733', cfg)).not.toThrow()
    expect(redactSecrets('id SOL-EMP-48127733', cfg).text).toBe('id [REDACTED:custom]')
  })

  it('caps the pattern list rather than compiling an unbounded number of them', () => {
    const many = Array.from({ length: 70 }, (_, i) => `AAA-${i}-[0-9]{4}`)
    const { patterns, problems } = compileCustomPatterns(many)
    expect(patterns.length).toBeLessThanOrEqual(64)
    expect(problems.some((p) => p.reason.includes('only the first'))).toBe(true)
  })
})

describe('redaction.strict', () => {
  // A base64-ish credential with no recognisable prefix: three character classes, high entropy.
  const unlabelled = 'kQ8vN2v_pR7wXz4TmB1cLdF6gH9jY0sA3eU5iO'

  it('is off by default, so an unrecognised random-looking string survives', () => {
    const text = `TOKEN=${unlabelled}`
    expect(redactSecrets(text, withRedaction({})).text).toBe(text)
  })

  it('redacts that same string once strict mode is on', () => {
    const { text, count } = redactSecrets(`TOKEN=${unlabelled}`, withRedaction({ strict: true }))
    expect(count).toBe(1)
    expect(text).toBe('TOKEN=[REDACTED:high_entropy]')
    expect(text).not.toContain(unlabelled)
  })

  it.each(SURVIVES)('leaves %s untouched even in strict mode', (_label, sample) => {
    // The over-collapse half. Without this, a matcher that redacted everything would score full
    // marks on every other case in this file.
    expect(redactSecrets(sample, withRedaction({ strict: true })).text).toBe(sample)
  })

  it('still labels a known credential with its own kind rather than the generic one', () => {
    // Built-ins run first by design: strict mode must not relabel a token that was already
    // correctly identified, or the placeholder stops telling an operator what leaked.
    const { text } = redactSecrets(`AWS_ACCESS_KEY_ID=${'AKIA' + 'IOSFODNN7EXAMPLE'}`, withRedaction({ strict: true }))
    expect(text).toBe('AWS_ACCESS_KEY_ID=[REDACTED:aws_access_key]')
  })

  it('does not re-redact its own placeholders when run over already-redacted text', () => {
    const once = redactSecrets(`TOKEN=${unlabelled}`, withRedaction({ strict: true })).text
    const twice = redactSecrets(once, withRedaction({ strict: true }))
    expect(twice.text).toBe(once)
    expect(twice.count).toBe(0)
  })
})

/**
 * Ways a custom pattern can be wrong that produce silence rather than an error.
 *
 * PROVENANCE
 *
 * CAPTURE. Every case here is an input an adversarial review ran against the shipped
 * `compileCustomPatterns` / `redactSecrets` and recorded the wrong output from. The comma case is
 * quoted from its report verbatim: `EMP-[0-9]{4,8}` reached the compiler as `EMP-[0-9]{4` and `8}`,
 * both of which compile, so `problems` came back empty and the operator's rule matched nothing.
 */
describe('a custom redaction pattern that is wrong in a way nothing would otherwise report', () => {
  it('rejects a pattern that matches the empty string instead of shredding the text', () => {
    const { patterns, problems } = compileCustomPatterns(['x*'])
    expect(patterns, 'an empty-matching pattern was compiled and will be applied').toEqual([])
    expect(problems.map((p) => p.pattern)).toEqual(['x*'])
    expect(problems[0]?.reason).toContain('empty string')

    const out = redactSecrets('hello world', withRedaction({ custom_patterns: ['x*'] }))
    expect(out.text, 'the text was rewritten by a pattern that should have been refused').toBe('hello world')
    expect(out.count, 'a refused pattern must not inflate the redaction count').toBe(0)
  })

  /**
   * Every group shape whose running time doubles as the input grows.
   *
   * HAND-DERIVED, and each one measured rather than assumed: `(?:a+)+$` took 13 ms against 18
   * characters and 121 ms against 24, which is four times the work for every two characters added.
   *
   * The first version of this check caught only the first entry. `(?:a+)+$` and `(?<x>a+)+$` walked
   * past it because it used a lookahead to skip `(?`-style constructs, which made every
   * non-capturing and named group invisible; `(\d{2,})+$` because its inner repetition is written
   * with braces; and `(a|a)+$` because it has no nested quantifier at all, only two branches that
   * match the same text. The last of those is caught by measurement rather than by shape, which is
   * the point of having both -- see the reason-split assertion below.
   */
  it.each(['(a+)+$', '(?:a+)+$', '(?<x>a+)+$', '(\\d{2,})+$', '(a|a)+$'])(
    'rejects %s, whose running time doubles as the text grows',
    (source) => {
      const { patterns, problems } = compileCustomPatterns([source])
      expect(patterns, 'a catastrophic-backtracking pattern was compiled').toEqual([])
      expect(problems.map((p) => p.pattern)).toEqual([source])
    },
  )

  // The two checks cover different ground and the split is worth pinning: the shape check reads the
  // pattern, and can only refuse shapes somebody thought of; the probe runs the pattern and refuses
  // whatever is actually slow. If the probe ever stopped running, `(a|a)+$` would be accepted and
  // nothing else here would notice.
  it('refuses an ambiguous alternation by measuring it, not by recognising its shape', () => {
    const { problems } = compileCustomPatterns(['(a|a)+$'])
    expect(problems[0]?.reason, 'the static shape check claimed this one').toContain('running time')
  })

  it('still accepts the ordinary patterns an operator actually writes', () => {
    const good = ['EMP-[0-9]{4,8}', 'SOL-[A-Z]{3}-\\d+', 'internal-[a-f0-9]{16}']
    const { patterns, problems } = compileCustomPatterns(good)
    expect(problems, `a legitimate pattern was refused: ${JSON.stringify(problems)}`).toEqual([])
    expect(patterns).toHaveLength(3)

    const out = redactSecrets('employee EMP-12345678 filed it', withRedaction({ custom_patterns: good }))
    expect(out.text).toBe('employee [REDACTED:custom] filed it')
  })

  // The refusals above are one over-broad regex away from taking every ordinary alternation and
  // every non-capturing group with them. Neither of these is ambiguous: the two branches of
  // `(x|y)+` cannot match the same character, so there is nothing for an engine to backtrack over.
  // The variable that carries these splits on line breaks, so blank entries are the normal shape of
  // a list written with a trailing newline or a gap between groups. Counting them against the cap
  // would drop real patterns off the end and report nothing about it.
  it('does not spend a pattern slot on a blank entry', () => {
    const blanks = Array.from({ length: 70 }, () => '')
    const { patterns, problems } = compileCustomPatterns([...blanks, 'EMP-[0-9]{4,8}', 'SOL-[A-Z]{3}'])
    expect(problems, `blank entries produced a problem: ${JSON.stringify(problems)}`).toEqual([])
    expect(patterns, 'a real pattern was pushed off the end by blank entries').toHaveLength(2)
  })

  it('accepts an unambiguous alternation and a plain non-capturing group', () => {
    const { patterns, problems } = compileCustomPatterns(['(?:abc)+', '(x|y)+'])
    expect(problems, `a safe pattern was refused: ${JSON.stringify(problems)}`).toEqual([])
    expect(patterns).toHaveLength(2)
  })
})

describe('the environment variable that carries custom patterns', () => {
  // A comma is how a regex writes a quantifier range, so a comma-separated list cuts `{4,8}` in
  // half. Both halves compile -- `{4` and `8}` degrade to literals -- which is why this failed
  // silently rather than loudly, and why the separator had to change rather than the validation.
  it('does not split a quantifier range down the middle', () => {
    const prev = process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS']
    try {
      process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS'] = 'EMP-[0-9]{4,8}'
      // loadConfig memoizes, so without this the assertion below reads a config built before the
      // environment was set and passes whatever the separator is -- which is how this test first
      // stayed green against the very bug it exists to catch.
      invalidateConfigCache()
      const cfg = loadConfig()
      expect(cfg.redaction.custom_patterns, 'the pattern was split into fragments').toEqual(['EMP-[0-9]{4,8}'])
      const out = redactSecrets('employee EMP-12345678', cfg)
      expect(out.text, 'the operator rule set through the environment did not redact').toBe('employee [REDACTED:custom]')
    } finally {
      if (prev === undefined) delete process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS']
      else process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS'] = prev
      invalidateConfigCache()
    }
  })
})
