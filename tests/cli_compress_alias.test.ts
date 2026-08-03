// Regression guard: the `compress` command wraps a shell command through the
// output-compression filters, but its name is undiscoverable from an agent's
// actual intent -- natural guesses (`bash`, `run`, `shell`, `exec`, `sh`, `cmd`)
// all fail, and two of them (`bash` -> `ask`, `shell` -> `help`) trigger
// Commander's "Did you mean X?" suggestion machinery pointing at a completely
// unrelated command. Registering `bash` and `run` as `.alias()`es on `compress`
// fixes the two worst false-suggestion cases while keeping the alias list short.
//
// This drives the real `run()` entry point (src/cli.ts), not a mock, so it
// exercises actual Commander dispatch -- the same concern raised by the
// injected-seam trap noted in CLAUDE.md: an alias could look wired up in source
// while Commander silently fails to route it to the same handler.
import { afterEach, describe, expect, it } from 'vitest'

import { buildProgram, run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stderr: string[]
let stdout: string[]
let stderrSpy: WriteSpy
let stdoutSpy: WriteSpy | undefined

function captureStderr(): void {
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
}

function captureStdout(): void {
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
}

afterEach(() => {
  stderrSpy.mockRestore()
  stdoutSpy?.mockRestore()
  stdoutSpy = undefined
})

async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

// A repeat count large enough to clear bash_compress's net-savings floor, matching
// the existing `compress` case in tests/command_matrix_e2e.test.ts.
const REPEAT_CMD = `"${process.execPath}" -e "for (let i = 0; i < 60; i++) console.log('compiling...')"`

describe('compress command aliases', () => {
  it('registers exactly `bash` and `run` as aliases on `compress`', () => {
    captureStderr()
    const program = buildProgram()
    const compressCmd = program.commands.find((c) => c.name() === 'compress')
    expect(compressCmd).toBeDefined()
    expect(compressCmd!.aliases()).toEqual(['bash', 'run'])
  })

  it('`compress` itself still runs and compresses output identically', async () => {
    captureStdout()
    captureStderr()
    const code = await runCli(['compress', '--filter', 'generic', '--cmd', REPEAT_CMD])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toContain('×60')
  })

  it('`bash` alias dispatches to the same compress handler', async () => {
    captureStdout()
    captureStderr()
    const code = await runCli(['bash', '--filter', 'generic', '--cmd', REPEAT_CMD])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toContain('×60')
  })

  it('`run` alias dispatches to the same compress handler', async () => {
    captureStdout()
    captureStderr()
    const code = await runCli(['run', '--filter', 'generic', '--cmd', REPEAT_CMD])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toContain('×60')
  })

  it('`bash` is no longer an unknown command misrouted toward `ask`', async () => {
    captureStdout()
    captureStderr()
    // Missing --cmd should fail with commander's required-option error, not an
    // "unknown command 'bash' (Did you mean ask?)" suggestion.
    const code = await runCli(['bash'])
    expect(code).not.toBe(0)
    const message = stderr.join('') + stdout.join('')
    expect(message).not.toContain('unknown command')
    expect(message).not.toContain('Did you mean')
  })
})
