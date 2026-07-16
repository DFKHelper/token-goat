/**
 * Guard against the "shared helper exists but callers reimplement their own
 * copy" class (see no_color_bypass.test.ts / require_int_dedup.test.ts for
 * sibling cases).
 *
 * util.ts exports pad() -- a right-pad-with-spaces helper. cache_session_commands.ts,
 * cli_hint_stats.ts, and cli_recall.ts previously each kept a byte-identical
 * private copy instead of importing the shared version. This asserts those
 * files import and use the shared helper rather than redefining their own.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

const FILES = ['cache_session_commands.ts', 'cli_hint_stats.ts', 'cli_recall.ts']

const LOCAL_REDEFINE_PATTERN = /function pad\(s: string, n: number\)/

describe('shared pad() (no local re-implementations)', () => {
  it.each(FILES)('%s does not redefine its own pad()', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(LOCAL_REDEFINE_PATTERN.test(src)).toBe(false)
  })

  it.each(FILES)('%s imports pad from util.js', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(/import\s*\{[^}]*\bpad\b[^}]*\}\s*from\s*'\.\/util\.js'/.test(src)).toBe(true)
  })
})
