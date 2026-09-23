/**
 * Guard against the "shared helper exists but callers reimplement their own
 * copy" class (see no_color_bypass.test.ts for the sibling case).
 *
 * util.ts exports requireNonNegativeStrictInt()/requirePositiveStrictInt() --
 * strict-integer CLI-flag validators with a sign check. read_commands.ts and
 * text_commands.ts previously kept byte-identical private copies
 * (requireNonNegativeInt/requirePositiveInt) instead of importing the shared
 * versions. This asserts those files import and use the shared helpers
 * rather than redefining their own.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

const FILES = ['read_commands.ts', 'text_commands.ts']

const LOCAL_REDEFINE_PATTERN = /function require(NonNegative|Positive)Int\(/

describe('shared requireNonNegativeStrictInt/requirePositiveStrictInt (no local re-implementations)', () => {
  it.each(FILES)('%s does not redefine its own requireNonNegativeInt/requirePositiveInt', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(LOCAL_REDEFINE_PATTERN.test(src)).toBe(false)
  })

  it.each(FILES)('%s imports requireNonNegativeStrictInt from util.js', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(src.includes('requireNonNegativeStrictInt')).toBe(true)
  })
})

/**
 * The same class one layer up, in the CliError-throwing family. cli.ts and cli_dispatch.ts each
 * defined and exported all three of requireInt/requireNonNegativeInt/requirePositiveInt with
 * identical bodies, and the command modules were split across the two import paths:
 * cli_session/cli_office/cli_structured/cli_diagnostics took cli.ts's copies, cli_cmd_analysis and
 * cli_cmd_session took cli_dispatch.ts's. A fix to the parse would have landed on one path and
 * missed the other with nothing failing. Identity rather than source text, so a reformat or a
 * renamed local cannot pass it: both import paths must reach one function object.
 */
describe('one requireInt family behind both CLI import paths', () => {
  it.each(['requireInt', 'requireNonNegativeInt', 'requirePositiveInt'])(
    '%s is the same function via cli.js and cli_dispatch.js',
    async (name) => {
      const cli = (await import('../../src/cli.js')) as unknown as Record<string, unknown>
      const dispatch = (await import('../../src/cli_dispatch.js')) as unknown as Record<string, unknown>
      expect(typeof cli[name]).toBe('function')
      expect(cli[name]).toBe(dispatch[name])
    },
  )
})
