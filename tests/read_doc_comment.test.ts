// `outline` clipped a doc comment to its first line with no ellipsis when later lines followed, so a doc ending "WARNING: also drops every backup" read as finished at its first sentence, and a text `read "file::symbol"` printed the body alone, although docs/cli.md sends the reader there for "the full doc comment". A text read now prints the doc comment's own source lines above the body, and an outline hint ends in an ellipsis whenever the doc goes on.
//
// Provenance: every source file below is HAND-DERIVED (written here, in the comment styles the TS, Rust, Python and Bash adapters read docs from); the expected output is the same source lines, so it is checked against the input, not against the reader's own code. The cases run the built dist/token-goat.mjs.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

let home: string
let proj: string

const TS = [
  'export const before = 1',
  '',
  '/**',
  ' * Deletes the user.',
  ' * WARNING: also drops every backup, irreversibly.',
  ' */',
  'export function drop(id: string): void {',
  '  void id',
  '}',
  '',
  '// Counts the users.',
  '// Skips the deleted ones.',
  'export function count(): number {',
  '  return 0',
  '}',
  '',
  '/** Not attached: a blank line follows. */',
  '',
  'export function loose(): void {}',
  '',
  'export class Store {',
  '  /**',
  '   * Saves one row.',
  '   * Overwrites a row with the same key.',
  '   */',
  '  save(key: string): void {',
  '    void key',
  '  }',
  '}',
  '',
  '//',
  '// Bare-topped run.',
  '// Second line.',
  'export function bareTop(): void {}',
  '',
  '//',
  '/** Block doc under a stray marker. */',
  'export function blockUnder(): void {}',
  '',
].join('\n')

const SH = [
  '#',
  '# Greets the user.',
  'wave() {',
  '  echo hi',
  '}',
  '',
].join('\n')

const PY = [
  'def greet(name):',
  '    """Say hello.',
  '',
  '    Uses the given name."""',
  '    return "hi " + name',
  '',
].join('\n')

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-read-doc-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-read-doc-proj-'))
  fs.writeFileSync(path.join(proj, 'a.ts'), TS)
  fs.writeFileSync(path.join(proj, 'g.py'), PY)
  fs.writeFileSync(path.join(proj, 'g.sh'), SH)
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

function tg(args: string[]): string {
  const r = runBundle(args, { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 60_000 })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.replace(/\r\n/g, '\n')
}

function sourceLines(from: number, to: number): string {
  return TS.split('\n').slice(from - 1, to).join('\n')
}

describe('read "file::symbol" prints the doc comment above the body', () => {
  it('a block doc comment, every line verbatim', () => {
    const out = tg(['read', 'a.ts::drop'])
    expect(out).toMatch(/^# 3 lines \+ 4-line doc comment \(~\d+ tok\)\n/)
    expect(out).toContain(sourceLines(3, 9))
  })

  it('a run of line comments', () => {
    const out = tg(['read', 'a.ts::count'])
    expect(out).toMatch(/^# 3 lines \+ 2-line doc comment \(~\d+ tok\)\n/)
    expect(out).toContain(sourceLines(11, 15))
  })

  it('a method doc keeps its indentation', () => {
    const out = tg(['read', 'a.ts::Store.save'])
    expect(out).toContain(`${sourceLines(22, 25)}\n`)
  })

  it('a comment a blank line away is not the symbol\'s doc, and nothing is added', () => {
    const out = tg(['read', 'a.ts::loose'])
    expect(out).toMatch(/^# 1 line \(~\d+ tok\)\n/)
    expect(out).not.toContain('Not attached')
  })

  it('a run of line comments whose top line is a bare marker keeps that line', () => {
    const out = tg(['read', 'a.ts::bareTop'])
    expect(out).toMatch(/^# 1 line \+ 3-line doc comment \(~\d+ tok\)\n/)
    expect(out).toContain(sourceLines(31, 34))
  })

  it('a bare # on top of a shell comment run is kept the same way', () => {
    const out = tg(['read', 'g.sh::wave'])
    expect(out).toMatch(/^# 3 lines \+ 2-line doc comment \(~\d+ tok\)\n/)
    expect(out).toContain(SH.trimEnd())
  })

  it('a stray // above a block doc comment is not part of that doc', () => {
    const out = tg(['read', 'a.ts::blockUnder'])
    expect(out).toMatch(/^# 1 line \+ 1-line doc comment \(~\d+ tok\)\n\/\*\* Block doc/)
  })

  it('a Python docstring, already inside the body, is not printed twice', () => {
    const out = tg(['read', 'g.py::greet'])
    expect(out).toMatch(/^# 5 lines \(~\d+ tok\)\n/)
    expect(out.split('Say hello.')).toHaveLength(2)
  })
})

describe('symbol NAME prints the doc comment above its preview, as read does', () => {
  beforeAll(() => {
    fs.writeFileSync(path.join(proj, 'long.ts'), ['// Sums one to seven.', '// Slowly.', 'export function sevenSum(): number {', '  let t = 0', '  t += 1', '  t += 2', '  t += 3', '  t += 4', '  return t', '}', ''].join('\n'))
    tg(['index', '.', '--walk'])
  })

  it('a block doc comment, every line verbatim, labelled in the header', () => {
    const out = tg(['symbol', 'drop'])
    expect(out).toMatch(/^# drop \(function\) — .*a\.ts:7-9 \+ 4-line doc comment\n/)
    expect(out).toContain(sourceLines(3, 9))
  })

  it('a run of line comments', () => {
    const out = tg(['symbol', 'count'])
    expect(out).toMatch(/^# count \(function\) — .*a\.ts:13-15 \+ 2-line doc comment\n/)
    expect(out).toContain(sourceLines(11, 15))
  })

  it('a comment a blank line away is not the symbol\'s doc, and nothing is added', () => {
    const out = tg(['symbol', 'loose'])
    expect(out).toMatch(/^# loose \(function\) — .*a\.ts:19-19\n/)
    expect(out).not.toContain('Not attached')
  })

  it('the doc lines do not use up the body preview', () => {
    const out = tg(['symbol', 'sevenSum'])
    expect(out).toContain('// Sums one to seven.\n// Slowly.\nexport function sevenSum(): number {\n  let t = 0\n  t += 1\n  t += 2\n  t += 3\n  ...(3 more lines;')
  })

  it('a Python docstring, already inside the body, is not printed twice', () => {
    const out = tg(['symbol', 'greet'])
    expect(out).not.toContain('doc comment')
    expect(out.split('Say hello.')).toHaveLength(2)
  })
})

describe('outline marks a doc hint that stops before the doc does', () => {
  it('ends the hint in an ellipsis when later doc lines follow', () => {
    const out = tg(['outline', 'a.ts'])
    expect(out).toMatch(/drop .*# Deletes the user\.…/)
    expect(out).toMatch(/count .*# Counts the users\.…/)
  })

  it('leaves a one-line doc unmarked', () => {
    fs.writeFileSync(path.join(proj, 'one.ts'), '/** Adds one. */\nexport function inc(n: number): number {\n  return n + 1\n}\n')
    const out = tg(['outline', 'one.ts'])
    expect(out).toMatch(/inc .*# Adds one\.$/m)
  })
})
