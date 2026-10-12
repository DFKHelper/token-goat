/** cliInvocation (src/command_error.ts): the argv a failure hint quotes. Every expectation is HAND-DERIVED from the rule the doc states: the argv of the run in progress, and process.argv once no run is in progress, so a long-lived server never quotes a finished run's command. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'
import { clearCliInvocation, cliInvocation, setCliInvocation } from '../src/command_error.js'

afterEach(() => {
  clearCliInvocation()
  vi.restoreAllMocks()
})

describe('cliInvocation', () => {
  it('returns the argv of the run in progress', () => {
    setCliInvocation(['node', 'token-goat', 'read', 'src/a.ts'])
    expect(cliInvocation()).toEqual(['read', 'src/a.ts'])
  })

  it('falls back to the process argv once cleared', () => {
    setCliInvocation(['node', 'token-goat', 'read', 'src/a.ts'])
    clearCliInvocation()
    expect(cliInvocation()).toEqual(process.argv.slice(2))
  })

  it.each([
    ['a command that fails', ['node', 'token-goat', 'no-such-command-xyz']],
    ['a help request', ['node', 'token-goat', '--help']],
  ])('is back to the process argv after run() ends on %s', async (_label, argv) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const previousExitCode = process.exitCode
    try {
      await run(argv)
    } finally {
      process.exitCode = previousExitCode
    }
    expect(cliInvocation()).toEqual(process.argv.slice(2))
  })
})
