/** `uninstall --purge` deletes the data directory but not a hook target a host config still names, and prints what it kept. PROVENANCE: HAND-DERIVED from the failing session (an emptied `native/<hash>/` under a settings file that still ran `tg-hook.exe`: `uv_spawn ENOENT`); the settings shape is what installHooks writes (command string naming the binary, JSON-escaped on Windows). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeFs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A running exe is EPERM or EBUSY on Windows, not portable to provoke: rmSync refuses the paths in this set.
const refused = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  return {
    ...original,
    rmSync: (...args: Parameters<typeof original.rmSync>) => {
      if (refused.has(String(args[0]))) {
        const busy = new Error(`EBUSY: resource busy or locked, unlink '${String(args[0])}'`)
        throw Object.assign(busy, { code: 'EBUSY' })
      }
      return original.rmSync(...args)
    },
  }
})

import { dataDir } from '../src/constants.js'
import { purgeDataDirectories } from '../src/purge.js'

const ENV_KEYS = ['TOKEN_GOAT_HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR'] as const

let root: string
let saved: Record<string, string | undefined>
let origCwd: string

beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-purge-native-')))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  origCwd = process.cwd()
  process.env['TOKEN_GOAT_HOME'] = path.join(root, 'home')
  process.env['XDG_DATA_HOME'] = path.join(root, 'share')
  process.env['LOCALAPPDATA'] = path.join(root, 'share')
  process.env['CLAUDE_CONFIG_DIR'] = path.join(root, 'claude')
  fs.mkdirSync(path.join(root, 'project'), { recursive: true })
  process.chdir(path.join(root, 'project'))
  const constants = await import('../src/constants.js')
  constants._resetDataDirCacheForTesting()
})

afterEach(async () => {
  refused.clear()
  process.chdir(origCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  const constants = await import('../src/constants.js')
  constants._resetDataDirCacheForTesting()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Two native copies and an index file under the data directory; returns the copy a config will name and the one it will not. */
function seedData(): { named: string; unnamed: string; index: string } {
  const named = path.join(dataDir(), 'native', 'aaaa', 'tg-hook.exe')
  const unnamed = path.join(dataDir(), 'native', 'bbbb', 'tg-hook.exe')
  const index = path.join(dataDir(), 'index.db')
  for (const f of [named, unnamed, index]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, 'x')
  }
  return { named, unnamed, index }
}

function writeUserSettings(text: string): string {
  const file = path.join(root, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

describe('purge and the hook targets configs name', () => {
  it('keeps a native copy a settings file names, removes the rest, and says why', () => {
    const { named, unnamed, index } = seedData()
    const settings = writeUserSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${named}" --harness claudecode` }] }] } }))
    const result = purgeDataDirectories()
    expect(fs.existsSync(named)).toBe(true)
    expect(fs.existsSync(unnamed)).toBe(false)
    expect(fs.existsSync(index)).toBe(false)
    expect(result.kept!.map((k) => k.path)).toEqual([named])
    expect(result.kept![0]!.reason).toContain(settings)
    expect(result.failed).toEqual([])
  })

  it('keeps every native copy, and still purges the index, when a config cannot be parsed', () => {
    const { named, unnamed, index } = seedData()
    writeUserSettings('{ "hooks": ')
    const result = purgeDataDirectories()
    expect(fs.existsSync(named)).toBe(true)
    expect(fs.existsSync(unnamed)).toBe(true)
    expect(fs.existsSync(index)).toBe(false)
    expect(result.kept!.map((k) => k.path).sort()).toEqual([named, unnamed].sort())
    expect(result.kept![0]!.reason).toContain('could not be checked')
  })

  it('finishes the purge and names the file when rmSync refuses a running exe (EBUSY)', () => {
    const { named, unnamed, index } = seedData()
    const command = `"${named}" --harness claudecode`
    writeUserSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }))
    refused.add(unnamed)
    const result = purgeDataDirectories()
    expect(result.failed.map((f) => f.path)).toEqual([unnamed])
    expect(result.failed[0]!.reason).toContain('EBUSY')
    expect(fs.existsSync(unnamed)).toBe(true)
    expect(fs.existsSync(index)).toBe(false)
    expect(fs.existsSync(named)).toBe(true)
  })

  it('removes the whole data directory when no config names anything in it', () => {
    const { named, index } = seedData()
    writeUserSettings(JSON.stringify({ theme: 'dark' }))
    const result = purgeDataDirectories()
    expect(fs.existsSync(named)).toBe(false)
    expect(fs.existsSync(index)).toBe(false)
    expect(fs.existsSync(dataDir())).toBe(false)
    expect(result.kept).toEqual([])
  })
})
