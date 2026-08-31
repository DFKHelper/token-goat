/**
 * `retrieve` / `bash-output` / `web-output` / `mcp-output` are exempt from the row-truncation guard
 * (tests/guards/truncation_invariant_holds.test.ts) because their --head/--tail trim LINES of cached
 * text rather than rows of a list, so "the pre-cap count of the rows being capped" is not a quantity
 * that exists for them -- the same unit mismatch that gives `logfold` its own test rather than a
 * case in that guard.
 *
 * An exemption is only honest if its stated reason is true, and that reason asserts these commands
 * already disclose what they elided. This file is what makes that assertion checked rather than
 * claimed. Without it the exemption rests on someone having once read the render path, which is how
 * thirteen commands previously sat behind a reason ("a fixture cannot create one") that was false.
 *
 * Provenance: CAPTURE. The expected strings below were read off a real run of the built bundle
 * against a seeded cache, then pasted here -- not copied from cli.ts's format string.
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { storeWebOutput } from '../src/web_cache.js'

const BUNDLE = join(__dirname, '..', 'dist', 'token-goat.mjs')

function run(args: string[]): string {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf-8', env: { ...process.env } })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

describe('cached-output commands disclose the lines they elide', () => {
  it('web-output --head says how much of the body it dropped', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the cached body`).join('\n')
    const id = storeWebOutput('https://example.com/elision-probe', body)

    const out = run(['web-output', id, '--head', '3'])

    // The head lines survive...
    expect(out).toContain('line 1 of the cached body')
    // ...the tail beyond the cap does not...
    expect(out).not.toContain('line 40 of the cached body')
    // ...and the reader is told how much went missing.
    // CAPTURE: the literal notice a real run emits, pasted from that run's stderr.
    expect(out, 'web-output dropped 57 of 60 lines and said nothing; a 3-line body and a 60-line one render identically').toContain('Showing first 3 of 60 lines')
  })

  it('web-output --tail says how much of the body it dropped', () => {
    // The other direction. A disclosure wired into only one of two symmetric branches is a
    // failure shape this repo has shipped before, and checking only --head would not see it.
    const body = Array.from({ length: 60 }, (_, i) => `tail line ${i + 1}`).join('\n')
    const id = storeWebOutput('https://example.com/elision-tail', body)

    const out = run(['web-output', id, '--tail', '3'])

    expect(out).toContain('tail line 60')
    expect(out).not.toContain('tail line 1\n')
    expect(out, 'web-output --tail dropped the head of the body silently').toContain('Showing last 3 of 60 lines')
  })

  it('leaves a short body alone, and says nothing about eliding it', () => {
    // The other half: a marker emitted unconditionally would be a false claim on a complete result,
    // which is the failure an "always disclose" fix introduces.
    const id = storeWebOutput('https://example.com/short-probe', 'only line\n')

    const out = run(['web-output', id, '--head', '3'])

    expect(out).toContain('only line')
    expect(out, 'web-output claimed an elision on a body that fit').not.toMatch(/Showing (first|last) \d+ of/)
  })
})
