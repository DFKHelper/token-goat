import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type * as NodeModule from 'node:module'

// version.ts has no direct test file. Its two branches:
//  - typeof __TG_VERSION__ === 'string': only true in the esbuild-built bundle
//    (exercised by the built-bundle command matrix's --version cases, not here).
//  - the runtime fallback (require('../package.json')), which is what every
//    vitest run actually takes since __TG_VERSION__ is undefined under tsx/vitest.
// Neither the fallback's `pkg.version ?? '0.0.0'` default, nor VERSION's equality
// with the real package.json version field, had ever been directly asserted.
describe('VERSION', () => {
  afterEach(() => {
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  it('resolves to the version field read from package.json at runtime', async () => {
    vi.resetModules()
    const { VERSION } = await import('../src/version.js')

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
      version: string
    }

    expect(VERSION).toBe(pkg.version)
  })

  it('falls back to 0.0.0 when the resolved package.json has no version field', async () => {
    vi.doMock('node:module', async (importOriginal) => {
      const original = await importOriginal<typeof NodeModule>()
      return {
        ...original,
        createRequire: (...args: Parameters<typeof original.createRequire>) => {
          const realRequire = original.createRequire(...args)
          const fakeRequire = ((id: string) => {
            if (id === '../package.json') {
              return {}
            }
            return realRequire(id)
          }) as unknown as ReturnType<typeof original.createRequire>
          return fakeRequire
        },
      }
    })
    vi.resetModules()

    const { VERSION } = await import('../src/version.js')

    expect(VERSION).toBe('0.0.0')
  })
})
