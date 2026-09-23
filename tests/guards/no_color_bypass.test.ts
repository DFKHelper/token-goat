/**
 * Guard against the "NO_COLOR-aware helper exists but callers reimplement a
 * simpler, non-compliant check" class.
 *
 * src/render/ansi.ts exports colorStdout() specifically to respect the NO_COLOR env-var convention
 * (no-color.org) before emitting ANSI escape codes. Every actual stdout-writing helper across the
 * CLI (out() in cli.ts, writeRaw() in cli_stats.ts, emit() in config_commands.ts, graph_commands.ts
 * and read_commands.ts) independently duplicated the same
 * `process.stdout.isTTY === true ? text : stripAnsi(text)` check instead of calling colorStdout() --
 * so `NO_COLOR=1 token-goat <cmd>` run on a real TTY still emitted ANSI codes at every one of those
 * five call sites, silently violating the convention colorStdout() itself correctly implements.
 *
 * Both populations here are derived from the source tree rather than listed by hand. The earlier
 * version of this guard carried a nine-name array, and when the eight byte-identical emit()/emitErr()
 * copies were folded into src/emit.ts, six of those names stopped satisfying the rule -- not because
 * the invariant broke but because the file that satisfies it moved. A hand-kept list answers "did
 * these specific files change" when the question is "does anything strip ANSI without asking
 * colorStdout first", and it degrades the other way too: a new stdout writer added tomorrow is
 * simply absent from it, and absence reads as compliance.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return srcFiles(full)
    return e.isFile() && e.name.endsWith('.ts') ? [full] : []
  })
}

const ALL_SRC = srcFiles(SRC_DIR).map((full) => ({ rel: path.relative(SRC_DIR, full).replace(/\\/g, '/'), text: fs.readFileSync(full, 'utf8') }))

// The stripper's name is optional in the pattern: this guard once named `stripAnsi` exactly, and that function has since been folded into `vlen` with every writer here moved to `stripAnsiEscapes`. A rename must not quietly empty the anti-pattern the guard exists to catch.
const BARE_ISTTY_PATTERN = /process\.stdout\.isTTY\s*===\s*true\s*\?\s*text\s*:\s*stripAnsi\w*\(text\)/

// A file that both writes to stdout and strips ANSI is one that decides, for itself, whether colour survives -- which is exactly the decision colorStdout() owns. Files that only write (raw passthrough, JSON-RPC frames) and files that only strip (hook payload sanitising, render width arithmetic) are not making that call and are correctly out of scope.
const DECIDES_COLOUR = ALL_SRC.filter((f) => f.text.includes('process.stdout.write(') && f.text.includes('stripAnsiEscapes('))

// 388 live at the time of writing; the floor is the collapse detector, not the count.
const SCANNED = pinnedPopulation({ what: 'src/**/*.ts files scanned for the bare isTTY bypass', items: ALL_SRC.map((f) => f.rel), floor: 350, mustIncludeExact: ['render/ansi.ts', 'emit.ts'] })

// Measured at 4: cli.ts, cli_statusline.ts, cli_stats.ts and emit.ts. No ceiling -- a new file that both writes stdout and strips ANSI is a file this guard SHOULD pick up and check, not one that should make it red. emit.ts is the shared writer the eight private emit()/emitErr() copies were folded into, so its absence means the detection stopped matching the shape it is written for rather than that nothing decides colour any more.
const DECIDERS = pinnedPopulation({ what: 'src files that decide whether colour survives to stdout', items: DECIDES_COLOUR.map((f) => f.rel), floor: 4, mustIncludeExact: ['emit.ts'] })

describe('NO_COLOR-aware stdout writers', () => {
  it.each(SCANNED)('%s does not bypass colorStdout() with a bare isTTY check', (rel) => {
    const file = ALL_SRC.find((f) => f.rel === rel)
    expect(BARE_ISTTY_PATTERN.test(file?.text ?? '')).toBe(false)
  })

  // The call parens are load-bearing: a bare `colorStdout` substring is satisfied by any file that only names the helper in a comment, which is how a file that stopped calling it would still read as compliant.
  it.each(DECIDERS)('%s takes the strip decision from colorStdout()', (rel) => {
    const file = DECIDES_COLOUR.find((f) => f.rel === rel)
    expect(file?.text.includes('colorStdout()')).toBe(true)
  })
})
