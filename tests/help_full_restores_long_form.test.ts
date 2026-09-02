import { describe, it, expect } from 'vitest'
import { buildProgram } from '../src/cli.js'

/**
 * Provenance: CAPTURE. The byte sizes and the "long form lists one indented
 * command per line" shape were taken from the real built bundle
 * (`node dist/token-goat.mjs --help` at 2318 bytes, `help --full` at 23790
 * bytes across 154 command lines) after the compact-help change shipped. They
 * are not read off the implementation's own formatter.
 *
 * Why this test exists: compacting `--help` overrides `helpInformation` with an
 * OWN property, which permanently shadows commander's prototype method. The
 * first implementation of `help --full` could not reach past that shadow and
 * printed a one-line pointer instead of the long listing, so the 23KB form was
 * unreachable from anywhere in the CLI. Lint, typecheck and the full suite were
 * all green with that defect in place: nothing asserted that `--full` returned
 * more than the compact index, only that the compact index was small.
 */
function captureStdout(fn: () => void): string {
  let captured = ''
  const original = process.stdout.write
  process.stdout.write = (function (data: string | Uint8Array) {
    captured += typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  } catch {
    // commander may exit internally; the captured bytes are what we assert on
  } finally {
    process.stdout.write = original
  }
  return captured
}

describe('help --full restores the long listing the compact index replaces', () => {
  it('emits substantially more than the compact index and lists many commands', () => {
    const program = buildProgram()
    const compact = program.helpInformation()

    const full = captureStdout(() => {
      program.parse(['node', 'token-goat', 'help', '--full'])
    })

    // The pre-fix stub printed a single pointer line of roughly 70 bytes. Any
    // assertion that only checked "compact is small" passed against it.
    expect(full.length).toBeGreaterThan(5000)
    expect(full.length).toBeGreaterThan(compact.length * 3)

    // The long form is a per-command listing, not a grouped index: count lines
    // that begin with an indented command name.
    const commandLines = full.split('\n').filter((l) => /^ {2}[a-z][a-z0-9-]+/.test(l))
    expect(commandLines.length).toBeGreaterThan(100)
  })

  it('keeps the compact index small so the saving is not undone', () => {
    const program = buildProgram()
    expect(program.helpInformation().length).toBeLessThan(4096)
  })
})
