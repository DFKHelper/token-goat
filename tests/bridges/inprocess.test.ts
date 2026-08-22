/**
 * Regression coverage for the in-process hook call refactor (fixes the "double node
 * process spawn per hook event" issue): every bridge used to spawnSync a whole second
 * `token-goat hook <event>` node process for each hook call. They now try an in-process
 * `import()` of the sibling `dist/token-goat-hook.mjs` hook library first
 * (src/hook_lib.ts -> relayInProcess), falling back to the old spawnSync path only when
 * that's unavailable.
 *
 * Each test here proves BOTH halves at once, against the real built bundle:
 *   1. zero-spawn: the spawnSync fallback target is "poisoned" (writes a marker file if
 *      ever invoked) and the test asserts that marker is never created.
 *   2. correct output: the response returned is a real hook decision -- a deny produced
 *      by the actual session-state-backed "already read this manifest file" dedup logic
 *      in hooks_read.ts, not a stub -- proving the in-process call really reached the
 *      real hook registry and that session state persists correctly across two calls.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../../src/bridges/codex.js'
import { OPENCLAW_PLUGIN_SCRIPT } from '../../src/bridges/openclaw.js'
import { OPENCODE_PLUGIN_SCRIPT } from '../../src/bridges/opencode.js'
import { PI_EXTENSION_SCRIPT } from '../../src/bridges/pi.js'
import { expandShortPath } from '../../src/paths.js'
import { HOOK_BUNDLE, ROOT } from '../helpers/bundle.js'

const tempDirs: string[] = []
let sharedHookFixture: { entryPath: string; markerPath: string; dir: string } | undefined

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(() => {
  if (sharedHookFixture) rmSync(sharedHookFixture.dir, { recursive: true, force: true })
})

// %TEMP% can be pinned to its Windows 8.3 short form (e.g. `RUNNER~1`), which every
// os.tmpdir()-based dir inherits. Vitest's Vite-backed module loader mishandles a `~` in a
// dynamic import() URL (surfaces as a "Failed to load url ...RUNNER%7E1..." resolution
// error), so expand to the long form before this dir is ever handed to pathToFileURL.
function mkIsolated(): string {
  const raw = mkdtempSync(join(tmpdir(), 'tg-inprocess-test-'))
  const dir = expandShortPath(raw.replace(/\\/g, '/'))
  tempDirs.push(dir)
  return dir
}

/**
 * Sets up a directory containing (a) a "poisoned" fake entry script that writes a marker
 * file if ever spawned (proving the spawnSync fallback fired, if the marker appears) and
 * (b) a real copy of dist/token-goat-hook.mjs alongside it, so a bridge's
 * `path.join(path.dirname(entryPath), 'token-goat-hook.mjs')` sibling lookup finds a
 * genuine, working hook library instead of a stub.
 */
function setupPoisonedEntryWithRealHookLib(_cwd: string): { entryPath: string; markerPath: string } {
  if (sharedHookFixture === undefined) {
    // Same 8.3 short-form hazard mkIsolated() guards against, and this dir is the one actually handed to pathToFileURL below -- expanding it there but not here left `RUNNER~1` intact on GitHub's Windows runners, where it URL-encoded to RUNNER%7E1 and the hook library failed to load for the whole file.
    const dir = expandShortPath(mkdtempSync(join(tmpdir(), 'tg-inprocess-hook-')).replace(/\\/g, '/'))
    const entryPath = join(dir, 'poisoned-entry.js')
    const markerPath = join(dir, 'SPAWNED_MARKER.txt')
    const markerLiteral = JSON.stringify(markerPath)
    writeFileSync(
      entryPath,
      `require('fs').writeFileSync(${markerLiteral}, 'spawned')\nprocess.stdout.write('{}')\n`,
      'utf8',
    )
    // Enforce the expansion above rather than trusting it: a surviving `~` segment does not fail here, it fails much later as an opaque "Failed to load url ...%7E1..." collection error for the entire file.
    if (/~\d/.test(dir)) throw new Error(`hook fixture dir still holds an 8.3 short name: ${dir}`)
    copyFileSync(HOOK_BUNDLE, join(dir, 'token-goat-hook.mjs'))
    // The hook bundle is code-split (see esbuild.config.mjs), so the entry is a stub that imports
    // sibling chunks by relative path -- copying it alone yields a file that throws on import. The
    // chunks are shared with the CLI entry and carry its prefix, so copy the whole set: which of
    // them this entry reaches is esbuild's business, not something to hard-code here.
    const distDir = dirname(HOOK_BUNDLE)
    for (const chunk of readdirSync(distDir).filter((f) => f.startsWith('token-goat-chunk-'))) {
      copyFileSync(join(distDir, chunk), join(dir, chunk))
    }
    // token-goat-hook.mjs bundles everything except its native/optional deps
    // (better-sqlite3, sqlite-vec, tree-sitter*, see esbuild.config.mjs's `external` list),
    // which it resolves at runtime via ordinary Node module resolution from its own
    // directory. In the real install that directory (dist/) sits inside
    // node_modules/token-goat/, with those deps reachable as node_modules siblings a few
    // levels up. This isolated temp dir has no such ancestry, so link one in.
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction')
    sharedHookFixture = { dir, entryPath, markerPath }
  }
  rmSync(sharedHookFixture.markerPath, { force: true })
  return sharedHookFixture
}

