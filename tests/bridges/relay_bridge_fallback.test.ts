/** The relay bridges (the opencode/openclaw block, and pi) run a hook by importing the install-time library,
 * or spawning the baked entry, or spawning `token-goat` from PATH. These rows pin that a failed entry run falls
 * back to PATH inside one budget, and that a block is accepted only from a clean run. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PI_EXTENSION_SCRIPT } from '../../src/bridges/pi.js'
import { BRIDGE_RELAY_JS } from '../../src/bridges/relay_block.js'
import { SHIM_FALLBACK_TIMEOUT_MS } from '../../src/bridges/shim_common.js'
import { expandShortPath } from '../../src/paths.js'

type Answer = Record<string, unknown> | null
type Opts = Record<string, unknown>
type SpawnCall = { command: string; args: unknown; options: Opts }
type SpawnResult = { status: number | null; stdout: string }
type Bridge = { name: string; cap: number; load: (dir: string) => Promise<(event: string) => Promise<Answer>> }

const SPAWN_SLOT = '__tgSpawnImpl'
const slot = globalThis as Record<string, unknown>
const tempDirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete slot[SPAWN_SLOT]
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function mkDir(): string {
  const raw = mkdtempSync(join(tmpdir(), 'tg-relay-fallback-'))
  const dir = expandShortPath(raw.replace(/\\/g, '/'))
  tempDirs.push(dir)
  return dir
}

/** Splits spawnSync's two call shapes (command, args, options) and (command, options). */
function optionsOf(args: unknown, options: Opts | undefined): Opts {
  return (Array.isArray(args) ? options : (args as Opts)) ?? {}
}

/** Imports the generated relay block as a module, with spawnSync routed through the spawn slot. */
async function loadRelayBlock(dir: string): Promise<(event: string) => Promise<Answer>> {
  const header = `import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const spawnSync = (...a) => globalThis.${SPAWN_SLOT}(...a)
`
  const file = join(dir, 'relay_block.mjs')
  writeFileSync(file, `${header}${BRIDGE_RELAY_JS}\nexport { callHook }\n`, 'utf8')
  type Mod = { callHook: (e: string, p: unknown) => Promise<Answer> }
  const mod = (await import(pathToFileURL(file).href)) as Mod
  return (event) => mod.callHook(event, { session_id: 's' })
}

type PiHandler = (...a: unknown[]) => unknown
type PiHost = { on: (e: string, h: PiHandler) => void; sendMessage: () => void }

/** Imports pi's extension and drives its pre-tool hook; a block comes back as the hook answer shape. */
async function loadPi(dir: string): Promise<(event: string) => Promise<Answer>> {
  const { code } = transformSync(PI_EXTENSION_SCRIPT, { loader: 'ts', format: 'esm' })
  const importLine = /import \{ spawnSync \} from "node:child_process";?/
  const patched = code.replace(importLine, `const spawnSync = (...a) => globalThis.${SPAWN_SLOT}(...a);`)
  expect(patched, 'the spawnSync import was replaced').not.toBe(code)
  const file = join(dir, 'pi_extension.mjs')
  writeFileSync(file, patched, 'utf8')
  const mod = (await import(pathToFileURL(file).href)) as { default: (pi: PiHost) => void }
  const handlers: Record<string, PiHandler> = {}
  mod.default({ on: (e, h) => { handlers[e] = h }, sendMessage: () => undefined })
  handlers['session_start']!({}, { cwd: dir, sessionManager: undefined })
  return async () => {
    const event = { toolName: 'read', input: { path: join(dir, 'a.txt') } }
    type Res = { block?: boolean; reason?: unknown } | undefined
    const res = (await handlers['tool_call']!(event, { cwd: dir })) as Res
    return res?.block ? { decision: 'block', reason: res.reason } : null
  }
}

const BRIDGES: Bridge[] = [
  { name: 'relay_block', cap: SHIM_FALLBACK_TIMEOUT_MS.relay, load: loadRelayBlock },
  { name: 'pi', cap: SHIM_FALLBACK_TIMEOUT_MS.pi, load: loadPi },
]

const ROUTE_ANSWER = { decision: 'block', reason: 'from the route' }
const BLOCK_JSON = JSON.stringify(ROUTE_ANSWER)

/** Routes spawnSync to the real one, recorded, with the stub dir put first on the child's PATH. */
function useRealSpawn(stubDir: string): SpawnCall[] {
  const calls: SpawnCall[] = []
  slot[SPAWN_SLOT] = (command: string, args: unknown, options?: Opts) => {
    const opts = optionsOf(args, options)
    calls.push({ command, args, options: opts })
    const env = { ...((opts['env'] as NodeJS.ProcessEnv | undefined) ?? process.env) }
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[key] = `${stubDir}${delimiter}${env[key] ?? ''}`
    const real = { ...opts, env }
    return Array.isArray(args) ? spawnSync(command, args, real) : spawnSync(command, real)
  }
  return calls
}

