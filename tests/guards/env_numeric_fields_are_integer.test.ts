/**
 * Guard: every numeric config field reachable from an environment variable is integer-bounded.
 *
 * config.ts's coerceEnvLike compares "what the variable asked for" against "what took effect" so
 * `config get`/`list`/`set`/`validate` can tell a clamped env value from one that is in effect.
 * To do that it has to reproduce the coercion _buildConfig applies, and for numbers it assumes
 * envInt's integer parse -- which is true today because every numeric key in
 * CONFIG_KEY_ENV_OVERRIDES is integer-bounded.
 *
 * If a float-bounded field ever gains an env override, that assumption silently breaks in the
 * worst direction: a perfectly valid `1.5` fails the integer regex, gets classified 'unusable',
 * and the user is told their value is not in effect when it is. This fails instead, at the moment
 * the override is added rather than the moment someone sets it.
 */

import { describe, expect, it } from 'vitest'
import { CONFIG_KEY_ENV_OVERRIDES, numericFieldBounds } from '../../src/config.js'

describe('env-overridable numeric config fields', () => {
  it('are all integer-bounded, matching coerceEnvLike\'s envInt assumption', () => {
    const floatBounded: string[] = []
    for (const key of Object.keys(CONFIG_KEY_ENV_OVERRIDES)) {
      const bounds = numericFieldBounds(key)
      if (bounds === undefined) continue
      if (!Number.isInteger(bounds.min) || !Number.isInteger(bounds.max)) floatBounded.push(key)
    }
    expect(floatBounded).toEqual([])
  })

  it('actually inspects a non-empty set, so the assertion above cannot pass vacuously', () => {
    // Without this, deleting every numeric env override -- or breaking numericFieldBounds so it
    // returns undefined for everything -- would leave the guard above green while checking nothing.
    const numeric = Object.keys(CONFIG_KEY_ENV_OVERRIDES).filter((k) => numericFieldBounds(k) !== undefined)
    expect(numeric.length).toBeGreaterThan(5)
  })
})
