/** Which answers about the claude process are remembered (src/claude_hidden_rules.ts): a command line that was read, and an entry point that settles the question, are kept for the session; a read that timed out or failed is strict for that call and asked again. HAND-DERIVED from the failure it prevents: one slow Windows query (the read has a 15 s timeout) must not turn off approvals for the rest of the session. The child process module is faked and the platform set to win32 so the query path runs on every CI platform; the fake's output shape (a trimmed command line from Get-CimInstance) is FORMAT-DERIVED from the query the module sends. */
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.fn()
const execFile = vi.fn()
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof ChildProcess>()), spawnSync: (...a: unknown[]) => spawnSync(...a), execFile: (...a: unknown[]) => execFile(...a) }))

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '4242', CLAUDE_CODE_SESSION_ID: 'cache-test' }

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  spawnSync.mockReset()
  execFile.mockReset()
  const mod = await import('../src/claude_hidden_rules.js')
  mod.resetHiddenRuleCache()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
})

const timedOut = { error: new Error('ETIMEDOUT'), status: null, stdout: '' }
const printed = (line: string): { error: undefined; status: number; stdout: string } => ({ error: undefined, status: 0, stdout: `${line}\r\n` })

describe('the claude process answer cache', () => {
  it('a read that timed out is strict for that call and read again on the next, then kept once it succeeds', async () => {
    const { commandLineRuleSource } = await import('../src/claude_hidden_rules.js')
    spawnSync.mockReturnValueOnce(timedOut).mockReturnValue(printed('claude.exe --model opus'))
    expect(commandLineRuleSource(env)).toBe('claude command line unreadable')
    expect(commandLineRuleSource(env)).toBeNull()
    expect(commandLineRuleSource(env)).toBeNull()
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('the asynchronous prime keeps nothing from a failed read and a definitive answer from a good one', async () => {
    const { commandLineRuleSource, primeProcessReason } = await import('../src/claude_hidden_rules.js')
    execFile.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(new Error('ETIMEDOUT'), ''))
    execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'claude.exe --model opus\r\n'))
    await primeProcessReason(env)
    await primeProcessReason(env)
    await primeProcessReason(env)
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(commandLineRuleSource(env)).toBeNull()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('a definitive strict answer (a flag that adds rules) is kept as well', async () => {
    const { commandLineRuleSource } = await import('../src/claude_hidden_rules.js')
    spawnSync.mockReturnValue(printed('claude.exe --disallowedTools Bash(curl *)'))
    expect(commandLineRuleSource(env)).toBe('claude started with --disallowedtools')
    expect(commandLineRuleSource(env)).toBe('claude started with --disallowedtools')
    expect(spawnSync).toHaveBeenCalledTimes(1)
  })
})