/**
 * Writes a `.env` fixture into `cwd` and returns its path. `.env` files get real
 * session-state-backed re-read denial in hooks_read.ts (deny after the first read,
 * unconditionally -- unlike package.json's manifest hint, which never denies, or the
 * generic manifest/tsconfig branches, which return a *different context hint* rather than
 * a hard deny on re-read). It's the cleanest fixture for proving the in-process hook call
 * really reached the real, session-persisted hook registry logic: pass-through on the
 * first call, `{decision:"block"}` on the second.
 */
function makeEnvFixture(cwd: string): string {
  const envPath = join(cwd, '.env')
  writeFileSync(envPath, 'FOO=bar\n', 'utf8')
  return envPath
}

// Preload the shared hook library during collection so a cold 3.2 MB dynamic import cannot
// consume an async test's 5s watchdog under full-suite load; bridge imports then hit this URL's
// module cache.
setupPoisonedEntryWithRealHookLib('')
await import(pathToFileURL(join(sharedHookFixture!.dir, 'token-goat-hook.mjs')).href)

describe('codex/claude code shims: in-process hook call replaces the second node spawn', () => {
  describe.each([
    ['CODEX_HOOK_SCRIPT', CODEX_HOOK_SCRIPT],
    ['CLAUDECODE_HOOK_SCRIPT', CLAUDECODE_HOOK_SCRIPT],
  ])('%s', (_name, script) => {
    it('serves a real hook decision via the in-process hook lib without ever spawning the poisoned fallback entry', () => {
      const cwd = mkIsolated()
      const { entryPath, markerPath } = setupPoisonedEntryWithRealHookLib(cwd)
      const envPath = makeEnvFixture(cwd)
      const scriptPath = join(cwd, 'shim.js')
      writeFileSync(scriptPath, script, 'utf8')
      const sessionId = 'inprocess-test-' + Math.random().toString(36).slice(2)

      const payload = JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: envPath },
        session_id: sessionId,
      })

      // First read: passes through, and records the read against session state
      // (persisted to disk under TOKEN_GOAT_HOME).
      const first = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
        cwd,
        input: payload,
        encoding: 'utf8',
        timeout: 15000,
      })
      expect(first.status).toBe(0)
      const firstParsed = JSON.parse(first.stdout || '{}')
      expect(firstParsed.decision).not.toBe('block')

      // Second read of the same .env file, same session: real session-state-backed
      // re-read dedup in hooks_read.ts denies it outright.
      const second = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
        cwd,
        input: payload,
        encoding: 'utf8',
        timeout: 15000,
      })
      expect(second.status).toBe(0)
      const secondParsed = JSON.parse(second.stdout || '{}')
      expect(secondParsed.decision).toBe('block')
      expect(secondParsed.reason).toContain('already read')

      // The poisoned fallback entry was never spawned for either call.
      expect(existsSync(markerPath)).toBe(false)
    })
  })
})

describe('opencode plugin: in-process hook call replaces the second node spawn', () => {
  it('serves a real hook decision via the in-process hook lib without ever spawning the poisoned fallback entry', async () => {
    const cwd = mkIsolated()
    const { entryPath, markerPath } = setupPoisonedEntryWithRealHookLib(cwd)
    writeFileSync(join(cwd, 'token-goat-entry.json'), JSON.stringify({ entryPath }), 'utf8')
    const pluginPath = join(cwd, 'plugin.mjs')
    writeFileSync(pluginPath, OPENCODE_PLUGIN_SCRIPT, 'utf8')

    const envPath = makeEnvFixture(cwd)
    const mod = (await import(pathToFileURL(pluginPath).href)) as {
      TokenGoatPlugin: (opts: { directory: string }) => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>>
    }
    const hooks = await mod.TokenGoatPlugin({ directory: cwd })
    const sessionID = 'inprocess-test-' + Math.random().toString(36).slice(2)

    const output1 = { args: { filePath: envPath }, output: '' }
    await hooks['tool.execute.before']!({ tool: 'read', sessionID, args: {} }, output1)
    // First read passes through without throwing (session state now records it).
    // The second read's deny (a throw) is the real, observable proof that the in-process
    // call reached the real, session-persisted hook registry logic.

    const output2 = { args: { filePath: envPath }, output: '' }
    await expect(
      hooks['tool.execute.before']!({ tool: 'read', sessionID, args: {} }, output2),
    ).rejects.toThrow(/already read/)

    expect(existsSync(markerPath)).toBe(false)
  })
})

