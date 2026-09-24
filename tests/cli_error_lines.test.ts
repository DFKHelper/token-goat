/** A command failure of several lines reached stderr as one line holding a literal `\n`: the printer escapes every control character in a message, because the message carries file-derived text (a heading, a path) into a line token-goat speaks in its own voice, and it escaped the break token-goat itself put between "not found" and "Try: token-goat outline ...". CAPTURE: `token-goat skill-section humanizer 'NoSuchHeadingXyz'` on the installed 2.9.28 bundle printed `token-goat: Section 'NoSuchHeadingXyz' not found in skill 'humanizer'\nTry: token-goat outline C:\Users\...\SKILL.md` with the backslash and the n as two bytes (checked with `od -c`). */
import { describe, expect, it } from 'vitest'

import { CliError, formatCommandError } from '../src/cli.js'

describe('formatCommandError', () => {
  it('prints each line of a CliError built from lines on a line of its own', () => {
    const e = new CliError([`Section 'Nope' not found in skill 'humanizer'`, 'Try: token-goat outline /skills/humanizer/SKILL.md'])

    expect(formatCommandError(e)).toBe("token-goat: Section 'Nope' not found in skill 'humanizer'\nTry: token-goat outline /skills/humanizer/SKILL.md")
    expect(e.message).toBe("Section 'Nope' not found in skill 'humanizer'\nTry: token-goat outline /skills/humanizer/SKILL.md")
  })

  // HAND-DERIVED: a heading argument is caller text, and a newline inside it must not start a line of its own. Only the breaks between the lines token-goat composed are kept.
  it('still escapes a newline inside one of those lines', () => {
    const e = new CliError(["Section 'a\nb' not found", 'Try: token-goat outline x.md'])

    expect(formatCommandError(e)).toBe("token-goat: Section 'a\\nb' not found\nTry: token-goat outline x.md")
  })

  it('escapes a newline in a plain message, as before', () => {
    expect(formatCommandError(new CliError('one\ntwo'))).toBe('token-goat: one\\ntwo')
    expect(formatCommandError(new Error('one\ntwo'))).toBe('token-goat: one\\ntwo')
  })
})
