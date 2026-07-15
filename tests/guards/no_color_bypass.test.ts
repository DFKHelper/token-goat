/**
 * Guard against the "NO_COLOR-aware helper exists but callers reimplement a
 * simpler, non-compliant check" class.
 *
 * src/render/ansi.ts exports colorStdout()/colorStderr() specifically to
 * respect the NO_COLOR env-var convention (no-color.org) before emitting
 * ANSI escape codes. Every actual stdout-writing helper across the CLI
 * (out() in cli.ts, writeRaw() in cli_stats.ts, emit() in config_commands.ts,
 * graph_commands.ts, and read_commands.ts) independently duplicated the same
 * `process.stdout.isTTY === true ? text : stripAnsi(text)` check instead of
 * calling colorStdout() -- so `NO_COLOR=1 token-goat <cmd>` run on a real TTY
 * still emitted ANSI codes for every one of those five call sites, silently
 * violating the convention colorStdout() itself correctly implements. This
 * scans the known stdout-writing files for the bare isTTY-only pattern and
 * asserts colorStdout() is actually imported and used instead.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

// Every file with a private out()/emit()/writeRaw()-style helper that decides
// whether to strip ANSI codes before writing to stdout.
const STDOUT_WRITER_FILES = [
  'cli.ts',
  'cli_stats.ts',
  'config_commands.ts',
  'graph_commands.ts',
  'read_commands.ts',
]

const BARE_ISTTY_PATTERN = /process\.stdout\.isTTY\s*===\s*true\s*\?\s*text\s*:\s*stripAnsi\(text\)/

describe('NO_COLOR-aware stdout writers', () => {
  it.each(STDOUT_WRITER_FILES)('%s does not bypass colorStdout() with a bare isTTY check', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(BARE_ISTTY_PATTERN.test(src)).toBe(false)
  })

  it.each(STDOUT_WRITER_FILES)('%s imports and uses colorStdout()', (file) => {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    expect(src.includes('colorStdout')).toBe(true)
  })
})
