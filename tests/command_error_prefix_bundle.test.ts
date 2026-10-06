// Built-bundle check that a failing command's stderr opens with exactly one `token-goat:` line, whichever path raised it: a `{ text, code }` handler (read, outline, section, symbol, semantic), an emitErr-then-return-1 handler (csv-query), a thrown CliError (bash-history, project exclude), a hand-written stderr write (session-schema) and commander's own parse errors. Before the fix most of these printed the bare message ("Symbol 'foo' not found in 'nope.ts'"), and bash-history / project exclude printed their message twice, once bare and once prefixed.

// HAND-DERIVED: every input names a file, table or command that does not exist, and each expected first line is the message the handler composes for that input (read off its source) with the one `token-goat: ` the rule adds; none of it is captured output.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

let home: string
let proj: string

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmd-err-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmd-err-proj-'))
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

function fail(args: string[]): { lines: string[]; stderr: string; stdout: string } {
  const r = runBundle(args, { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 60_000 })
  expect(r.status, `${args.join(' ')} exits 1\nstderr: ${r.stderr}`).toBe(1)
  const lines = r.stderr.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  for (const line of lines) expect(line.startsWith('token-goat: token-goat:'), `doubled prefix: ${line}`).toBe(false)
  return { lines, stderr: r.stderr, stdout: r.stdout }
}

describe('a failing command names itself on its first stderr line', () => {
  it.each([
    [['read', 'nope.ts::foo'], "token-goat: Symbol 'foo' not found in 'nope.ts'"],
    [['outline', 'nope.ts'], 'token-goat: Could not read: nope.ts'],
    [['section', 'nope.md::X'], "token-goat: File not found: 'nope.md'"],
    [['csv-query', 'nope.csv'], 'token-goat: Could not read: nope.csv'],
    [['semantic', '--limit', '0', 'x'], 'token-goat: --limit must be a positive number, got: "0"'],
    [['note-get', 'nope.ts'], "token-goat: No note found for 'nope.ts' (whole-file note)"],
    [['symbl'], "token-goat: unknown command 'symbl'"],
    [['read'], "token-goat: missing required argument 'spec'"],
  ] as const)('%j', (args, first) => {
    expect(fail([...args]).lines[0]).toBe(first)
  })

  it('prints a thrown handler error once, not once bare and once prefixed', () => {
    for (const [args, message] of [
      [['bash-history', '--limit', '0'], 'bash-history: --limit must be a positive number, got: "0"'],
      [['project', 'exclude'], 'project exclude requires a path argument'],
    ] as const) {
      const { lines, stderr } = fail([...args])
      expect(lines[0]).toBe(`token-goat: ${message}`)
      expect(stderr.split(message).length - 1, stderr).toBe(1)
    }
  })

  it('keeps the line breaks of a several-line error, prefixing only the first', () => {
    const { lines } = fail(['session-schema', 'nope_table'])
    expect(lines[0]!.startsWith("token-goat: Unknown session store table 'nope_table'. Available tables: sessions, ")).toBe(true)
    expect(lines[1]).toBe('Run `token-goat session-schema` to see all tables.')
  })

  it('leads with the error and puts the extra-argument note after it', () => {
    const { lines } = fail(['symbol', 'zzzNope', 'extra1'])
    expect(lines[0]).toBe("token-goat: No matches for 'zzzNope'")
    expect(lines.at(-1)).toBe('Note: 1 extra spec argument(s) ignored (extra1). Run symbol once per spec.')
  })

  it('leaves a --json failure body unprefixed so it still parses', () => {
    const { stderr } = fail(['outline', 'nope.ts,nope2.ts', '--json'])
    const body = JSON.parse(stderr) as { items: unknown[]; errors: unknown[] }
    expect(body.items).toEqual([])
    expect(body.errors).toHaveLength(2)
  })
})
