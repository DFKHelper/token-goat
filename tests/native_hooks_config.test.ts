/** Precedence of the switch that decides whether `install` wires the native hook client: TOKEN_GOAT_NATIVE_HOOKS over `hooks.native` in the user's global config over the `auto` default, with a project's `.token-goat.toml` never consulted (the key is in PROJECT_LOCKED_KEYS). Provenance: HAND-DERIVED from the rule as documented in src/config.ts (nativeHooksEnabled) and docs/install.md; every value is written by this test, none is read off the code. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FALSY_ENV_VALUES, TRUTHY_ENV_VALUES } from '../src/env.js'
import { invalidateConfigCache, lastProjectConfigLockedKeys, loadConfig, nativeHooksEnabled, resolveConfigKeyLayer } from '../src/config.js'
import { configPath } from '../src/constants.js'

const ENV = 'TOKEN_GOAT_NATIVE_HOOKS'
// Written out rather than spread from src/env.ts so a table below can never register zero cases; the first test pins each list to the set the loader actually accepts, so a new spelling there fails here instead of going untested.
const FALSY_SPELLINGS = ['0', 'false', 'no', 'off']
const TRUTHY_SPELLINGS = ['1', 'true', 'yes', 'on']
const EVERY_SPELLING = [...FALSY_SPELLINGS, ...TRUTHY_SPELLINGS, ' OFF ']
let saved: string | undefined
let savedConfig: string | undefined
let root: string

function writeGlobal(text: string): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), text)
  invalidateConfigCache()
}

beforeEach(() => {
  // The global config this writes must be the isolated one tests/setup/isolate-home.ts set up, never a real one.
  expect(path.resolve(configPath()).startsWith(path.resolve(os.tmpdir()))).toBe(true)
  saved = process.env[ENV]
  savedConfig = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf8') : undefined
  delete process.env[ENV]
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-cfg-'))
  invalidateConfigCache()
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
  if (savedConfig === undefined) fs.rmSync(configPath(), { force: true })
  else fs.writeFileSync(configPath(), savedConfig)
  fs.rmSync(root, { recursive: true, force: true })
  invalidateConfigCache()
})

describe('hooks.native precedence', () => {
  it('exercises every spelling the loader accepts as on and as off', () => {
    expect(new Set(FALSY_SPELLINGS)).toEqual(FALSY_ENV_VALUES)
    expect(new Set(TRUTHY_SPELLINGS)).toEqual(TRUTHY_ENV_VALUES)
  })

  it('defaults to auto with neither the variable nor the config set', () => {
    fs.rmSync(configPath(), { force: true })
    invalidateConfigCache()
    expect(loadConfig().hooks.native).toBe('auto')
    expect(nativeHooksEnabled()).toBe(true)
  })

  it('reads off from the global config', () => {
    writeGlobal('[hooks]\nnative = "off"\n')
    expect(loadConfig().hooks.native).toBe('off')
    expect(nativeHooksEnabled()).toBe(false)
  })

  it('keeps the default for a value that is neither auto nor off', () => {
    writeGlobal('[hooks]\nnative = "sometimes"\n')
    expect(loadConfig().hooks.native).toBe('auto')
    expect(nativeHooksEnabled()).toBe(true)
  })

  it.each(FALSY_SPELLINGS.map((v) => [v]))('the variable set to %j turns it off over a config of auto', (value) => {
    writeGlobal('[hooks]\nnative = "auto"\n')
    process.env[ENV] = value
    expect(nativeHooksEnabled()).toBe(false)
    expect(loadConfig().hooks.native).toBe('off')
  })

  it.each(TRUTHY_SPELLINGS.map((v) => [v]))('the variable set to %j turns it back on over a config of off', (value) => {
    writeGlobal('[hooks]\nnative = "off"\n')
    process.env[ENV] = value
    expect(nativeHooksEnabled()).toBe(true)
    expect(loadConfig().hooks.native).toBe('auto')
  })

  it('an empty or unrecognised variable leaves the config in charge', () => {
    writeGlobal('[hooks]\nnative = "off"\n')
    for (const value of ['', '  ', 'maybe']) {
      process.env[ENV] = value
      expect(nativeHooksEnabled(), JSON.stringify(value)).toBe(false)
    }
  })

  // `config validate` judges an environment variable by the value it sets, and this one is spelled as a boolean over a two-mode key: judged by the key's type, `0` never equals `off`, and validate called the variable that had just switched native hooks off an ignored one.
  it.each(EVERY_SPELLING.map((v) => [v]))('config validate reads the variable set to %j as in effect, as the loader does', (value) => {
    writeGlobal('[hooks]\nnative = "auto"\n')
    process.env[ENV] = value
    const cfg = loadConfig() as unknown as Record<string, unknown>
    const state = resolveConfigKeyLayer('hooks.native', loadConfig().hooks.native, cfg, null)
    expect(state).toEqual({ layer: 'env', envVar: ENV })
  })

  it('config validate still reports a value the loader ignores', () => {
    writeGlobal('[hooks]\nnative = "off"\n')
    process.env[ENV] = 'maybe'
    const cfg = loadConfig() as unknown as Record<string, unknown>
    const state = resolveConfigKeyLayer('hooks.native', loadConfig().hooks.native, cfg, null)
    expect(state).toMatchObject({ layer: 'env-invalid', envVar: ENV, rawValue: 'maybe', effectiveValue: 'off' })
  })

  it("ignores a project's .token-goat.toml, which cannot decide what user-scope harness configs run", () => {
    writeGlobal('[hooks]\nnative = "auto"\n')
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[hooks]\nnative = "off"\nlatency_budget_ms = 900\n')
    const cfg = loadConfig(root)
    expect(cfg.hooks.native).toBe('auto')
    // Survival anchor: the rest of the project's [hooks] section still applies, so the lock dropped one key rather than the file.
    expect(cfg.hooks.latency_budget_ms).toBe(900)
    expect(lastProjectConfigLockedKeys()).toEqual(['hooks.native'])
    expect(nativeHooksEnabled()).toBe(true)
  })
})
