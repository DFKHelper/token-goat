import { describe, it, expect } from 'vitest'
import type { Command } from 'commander'
import { buildProgram } from '../src/cli.js'

describe('help footer (cost + discoverability)', () => {
  it('top-level --help contains footer with both commands', () => {
    const program = buildProgram()
    let capturedOutput = ''
    // Capture what outputHelp would write by overriding write
    const originalStdoutWrite = process.stdout.write
    process.stdout.write = (function (data: string | Uint8Array) {
      capturedOutput += data
      return true
    }) as typeof process.stdout.write
    try {
      // outputHelp emits the help events which trigger addHelpText listeners
      program.outputHelp()
    } catch {
      // outputHelp calls process.exit internally, so we expect it to throw
    } finally {
      process.stdout.write = originalStdoutWrite
    }

    expect(capturedOutput).toContain('commands --grep')
    expect(capturedOutput).toContain('help <command>')
    // The anchored-pattern guidance is the substance of this tip, not decoration: a bare `--grep read` matches every command whose DESCRIPTION contains "read" and returns ~7KB of the ~21.9KB help, while `--grep '^read$'` returns ~700B. Without the anchoring hint the tip advertises "one command" and delivers a third of the list, so assert the hint survives future edits.
    expect(capturedOutput).toContain('^read$')
  })

  it('subcommand --help does NOT inherit footer', () => {
    const program = buildProgram()
    const readCmd = program.commands.find((c: Command) => c.name() === 'read')
    expect(readCmd).toBeDefined()

    let capturedOutput = ''
    const originalStdoutWrite = process.stdout.write
    process.stdout.write = (function (data: string | Uint8Array) {
      capturedOutput += data
      return true
    }) as typeof process.stdout.write
    try {
      readCmd!.outputHelp()
    } catch {
      //
    } finally {
      process.stdout.write = originalStdoutWrite
    }

    expect(capturedOutput).not.toContain('commands --grep')
  })

  it('footer costs under 250 bytes', () => {
    const program = buildProgram()
    let capturedOutput = ''
    const originalStdoutWrite = process.stdout.write
    process.stdout.write = (function (data: string | Uint8Array) {
      capturedOutput += data
      return true
    }) as typeof process.stdout.write
    try {
      program.outputHelp()
    } catch {
      //
    } finally {
      process.stdout.write = originalStdoutWrite
    }

    // Bound the FOOTER's own cost, not the whole help text: the help output grows every time a command is registered, so asserting a total-size ceiling against a hardcoded baseline would fail on an unrelated future command rather than on this tip growing. The footer is what this test owns, so measure only the footer.
    const tip = capturedOutput.split('\n').find((l) => l.startsWith('Tip:'))
    expect(tip).toBeDefined()
    expect(tip!.length).toBeLessThan(250)
  })
})
