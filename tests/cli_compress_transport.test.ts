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

const NOTE = '[tg: note] Command failed when invoked via --cmd-b64.'

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

  it('preserves a nonzero exit code and emits the advisory once', async () => {
    runner.run.mockResolvedValue(7)
    await runEncoded(`token-goat compress --cmd-b64 ${encode('git status')}`)
    expect(process.exitCode).toBe(7)
    expect(stderr.join('').split(NOTE)).toHaveLength(2)
  })

  it('emits the advisory on a raw runner failure', async () => {
    runner.runRaw.mockReturnValue(9)
    await runEncoded('git status', ['--no-compress'])
    expect(process.exitCode).toBe(9)
    expect(stderr.join('')).toContain(NOTE)
  })

  it('emits the advisory when the runner throws', async () => {
    runner.run.mockRejectedValue(new Error('runner failed'))
    await runEncoded('git status')
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toContain('runner failed')
    expect(stderr.join('')).toContain(NOTE)
  })

  it('emits the advisory for an empty transport command without executing it', async () => {
    await runEncoded('')
    expect(process.exitCode).toBe(1)
    expect(runner.run).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain(NOTE)
  })

  it('fails safely on an invalid nested wrapper option', async () => {
    await runEncoded('token-goat compress --cmd-b64')
    expect(process.exitCode).toBe(1)
    expect(runner.run).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain(NOTE)
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
