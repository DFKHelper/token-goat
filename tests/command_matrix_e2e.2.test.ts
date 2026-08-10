/**
 * Built-bundle command matrix, shard 2 of 4 (pre-push / CI tier — slow). See
 * tests/command_matrix_e2e.1.test.ts for the full doc comment (fixture, coverage gate) and
 * tests/helpers/matrix_cases.ts for the shared fixture/case table this shard runs a slice of.
 */

import { afterAll, afterEach, beforeAll, describe, it } from 'vitest'

import { afterEachHeartbeatMitigation, cases, cleanupMatrixFixture, setupMatrixFixture, shardKeys } from './helpers/matrix_cases.js'

beforeAll(setupMatrixFixture, 120000)
afterAll(cleanupMatrixFixture)
afterEach(afterEachHeartbeatMitigation)

describe('built bundle command matrix (shard 2/4)', () => {
  for (const name of shardKeys(1)) {
    it(`'${name}' produces correct output from the built bundle`, cases[name], 120000)
  }
})
