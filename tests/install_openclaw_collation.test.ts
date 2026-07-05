import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'
import type * as UtilModule from '../src/util.js'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// installOpenclaw/uninstallOpenclaw/isOpenclawInstalled fold plugin-path membership
// checks via foldPath() for a case-insensitive-filesystem-correct comparison (Windows/
// macOS). Mirrors tests/memory_prune_collation.test.ts's approach: mock foldPath itself
// (not isCaseInsensitiveFs, since foldPath/isCaseInsensitiveFs call each other in-module
// and vi.mock can't intercept same-module calls) with a toggle, so both platform branches
// are exercised regardless of the host OS running this suite.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

let simulateCaseInsensitiveFs = false
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    foldPath: (p: string) => (simulateCaseInsensitiveFs ? p.toLowerCase() : p),
  }
})

const { installOpenclaw, isOpenclawInstalled, openclawConfigPath, openclawPluginPath, uninstallOpenclaw } =
  await import('../src/bridges/openclaw_install.js')
const { OPENCLAW_PLUGIN_SCRIPT } = await import('../src/bridges/openclaw.js')

let TMP: string

beforeEach(() => {
  simulateCaseInsensitiveFs = false
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-openclaw-collation-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function seedConfigWithUppercasedPath(): void {
  const configPath = openclawConfigPath()
  const pluginPath = openclawPluginPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true })
  fs.writeFileSync(pluginPath, OPENCLAW_PLUGIN_SCRIPT)
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginPath.toUpperCase()] },
        entries: { 'token-goat': { enabled: true } },
      },
    }),
  )
}

describe('openclaw plugin-path case-fold (simulated case-insensitive fs)', () => {
  it('isOpenclawInstalled recognizes an existing entry stored with different casing', () => {
    seedConfigWithUppercasedPath()
    simulateCaseInsensitiveFs = true
    expect(isOpenclawInstalled()).toBe(true)
  })

  it('installOpenclaw does not add a duplicate load-path entry for a differently-cased match', () => {
    seedConfigWithUppercasedPath()
    simulateCaseInsensitiveFs = true

    const result = installOpenclaw()
    expect(result.alreadyInstalled).toBe(true)

    const settings = JSON.parse(fs.readFileSync(openclawConfigPath(), 'utf8'))
    expect(settings.plugins.load.paths).toHaveLength(1)
  })

  it('uninstallOpenclaw removes a differently-cased load-path entry', () => {
    seedConfigWithUppercasedPath()
    simulateCaseInsensitiveFs = true

    expect(uninstallOpenclaw()).toBe(true)

    const settings = JSON.parse(fs.readFileSync(openclawConfigPath(), 'utf8'))
    expect(settings.plugins).toBeUndefined()
  })
})

describe('openclaw plugin-path case-fold (simulated case-sensitive fs)', () => {
  it('treats a differently-cased load-path entry as a distinct path, proving the mock actually flips behavior', () => {
    seedConfigWithUppercasedPath()
    simulateCaseInsensitiveFs = false

    expect(isOpenclawInstalled()).toBe(false)

    const result = installOpenclaw()
    expect(result.alreadyInstalled).toBe(false)

    const settings = JSON.parse(fs.readFileSync(openclawConfigPath(), 'utf8'))
    expect(settings.plugins.load.paths).toHaveLength(2)
  })
})