/** Routes spawnSync to `fake`, recording each call. */
function useFakeSpawn(fake: (calls: SpawnCall[]) => SpawnResult): SpawnCall[] {
  const calls: SpawnCall[] = []
  slot[SPAWN_SLOT] = (command: string, args: unknown, options?: Opts) => {
    calls.push({ command, args, options: optionsOf(args, options) })
    return fake(calls)
  }
  return calls
}

/** Writes a `token-goat` stub (cmd on Windows, sh elsewhere) that records it ran and prints `stdout`. */
function writePathStub(dir: string, stdout: string): { stubDir: string; marker: string } {
  const stubDir = join(dir, 'stub-bin')
  mkdirSync(stubDir)
  const marker = join(dir, 'path-stub-ran.txt')
  const js = join(stubDir, 'stub.cjs')
  writeFileSync(js, printerScript(stdout, marker), 'utf8')
  if (process.platform === 'win32') {
    writeFileSync(join(stubDir, 'token-goat.cmd'), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, 'utf8')
  } else {
    const sh = join(stubDir, 'token-goat')
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf8')
    chmodSync(sh, 0o755)
  }
  return { stubDir, marker }
}

/** A node script that drains stdin, optionally writes a marker, prints `stdout` and exits with `exitCode`. */
function printerScript(stdout: string, marker?: string, exitCode = 0): string {
  const mark = marker ? `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n` : ''
  const done = `process.stdout.write(${JSON.stringify(stdout)}, () => process.exit(${exitCode}))`
  return `${mark}process.stdin.resume()\nprocess.stdin.on('end', () => ${done})\n`
}

function writeEntry(dir: string, source: string): string {
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, source, 'utf8')
  writeFileSync(join(dir, 'token-goat-entry.json'), JSON.stringify({ entryPath: entry }), 'utf8')
  return entry
}

describe.each(BRIDGES)('$name: a failed entry spawn falls back to the PATH spawn', ({ load, cap }) => {
  it('an entry path that is a directory gives the PATH answer', async () => {
    const dir = mkDir()
    const entryDir = join(dir, 'entry-is-a-dir')
    mkdirSync(entryDir)
    writeFileSync(join(dir, 'token-goat-entry.json'), JSON.stringify({ entryPath: entryDir }), 'utf8')
    const { stubDir, marker } = writePathStub(dir, BLOCK_JSON)
    const calls = useRealSpawn(stubDir)
    const answer = await (await load(dir))('pre_tool_use')
    expect(answer, 'the PATH answer after a directory entry').toEqual(ROUTE_ANSWER)
    expect(existsSync(marker), 'the PATH stub ran').toBe(true)
    expect(calls.length, 'entry spawn then PATH spawn').toBe(2)
  })

  it('an entry that exits 1 with no output gives the PATH answer', async () => {
    const dir = mkDir()
    writeEntry(dir, 'process.exit(1)\n')
    useRealSpawn(writePathStub(dir, BLOCK_JSON).stubDir)
    const answer = await (await load(dir))('pre_tool_use')
    expect(answer, 'the PATH answer after a failed entry').toEqual(ROUTE_ANSWER)
  })

  it('an entry that works is used and the PATH stub is not run', async () => {
    const dir = mkDir()
    const fromEntry = { decision: 'block', reason: 'from the entry' }
    writeEntry(dir, printerScript(JSON.stringify(fromEntry)))
    const { stubDir, marker } = writePathStub(dir, BLOCK_JSON)
    const calls = useRealSpawn(stubDir)
    expect(await (await load(dir))('pre_tool_use'), 'the entry answer').toEqual(fromEntry)
    expect(existsSync(marker), 'the PATH stub did not run').toBe(false)
    expect(calls.length, 'one spawn only').toBe(1)
  })

  it('both routes failing gives null', async () => {
    const dir = mkDir()
    writeEntry(dir, 'process.exit(1)\n')
    useRealSpawn(writePathStub(dir, '').stubDir)
    expect(await (await load(dir))('pre_tool_use'), 'null when both routes fail').toBeNull()
  })

  it('the PATH spawn gets only the budget the entry spawn left', async () => {
    const dir = mkDir()
    writeEntry(dir, '')
    let now = 5_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const calls = useFakeSpawn((made) => {
      if (made.length === 1) now += 1_000
      return { status: 1, stdout: '' }
    })
    await (await load(dir))('pre_tool_use')
    const timeouts = calls.map((c) => c.options['timeout'])
    expect(timeouts, 'entry gets the whole budget, PATH what is left').toEqual([cap, cap - 1_000])
  })

  it('no PATH spawn happens once the entry spawn spent the whole budget', async () => {
    const dir = mkDir()
    writeEntry(dir, '')
    let now = 5_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const calls = useFakeSpawn(() => {
      now += cap
      return { status: 1, stdout: '' }
    })
    expect(await (await load(dir))('pre_tool_use')).toBeNull()
    expect(calls.length, 'only the entry spawn ran').toBe(1)
  })
})
