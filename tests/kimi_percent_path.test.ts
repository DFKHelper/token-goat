import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NodeOs from 'node:os'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return { ...original, homedir: vi.fn((...a: Parameters<typeof original.homedir>) => original.homedir(...a)) }
})

import { HookCommandRewriteError } from '../src/hook_guard.js'
import {
  installKimi,
  isKimiInstalled,
  kimiConfigPath,
  kimiHookCommandFor,
  wiredKimiHookWords,
} from '../src/bridges/kimi_install.js'

// Provenance: HAND-DERIVED. cmd.exe expands %NAME% inside double quotes (hook_guard.ts, the cmd form), so a
// home directory holding a percent sign cannot be written into a Kimi hook command on Windows.
const REAL_PLATFORM = process.platform
let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-kimi-pct-'))
  const home = path.join(tmp, '100%done')
  fs.mkdirSync(home)
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(home)
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Kimi on Windows with a percent sign in the home path', () => {
  it('the command builder refuses with a one-line message naming the percent sign', () => {
    let refused: unknown
    try {
      kimiHookCommandFor(path.join(os.homedir(), '.kimi', 'hooks', 'token-goat-shim.cjs'), 'pre_tool_use')
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(HookCommandRewriteError)
    expect((refused as Error).message).toContain('percent sign')
    expect((refused as Error).message).not.toContain('\n')
  })

  it('the install refuses before writing anything', () => {
    expect(() => installKimi()).toThrow(HookCommandRewriteError)
    expect(fs.existsSync(path.join(os.homedir(), '.kimi'))).toBe(false)
  })

  it('the status reads report not installed and no wired hooks, never a throw', () => {
    expect(isKimiInstalled()).toBe(false)
    expect(wiredKimiHookWords()).toEqual([])
  })

  it('the status reads with a token-goat hook in the config report it out of date, never a throw', () => {
    const shim = path.join(os.homedir(), '.kimi', 'hooks', 'token-goat-shim.cjs')
    fs.mkdirSync(path.dirname(kimiConfigPath()), { recursive: true })
    fs.writeFileSync(
      kimiConfigPath(),
      `[[hooks]]\nevent = "PreToolUse"\ncommand = ${JSON.stringify(`token-goat hook pre_tool_use ${shim}`)}\n`,
    )
    expect(isKimiInstalled()).toBe(false)
    const wired = wiredKimiHookWords()
    expect(wired).toHaveLength(1)
    expect(wired[0]!.current).toBe(false)
  })
})
