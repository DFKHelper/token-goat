// Regression guard: a non-numeric --limit/--top CLI arg (e.g. "abc") parses to NaN via
// Number.parseInt, and several commands bind that limit straight into a SQL `LIMIT ?`
// parameter. better-sqlite3 rejects a NaN bind with an opaque "datatype mismatch" error
// instead of a clean, actionable CLI validation error. Drive the real run() entry so this
// exercises the actual command wiring, not just the parsing helper in isolation.
//
// The same root cause -- a numeric flag parsed with a bare `Number.parseInt` instead of
// being routed through the shared `requireInt` validator -- also affected `grep --max-lines`,
// `call-chain --depth`, and `pack`/`context-for --budget`. Each of those flags feeds a
// comparison or `.slice()` call that is silently a no-op against NaN (`x > NaN` is always
// false, `arr.slice(0, NaN)` returns `[]`), so an invalid value used to fail open (silently
// suppressing output or skipping the enforcement check) instead of erroring.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'

let stderr: string[]
let writeSpy: ReturnType<typeof vi.spyOn>

function captureStderr(): void {
  stderr = []
  writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
}

afterEach(() => {
  writeSpy.mockRestore()
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

describe('non-numeric --limit/--top validation', () => {
  it('rejects a non-numeric --limit on `symbol` with a clean error instead of a SQL datatype mismatch', async () => {
    captureStderr()
    const code = await runCli(['symbol', 'nonexistent-symbol-zzz', '--limit', 'abc'])
    expect(code).toBe(1)
    const message = stderr.join('')
    expect(message).not.toContain('datatype mismatch')
    expect(message).toContain('--limit')
  })

  it('rejects a non-numeric --limit on `refs` with a clean error instead of a SQL datatype mismatch', async () => {
    captureStderr()
    const code = await runCli(['refs', 'nonexistent-symbol-zzz', '--limit', 'abc'])
    expect(code).toBe(1)
    const message = stderr.join('')
    expect(message).not.toContain('datatype mismatch')
    expect(message).toContain('--limit')
  })
})

describe('non-numeric --max-lines validation on grep', () => {
  it('rejects a non-numeric --max-lines with a clean error instead of silently returning empty output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-grep-maxlines-'))
    try {
      writeFileSync(join(dir, 'fixture.txt'), 'UNIQUE_GREP_MATCH_TOKEN\n', 'utf-8')
      captureStderr()
      const code = await runCli(['grep', 'UNIQUE_GREP_MATCH_TOKEN', dir, '--max-lines', 'abc'])
      expect(code).toBe(1)
      expect(stderr.join('')).toContain('--max-lines')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('non-numeric --depth validation on call-chain', () => {
  it('rejects a non-numeric --depth with a clean error instead of silently ignoring the depth cap', async () => {
    captureStderr()
    const code = await runCli(['call-chain', 'nonexistent-symbol-zzz', '--depth', 'abc'])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('--depth')
  })
})

describe('non-numeric --budget validation on pack and context-for', () => {
  it('rejects a non-numeric --budget on `pack` with a clean error instead of silently skipping the budget check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pack-budget-'))
    try {
      const file = join(dir, 'fixture.ts')
      writeFileSync(file, 'export const x = 1\n', 'utf-8')
      captureStderr()
      const code = await runCli(['pack', file, '--budget', 'abc'])
      expect(code).toBe(1)
      expect(stderr.join('')).toContain('--budget')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-numeric --budget on `context-for` with a clean error instead of silently skipping the budget check', async () => {
    captureStderr()
    const code = await runCli(['context-for', 'nonexistent task xyz', '--budget', 'abc'])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('--budget')
  })
})
