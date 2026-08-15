/**
 * The Claude Code hook shim must enable V8's compile cache before it import()s the hook bundle.
 *
 * A hook fires on every tool call, and the bundle it loads is ~3.4 MB. Without the cache, V8
 * recompiles that from source every time: profiled at roughly 40 ms of the ~148 ms a hook takes,
 * and worth about 23 ms per invocation end to end, measured twice on the installed shim by
 * interleaving both variants (148 ms against 125 ms, and 186 ms against 163 ms on a busier
 * machine, so the floor moves with load but the saving does not). The call has to live in the shim
 * rather than in the bundle, because a module is compiled before any of its own code runs, so a
 * bundle cannot enable the cache for itself.
 *
 * Two mutations have to fail here, and both do, on measured evidence rather than assumption:
 * removing the call, and relocating it below the `import()` where the bundle has already been
 * compiled. Each drops the cache to zero bytes. `enableCompileCache()` with no argument writes
 * under the temp directory, so pointing the child's temp at a scratch dir makes that directly
 * observable, and the control case pins that this is about the shim rather than the environment.
 *
 * The ordering case is kept anyway, even though the behavioral one already covers it. It states
 * the actual invariant in one line and says why in its failure message, so a future reader who
 * breaks the order is told what they broke rather than being handed a byte count. It reads the
 * emitted script with comments stripped, so prose mentioning either name cannot satisfy or break
 * it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { BUNDLE } from '../helpers/bundle.js'

const ENABLE_LINE = /^.*\brequire\('node:module'\)\.enableCompileCache\(\).*$/m

/** Blanks out `//` and block comments, preserving offsets so positions stay comparable to the original. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

/** Total bytes the shim leaves in an isolated compile cache after one real hook invocation. */
function compileCacheBytes(script: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-cc-'))
  const temp = join(dir, 'temp')
  mkdirSync(temp, { recursive: true })
  const scriptPath = join(dir, 'shim.js')
  writeFileSync(scriptPath, script, 'utf8')

  // The real built entry, so the shim takes its in-process path and imports the real sibling
  // dist/token-goat-hook.mjs -- the 3.4 MB module this whole change is about. A synthetic entry
  // would load nothing large and the cache would be empty no matter what the shim did.
  const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', BUNDLE], {
    cwd: dirname(BUNDLE),
    input: '{"tool_name":"Read","tool_input":{"file_path":"x.ts"},"session_id":"shim-cc"}',
    encoding: 'utf8',
    timeout: 60000,
    // NODE_COMPILE_CACHE must be cleared, not just overridden: the suite sets it globally in
    // globalSetup so spawned bundles share one cache, and if the child inherits it the child
    // caches there instead of here. Both cases then read zero from this directory and the control
    // agrees with the real one for entirely the wrong reason.
    env: { ...process.env, NODE_COMPILE_CACHE: undefined, TMPDIR: temp, TEMP: temp, TMP: temp },
  })
  expect(res.status, `shim exited ${String(res.status)}: ${res.stderr}`).toBe(0)

  const cacheRoot = join(temp, 'node-compile-cache')
  if (!existsSync(cacheRoot)) return 0
  return readdirSync(cacheRoot, { recursive: true, encoding: 'utf8' })
    .map((entry) => statSync(join(cacheRoot, entry)))
    .filter((s) => s.isFile())
    .reduce((sum, s) => sum + s.size, 0)
}

describe('Claude Code hook shim compile cache', () => {
  // 1 MB: the hook bundle's cache entry measured ~1.3 MB, and nothing else the shim loads is
  // remotely that size, so this cannot be satisfied by caching the shim itself.
  const BUNDLE_SCALE_BYTES = 1_000_000

  it('caches the hook bundle, so it is not recompiled on every tool call', () => {
    expect(compileCacheBytes(CLAUDECODE_HOOK_SCRIPT)).toBeGreaterThan(BUNDLE_SCALE_BYTES)
  })

  it('caches nothing once the enabling call is removed, so the above is about the shim', () => {
    expect(ENABLE_LINE.test(CLAUDECODE_HOOK_SCRIPT), 'shim no longer calls enableCompileCache at all').toBe(true)
    expect(compileCacheBytes(CLAUDECODE_HOOK_SCRIPT.replace(ENABLE_LINE, ''))).toBe(0)
  })

  it('enables the cache before it imports the hook bundle, since a module cannot cache itself', () => {
    const code = stripComments(CLAUDECODE_HOOK_SCRIPT)
    const enableAt = code.search(/\benableCompileCache\(\)/)
    const bundleImportAt = code.search(/\bimport\(/)
    expect(enableAt, 'shim never calls enableCompileCache in code (only, perhaps, in a comment)').toBeGreaterThanOrEqual(0)
    expect(bundleImportAt, 'shim no longer import()s the hook bundle at all').toBeGreaterThanOrEqual(0)
    expect(enableAt, 'enableCompileCache runs after the hook bundle is imported, which is too late to cache it').toBeLessThan(bundleImportAt)
  })
})
