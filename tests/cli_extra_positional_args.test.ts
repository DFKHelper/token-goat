// Regression: a single-argument read command silently dropped every extra space-separated
// positional. `read a.ts::x b.ts::y` returned only `x`, exit 0, no mention that the second spec
// was thrown away -- the shape an agent is most likely to type, because the merged form these
// commands advertise is comma-separated and space is the habit from every other CLI. A note for
// this existed and was wired to the four file-taking commands only, so `read`, `brief`, `section`,
// `refs` and `symbol` kept dropping in silence. Nothing tested the note at all, on any command,
// which is why the gap went unnoticed; this covers all nine.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let TMP: string
let fileA: string
let fileB: string
let docA: string
let docB: string

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tg-extra-args-'))
  fileA = join(TMP, 'a.ts')
  fileB = join(TMP, 'b.ts')
  docA = join(TMP, 'a.md')
  docB = join(TMP, 'b.md')
  writeFileSync(fileA, 'export function alpha(): number {\n  return 1\n}\n')
  writeFileSync(fileB, 'export function beta(): number {\n  return 2\n}\n')
  writeFileSync(docA, '# Doc A\n\n## Heading A\nbody a\n')
  writeFileSync(docB, '# Doc B\n\n## Heading B\nbody b\n')
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy | undefined
let stderrSpy: WriteSpy | undefined

afterEach(() => {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
  stdoutSpy = undefined
  stderrSpy = undefined
})

/** Returns stdout and stderr together: a command with nothing to report (`refs` on a symbol with no callers) still says so, just on the other stream, and the point of these assertions is that the note never becomes the whole response. */
async function runCli(argv: string[]): Promise<string> {
  stdout = []
  stderr = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderrSpy = spyOnWrite(process.stderr, stderr)
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
  } finally {
    process.exitCode = prev
  }
  return stdout.join('') + stderr.join('')
}

describe('extra positional arguments are reported, never dropped in silence', () => {
  // Each entry is one command's natural two-argument misuse. `mergedSuggestion` is the comma form
  // the note is expected to name; commands with no merged form say so instead of naming one.
  const CASES: Array<{ name: string; argv: () => string[]; noun: 'file' | 'spec'; dropped: () => string; mergedSuggestion: boolean }> = [
    { name: 'outline', argv: () => ['outline', fileA, fileB], noun: 'file', dropped: () => fileB, mergedSuggestion: true },
    { name: 'skeleton', argv: () => ['skeleton', fileA, fileB], noun: 'file', dropped: () => fileB, mergedSuggestion: true },
    { name: 'exports', argv: () => ['exports', fileA, fileB], noun: 'file', dropped: () => fileB, mergedSuggestion: true },
    { name: 'imports', argv: () => ['imports', fileA, fileB], noun: 'file', dropped: () => fileB, mergedSuggestion: true },
    { name: 'read', argv: () => ['read', `${fileA}::alpha`, `${fileB}::beta`], noun: 'spec', dropped: () => `${fileB}::beta`, mergedSuggestion: true },
    { name: 'brief', argv: () => ['brief', `${fileA}::alpha`, `${fileB}::beta`], noun: 'spec', dropped: () => `${fileB}::beta`, mergedSuggestion: true },
    { name: 'section', argv: () => ['section', `${docA}::Heading A`, `${docB}::Heading B`], noun: 'spec', dropped: () => `${docB}::Heading B`, mergedSuggestion: true },
    { name: 'refs', argv: () => ['refs', `${fileA}::alpha`, `${fileB}::beta`], noun: 'spec', dropped: () => `${fileB}::beta`, mergedSuggestion: true },
    { name: 'symbol', argv: () => ['symbol', 'alpha', 'beta'], noun: 'spec', dropped: () => 'beta', mergedSuggestion: false },
    { name: 'section --list', argv: () => ['section', '--list', docA, docB], noun: 'file', dropped: () => docB, mergedSuggestion: false },
  ]

  for (const c of CASES) {
    it(`${c.name} names the dropped argument`, async () => {
      const output = await runCli(c.argv())
      expect(output).toContain(`1 extra ${c.noun} argument(s) ignored`)
      // The dropped value itself, not just a count: a bare count leaves the caller guessing which
      // of the arguments it typed was the one that never ran.
      expect(output).toContain(c.dropped())
    })

    it(`${c.name} ${c.mergedSuggestion ? 'names the comma form that reads them all' : 'suggests no comma form, because it has none'}`, async () => {
      const output = await runCli(c.argv())
      if (c.mergedSuggestion) {
        expect(output).toContain(`token-goat ${c.name} "`)
      } else {
        // Suggesting a comma list here would print a command that does not work. `section --list`
        // reads a plain file path and `symbol` searches one name; neither splits on commas.
        expect(output).toContain(`${c.name} takes one ${c.noun} at a time`)
        expect(output).not.toContain(`token-goat ${c.name} "`)
      }
    })

    it(`${c.name} still produces its normal output alongside the note`, async () => {
      const output = await runCli(c.argv())
      // The note is additive: the first argument is still served. A note that replaced the result
      // would be a worse bug than the silent drop it reports.
      expect(output.replace(/^Note:.*\n?/, '').trim().length).toBeGreaterThan(0)
    })
  }

  it('prints no note when a single argument was given', async () => {
    const output = await runCli(['read', `${fileA}::alpha`])
    expect(output).not.toContain('argument(s) ignored')
  })

  it('prints no note for the comma form these commands point at', async () => {
    const output = await runCli(['read', `${fileA}::alpha,${fileB}::beta`])
    expect(output).not.toContain('argument(s) ignored')
  })

  it('counts and lists every dropped argument, not just the first', async () => {
    const output = await runCli(['outline', fileA, fileB, docA])
    expect(output).toContain('2 extra file argument(s) ignored')
    expect(output).toContain(fileB)
    expect(output).toContain(docA)
  })
})
