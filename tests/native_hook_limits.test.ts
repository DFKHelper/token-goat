import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SHIM_FALLBACK_TIMEOUT_MS } from '../src/bridges/shim_common.js'

// FORMAT-DERIVED: tg-hook embeds hook_limits.json (fallback.rs::harness_limit); Node's side is the shim table.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIMITS_FILE = path.join(ROOT, 'native', 'tg-hook', 'hook_limits.json')
const limits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')) as Record<string, number>

// tg-hook spells the Copilot CLI harness `copilot_cli`; the shims call the same limit `copilot`.
const NATIVE_TO_SHIM: Record<string, keyof typeof SHIM_FALLBACK_TIMEOUT_MS> = { copilot_cli: 'copilot' }
const shimName = (native: string): string => NATIVE_TO_SHIM[native] ?? native

// Installer harness names: NativeHarness (src/native_hook.ts:19) plus vscode, aliased in fallback.rs.
const INSTALLER_NATIVE_NAMES = ['claudecode', 'codex', 'grok', 'kimi', 'copilot_cli', 'vscode']
const RUST_FALLBACK = path.join(ROOT, 'native', 'tg-hook', 'src', 'fallback.rs')

// The aliases are read from the `"name" => "target"` arms of harness_limit, so the Rust source is the only copy.
function rustHarnessAliases(): Record<string, string> {
  const src = fs.readFileSync(RUST_FALLBACK, 'utf8')
  const start = src.indexOf('pub fn harness_limit')
  expect(start, 'pub fn harness_limit in fallback.rs').toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n}\n', start))
  return Object.fromEntries([...body.matchAll(/"(\w+)" => "(\w+)"/g)].map((m) => [m[1], m[2]]))
}

describe('the native client limit table', () => {
  it('names every harness of the shim table with the same milliseconds', () => {
    const asShim = Object.fromEntries(Object.entries(limits).map(([name, ms]) => [shimName(name), ms]))
    expect(asShim).toEqual({ ...SHIM_FALLBACK_TIMEOUT_MS })
  })

  it('holds positive integers only, so a bad entry cannot become a zero or negative limit', () => {
    for (const [name, ms] of Object.entries(limits)) {
      expect(Number.isInteger(ms) && ms > 0, `${name}: ${String(ms)}`).toBe(true)
    }
  })

  it('gives every harness an installer passes a named limit or an alias to one', () => {
    const aliases = rustHarnessAliases()
    for (const name of INSTALLER_NATIVE_NAMES) {
      const key = aliases[name] ?? name
      expect(Object.keys(limits), `${name} -> ${key}`).toContain(key)
    }
  })

  it('has a smallest limit equal to the shim table smallest, which an unknown harness gets', () => {
    expect(Math.min(...Object.values(limits))).toBe(Math.min(...Object.values(SHIM_FALLBACK_TIMEOUT_MS)))
  })
})
