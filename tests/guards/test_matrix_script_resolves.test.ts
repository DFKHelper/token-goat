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
import { pinnedPopulation } from './population.js'

import { SHARD_COUNT } from '../helpers/matrix_cases.js'

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

  // Every command-matrix file, not only the numbered shards: the non-shard members of this tier
  // (the image/OCR wiring tests) are selected purely by how they are named, so a name that reads
  // fine -- command_matrix_image_e2e.test.ts -- can stop containing the filter substring and drop
  // out of the tier with nothing failing. That happened while splitting them out of shard 4.
  it('selects every command-matrix file, so none is silently left unrun', () => {
    const filter = matrixFilter().replace(/\\/g, '/')
    const files = readdirSync(resolve('tests')).filter((f) => /^command_matrix.*\.test\.ts$/.test(f))
    expect(files.length, 'expected the command-matrix files to exist').toBeGreaterThan(1)
    for (const file of files) {
      expect(`tests/${file}`.includes(filter), `${file} is not selected by test:matrix filter '${filter}'`).toBe(true)
    }
  })
})

describe('command-matrix shard set', () => {
  // SHARD_COUNT and the files on disk are two halves of one fact, and only the files run tests.
  // Raising the constant without adding the file drops that shard's cases from every run, and
  // nothing else notices: the union guard checks shardKeys against each other, not against what
  // is executed, so it keeps passing while the cases it is vouching for are never run at all.
  it('has exactly one shard file per SHARD_COUNT, each running its own slice', () => {
    const shards = readdirSync(resolve('tests')).filter((f) => /^command_matrix_e2e\.\d+\.test\.ts$/.test(f)).sort()
    expect(shards.length, `SHARD_COUNT is ${SHARD_COUNT} but ${shards.length} shard files exist; the difference is cases no file runs`).toBe(SHARD_COUNT)

    for (let i = 0; i < SHARD_COUNT; i++) {
      const file = `command_matrix_e2e.${i + 1}.test.ts`
      expect(shards, `missing shard file ${file}`).toContain(file)
      const body = readFileSync(join(resolve('tests'), file), 'utf8')
      expect(body, `${file} must run shardKeys(${i}); a duplicated index silently runs one slice twice and never runs another`).toContain(`shardKeys(${i})`)
    }
  })

  it('has no leftover unsharded command_matrix_e2e.test.ts alongside the shards', () => {
    // Both present would double-run every case and double the suite's slowest file.
    // Pinned: this case is a pure negative assertion, which an empty directory listing satisfies
    // for free -- exactly the shape where "no leftover file found" and "nothing was looked at" are
    // the same green tick.
    const files = pinnedPopulation({
      what: 'tests/ directory entries',
      items: readdirSync(join(resolve('tests'))),
      floor: 300,
      mustInclude: ['command_matrix_e2e.1.test.ts'],
    })
    expect(files).not.toContain('command_matrix_e2e.test.ts')
  })
})
