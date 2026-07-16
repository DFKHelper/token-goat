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
