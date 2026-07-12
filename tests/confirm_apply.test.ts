import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { confirmAndApply, type FileChange } from '../src/confirm_apply.js'

describe('confirmAndApply', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-apply-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function mkChange(name: string, before: string, after: string): FileChange {
    const p = path.join(tempDir, name)
    fs.writeFileSync(p, before, 'utf-8')
    return { path: p, before, after }
  }

  it('applies every change without prompting when yes is true', async () => {
    const change = mkChange('a.md', 'one\ntwo\n', 'one\n')
    const written: string[] = []

    const result = await confirmAndApply([change], { yes: true, write: (t) => written.push(t) })

    expect(result.applied).toEqual([change])
    expect(result.skipped).toEqual([])
    expect(result.dryRun).toBe(false)
    expect(fs.readFileSync(change.path, 'utf-8')).toBe('one\n')
    expect(written.join('')).toContain('a.md')
  })

  it('prints diffs and applies nothing when stdin is not a TTY and yes is absent (dry run)', async () => {
    const change = mkChange('b.md', 'one\ntwo\n', 'one\n')
    const written: string[] = []

    const result = await confirmAndApply([change], { isTTY: false, write: (t) => written.push(t) })

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([change])
    expect(result.dryRun).toBe(true)
    expect(fs.readFileSync(change.path, 'utf-8')).toBe('one\ntwo\n')
    expect(written.join('')).toMatch(/Dry run: no files were written/)
    expect(written.join('')).toMatch(/--yes/)
  })

  it('prompts per file on a TTY and only applies confirmed changes', async () => {
    const keep = mkChange('keep.md', 'x\ny\n', 'x\n')
    const drop = mkChange('drop.md', 'p\nq\n', 'p\n')
    const written: string[] = []

    const result = await confirmAndApply([keep, drop], {
      isTTY: true,
      write: (t) => written.push(t),
      confirm: async (question) => question.includes('keep.md'),
    })

    expect(result.applied).toEqual([keep])
    expect(result.skipped).toEqual([drop])
    expect(result.dryRun).toBe(false)
    expect(fs.readFileSync(keep.path, 'utf-8')).toBe('x\n')
    expect(fs.readFileSync(drop.path, 'utf-8')).toBe('p\nq\n')
  })

  it('never writes content other than the exact after shown in the diff', async () => {
    const change = mkChange('c.md', 'alpha\nbeta\ngamma\n', 'alpha\ngamma\n')

    await confirmAndApply([change], { yes: true, write: () => {} })

    expect(fs.readFileSync(change.path, 'utf-8')).toBe(change.after)
  })

  it('handles an empty change list as a no-op', async () => {
    const result = await confirmAndApply([], { yes: true, write: () => {} })
    expect(result).toEqual({ applied: [], skipped: [], dryRun: false })
  })
})
