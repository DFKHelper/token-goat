// HAND-DERIVED: the expected values come from git's own `config --get`, which prints the effective value of a key and exits 1 when it is unset; nothing here reads the helper's matcher.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const QUERY = ['config', '--get', 'core.fsmonitor']

describe('every git a test starts runs with core.fsmonitor=false', () => {
  it('spawnSync', () => {
    const r = spawnSync('git', QUERY, { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('false')
  })

  it('execFileSync', () => {
    expect(execFileSync('git', QUERY, { encoding: 'utf8' }).trim()).toBe('false')
  })

  it('spawn', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', QUERY, { stdio: ['ignore', 'pipe', 'ignore'] })
      let text = ''
      child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', () => resolve(text))
    })
    expect(out.trim()).toBe('false')
  })

  it('execFile with a callback', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('git', QUERY, { encoding: 'utf8' }, (err, stdout) => (err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? reject(err) : resolve(stdout)))
    })
    expect(out.trim()).toBe('false')
  })

  it('a promisified execFile', async () => {
    const { stdout } = await promisify(execFile)('git', QUERY, { encoding: 'utf8' })
    expect(stdout.trim()).toBe('false')
  })

  it('a call that names its own core.fsmonitor keeps its value', () => {
    expect(execFileSync('git', ['-c', 'core.fsmonitor=true', ...QUERY], { encoding: 'utf8' }).trim()).toBe('true')
  })

  it('a git call with its leading options keeps them', () => {
    expect(execFileSync('git', ['-c', 'tgtest.key=value', 'config', '--get', 'tgtest.key'], { encoding: 'utf8' }).trim()).toBe('value')
  })

  it('a git call that passes its own env without this process env still gets it', () => {
    const own: NodeJS.ProcessEnv = { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'] }
    expect(execFileSync('git', QUERY, { encoding: 'utf8', env: own }).trim()).toBe('false')
  })

  it('a caller env that already carries config entries keeps them and gains the fsmonitor one', () => {
    const own = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'tgtest.key', GIT_CONFIG_VALUE_0: 'value' }
    expect(execFileSync('git', ['config', '--get', 'tgtest.key'], { encoding: 'utf8', env: own }).trim()).toBe('value')
    expect(execFileSync('git', QUERY, { encoding: 'utf8', env: own }).trim()).toBe('false')
    expect(own.GIT_CONFIG_COUNT).toBe('1')
  })

  it('a caller env that names core.fsmonitor itself keeps its value', () => {
    const own = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'true' }
    expect(execFileSync('git', QUERY, { encoding: 'utf8', env: own }).trim()).toBe('true')
  })

  it('leaves this process env without any config variable', () => {
    execFileSync('git', QUERY, { encoding: 'utf8' })
    expect(Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('GIT_CONFIG'))).toEqual([])
  })

  it('hands a fake git binary the argv the test wrote and the env entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fsmonitor-fake-'))
    try {
      const fake = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')
      try {
        fs.linkSync(process.execPath, fake)
      } catch {
        fs.copyFileSync(process.execPath, fake)
      }
      const script = 'process.stdout.write(JSON.stringify([process.argv.slice(1), process.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0]))'
      const out = execFileSync(fake, ['-e', script, 'a', 'b'], { encoding: 'utf8' })
      expect(JSON.parse(out)).toEqual([['a', 'b'], '1', 'core.fsmonitor', 'false'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a command that is not git is passed through untouched', () => {
    expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(process.argv.slice(1).join(","))', 'a', 'b'], { encoding: 'utf8' })).toBe('a,b')
  })
})
