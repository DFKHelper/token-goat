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
  piEntrySidecarPath,
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

describe('installPi entry-path sidecar (PATH-hardening for the extension\'s inner token-goat call)', () => {
  it('writes token-goat-entry.json next to the extension file, containing the running entry (process.argv[1])', () => {
    expect(process.argv[1]).toBeDefined()
    const result = installPi()
    const sidecarPath = piEntrySidecarPath()
    expect(sidecarPath).toBe(path.join(path.dirname(result.extensionPath), 'token-goat-entry.json'))
    expect(fs.existsSync(sidecarPath)).toBe(true)
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as { entryPath: string }
    expect(sidecar.entryPath).toBe(process.argv[1])
  })

  it('writes the sidecar for a --local install too, next to the local extension path', () => {
    const result = installPi({ local: true })
    const sidecarPath = piEntrySidecarPath({ local: true })
    expect(sidecarPath).toBe(path.join(path.dirname(result.extensionPath), 'token-goat-entry.json'))
    expect(fs.existsSync(sidecarPath)).toBe(true)
  })

  it('uninstallPi removes the sidecar along with the extension file', () => {
    installPi()
    expect(fs.existsSync(piEntrySidecarPath())).toBe(true)
    uninstallPi()
    expect(fs.existsSync(piEntrySidecarPath())).toBe(false)
    expect(fs.existsSync(piGlobalExtensionPath())).toBe(false)
  })

  it('uninstallPi does not throw when no sidecar was ever written (an install predating this fix)', () => {
    installPi()
    fs.unlinkSync(piEntrySidecarPath())
    expect(() => uninstallPi()).not.toThrow()
    expect(fs.existsSync(piGlobalExtensionPath())).toBe(false)
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

  // Regression: uninstallPi used to require the caller to pass the exact scope
  // opts it was installed with -- since the CLI's --pi uninstall always forced
  // { local: opts.local === true } (never left undefined), a plain
  // `token-goat uninstall --pi` (no --local) could never clean up a --local
  // install; the user had to remember to also pass --local, or it silently
  // survived. uninstallPi() with no explicit local now cleans up wherever the
  // extension actually is, both scopes at once.
  it('uninstallPi() with no explicit scope removes both a global and a local install', () => {
    const globalResult = installPi()
    const localResult = installPi({ local: true })
    expect(uninstallPi()).toBe(true)
    expect(fs.existsSync(globalResult.extensionPath)).toBe(false)
    expect(fs.existsSync(localResult.extensionPath)).toBe(false)
  })

  it('uninstallPi({ local: true }) narrows removal to the local scope, leaving a global install untouched', () => {
    const globalResult = installPi()
    installPi({ local: true })
    uninstallPi({ local: true })
    expect(fs.existsSync(globalResult.extensionPath)).toBe(true)
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

  it('sets TOKEN_GOAT_HARNESS_OVERRIDE=pi so detectHarness() resolves correctly, since pi has no ambient env-var signal of its own', () => {
    expect(PI_EXTENSION_SCRIPT).toMatch(/TOKEN_GOAT_HARNESS_OVERRIDE:\s*"pi"/)
  })

  it('excludes Glob from PRE_HOOK_TOOLS, since no pre_tool_use handler exists for it', () => {
    const match = /const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(PI_EXTENSION_SCRIPT)
    expect(match).not.toBeNull()
    expect(match?.[1]).not.toMatch(/"Glob"/)
  })

  // Regression: the tool_result handler built its post_tool_use payload with
  // session_id/tool_name/tool_input/cwd but never forwarded tool_response, so
  // extractReadOutput (src/hooks_read.ts) and hooks_bash's truncation-marker
  // detection always saw empty output for files/commands run through pi --
  // silently disabling confirmed re-read denial despite this module's header
  // comment listing it as a working feature.
  // Regression: callHook's inner spawnSync("token-goat", [...]) depends on PATH
  // resolution -- the npm global bin being on whatever PATH pi-coding-agent's own
  // process inherits -- the same single-point-of-failure class fixed for the
  // Codex/Copilot CLI bridges' hook commands. resolveEntryPath() reads an
  // install-time sidecar (see installPi in pi_install.ts) so callHook can invoke
  // the real token-goat entry directly via process.execPath instead.
  it('reads the baked entry path via resolveEntryPath() before falling back to a bare PATH-resolved "token-goat"', () => {
    expect(PI_EXTENSION_SCRIPT).toMatch(/function resolveEntryPath\(\)/)
    expect(PI_EXTENSION_SCRIPT).toMatch(/token-goat-entry\.json/)
    // The spawnSync fallback now lives in callHookViaSpawn -- callHook itself tries the
    // in-process hook lib (resolveRelayInProcess) first, only calling callHookViaSpawn
    // when that's unavailable. See the "in-process hook call" describe block below for
    // coverage of the in-process path taking priority and never spawning a process.
    const callHookMatch = /function callHookViaSpawn\([\s\S]*?\n\}/.exec(PI_EXTENSION_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    expect(body).toMatch(/resolveEntryPath\(\)/)
    expect(body).toMatch(/spawnSync\(process\.execPath, \[entryPath, "hook", event\]/)
    expect(body).toMatch(/spawnSync\('token-goat hook '/)
  })

  it('fallback spawnSync uses shell:true so it resolves .cmd shims on Windows', () => {
    // Regression: pi.ts's fallback branch (when resolveEntryPath returns undefined)
    // ran spawnSync("token-goat", ["hook", event]) without shell:true, causing ENOENT
    // on Windows where "token-goat" is a .cmd shim and Node doesn't resolve PATHEXT
    // extensions without shell:true. This made every hook call silently fail when the
    // entry-path sidecar was missing/stale, defeating the whole PATH-hardening this
    // commit added. Fix: use string concatenation + shell:true like the Codex/Copilot
    // CLI bridges already do.
    const callHookMatch = /function callHookViaSpawn\([\s\S]*?\n\}/.exec(PI_EXTENSION_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    // Find the fallback spawnSync block (the : branch of a ternary)
    const fallbackMatch = /: spawnSync\('token-goat hook '[\s\S]*?\}\);/.exec(body)
    expect(fallbackMatch).not.toBeNull()
    const fallbackBlock = fallbackMatch?.[0] ?? ''
    expect(fallbackBlock).toContain('shell: true')
    expect(fallbackBlock).toContain('token-goat hook')
  })

  // Regression: callHook used to spawnSync a whole second node process
  // (`token-goat hook <event>`) for every single tool call in this long-lived agent
  // process. It now tries an in-process import() of the sibling dist/token-goat-hook.mjs
  // hook lib first, falling back to callHookViaSpawn only when that's unavailable.
  it('tries the in-process hook lib (resolveRelayInProcess) before ever calling callHookViaSpawn', () => {
    expect(PI_EXTENSION_SCRIPT).toMatch(/function resolveRelayInProcess\(\)/)
    expect(PI_EXTENSION_SCRIPT).toMatch(/token-goat-hook\.mjs/)
    expect(PI_EXTENSION_SCRIPT).toMatch(/await import\(pathToFileURL\(hookLibPath\)\.href\)/)
    const callHookMatch = /async function callHook\([\s\S]*?\n\}/.exec(PI_EXTENSION_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    const inProcessIndex = body.indexOf('resolveRelayInProcess')
    const spawnFallbackIndex = body.indexOf('callHookViaSpawn')
    expect(inProcessIndex).toBeGreaterThanOrEqual(0)
    expect(spawnFallbackIndex).toBeGreaterThan(inProcessIndex)
  })

  it("forwards tool_result's real output (event.content) as tool_response.output in the post_tool_use payload, mirroring opencode.ts's tool_response shape", () => {
    const match = /pi\.on\("tool_result",[\s\S]*?\n {2}\}\);/.exec(PI_EXTENSION_SCRIPT)
    expect(match).not.toBeNull()
    const handlerBody = match?.[0] ?? ''
    expect(handlerBody).toMatch(/tool_response/)
    expect(handlerBody).toMatch(/event\.content/)
  })
})
