/** Built-bundle replay of the inline symbol cap: the shipped dist/token-goat.mjs, not source, indexes a 40-line function and a function past INLINE_SYMBOL_MAX_BYTES, then answers `symbol` for each. A body under the cap comes back whole with no follow-up read to name; a body over it is cut and names the read that returns the rest. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return bundleTg(project, env, args)
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-symbol-cap-bundle-'))
  // Provenance: HAND-DERIVED. Both functions below are written by this file, not copied from a real project.
  const forty = ['export function fortyLines(): number {', ...Array.from({ length: 37 }, (_, i) => `  const v${i + 1} = ${i + 1}`), '  return v37', '}']
  const huge = ['export function hugeFn(): string {', ...Array.from({ length: 200 }, (_, i) => `  const s${i} = '${'x'.repeat(80)}'`), '  return s0', '}']
  // The provenance comment is followed by a blank line, so it is not the doc comment of the function below it.
  fs.writeFileSync(path.join(project, 'long.ts'), ['// Provenance: HAND-DERIVED, written by tests/symbol_inline_cap_e2e.test.ts.', '', ...forty, '', ...huge, ''].join('\n'))
  // Provenance: HAND-DERIVED. minFn is one 50,000-character line; tripleFn is defined in three files, each body about 20 KB (200 lines of about 100 bytes), past INLINE_SYMBOL_MAX_BYTES on its own.
  fs.writeFileSync(path.join(project, 'min.ts'), `export function minFn(): string { return '${'m'.repeat(50000)}' }\n`)
  for (const p of ['A', 'B', 'C']) {
    const body = Array.from({ length: 200 }, (_, i) => `  const ${p}${i} = '${'x'.repeat(80)}'`)
    fs.writeFileSync(path.join(project, `triple${p}.ts`), ['export function tripleFn(): string {', ...body, '  return A0', '}', ''].join('\n'))
  }
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('built bundle: symbol prints a body up to the inline cap', () => {
  it('prints a 40-line function whole and names no follow-up read', () => {
    const r = tg(['symbol', 'fortyLines'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout, 'the header line must print').toMatch(/^# fortyLines \(function\) — /m)
    expect(r.stdout, 'the signature line must print').toContain('export function fortyLines(): number {')
    expect(r.stdout, 'the last body line must print, not a 5-line preview').toContain('  return v37')
    expect(r.stdout, 'a whole body must not name a read command').not.toContain('token-goat read')
  })

  it('cuts a body past the cap at a line boundary and names the read that returns the rest', () => {
    const r = tg(['symbol', 'hugeFn'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout, 'the cut must keep the first body line').toContain("  const s0 = 'xxxx")
    expect(r.stdout, 'the cut must not print the last body line').not.toContain('const s199 = ')
    expect(r.stdout, 'the cut must name the full-body read').toMatch(/token-goat read "[^"]*long\.ts::hugeFn"/)
  })

  it('bounds a one-line 50,000-character body to the per-line bound and names the read', () => {
    const r = tg(['symbol', 'minFn'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout, 'the minified line must not print past 2,400 bytes of m').not.toContain('m'.repeat(2401))
    expect(r.stdout, 'the minified line must print most of its 2,400 bytes, after the export prefix').toContain('m'.repeat(2300))
    expect(r.stdout, 'the cut must be marked').toContain('...(line cut at 2400 bytes)')
    expect(r.stdout, 'the cut must name the full-body read').toMatch(/token-goat read "[^"]*min\.ts::minFn"/)
    expect(Buffer.byteLength(r.stdout, 'utf8'), 'the output must stay near the cap, not near 50,000 bytes').toBeLessThan(12_000 + 1024)
  })

  it('shows every one of three matches that are each past the whole budget', () => {
    const r = tg(['symbol', 'tripleFn'])
    expect(r.status, r.stderr).toBe(0)
    for (const p of ['A', 'B', 'C']) {
      const shown = r.stdout.split('\n').filter((l) => l.startsWith(`  const ${p}`)).length
      // A third of the budget holds about 40 lines of about 100 bytes; far more than the 5-line floor, far fewer than the body.
      expect(shown, `match ${p} must get its share, not the floor and not everything`).toBeGreaterThan(20)
      expect(shown, `match ${p} must not take more than its share`).toBeLessThan(60)
    }
    expect([...r.stdout.matchAll(/token-goat read "[^"]*triple[ABC]\.ts::tripleFn"/g)], 'each match names its own read').toHaveLength(3)
  })
})
