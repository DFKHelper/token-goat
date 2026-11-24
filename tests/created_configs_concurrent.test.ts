/** Two real processes recording at once must both keep every entry: the ledger update is locked. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import type * as NodeFs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dataDirForHome } from '../src/constants.js'
import { normalizePath } from '../src/paths.js'
import { CAN_JUNCTION } from './helpers/can-symlink.js'

// Every path existsSync is asked about, to show backup removal does not check before it unlinks (CodeQL #424).
const existsAsked = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  return {
    ...original,
    existsSync: (p: Parameters<typeof original.existsSync>[0]) => {
      existsAsked.push(String(p))
      return original.existsSync(p)
    },
  }
})

const ROOT = path.resolve(__dirname, '..')
const SRC = (file: string): string => JSON.stringify(pathToFileURL(path.join(ROOT, 'src', file)).href)
const PER_WRITER = 40

let TMP: string
const children: ChildProcess[] = []

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-created-concurrent-'))
})

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.pid !== undefined) {
      const kill = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      kill.on('error', () => child.kill())
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITEST_ALLOW_REAL_DATA_DIR: '1',
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  }
  if (process.platform === 'darwin') delete env['XDG_DATA_HOME']
  return env
}

function runWriter(script: string, home: string, tag: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const argv = ['--import', 'tsx', script, tag, String(PER_WRITER)]
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']
    const child = spawn(process.execPath, argv, { cwd: ROOT, env: childEnv(home), stdio })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`writer ${tag} exited ${code}: ${err}`))
    })
  })
}

function writeScript(): string {
  const script = path.join(TMP, 'writer.mjs')
  fs.writeFileSync(
    script,
    [
      `import { recordCreatedConfig } from ${SRC('bridges/created_configs.ts')}`,
      `import { dataDir } from ${SRC('constants.ts')}`,
      `const [tag, n] = process.argv.slice(2)`,
      `for (let i = 0; i < Number(n); i++) recordCreatedConfig(process.cwd() + '/zz-' + tag + '/f' + i)`,
      `console.log('DATADIR=' + dataDir())`,
    ].join('\n'),
  )
  return script
}

describe('created-configs ledger under concurrent writers', () => {
  it('keeps every entry when two real processes record at once', async () => {
    const home = path.join(TMP, 'home')
    // The lock file needs the data directory to exist; a fresh machine's first write runs unlocked.
    const dir = dataDirForHome(home)
    fs.mkdirSync(dir, { recursive: true })
    const script = writeScript()
    const [a, b] = await Promise.all([runWriter(script, home, 'a'), runWriter(script, home, 'b')])
    expect(/DATADIR=(.+)/.exec(a)?.[1]?.trim(), `writer output: ${a} | ${b}`).toBe(dir)
    const ledgerFile = path.join(dir, 'created-configs.json')
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) as string[]
    const mine = (tag: string): string[] => ledger.filter((e) => e.includes(`/zz-${tag}/`))
    expect(mine('a')).toHaveLength(PER_WRITER)
    expect(mine('b')).toHaveLength(PER_WRITER)
    expect(fs.existsSync(`${ledgerFile}.lock`)).toBe(false)
  }, 60_000)

  it('removes a recorded backup that is already gone without a check-then-use on it', async () => {
    const created = await import('../src/bridges/created_configs.js')
    const config = path.join(TMP, 'settings.json')
    created.recordCreatedBackup(`${config}.bak.2026-01-01T00-00-00-000Z`)
    existsAsked.length = 0
    expect(created.removeCreatedBackups(config)).toBe(0)
    expect(created.createdBackupsFor(config)).toEqual([])
    expect(existsAsked.filter((p) => p.includes('.bak.'))).toEqual([])
  })

  it('still reads a ledger written by an older build (a plain JSON list of strings)', async () => {
    const { hasCreatedConfig } = await import('../src/bridges/created_configs.js')
    const { dataDir } = await import('../src/constants.js')
    fs.mkdirSync(dataDir(), { recursive: true })
    const target = path.join(TMP, 'old-shape.json')
    const ledgerFile = path.join(dataDir(), 'created-configs.json')
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : null
    try {
      fs.writeFileSync(ledgerFile, `${JSON.stringify([target.replace(/\\/g, '/')])}\n`)
      expect(hasCreatedConfig(target)).toBe(true)
    } finally {
      if (before === null) fs.rmSync(ledgerFile, { force: true })
      else fs.writeFileSync(ledgerFile, before)
    }
  })

  it.skipIf(process.platform !== 'win32' || !CAN_JUNCTION)('normalizes legacy marker paths through an 8.3-style alias', async () => {
    const created = await import('../src/bridges/created_configs.js')
    const { hasCreatedConfig, takeCreatedRootKey, takeHookConfig, takeTurnedOffSetting } = created
    const { dataDir } = await import('../src/constants.js')
    fs.mkdirSync(dataDir(), { recursive: true })
    const realHome = path.join(TMP, 'long-profile')
    const aliasHome = path.join(TMP, 'RUNNER~1')
    fs.mkdirSync(realHome)
    fs.symlinkSync(realHome, aliasHome, 'junction')
    const rawTarget = path.join(realHome, 'settings.json')
    fs.writeFileSync(rawTarget, '{}\n')
    const target = fs.realpathSync.native(rawTarget)
    const legacy = path.join(aliasHome, 'settings.json').replace(/\\/g, '/')
    expect(normalizePath(legacy)).toBe(normalizePath(target))

    const ledgerFile = path.join(dataDir(), 'created-configs.json')
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : null
    try {
      fs.writeFileSync(
        ledgerFile,
        `${JSON.stringify([
          legacy,
          `${legacy}#root-key=servers`,
          `${legacy}#hook-config`,
          `${legacy}#turned-off=hooks:true`,
        ])}\n`,
      )
      expect(hasCreatedConfig(target)).toBe(true)
      expect(takeCreatedRootKey(target, 'servers')).toBe(true)
      expect(takeHookConfig(target)).toBe(true)
      expect(takeTurnedOffSetting(target, 'hooks')).toBe(true)
    } finally {
      if (before === null) fs.rmSync(ledgerFile, { force: true })
      else fs.writeFileSync(ledgerFile, before)
    }
  })
})
