// The shell oracle behind the quoting tests: it must account for every command it was handed, say so when a shell was killed rather than report an empty stderr, and not fork a subshell per command, which under full-suite load took Git Bash past its 120 s cap at 158 of 184 commands. Provenance: HAND-DERIVED. Each expected argv is read off the command text by hand, independently of the helper's parser.
import { describe, expect, it } from 'vitest'

import { POSIX_SH, shRunAll } from './helpers/shell_argv.js'

describe.skipIf(POSIX_SH === null)('shRunAll', () => {
  const sh = POSIX_SH!

  // A builtin loop rather than sleep: a child process would hold the output pipe open after the shell is killed.
  // The budget is three times a measured warm run plus a second, so a loaded machine slow to start the shell still reaches the loop before the kill.
  it('names a timeout when the shell is killed before every command ran', () => {
    const started = Date.now()
    shRunAll(sh, ['token-goat w'])
    const timeoutMs = Math.max(1500, (Date.now() - started) * 3 + 1000)
    expect(() => shRunAll(sh, ['token-goat a', 'while :; do :; done', 'token-goat b'], { timeoutMs })).toThrow(/ran 1 of 3 commands: .*(ETIMEDOUT|SIGTERM)/)
  })

  it('shares one subshell across a chunk of commands, so a run forks once per chunk', () => {
    const got = shRunAll(sh, ['tg_probe=set', 'token-goat "${tg_probe-unset}"'])
    expect(got.map((r) => r.calls)).toEqual([[], [['set']]])
  })

  it('still gives every command its run when one ends the shell partway through a chunk', () => {
    const commands = Array.from({ length: 40 }, (_, i) => `token-goat n${i}`)
    commands[3] = 'token-goat a; exit 3'
    commands[15] = 'token-goat b; exit'
    commands[16] = 'exit 1'
    commands[17] = 'token-goat "${tg_left-clean}"'
    const got = shRunAll(sh, commands)
    expect(got).toHaveLength(40)
    const want = commands.map((_, i) => [[`n${i}`]])
    want[3] = [['a']]
    want[15] = [['b']]
    want[16] = []
    want[17] = [['clean']]
    expect(got.map((r) => r.calls)).toEqual(want)
    expect(got.every((r) => r.stray.length === 0)).toBe(true)
  })
})
