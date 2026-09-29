/** The background worker makes most of token-goat's downloads (the embedding model on the first embed), and Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set too. A machine behind a proxy usually sets only the first, so every download from the worker failed with "fetch failed" and the user had to find the second variable themselves. token-goat starts the worker, so startDetachedWorker completes the pair in the daemon's environment (src/env_proxy.ts). PROVENANCE: FORMAT-DERIVED for the variable names and version floors, from the Node v22.21.0 release notes ("http: support http proxy for fetch under NODE_USE_ENV_PROXY") and nodejs/node#57165, which is where 24.0.0 gained it. CAPTURE for the effect: on node v24.12.0, `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9` makes fetch('https://huggingface.co/') reject with cause ECONNREFUSED 127.0.0.1:9, i.e. the request went to the proxy; without the flag it goes direct. HAND-DERIVED for the table of inputs below. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Replaced with vi.mock rather than spied: Node's ESM namespace bindings for a builtin are not configurable. Nothing is really started.
const state = vi.hoisted(() => ({
  child: { pid: 4242426, unref: (): void => undefined, on: (): void => undefined },
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn(() => state.child) }
})

import { spawn } from 'node:child_process'
import { fetchBypassesProxy, nodeFetchHonoursEnvProxy, proxyConfigured, rerunWithEnvProxy, withEnvProxyEnabled } from '../src/env_proxy.js'
import { startDetachedWorker } from '../src/worker_lifecycle.js'

const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY'] as const

let dataDir: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spawn-proxy-')))
  vi.mocked(spawn).mockClear()
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function spawnedEnv(): NodeJS.ProcessEnv {
  expect(spawn).toHaveBeenCalledTimes(1)
  return (vi.mocked(spawn).mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env
}

describe('startDetachedWorker proxy environment', () => {
  it.runIf(nodeFetchHonoursEnvProxy())('turns on NODE_USE_ENV_PROXY for the daemon when this machine sets a proxy and not the flag', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:3128'
    startDetachedWorker({ dataDir })
    const env = spawnedEnv()
    expect(env['NODE_USE_ENV_PROXY']).toBe('1')
    expect(env['HTTPS_PROXY']).toBe('http://proxy.example:3128')
    // The caller's own environment is not changed, only the daemon's.
    expect(process.env['NODE_USE_ENV_PROXY']).toBeUndefined()
  })

  it('leaves the flag unset when no proxy is configured', () => {
    startDetachedWorker({ dataDir })
    expect(spawnedEnv()['NODE_USE_ENV_PROXY']).toBeUndefined()
  })

  it('keeps a value the user chose, including 0', () => {
    process.env['https_proxy'] = 'http://proxy.example:3128'
    process.env['NODE_USE_ENV_PROXY'] = '0'
    startDetachedWorker({ dataDir })
    expect(spawnedEnv()['NODE_USE_ENV_PROXY']).toBe('0')
  })
})

describe('withEnvProxyEnabled', () => {
  it.each([
    [{ HTTPS_PROXY: 'http://p:1' }, '24.12.0', '1'],
    [{ http_proxy: 'http://p:1' }, '22.21.0', '1'],
    [{ HTTP_PROXY: 'http://p:1' }, '25.0.0', '1'],
    // 22.16 is the engines floor; its fetch cannot use the proxy, so the flag would do nothing there.
    [{ HTTPS_PROXY: 'http://p:1' }, '22.20.9', undefined],
    [{ HTTPS_PROXY: '   ' }, '24.12.0', undefined],
    [{}, '24.12.0', undefined],
    [{ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '' }, '24.12.0', ''],
  ])('%o on Node %s gives NODE_USE_ENV_PROXY=%s', (env, version, expected) => {
    expect(withEnvProxyEnabled(env as NodeJS.ProcessEnv, version)['NODE_USE_ENV_PROXY']).toBe(expected)
  })

  it('returns the same object when there is nothing to add', () => {
    const env = { PATH: '/bin' }
    expect(withEnvProxyEnabled(env, '24.12.0')).toBe(env)
  })

  it.each([
    ['22.16.0', false],
    ['22.20.1', false],
    ['22.21.0', true],
    ['23.11.0', false],
    ['24.0.0', true],
    ['26.1.0', true],
  ])('nodeFetchHonoursEnvProxy(%s) is %s', (version, expected) => {
    expect(nodeFetchHonoursEnvProxy(version)).toBe(expected)
  })

  it('proxyConfigured ignores blank values', () => {
    expect(proxyConfigured({ HTTPS_PROXY: '' })).toBe(false)
    expect(proxyConfigured({ http_proxy: 'http://p:1' })).toBe(true)
  })
})

/** A foreground command cannot turn the flag on for itself (Node reads it once at startup), so its fetch goes around the proxy the worker's goes through. fetchBypassesProxy names that case; rerunWithEnvProxy is how `semantic --warm` and `doctor --repair`, whose whole job is a download the user asked for now, get through anyway: they run again in a child that has the flag. HAND-DERIVED: each row follows from the three conditions, with the version floors as above. */
describe('fetchBypassesProxy', () => {
  const proxy = { HTTPS_PROXY: 'http://proxy.example:3128' }
  it.each([
    ['a proxy, no flag, a Node that honours it', proxy, '24.12.0', true],
    ['a proxy, no flag, 22.21', proxy, '22.21.0', true],
    ['the flag already set', { ...proxy, NODE_USE_ENV_PROXY: '1' }, '24.12.0', false],
    ['the flag set to 0 by the user', { ...proxy, NODE_USE_ENV_PROXY: '0' }, '24.12.0', false],
    ['no proxy', {}, '24.12.0', false],
    ['a Node that cannot use the flag, so the worker is no better off', proxy, '22.20.0', false],
  ] as const)('%s', (_label, env, version, expected) => {
    expect(fetchBypassesProxy(env, version)).toBe(expected)
  })
})

describe('rerunWithEnvProxy', () => {
  const env = { HTTPS_PROXY: 'http://proxy.example:3128' }
  const argv = ['node', '/opt/tg/token-goat.mjs', 'semantic', '--preflight', '--warm']

  it('runs the same command again with NODE_USE_ENV_PROXY=1 and returns its exit code', () => {
    const spawn = vi.fn(() => ({ status: 3 }))
    expect(rerunWithEnvProxy(spawn, argv, env, '24.12.0')).toBe(3)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; stdio: string }]
    expect(command).toBe(process.execPath)
    expect(args.slice(-4)).toEqual(argv.slice(1))
    expect(options.env['NODE_USE_ENV_PROXY']).toBe('1')
    expect(options.env['HTTPS_PROXY']).toBe('http://proxy.example:3128')
    expect(options.stdio).toBe('inherit')
  })

  it('answers null and starts nothing when this process already goes through the proxy, which is also what stops the child running itself again', () => {
    const spawn = vi.fn(() => ({ status: 0 }))
    expect(rerunWithEnvProxy(spawn, argv, { ...env, NODE_USE_ENV_PROXY: '1' }, '24.12.0')).toBeNull()
    expect(rerunWithEnvProxy(spawn, argv, {}, '24.12.0')).toBeNull()
    expect(rerunWithEnvProxy(spawn, argv, env, '22.20.0')).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a child ended by a signal as a failure', () => {
    expect(rerunWithEnvProxy(() => ({ status: null }), argv, env, '24.12.0')).toBe(1)
  })
})