describe('openclaw plugin: in-process hook call replaces the second node spawn', () => {
  it('serves a real hook decision via the in-process hook lib without ever spawning the poisoned fallback entry', async () => {
    const cwd = mkIsolated()
    const { entryPath, markerPath } = setupPoisonedEntryWithRealHookLib(cwd)
    writeFileSync(join(cwd, 'token-goat-entry.json'), JSON.stringify({ entryPath }), 'utf8')
    // OPENCLAW_PLUGIN_SCRIPT imports definePluginEntry from the (test-unavailable) "openclaw"
    // package. Swap that single import line for a local identity stub -- definePluginEntry's
    // only real job, per its own usage below (`export default definePluginEntry({...})`), is to
    // hand the config object straight through unchanged.
    const transformed = OPENCLAW_PLUGIN_SCRIPT.replace(
      'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";',
      'function definePluginEntry(cfg) { return cfg }',
    )
    expect(transformed).not.toBe(OPENCLAW_PLUGIN_SCRIPT)
    const pluginPath = join(cwd, 'plugin.mjs')
    writeFileSync(pluginPath, transformed, 'utf8')

    const mod = (await import(pathToFileURL(pluginPath).href)) as {
      default: { register: (api: { on: (event: string, handler: (...args: unknown[]) => unknown) => void }) => void }
    }
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    mod.default.register({
      on(event, handler) {
        handlers[event] = handler
      },
    })
    const envPath = makeEnvFixture(cwd)
    const sessionId = 'inprocess-test-' + Math.random().toString(36).slice(2)
    const ctx = { sessionId }

    type BeforeToolCallResult = { block?: boolean; blockReason?: string } | undefined
    const first = (await handlers['before_tool_call']!(
      { toolName: 'read', params: { file_path: envPath } },
      ctx,
    )) as BeforeToolCallResult
    expect(first?.block).toBeFalsy()

    const second = (await handlers['before_tool_call']!(
      { toolName: 'read', params: { file_path: envPath } },
      ctx,
    )) as BeforeToolCallResult
    expect(second?.block).toBe(true)
    expect(second?.blockReason).toContain('already read')

    expect(existsSync(markerPath)).toBe(false)
  })
})

describe('pi extension: in-process hook call replaces the second node spawn', () => {
  it('serves a real hook decision via the in-process hook lib without ever spawning the poisoned fallback entry', async () => {
    const cwd = mkIsolated()
    const { entryPath, markerPath } = setupPoisonedEntryWithRealHookLib(cwd)
    writeFileSync(join(cwd, 'token-goat-entry.json'), JSON.stringify({ entryPath }), 'utf8')
    // PI_EXTENSION_SCRIPT is TypeScript source (type annotations throughout, plus an
    // erasable `import type` for pi's own SDK types). Strip it to plain JS with esbuild --
    // already a project devDependency and the same tool the real build pipeline uses.
    const { code } = transformSync(PI_EXTENSION_SCRIPT, { loader: 'ts', format: 'esm' })
    const extensionPath = join(cwd, 'extension.mjs')
    writeFileSync(extensionPath, code, 'utf8')

    const mod = (await import(pathToFileURL(extensionPath).href)) as {
      default: (pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void; sendMessage: () => void }) => void
    }
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    mod.default({
      on(event, handler) {
        handlers[event] = handler
      },
      sendMessage() {
        // no-op
      },
    })
    const sessionCtx = { cwd, sessionManager: undefined }
    handlers['session_start']!({}, sessionCtx)
    const envPath = makeEnvFixture(cwd)

    type ToolCallResult = { block?: boolean; reason?: string } | undefined
    const first = (await handlers['tool_call']!({ toolName: 'read', input: { path: envPath } }, {})) as ToolCallResult
    expect(first?.block).toBeFalsy()

    const second = (await handlers['tool_call']!({ toolName: 'read', input: { path: envPath } }, {})) as ToolCallResult
    expect(second?.block).toBe(true)
    expect(second?.reason).toContain('already read')

    expect(existsSync(markerPath)).toBe(false)
  })
})
