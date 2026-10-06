// A failed git call printed git's stderr as it came: `blame` and `log` ended their one line in a literal `\n` (the trailing newline, escaped), `diff` folded 130 lines of usage text into one escaped line, and `changed` outside a repository dumped those 131 lines raw, with no `token-goat:` prefix. Every git failure now goes through formatGitFailure in src/command_error.ts.
//
// Provenance: the stderr each unit case formats is CAPTURE, produced by the real git binary at test time in a directory outside any repository (GIT_CEILING_DIRECTORIES stops the upward search). The usage-text and several-line cases are HAND-DERIVED from the shape of git 2.53's own output (an `error:` line, then `usage: git diff ...` and its option table; `fatal: ambiguous argument` followed by its `Use '--' to separate` lines). The bundle cases run the built dist/token-goat.mjs against that same directory.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { formatGitFailure } from '../src/command_error.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

let home: string
let outside: string
let gitEnv: NodeJS.ProcessEnv

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-fail-home-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-fail-proj-'))
  fs.writeFileSync(path.join(outside, 'a.ts'), 'export function alpha(): number {\n  return 1\n}\n')
  gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) }
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function gitStderr(args: string[]): string {
  const r = spawnSync('git', args, { cwd: outside, env: gitEnv, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} should fail outside a repository`).not.toBe(0)
  return r.stderr
}

describe('formatGitFailure', () => {
  it.each([
    ['blame', ['blame', '-L', '1,3', '--', 'a.ts']],
    ['log', ['log', '-L1,3:a.ts', '--max-count=5']],
    ['diff', ['diff', 'HEAD~5', '--name-only']],
  ])('says in one line that git %s ran outside a repository', (command, args) => {
    const stderr = gitStderr(args)
    expect(stderr).toMatch(/not a git repository/i)
    expect(formatGitFailure(command, stderr)).toBe(`token-goat: git ${command} failed: not a git repository`)
  })

  it('drops the usage text git prints after an argument it refuses', () => {
    const stderr = "error: unknown option `bogus'\nusage: git diff [<options>] [<commit>] [--] [<path>...]\n\nDiff output format options\n    -p, --patch           generate patch\n"
    expect(formatGitFailure('diff', stderr)).toBe("token-goat: git diff failed: error: unknown option `bogus'")
  })

  it('keeps every line of a several-line error and no trailing line break', () => {
    const stderr = "fatal: ambiguous argument 'HEAD~5': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n"
    expect(formatGitFailure('diff', stderr).split('\n')).toEqual([
      "token-goat: git diff failed: fatal: ambiguous argument 'HEAD~5': unknown revision or path not in the working tree.",
      "Use '--' to separate paths from revisions, like this:",
      "'git <command> [<revision>...] -- [<file>...]'",
    ])
  })

  it('escapes a control character inside a line, so git output cannot forge a line of its own', () => {
    const out = formatGitFailure('log', 'fatal: bad revision \u001b[31mx\n')
    expect(out).not.toContain('\u001b')
    expect(out.split('\n')).toHaveLength(1)
  })
})

describe('a git-backed command outside a repository fails in one line', () => {
  it.each([
    [['blame', 'a.ts::alpha'], 'blame'],
    [['diff', 'a.ts::alpha'], 'diff'],
    [['log', 'a.ts::alpha'], 'log'],
    [['changed'], 'diff'],
    [['changed', '--symbol'], 'diff'],
  ])('%j', (args, gitCommand) => {
    const r = runBundle(args, { cwd: outside, env: tgIsolatedEnv(home, { ...gitEnv, TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 60_000 })
    expect(r.status, r.stderr).toBe(1)
    expect(r.stderr.replace(/\r\n/g, '\n')).toBe(`token-goat: git ${gitCommand} failed: not a git repository\n`)
  })
})
