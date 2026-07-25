import { describe, expect, it, vi } from 'vitest'

import { createLazyModuleLoader } from '../src/lazy_module.js'

describe('createLazyModuleLoader', () => {
  it('resolves the loaded value on first call', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true })
    const getModule = createLazyModuleLoader(load, 'test-module')
    await expect(getModule()).resolves.toEqual({ ok: true })
  })

  it('calls load only once and caches the result across repeated calls (mutation-testing gap: the whole point of this factory is avoiding a re-import on every call)', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true })
    const getModule = createLazyModuleLoader(load, 'test-module')
    await getModule()
    await getModule()
    await getModule()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('never throws when load() rejects -- returns null instead', async () => {
    const load = vi.fn().mockRejectedValue(new Error('module not installed'))
    const getModule = createLazyModuleLoader(load, 'test-module')
    await expect(getModule()).resolves.toBeNull()
  })

  it('caches a failed load as null and does not retry on subsequent calls (mutation-testing gap: caching failure as `null` vs leaving cache `undefined` determines whether a broken optional dep gets retried forever)', async () => {
    const load = vi.fn().mockRejectedValue(new Error('module not installed'))
    const getModule = createLazyModuleLoader(load, 'test-module')
    await getModule()
    await getModule()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('writes the errorLabel and error to stderr on a failed load', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const load = vi.fn().mockRejectedValue(new Error('boom'))
    const getModule = createLazyModuleLoader(load, 'my-optional-dep')
    await getModule()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('my-optional-dep'))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('boom'))
    stderrSpy.mockRestore()
  })

  it('distinguishes a resolved falsy-but-defined value from an uncached state (mutation-testing gap: `cache !== undefined` must not collapse to a truthiness check, or a load that legitimately resolves to a falsy value would be re-imported every call)', async () => {
    const load = vi.fn().mockResolvedValue(0)
    const getModule = createLazyModuleLoader(load, 'test-module')
    await getModule()
    await getModule()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
