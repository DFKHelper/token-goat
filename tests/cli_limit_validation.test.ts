// Regression guard: a non-numeric --limit/--top CLI arg (e.g. "abc") parses to NaN via
// Number.parseInt, and several commands bind that limit straight into a SQL `LIMIT ?`
// parameter. better-sqlite3 rejects a NaN bind with an opaque "datatype mismatch" error
// instead of a clean, actionable CLI validation error. Drive the real run() entry so this
// exercises the actual command wiring, not just the parsing helper in isolation.
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
