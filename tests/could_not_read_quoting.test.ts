// Built-bundle check that every command which fails with "Could not read" names the missing path display-safe and quoted, whichever module raised it: a path holding a space and an apostrophe, a `$`, both, or a control character used to be printed as written.

// HAND-DERIVED: each name is invented to hold the characters under test and names no file on disk. The expected spellings follow quotedArg's rule (double quotes by default, single quotes when the value holds `$` or a backtick, no quote mark when a value holding both an apostrophe and a `$` cannot be held) and displaySafeText's `\xNN` escape for a control character, worked out from those rules and not read off the implementation's output.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

let home: string
let proj: string

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cnr-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cnr-proj-'))
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

function firstStderrLine(args: string[]): string {
  const r = runBundle(args, { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 60_000 })
  expect(r.status, `${args.join(' ')} exits 1\nstderr: ${r.stderr}`).toBe(1)
  return r.stderr.replace(/\r\n/g, '\n').split('\n')[0] ?? ''
}

/** One command per module that raises the error: read_meta (outline), read_structured_data (csv-query), read_inspect (zip-list), graph_inspection (deps), graph_analysis (test-for), read_git (conflicts), read_commands (image-meta), read_spec (read with a line range). */
const COMMANDS: ReadonlyArray<{ name: string; argv: (file: string) => string[] }> = [
  { name: 'outline', argv: (f) => ['outline', f] },
  { name: 'csv-query', argv: (f) => ['csv-query', f] },
  { name: 'zip-list', argv: (f) => ['zip-list', f] },
  { name: 'deps', argv: (f) => ['deps', f] },
  { name: 'test-for', argv: (f) => ['test-for', f] },
  { name: 'conflicts', argv: (f) => ['conflicts', f] },
  { name: 'image-meta', argv: (f) => ['image-meta', f] },
  { name: 'read (line range)', argv: (f) => ['read', f + ':1-2'] },
]

const NAMES: ReadonlyArray<{ what: string; file: string; shown: string }> = [
  { what: 'a space and an apostrophe', file: "a b's.zz", shown: `"a b's.zz"` },
  { what: 'a control character', file: 'a\u0007b.zz', shown: '"a\\x07b.zz"' },
]

describe('"Could not read" names the path quoted and escaped', () => {
  for (const { name, argv } of COMMANDS) {
    for (const { what, file, shown } of NAMES) {
      it(`${name}, a path holding ${what}`, () => {
        expect(firstStderrLine(argv(file))).toBe(`token-goat: Could not read: ${shown}`)
      })
    }
  }

  it('single-quotes a path holding a dollar sign and writes one nothing can quote escaped but bare', () => {
    expect(firstStderrLine(['outline', 'a$b c.zz'])).toBe("token-goat: Could not read: 'a$b c.zz'")
    expect(firstStderrLine(['outline', "a b's$c.zz"])).toBe("token-goat: Could not read: a b's$c.zz")
  })
})
