/**
 * `uninstall --purge`. Uninstall deliberately leaves the data directories alone, which is right
 * for a reinstall and wrong for offboarding a machine: "remove it by hand" is not something an
 * organisation can put in a runbook when there are two roots and they differ per platform.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { directorySize, formatBytes, purgeDataDirectories, purgeRoots } from '../src/purge.js'

const ENV_KEYS = ['TOKEN_GOAT_HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA'] as const

let root: string
let saved: Record<string, string | undefined>

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-purge-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['TOKEN_GOAT_HOME'] = path.join(root, 'home')
  process.env['XDG_DATA_HOME'] = path.join(root, 'share')
  process.env['LOCALAPPDATA'] = path.join(root, 'share')
  const constants = await import('../src/constants.js')
  constants._resetDataDirCacheForTesting()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  const constants = await import('../src/constants.js')
  constants._resetDataDirCacheForTesting()
  fs.rmSync(root, { recursive: true, force: true })
})

function seed(dir: string, name: string, bytes: number): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), 'x'.repeat(bytes))
}

describe('directorySize', () => {
  it('counts nested files, not just the top level', () => {
    seed(path.join(root, 'a'), 'one.txt', 100)
    seed(path.join(root, 'a', 'b', 'c'), 'two.txt', 50)

    expect(directorySize(path.join(root, 'a'))).toBe(150)
  })

  it('returns zero for a directory that does not exist rather than throwing', () => {
    expect(directorySize(path.join(root, 'missing'))).toBe(0)
  })
})

describe('purgeRoots', () => {
  it('names both roots, because the index and the session state live in different places', () => {
    const roots = purgeRoots()

    expect(roots.length).toBe(2)
    expect(roots.some((r) => r.includes('home'))).toBe(true)
  })

  it('does not list the same root twice when the two resolve to one directory', () => {
    // The collision is built by pointing the home at whatever the data directory resolved to on
    // this platform. Asserting set size equals array length would pass without ever colliding.
    process.env['TOKEN_GOAT_HOME'] = purgeRoots()[0] as string

    expect(purgeRoots().length).toBe(1)
  })
})

describe('purgeDataDirectories', () => {
  it('deletes both roots and reports the bytes each held', () => {
    const home = path.join(root, 'home')
    seed(home, 'session.json', 40)
    const data = purgeRoots().find((r) => r !== home)
    expect(data).toBeDefined()
    seed(data as string, 'index.db', 60)

    const result = purgeDataDirectories()

    expect(result.failed).toEqual([])
    expect(result.removed.map((r) => r.bytes).sort((a, b) => a - b)).toEqual([40, 60])
    expect(fs.existsSync(home)).toBe(false)
    expect(fs.existsSync(data as string)).toBe(false)
  })

  it('reports a root that was never there as absent rather than as removed', () => {
    const result = purgeDataDirectories()

    expect(result.removed).toEqual([])
    expect(result.absent.length).toBe(2)
  })

  it('does not touch anything outside the two roots', () => {
    const bystander = path.join(root, 'someone-elses-data')
    seed(bystander, 'keep.txt', 10)
    seed(path.join(root, 'home'), 'session.json', 10)

    purgeDataDirectories()

    expect(fs.existsSync(path.join(bystander, 'keep.txt'))).toBe(true)
  })
})

describe('formatBytes', () => {
  it('uses the unit the size calls for', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})

// The CLI half. The delete logic above is unit-tested; what a runbook actually depends on is that
// `uninstall --purge` reaches it, and that it refuses while the worker is alive rather than
// deleting files the worker is about to rewrite. The roots come from purgeRoots() rather than a
// hardcoded layout, because the data directory sits somewhere different on every platform.
describe('uninstall --purge through the built bundle', () => {
  const bundle = path.resolve(process.cwd(), 'dist', 'token-goat.mjs')

  function run(): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [bundle, 'uninstall', '--purge'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root },
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  it('deletes the data it finds and says how much it reclaimed', () => {
    const roots = purgeRoots()
    for (const dir of roots) seed(dir, 'payload.bin', 4096)

    const { status, output } = run()

    expect(status).toBe(0)
    expect(output).toContain('reclaimed')
    for (const dir of roots) expect(fs.existsSync(path.join(dir, 'payload.bin'))).toBe(false)
  })

  it('refuses while the worker is running, naming the command that stops it', () => {
    const dataRoot = purgeRoots()[0] as string
    seed(dataRoot, 'payload.bin', 4096)
    fs.writeFileSync(path.join(dataRoot, 'worker.pid'), String(process.pid))
    fs.mkdirSync(path.join(dataRoot, 'queue'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'queue', 'drain-heartbeat'), String(process.pid))

    const { output } = run()

    expect(output).toContain('token-goat worker stop')
    expect(fs.existsSync(path.join(dataRoot, 'payload.bin'))).toBe(true)
  })
})
