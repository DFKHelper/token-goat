import { describe, expect, it } from 'vitest'

import { execFormSupportedForVersionOutput } from '../src/install.js'

/**
 * The exec-form install path is chosen by parsing `claude --version`. Every other test of that path
 * forces the choice through TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS, so without this file the parse and the
 * comparison behind the shipped default would never run under the suite at all.
 *
 * Provenance of the real-output fixture: CAPTURE. `claude --version` on 2026-09-20 printed exactly
 * `2.1.276 (Claude Code)`. The other strings are HAND-DERIVED boundary cases around the 2.1.139
 * minimum, computed from the version ordering rather than from the implementation.
 */
describe('execFormSupportedForVersionOutput', () => {
  it('accepts the real installed version string', () => {
    expect(execFormSupportedForVersionOutput('2.1.276 (Claude Code)')).toBe(true)
  })

  it('accepts exactly the minimum version', () => {
    expect(execFormSupportedForVersionOutput('2.1.139 (Claude Code)')).toBe(true)
  })

  it('rejects the release just below the minimum', () => {
    expect(execFormSupportedForVersionOutput('2.1.138 (Claude Code)')).toBe(false)
  })

  // A string compare answers '2.1.9' > '2.1.139' because '9' > '1'. Numeric comparison is the only
  // thing standing between a pre-2.1.139 Claude Code and a hook shape it silently drops.
  it('rejects a lower patch whose text sorts above the minimum', () => {
    expect(execFormSupportedForVersionOutput('2.1.9 (Claude Code)')).toBe(false)
  })

  it('rejects an older major and accepts a newer one', () => {
    expect(execFormSupportedForVersionOutput('1.9.999 (Claude Code)')).toBe(false)
    expect(execFormSupportedForVersionOutput('3.0.0 (Claude Code)')).toBe(true)
  })

  it('falls back to string form when the output carries no version', () => {
    expect(execFormSupportedForVersionOutput('')).toBe(false)
    expect(execFormSupportedForVersionOutput('claude: command not found')).toBe(false)
    expect(execFormSupportedForVersionOutput('2.1 (Claude Code)')).toBe(false)
  })
})
