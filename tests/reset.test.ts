import { beforeEach, describe, expect, it } from 'vitest'

import { _clearResetRegistryForTesting, clearModuleCaches, registerReset } from '../src/reset.js'

describe('reset registry', () => {
  beforeEach(() => {
    _clearResetRegistryForTesting()
  })
  it('calls every registered reset function', () => {
    const calls: string[] = []
    registerReset(() => calls.push('a'))
    registerReset(() => calls.push('b'))
    registerReset(() => calls.push('c'))

    clearModuleCaches()

    expect(calls).toContain('a')
    expect(calls).toContain('b')
    expect(calls).toContain('c')
  })

  it('runs all resets even when one throws, then rethrows the error', () => {
    const calls: string[] = []
    registerReset(() => calls.push('before'))
    registerReset(() => {
      throw new Error('boom')
    })
    registerReset(() => calls.push('after'))

    expect(() => clearModuleCaches()).toThrow('boom')

    // The throwing reset must not block the ones registered after it.
    expect(calls).toContain('before')
    expect(calls).toContain('after')
  })

  it('aggregates multiple errors into an AggregateError', () => {
    registerReset(() => {
      throw new Error('first')
    })
    registerReset(() => {
      throw new Error('second')
    })

    let caught: unknown
    try {
      clearModuleCaches()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AggregateError)
    const agg = caught as AggregateError
    expect(agg.errors.length).toBe(2)
  })
})
