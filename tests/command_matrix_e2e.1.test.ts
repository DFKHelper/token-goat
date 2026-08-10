/**
 * Built-bundle command matrix, shard 1 of 4 (pre-push / CI tier — slow).
 *
 * Builds the real shipping artifact (dist/token-goat.mjs), indexes one shared git fixture (see
 * tests/helpers/matrix_cases.ts), then runs an interleaved quarter of every registered command
 * against the bundle and asserts real output. This shard also owns the coverage gate: the case
 * table is driven off the same registry the fast registration guard uses
 * (tests/registry.ts::allCommandNames), so a newly registered command with no matrix case fails
 * automatically, and a separate guard asserts the 4 shards' key slices union back to the full
 * case table exactly, so a shard can't silently drop a case.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { allCommandNames } from './registry.js'
import { afterEachHeartbeatMitigation, cases, cleanupMatrixFixture, setupMatrixFixture, shardKeys, SHARD_COUNT } from './helpers/matrix_cases.js'

beforeAll(setupMatrixFixture, 120000)
afterAll(cleanupMatrixFixture)
afterEach(afterEachHeartbeatMitigation)

describe('built bundle command matrix coverage', () => {
  it('every registered command has a matrix case (and vice versa)', () => {
    const registered = new Set(allCommandNames())
    const covered = new Set(Object.keys(cases))
    const missing = [...registered].filter((n) => !covered.has(n)).sort()
    const extra = [...covered].filter((n) => !registered.has(n)).sort()
    expect(missing, 'registered commands with no matrix case').toEqual([])
    expect(extra, 'matrix cases for commands that are not registered').toEqual([])
  })

  it('shard union covers every matrix case exactly once', () => {
    const allKeys = Object.keys(cases).sort()
    const shardSlices = Array.from({ length: SHARD_COUNT }, (_, i) => shardKeys(i))
    const union = shardSlices.flat().sort()
    expect(union.length, 'union of all shard slices must equal case count').toBe(allKeys.length)
    expect(union).toEqual(allKeys)
    for (const slice of shardSlices) expect(slice.length).toBeGreaterThan(0)
  })
})

describe('built bundle command matrix (shard 1/4)', () => {
  for (const name of shardKeys(0)) {
    it(`'${name}' produces correct output from the built bundle`, cases[name], 120000)
  }
})
