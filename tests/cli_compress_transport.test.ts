import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runner = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue(0),
  runRaw: vi.fn().mockReturnValue(0),
}))
vi.mock('../src/bash_runner.js', () => ({
  ...runner,
  DEFAULT_TIMEOUT_SECONDS: 600,
}))

import { buildProgram, run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stderr: string[]
let stderrSpy: WriteSpy
let stdoutSpy: WriteSpy
let previousExitCode: typeof process.exitCode

beforeEach(() => {
  vi.clearAllMocks()
  runner.run.mockResolvedValue(0)
  runner.runRaw.mockReturnValue(0)
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
  stdoutSpy = spyOnWrite(process.stdout, [])
  previousExitCode = process.exitCode
  process.exitCode = 0
})

afterEach(() => {
  stderrSpy.mockRestore()
  stdoutSpy.mockRestore()
  process.exitCode = previousExitCode
})

function encode(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64')
}

async function runEncoded(command: string, flags: string[] = []): Promise<void> {
  await run(['node', 'token-goat', 'compress', ...flags, '--cmd-b64', encode(command)])
}

const NOTE = '[tg: note] Command failed when invoked via --cmd-b64, and the payload did not decode cleanly'

describe('compress hook transport', () => {
  it('marks --cmd-b64 as internal hook transport in CLI help', () => {
    const command = buildProgram().commands.find((sub) => sub.name() === 'compress')!
    expect(command.helpInformation()).toContain('internal hook use only')
    expect(command.helpInformation().replace(/\s+/g, ' ')).toContain('must NOT use this flag manually')
  })

  it.each(['compress', 'bash', 'run'])('unwraps token-goat %s with a quoted command', async (alias) => {
    await runEncoded(`token-goat ${alias} --shell pwsh --timeout 23 -f passthrough -c 'Write-Output "NYVUS C:\\a b\\雪"'`)
    expect(runner.run).toHaveBeenCalledExactlyOnceWith('Write-Output "NYVUS C:\\a b\\雪"', expect.objectContaining({
      shellType: 'pwsh',
      timeout: 23,
      filterName: 'passthrough',
    }))
    expect(process.exitCode).toBe(0)
    expect(stderr.join('')).not.toContain(NOTE)
  })

  it('unwraps multiple programmatically encoded wrappers and the short executable alias', async () => {
    const original = 'git status --short'
    const inner = `tg run --cmd-b64 ${encode(original)}`
    await runEncoded(`token-goat compress --cmd-b64 ${encode(inner)}`)
    expect(runner.run).toHaveBeenCalledExactlyOnceWith(original, expect.any(Object))
  })

  it('unwraps positional commands and preserves child flags', async () => {
    await runEncoded('token-goat compress -- git status --short')
    expect(runner.run).toHaveBeenCalledExactlyOnceWith('git status --short', expect.any(Object))
  })

  it('honors base64 precedence over an inner --cmd value', async () => {
    await runEncoded(`token-goat compress --cmd ignored --cmd-b64 ${encode('git status --short')}`)
    expect(runner.run).toHaveBeenCalledExactlyOnceWith('git status --short', expect.any(Object))
  })

  it('unwraps --no-compress without launching a second compressor', async () => {
    await runEncoded('token-goat compress --no-compress --shell pwsh --cmd "git status"')
    expect(runner.runRaw).toHaveBeenCalledExactlyOnceWith('git status', 600, undefined, 'pwsh')
    expect(runner.run).not.toHaveBeenCalled()
  })

  it.each(['token-goat outline src/cli.ts', 'token-goat compressor -c "git status"', 'echo token-goat compress'])(
    'does not unwrap another command: %s',
    async (command) => {
      await runEncoded(command)
      expect(runner.run).toHaveBeenCalledExactlyOnceWith(command, expect.any(Object))
    },
  )

  it('leaves manually supplied plain nested commands unchanged', async () => {
    const command = 'token-goat compress -c "git status"'
    await run(['node', 'token-goat', 'compress', '--cmd', command])
    expect(runner.run).toHaveBeenCalledExactlyOnceWith(command, expect.any(Object))
  })

  // HAND-DERIVED: 'Z2l0IHN0YXR1cw==' is base64 for 'git status'; dropping its seventh character leaves a payload that no longer re-encodes to itself, the mark a dropped or inserted character leaves, and 'Z2l0IP9zdGF0dXM=' decodes to 'git ' 0xFF 'status', a byte that is not UTF-8.
  const DROPPED_CHAR = 'Z2l0IH0YXR1cw=='
  const NOT_UTF8 = 'Z2l0IP9zdGF0dXM='

  it('preserves a nonzero exit code and emits the advisory once for a damaged nested payload', async () => {
    runner.run.mockResolvedValue(7)
    await runEncoded(`token-goat compress --cmd-b64 ${DROPPED_CHAR}`)
    expect(process.exitCode).toBe(7)
    expect(stderr.join('').split(NOTE)).toHaveLength(2)
  })

  it('does not blame a payload that decodes cleanly when its command fails', async () => {
    runner.run.mockResolvedValue(7)
    await runEncoded(`token-goat compress --cmd-b64 ${encode('git status')}`)
    expect(process.exitCode).toBe(7)
    expect(stderr.join('')).not.toContain(NOTE)
  })

  it('emits the advisory on a raw runner failure behind a payload that is not UTF-8', async () => {
    runner.runRaw.mockReturnValue(9)
    await run(['node', 'token-goat', 'compress', '--no-compress', '--cmd-b64', NOT_UTF8])
    expect(process.exitCode).toBe(9)
    expect(stderr.join('')).toContain(NOTE)
  })

  it('emits the advisory when the runner throws behind a damaged payload', async () => {
    runner.run.mockRejectedValue(new Error('runner failed'))
    await run(['node', 'token-goat', 'compress', '--cmd-b64', DROPPED_CHAR])
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toContain('runner failed')
    expect(stderr.join('')).toContain(NOTE)
  })

  it('refuses an empty transport command without executing it or blaming base64', async () => {
    await runEncoded('')
    expect(process.exitCode).toBe(1)
    expect(runner.run).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain(NOTE)
  })

  it('fails safely on an invalid nested wrapper option', async () => {
    await runEncoded('token-goat compress --cmd-b64')
    expect(process.exitCode).toBe(1)
    expect(runner.run).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain(NOTE)
  })

  it('allows nested help without executing a command or emitting a failure advisory', async () => {
    await runEncoded('token-goat compress --help')
    expect(process.exitCode).toBe(0)
    expect(runner.run).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain(NOTE)
  })

  it('does not blame base64 for a plain-command failure', async () => {
    runner.run.mockResolvedValue(7)
    await run(['node', 'token-goat', 'compress', '--cmd', 'git status'])
    expect(process.exitCode).toBe(7)
    expect(stderr.join('')).not.toContain(NOTE)
  })
})
