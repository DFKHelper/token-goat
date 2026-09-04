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

import { loadConfig, type Config, type RedactionConfig } from '../src/config.js'
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
