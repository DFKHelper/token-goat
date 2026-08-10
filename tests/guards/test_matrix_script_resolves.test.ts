/**
 * Guard: the `test:matrix` npm script must actually select test files.
 *
 * vitest treats a CLI positional as a plain SUBSTRING filter against each file's path, not as a
 * glob. Spelling it as a glob (`tests/command_matrix_e2e.*.test.ts`) therefore matches nothing and
 * the script exits 1 with "No test files found" -- a mandatory coverage gate that runs ZERO tests
 * while reporting failure, which reads like a broken suite rather than a broken filter and invites
 * "fixing" it by deleting the gate. This happened twice while sharding that file, in both
 * directions, because nothing asserted the script resolves anything.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/** Last whitespace-separated token of the script is the filter vitest receives. */
function matrixFilter(): string {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
  const script = pkg.scripts['test:matrix']
  expect(script, 'package.json must define a test:matrix script').toBeDefined()
  const parts = (script ?? '').trim().split(/\s+/)
  return parts[parts.length - 1] ?? ''
}

describe('test:matrix script', () => {
  it('uses a plain substring filter, not a glob vitest will never expand', () => {
    const filter = matrixFilter()
    expect(filter.length).toBeGreaterThan(0)
    // `*` and `?` are the tell: vitest does not expand them, so any filter containing one silently matches nothing.
    expect(filter, `test:matrix filter '${filter}' contains a glob metacharacter; vitest treats this arg as a literal path substring`).not.toMatch(/[*?]/)
  })

  it('matches at least one test file that actually exists on disk', () => {
    const filter = matrixFilter().replace(/\\/g, '/')
    const testFiles = readdirSync(resolve('tests')).map((f) => `tests/${f}`)
    const matched = testFiles.filter((p) => p.includes(filter) && /\.test\.ts$/.test(p))
    expect(matched.length, `test:matrix filter '${filter}' matches no file under tests/; the gate would run zero tests`).toBeGreaterThan(0)
  })

  it('selects every command-matrix shard, so no shard is silently left unrun', () => {
    const filter = matrixFilter().replace(/\\/g, '/')
    const shards = readdirSync(resolve('tests')).filter((f) => /^command_matrix_e2e\.\d+\.test\.ts$/.test(f))
    expect(shards.length, 'expected the sharded command-matrix files to exist').toBeGreaterThan(1)
    for (const shard of shards) {
      expect(`tests/${shard}`.includes(filter), `shard ${shard} is not selected by test:matrix filter '${filter}'`).toBe(true)
    }
  })
})

describe('command-matrix shard set', () => {
  it('has no leftover unsharded command_matrix_e2e.test.ts alongside the shards', () => {
    // Both present would double-run every case and double the suite's slowest file.
    const files = readdirSync(join(resolve('tests')))
    expect(files).not.toContain('command_matrix_e2e.test.ts')
  })
})
