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
import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'

let stderr: string[]
let stdout: string[]
let writeSpy: ReturnType<typeof vi.spyOn>
let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined

function captureStderr(): void {
  stderr = []
  writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
}

function captureStdout(): void {
  stdout = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
}

afterEach(() => {
  writeSpy.mockRestore()
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

// Regression guard: unlike a non-numeric value (caught above), a negative --limit/--top is a
// *finite* number, so it sailed straight past the NaN-only check the fixes above added. Two
// different downstream sinks turn that "valid-looking" negative number into a silent cap bypass
// instead of an error:
//
//   - `symbol`/`refs` (and `find`/`callers`/`types`/`semantic`) bind --limit straight into a SQL
//     `... LIMIT ?`. SQLite treats a negative LIMIT bind as "no limit at all" (LIMIT -1 returns
//     every row; LIMIT 0 correctly returns zero), so `--limit -1` silently dumps the entire
//     matching set instead of capping it -- the exact large-context-burn outcome these row caps
//     exist to prevent.
//   - `tokens` (and other --top consumers) feed --top into `entries.slice(0, top)`. JS's
//     `.slice(0, -1)` means "everything except the last element", not "nothing" -- a negative
//     --top silently reinterprets as a near-complete, confusingly-truncated result instead of
//     erroring.
//
// requireNonNegativeInt() closes both: it rejects any strictly-negative value with a clean
// CliError before it ever reaches the SQL bind or the .slice() call. Zero is still accepted
// (SQLite and .slice() both correctly return nothing for a 0 cap).
describe('negative --limit/--top validation', () => {
  it('rejects a negative --limit on `symbol` instead of dumping every matching row', async () => {
    const db = getDb(globalDbPath())
    const stmt = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    // More rows than `symbol`'s sane default --limit of 20, so an unclamped negative --limit
    // (SQLite's LIMIT -1 == unlimited) would observably return all of them instead of erroring.
    const rowCount = 30
    for (let i = 0; i < rowCount; i++) {
      stmt.run(`fixture-neg-limit-symbol-${i}.ts`, 'fixtureNegLimitSymbol', 'function', 1, 2, 'function fixtureNegLimitSymbol() {}', '')
    }

    captureStdout()
    captureStderr()
    const code = await runCli(['symbol', 'fixtureNegLimitSymbol', '--limit', '-1', '--json'])
    expect(code).toBe(1)
    // Pre-fix this would print a 30-element JSON array of matches; post-fix nothing is printed
    // because requireNonNegativeInt throws before querySymbols ever runs.
    expect(stdout.join('')).not.toContain('fixtureNegLimitSymbol')
    expect(stderr.join('')).toContain('--limit')
  })

  it('rejects a negative --limit on `refs` instead of dumping every matching reference', async () => {
    const db = getDb(globalDbPath())
    const stmt = db.prepare('INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)')
    // More rows than queryRefs' internal default cap of 100, for the same reason as above.
    const rowCount = 120
    for (let i = 0; i < rowCount; i++) {
      stmt.run(`fixture-neg-limit-refs-${i}.ts`, 'fixtureNegLimitRef', i + 1, 0, 'fixtureNegLimitRef()')
    }

    captureStdout()
    captureStderr()
    const code = await runCli(['refs', 'fixtureNegLimitRef', '--limit', '-1', '--json'])
    expect(code).toBe(1)
    expect(stdout.join('')).not.toContain('fixtureNegLimitRef')
    expect(stderr.join('')).toContain('--limit')
  })

  it('rejects a negative --top on `tokens` instead of silently slicing from the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-tokens-negtop-'))
    try {
      const fileA = join(dir, 'fixture-neg-top-a.ts')
      const fileB = join(dir, 'fixture-neg-top-b.ts')
      const fileC = join(dir, 'fixture-neg-top-c.ts')
      writeFileSync(fileA, 'export const fixtureNegTopA = 1\n', 'utf-8')
      writeFileSync(fileB, 'export const fixtureNegTopB = 2\n', 'utf-8')
      writeFileSync(fileC, 'export const fixtureNegTopC = 3\n', 'utf-8')

      captureStdout()
      captureStderr()
      // Absolute paths so expandGlobs() uses them as-is regardless of process.cwd().
      const code = await runCli(['tokens', fileA, fileB, fileC, '--top', '-1', '--json'])
      expect(code).toBe(1)
      // Pre-fix, entries.slice(0, -1) on 3 entries silently returns the first 2 (all but the
      // last) and exits 0 instead of erroring.
      expect(stdout.join('')).not.toContain('fixture-neg-top')
      expect(stderr.join('')).toContain('--top')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
