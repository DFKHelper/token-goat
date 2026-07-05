import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.pi/` (mirrors the pattern in install_codex.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  installPi,
  isPiInstalled,
  piGlobalExtensionPath,
  piLocalExtensionPath,
  uninstallPi,
} from '../src/bridges/pi_install.js'
import { PI_EXTENSION_SCRIPT } from '../src/bridges/pi.js'
import { HOOK_EVENTS } from '../src/types.js'

let TMP: string
let origCwd: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pi-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(path.join(TMP, 'home'))

  origCwd = process.cwd()
  // Project-local install resolves against process.cwd() (mirrors install.test.ts's
  // handling of installHooks('project')); chdir into an isolated project dir so
  // --local writes under {TMP}/project/.pi/extensions, never this repo's own .pi/.
  fs.mkdirSync(path.join(TMP, 'project'), { recursive: true })
  process.chdir(path.join(TMP, 'project'))
})

afterEach(() => {
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installPi (global)', () => {
  it('writes the extension file with the exact embedded template on a fresh install', () => {
    const result = installPi()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.extensionPath).toBe(piGlobalExtensionPath())
    expect(fs.existsSync(result.extensionPath)).toBe(true)
    expect(fs.readFileSync(result.extensionPath, 'utf8')).toBe(PI_EXTENSION_SCRIPT)
    expect(isPiInstalled()).toBe(true)
  })

  it('is idempotent: a second install reports alreadyInstalled and does not alter the file', () => {
    installPi()
    const second = installPi()
    expect(second.alreadyInstalled).toBe(true)
    expect(fs.readFileSync(second.extensionPath, 'utf8')).toBe(PI_EXTENSION_SCRIPT)
  })

  it('overwrites a hand-modified file wholesale instead of merging or warning', () => {
    // Design decision (documented in pi_install.ts): the extension is a
    // single generated artifact with no merge target, analogous to Codex's
    // shim script -- install always reconciles it to the current template on
    // any content difference, with no .bak and no confirmation prompt.
    const p = piGlobalExtensionPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '// a user hand-edited this file\nexport default function () {}\n')

    const result = installPi()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe(PI_EXTENSION_SCRIPT)
    // No backup file left behind for this single-file artifact.
    const siblings = fs.readdirSync(path.dirname(p))
    expect(siblings.some((f) => f.includes('.bak'))).toBe(false)
  })
})

describe('installPi --local', () => {
  it('writes to the project-local path instead of the global one', () => {
    const result = installPi({ local: true })
    expect(result.alreadyInstalled).toBe(false)
    expect(result.extensionPath).toBe(piLocalExtensionPath())
    expect(result.extensionPath).toBe(path.join(process.cwd(), '.pi', 'extensions', 'token-goat.ts'))
    expect(fs.existsSync(piGlobalExtensionPath())).toBe(false)
    expect(fs.readFileSync(result.extensionPath, 'utf8')).toBe(PI_EXTENSION_SCRIPT)
  })

  it('is idempotent for the local path too', () => {
    installPi({ local: true })
    const second = installPi({ local: true })
    expect(second.alreadyInstalled).toBe(true)
  })

  it('does not collide with a global install in the same run', () => {
    const globalResult = installPi()
    const localResult = installPi({ local: true })
    expect(globalResult.extensionPath).not.toBe(localResult.extensionPath)
    expect(fs.existsSync(globalResult.extensionPath)).toBe(true)
    expect(fs.existsSync(localResult.extensionPath)).toBe(true)
  })
})

describe('isPiInstalled / uninstallPi', () => {
  it('isPiInstalled is false before install, true after (global)', () => {
    expect(isPiInstalled()).toBe(false)
    installPi()
    expect(isPiInstalled()).toBe(true)
  })

  it('isPiInstalled is false before install, true after (local)', () => {
    expect(isPiInstalled({ local: true })).toBe(false)
    installPi({ local: true })
    expect(isPiInstalled({ local: true })).toBe(true)
  })

  it('uninstallPi removes the global file and returns true', () => {
    const result = installPi()
    expect(uninstallPi()).toBe(true)
    expect(fs.existsSync(result.extensionPath)).toBe(false)
    expect(isPiInstalled()).toBe(false)
  })

  it('uninstallPi removes the local file and returns true', () => {
    const result = installPi({ local: true })
    expect(uninstallPi({ local: true })).toBe(true)
    expect(fs.existsSync(result.extensionPath)).toBe(false)
    expect(isPiInstalled({ local: true })).toBe(false)
  })

  it('uninstallPi returns false when nothing is installed (global)', () => {
    expect(uninstallPi()).toBe(false)
  })

  it('uninstallPi returns false when nothing is installed (local)', () => {
    expect(uninstallPi({ local: true })).toBe(false)
  })

  it('uninstalling the global scope leaves a local install untouched', () => {
    const localResult = installPi({ local: true })
    installPi()
    uninstallPi()
    expect(fs.existsSync(localResult.extensionPath)).toBe(true)
  })
})

// PI_EXTENSION_SCRIPT's file-writing/idempotency tests above (unlike this
// block) never exercised whether the embedded template actually speaks
// token-goat's real hook protocol. It once didn't: every callHook() call in
// the shipped template used invented per-tool-type event names ("pre-read",
// "post-bash", "session-start", "pre-compact") that don't exist in the real
// HOOK_EVENTS vocabulary, so relay() (src/relay.ts) silently no-op'd (`{}`)
// on every single one -- bash compression, re-read denial, image shrinking,
// post-edit indexing, and the compaction manifest were all completely inert
// once installed, despite every test in this file passing. This directly
// mirrors this project's own documented "injected-seam trap": the file gets
// written and byte-compared correctly, but nothing checks the content it
// ships actually reaches a real handler. See HOOK_EVENTS/isHookEventName's
// contract in src/types.ts / src/relay.ts.
describe('PI_EXTENSION_SCRIPT speaks the real hook protocol', () => {
  it('every callHook(...) event-name literal is a real HOOK_EVENTS member', () => {
    const calls = [...PI_EXTENSION_SCRIPT.matchAll(/callHook\("([^"]+)"/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const eventName of calls) {
      expect(HOOK_EVENTS as readonly string[]).toContain(eventName)
    }
  })

  it('parses the deny response from the real {decision:"block"} shape, not a Claude-Code-only hookSpecificOutput.permissionDecision shape', () => {
    expect(PI_EXTENSION_SCRIPT).toMatch(/resp\["decision"\]\s*===\s*"block"/)
    expect(PI_EXTENSION_SCRIPT).not.toMatch(/hso\["permissionDecision"\]\s*===\s*"deny"/)
  })

  it('reads rewriteInput\'s updatedInput from the real hookSpecificOutput-nested location', () => {
    expect(PI_EXTENSION_SCRIPT).toMatch(/hso\["updatedInput"\]/)
  })
})
