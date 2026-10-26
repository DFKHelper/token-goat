/** A bundle child spawned with no env inherits the sandboxed HOME and USERPROFILE from tests/setup/isolate-home.ts, never the developer's real home that the setup stashes as TG_REAL_HOME and TG_REAL_USERPROFILE. Provenance: HAND-DERIVED from tests/helpers/bundle.ts (runBundle passes env: undefined, which Node resolves to the parent's process.env) and tests/setup/isolate-home.ts (process.env.HOME and USERPROFILE assigned the sandbox). */
import { describe, expect, it } from 'vitest'

import { runBundle } from '../helpers/bundle.js'

const PAIRS = [
  ['HOME', 'TG_REAL_HOME'],
  ['USERPROFILE', 'TG_REAL_USERPROFILE'],
] as const

describe('runBundle with no env hands the child the sandboxed home', () => {
  it('runs the bundle under the inherited env and the inherited home differs from the real one', () => {
    const res = runBundle(['config', 'validate'])
    expect(res.status, res.stderr).toBe(0)
    const stashed = PAIRS.filter(([, real]) => process.env[real])
    expect(stashed.length, 'isolate-home must stash at least one real home').toBeGreaterThan(0)
    for (const [inherited, real] of stashed) {
      expect(process.env[inherited], `child inherits ${inherited}`).not.toBe(process.env[real])
    }
  })
})
