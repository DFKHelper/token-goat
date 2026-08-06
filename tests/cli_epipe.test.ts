/**
 * Regression coverage for the EPIPE crash: piping a large-output command into a consumer that
 * closes early (`token-goat grep ... | head -2`) killed the CLI with an unhandled 'error' event
 * and a nonzero exit. Piping to `head`/`grep -q`/a pager is one of the most common agent
 * invocation shapes, so this is exercised end-to-end against the real built bundle -- with no
 * shell, by destroying the child's stdout pipe from the parent, which is exactly what an
 * early-closing consumer does.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { installEpipeGuard } from '../src/util.js'

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'token-goat.mjs')

interface PipeResult {
  code: number | null
  stderr: string
}

/** Run the bundle and slam its stdout shut after the first chunk, emulating `| head`. */
function runAndCloseStdout(args: string[]): Promise<PipeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      stderr += d
    })
    child.stdout.once('data', () => {
      child.stdout.destroy()
    })
    child.stdout.on('error', () => {
      // The parent side of a destroyed pipe may also emit; irrelevant to what the child did.
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

describe('installEpipeGuard', () => {
  it('swallows EPIPE on a stream and leaves exitCode 0', () => {
    const errors: unknown[] = []
    const fake = { on: (_e: string, fn: (err: NodeJS.ErrnoException) => void) => errors.push(fn) } as unknown as NodeJS.WriteStream
    const attached = installEpipeGuard([fake])
    expect(attached.length).toBe(1)
    const handler = errors[0] as (err: NodeJS.ErrnoException) => void
    const before = process.exitCode
    try {
      const epipe: NodeJS.ErrnoException = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      expect(() => handler(epipe)).not.toThrow()
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = before
    }
  })

  it('rethrows any non-EPIPE stream error rather than hiding it', () => {
    const errors: unknown[] = []
    const fake = { on: (_e: string, fn: (err: NodeJS.ErrnoException) => void) => errors.push(fn) } as unknown as NodeJS.WriteStream
    installEpipeGuard([fake])
    const handler = errors[0] as (err: NodeJS.ErrnoException) => void
    const other: NodeJS.ErrnoException = Object.assign(new Error('write EACCES'), { code: 'EACCES' })
    expect(() => handler(other)).toThrow('EACCES')
  })

  it('defaults to stdout and stderr when given no explicit streams', () => {
    const attached = installEpipeGuard()
    expect(attached).toContain(process.stdout)
    expect(attached).toContain(process.stderr)
    process.stdout.removeAllListeners('error')
    process.stderr.removeAllListeners('error')
  })
})

describe('built bundle piped into an early-closing consumer', () => {
  it('exits cleanly instead of crashing with an unhandled EPIPE', async () => {
    const r = await runAndCloseStdout(['grep', 'e', 'src', '--max-lines', '50000', '-C', '2'])
    expect(r.stderr).not.toContain('EPIPE')
    expect(r.stderr).not.toContain("Unhandled 'error' event")
    expect(r.code).toBe(0)
  }, 60_000)

  it('also survives a large --help-style listing being cut off', async () => {
    const r = await runAndCloseStdout(['commands'])
    expect(r.stderr).not.toContain("Unhandled 'error' event")
    expect(r.code).toBe(0)
  }, 30_000)
})
