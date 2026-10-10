// Codex CLI reads its config from $CODEX_HOME, else ~/.codex. install, uninstall and doctor all resolve their paths through codexHomeDir(), so these tests drive install/uninstall with the variable set and look at where the files land. FORMAT-DERIVED from `find_codex_home` in https://github.com/openai/codex/blob/main/codex-rs/utils/home-dir/src/lib.rs ("can be specified by the `CODEX_HOME` environment variable. If not set, defaults to `~/.codex`"; the variable is filtered with `!val.is_empty()`, so only an empty value counts as unset).
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { codexAgentsPath, codexConfigPath, codexHomeDir, codexHookScriptPath, installCodex, isCodexInstalled, uninstallCodex } from '../src/bridges/codex_install.js'

let base: string
let userHome: string
let codexHome: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-home-'))
  userHome = path.join(base, 'user')
  codexHome = path.join(base, 'elsewhere')
  fs.mkdirSync(userHome)
  fs.mkdirSync(codexHome)
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(userHome)
})

afterEach(() => {
  delete process.env['CODEX_HOME']
  fs.rmSync(base, { recursive: true, force: true })
})

describe('Codex home resolution', () => {
  it('writes config, AGENTS.md and the shim under CODEX_HOME and nothing under ~/.codex', () => {
    process.env['CODEX_HOME'] = codexHome
    installCodex()
    for (const p of [codexConfigPath(), codexAgentsPath(), codexHookScriptPath()]) {
      expect(p.startsWith(codexHome + path.sep), p).toBe(true)
      expect(fs.existsSync(p), p).toBe(true)
    }
    expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
    expect(isCodexInstalled()).toBe(true)
  })

  it('uninstall removes what install wrote under CODEX_HOME', () => {
    process.env['CODEX_HOME'] = codexHome
    installCodex()
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true)
    uninstallCodex()
    expect(isCodexInstalled()).toBe(false)
    expect(fs.existsSync(codexHookScriptPath())).toBe(false)
  })

  it('falls back to ~/.codex when CODEX_HOME is unset or empty', () => {
    expect(codexHomeDir()).toBe(path.join(userHome, '.codex'))
    process.env['CODEX_HOME'] = ''
    expect(codexHomeDir()).toBe(path.join(userHome, '.codex'))
    installCodex()
    expect(fs.existsSync(path.join(userHome, '.codex', 'config.toml'))).toBe(true)
  })
})
