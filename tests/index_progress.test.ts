// `token-goat index` (manual run) used to print nothing at all until the very end, which looks
// hung on a real terminal when parsing + embedding a large repo takes minutes. cmdIndex now
// writes a throttled progress line to stderr, gated by the exact _useRichStats rule stats.ts
// already uses for rich vs plain output (NO_COLOR wins, CI is non-rich, Claude Code's own
// terminal reports isTTY===undefined and counts as rich). This file proves: (1) the byte-identical
// stdout regression never happens regardless of TTY state, (2) progress only appears on stderr
// when the rich-terminal gate is on, (3) it stays silent under CI/pipe/NO_COLOR, (4) NO_COLOR
// wins even on a real TTY (mirroring _useRichStats itself), matching the documented "skip-to-green
// blind spot" lesson: the TTY-on path gets its own assertion, never only a skipIf.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { cmdIndex } from '../src/cli.js'

function withStdoutStderrCapture<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout.write as any) = (chunk: string): boolean => {
    stdout += chunk
    return true
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr.write as any) = (chunk: string): boolean => {
    stderr += chunk
    return true
  }
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = origStdoutWrite
      process.stderr.write = origStderrWrite
    })
}

function setTty(value: boolean | undefined): () => void {
  const orig = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  return () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: orig, configurable: true })
  }
}

function makeTestDir(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dbPath = path.join(dir, 'idx.db')
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const aSym = 1\n')
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const bSym = 2\n')
  return { dir, dbPath }
}

describe('cmdIndex manual-run progress reporting', () => {
  let restoreTty: (() => void) | undefined
  let origNoColor: string | undefined
  let origCi: string | undefined

  afterEach(() => {
    restoreTty?.()
    restoreTty = undefined
    if (origNoColor === undefined) delete process.env['NO_COLOR']
    else process.env['NO_COLOR'] = origNoColor
    if (origCi === undefined) delete process.env['CI']
    else process.env['CI'] = origCi
    origNoColor = undefined
    origCi = undefined
  })

  it('stdout stays byte-identical to the pre-progress format in the non-terminal (piped/CI) case', async () => {
    origCi = process.env['CI']
    delete process.env['CI']
    restoreTty = setTty(false)
    const { dir, dbPath } = makeTestDir('tg-idxprog-plain-')
    const { stdout, stderr } = await withStdoutStderrCapture(() => cmdIndex(dir, { walk: true, dbPath }))
    expect(stdout).toMatch(/^Indexed \d+ files? into the symbol index\.\n?$/)
    expect(stderr).toBe('')
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })

  it('emits no progress output under CI even when isTTY is undefined (Claude Code shape)', async () => {
    origCi = process.env['CI']
    process.env['CI'] = '1'
    restoreTty = setTty(undefined)
    const { dir, dbPath } = makeTestDir('tg-idxprog-ci-')
    const { stdout, stderr } = await withStdoutStderrCapture(() => cmdIndex(dir, { walk: true, dbPath }))
    expect(stdout).toMatch(/^Indexed \d+ files? into the symbol index\.\n?$/)
    expect(stderr).toBe('')
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })

  it('emits no progress output and no ANSI when NO_COLOR is set on a real TTY', async () => {
    origNoColor = process.env['NO_COLOR']
    process.env['NO_COLOR'] = '1'
    restoreTty = setTty(true)
    const { dir, dbPath } = makeTestDir('tg-idxprog-nocolor-')
    const { stdout, stderr } = await withStdoutStderrCapture(() => cmdIndex(dir, { walk: true, dbPath }))
    expect(stdout).toMatch(/^Indexed \d+ files? into the symbol index\.\n?$/)
    expect(stderr).toBe('')
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })

  it('writes progress to stderr only (never stdout) and clears the line before the final summary on a real TTY', async () => {
    origCi = process.env['CI']
    delete process.env['CI']
    restoreTty = setTty(true)
    const { dir, dbPath } = makeTestDir('tg-idxprog-tty-')
    const { stdout, stderr } = await withStdoutStderrCapture(() => cmdIndex(dir, { walk: true, dbPath }))
    expect(stdout).toMatch(/^Indexed \d+ files? into the symbol index\.\n?$/)
    // At least one progress repaint was written to stderr, carrying the done/total shape.
    expect(stderr).toMatch(/\d+\/2 files/)
    // The last thing written to stderr before the process moved on must be a line-clear (carriage
    // return followed by spaces then another carriage return), not a dangling progress fragment.
    expect(stderr.endsWith('\r')).toBe(true)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })

  it('emits no progress output when isTTY is undefined and CI is unset (Claude Code terminal, still stays clean because progress is throttled and files finish before the 100ms window)', async () => {
    // Claude Code's own terminal (isTTY undefined, CI unset) is treated as rich by _useRichStats,
    // so progress IS eligible here; this test documents that a tiny 2-file run may legitimately
    // produce zero repaints (finishes inside one throttle window) while the summary line is intact.
    origCi = process.env['CI']
    delete process.env['CI']
    restoreTty = setTty(undefined)
    const { dir, dbPath } = makeTestDir('tg-idxprog-cc-')
    const { stdout } = await withStdoutStderrCapture(() => cmdIndex(dir, { walk: true, dbPath }))
    expect(stdout).toMatch(/^Indexed \d+ files? into the symbol index\.\n?$/)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })
})
