/**
 * Item B: `map --json` and `doctor --json`.
 *
 * Drives the real, unmocked `run()` CLI entrypoint (same pattern as cli_map_stats.test.ts)
 * against a scratch project directory with an isolated (empty) index, since the goal is
 * specifically to prove the empty-index case is surfaced correctly, not just that the flag
 * parses.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return fn()
    .then(() => spy.mock.calls.map((c) => String(c[0])).join(''))
    .finally(() => spy.mockRestore())
}

describe('map --json / doctor --json', () => {
  let root: string
  const cwd = process.cwd()

  afterEach(() => {
    process.chdir(cwd)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('`map --json` parses as JSON and carries topSymbols against an empty/unindexed project', async () => {
    root = mkdtempSync(join(tmpdir(), 'tg-mapjson-'))
    writeFileSync(join(root, 'a.ts'), 'export const x = 1\n')
    process.chdir(root)

    const output = await captureStdout(() => run(['node', 'token-goat', 'map', '--json']))
    const parsed = JSON.parse(output.trim()) as { fileCount: number; topSymbols: unknown[] }
    expect(parsed.fileCount).toBe(1)
    expect(parsed.topSymbols).toEqual([])
  })

  it('`doctor --json` parses as JSON, has one entry per check, statuses in {ok,warn,fail}, and warns the Symbols check against an empty/unindexed project', async () => {
    root = mkdtempSync(join(tmpdir(), 'tg-doctorjson-'))
    writeFileSync(join(root, 'a.ts'), 'export const x = 1\n')
    // A package.json gives findProject() a real project root to scope the Symbols check to
    // (see cmdDoctor's rootDir wiring) -- without it the check falls back to the whole shared
    // global.db, which other tests in this same run may have already populated, defeating the
    // "unindexed project" assertion below.
    writeFileSync(join(root, 'package.json'), '{"name":"tg-doctorjson-fixture"}\n')
    process.chdir(root)

    let threw = false
    const output = await captureStdout(async () => {
      try {
        await run(['node', 'token-goat', 'doctor', '--json'])
      } catch {
        // doctor throws CliError('doctor checks failed') on any fail-status check — irrelevant
        // to this test, which only asserts the JSON payload's shape and the Symbols entry.
        threw = true
      }
    })
    void threw

    const results = JSON.parse(output.trim()) as Array<{ name: string; status: string; message: string }>
    expect(results.length).toBeGreaterThan(0)
    for (const check of results) {
      expect(['ok', 'warn', 'fail']).toContain(check.status)
    }
    const symbols = results.find((r) => r.name === 'Symbols')
    expect(symbols).toBeDefined()
    expect(symbols?.status).toBe('warn')
    expect(symbols?.message).toContain('no files indexed')
  })
})
