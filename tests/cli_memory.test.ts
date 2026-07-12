import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as NodeOs from 'node:os'

// vi.mock is hoisted -- wrap homedir so every test's findClaudeMdFiles() walk-up
// checks an isolated fake home instead of the real developer machine's
// ~/.claude/CLAUDE.md, which would otherwise leak into every report.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import { runMemoryCommand } from '../src/cli_memory.js'

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
    return true
  })
  return {
    text: () => chunks.join(''),
    restore: () => spy.mockRestore(),
  }
}

describe('runMemoryCommand', () => {
  let tempDir: string
  let fakeHome: string
  let origIsTTY: boolean | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-memory-test-'))
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-memory-home-'))
    const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
    homedirMock.mockReturnValue(fakeHome)
    origIsTTY = process.stdin.isTTY
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.rmSync(fakeHome, { recursive: true, force: true })
    const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
    homedirMock.mockReset()
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
  })

  it('--analyze reports exact-duplicate lines and never writes', async () => {
    const claudeMd = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(claudeMd, '# Rules\n\nDo the thing.\n\nDo the thing.\n', 'utf-8')

    const cap = captureStdout()
    try {
      await runMemoryCommand({ project: tempDir })
    } finally {
      cap.restore()
    }

    const out = cap.text()
    expect(out).toContain('CLAUDE.md files')
    expect(out).toContain('exact-duplicate lines: 1')
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe('# Rules\n\nDo the thing.\n\nDo the thing.\n')
  })

  it('reports "none found" when there are no CLAUDE.md files', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-memory-empty-'))
    try {
      const cap = captureStdout()
      try {
        await runMemoryCommand({ project: emptyDir })
      } finally {
        cap.restore()
      }
      expect(cap.text()).toContain('No CLAUDE.md files found')
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('--fix without --yes on a non-TTY stdin is a dry run: reports and does not write', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
    const claudeMd = path.join(tempDir, 'CLAUDE.md')
    const original = '# Rules\n\nDo the thing.\n\nDo the thing.\n'
    fs.writeFileSync(claudeMd, original, 'utf-8')

    const cap = captureStdout()
    try {
      await runMemoryCommand({ project: tempDir, fix: true })
    } finally {
      cap.restore()
    }

    expect(cap.text()).toMatch(/Dry run: no files were written/)
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(original)
  })

  it('--fix --yes removes exact-duplicate lines and writes the file', async () => {
    const claudeMd = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(claudeMd, '# Rules\n\nDo the thing.\n\nDo the thing.\n', 'utf-8')

    const cap = captureStdout()
    try {
      await runMemoryCommand({ project: tempDir, fix: true, yes: true })
    } finally {
      cap.restore()
    }

    expect(cap.text()).toMatch(/applied 1 file\(s\)/)
    const after = fs.readFileSync(claudeMd, 'utf-8')
    expect((after.match(/Do the thing\./g) ?? []).length).toBe(1)
  })

  it('--fix leaves cross-file-overlap-only content untouched (advisory, no mechanical fix)', async () => {
    // Neither file has a duplicate line *within itself*; the only finding is a
    // line shared *across* the two files, which is never auto-applied.
    const parentMd = path.join(tempDir, 'CLAUDE.md')
    const childDir = path.join(tempDir, 'child')
    fs.mkdirSync(childDir)
    const childMd = path.join(childDir, 'CLAUDE.md')

    const parentOriginal = '# Parent\n\nShared line here.\n'
    const childOriginal = '# Child\n\nShared line here.\n\nChild only line.\n'
    fs.writeFileSync(parentMd, parentOriginal, 'utf-8')
    fs.writeFileSync(childMd, childOriginal, 'utf-8')

    const cap = captureStdout()
    try {
      await runMemoryCommand({ project: childDir, fix: true, yes: true })
    } finally {
      cap.restore()
    }

    expect(cap.text()).toContain('cross-file overlaps: 1')
    expect(cap.text()).toContain('No mechanical (exact-duplicate-line) fixes to apply')
    expect(cap.text()).toContain('advisory only')
    expect(fs.readFileSync(parentMd, 'utf-8')).toBe(parentOriginal)
    expect(fs.readFileSync(childMd, 'utf-8')).toBe(childOriginal)
  })
})
