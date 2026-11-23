import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { once } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  AV_EXCLUSION_DISCLAIMER,
  checkHarnessSessionStorage,
  checkAntivirusExclusionPosture,
  isPathExcluded,
  measureDirectoryBytes,
  startWindowsDefenderExclusionQuery,
} from '../src/cli_doctor_harness_perf.js'
import { runDoctorChecks } from '../src/cli_doctor.js'
import type * as HookClientModule from '../src/hook_client.js'
import { killProcessTree } from '../src/process_tree.js'

// Event log: Defender query sync/spawn/settle and hook-server status asks, in call order.
const defenderQueries = vi.hoisted(() => ({ events: [] as string[] }))
// Per-row Defender query behaviour: 'real' runs PowerShell, 'hang' runs a child that outlives the deadline, 'throw' fails the spawn.
const defenderOverride = vi.hoisted(() => ({ mode: 'real' as 'real' | 'hang' | 'throw' }))
const defenderChildren = vi.hoisted(() => [] as ChildProcessModule.ChildProcess[])

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const isDefenderQuery = (args: readonly string[]): boolean => args.some((a) => a.includes('Get-MpPreference'))
  return {
    ...real,
    spawn: ((file: string, args: readonly string[], options: ChildProcessModule.SpawnOptions) => {
      if (!isDefenderQuery(args)) return real.spawn(file, args, options)
      defenderQueries.events.push('spawn:defender')
      if (defenderOverride.mode === 'throw') throw new Error('spawn EACCES (test: Defender query)')
      // Exits by itself after 15 s, so a row whose deadline never kills it fails on its exit code, not by hanging.
      const child =
        defenderOverride.mode === 'hang'
          ? real.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 15000)'], options)
          : real.spawn(file, args, options)
      defenderChildren.push(child)
      const settled = (): void => {
        defenderQueries.events.push('defender:settled')
      }
      child.once('error', settled)
      child.once('close', settled)
      return child
    }) as typeof real.spawn,
    spawnSync: ((file: string, args: readonly string[], options: ChildProcessModule.SpawnOptions) => {
      if (isDefenderQuery(args)) defenderQueries.events.push('sync:defender')
      return real.spawnSync(file, args, options)
    }) as typeof real.spawnSync,
  }
})

vi.mock('../src/hook_client.js', async (importOriginal) => {
  const real = await importOriginal<typeof HookClientModule>()
  return {
    ...real,
    serverStatuses: (dir?: string) => {
      defenderQueries.events.push('status:start')
      return real.serverStatuses(dir)
    },
  }
})

describe('cli_doctor_harness_perf', () => {
  it('disclaimer constant contains required label and wording', () => {
    expect(AV_EXCLUSION_DISCLAIMER).toContain('(disclaimer)')
    expect(AV_EXCLUSION_DISCLAIMER).toContain('blind spot')
    expect(AV_EXCLUSION_DISCLAIMER).toContain('security policy')
  })

  it('isPathExcluded correctly matches exact and parent directories case-insensitively', () => {
    const exclusions = [
      'c:\\projects',
      'c:\\users\\testuser\\.copilot',
    ]

    expect(isPathExcluded('C:\\Projects', exclusions)).toBe(true)
    expect(isPathExcluded('c:\\projects\\token-goat', exclusions)).toBe(true)
    expect(isPathExcluded('C:\\Users\\testuser\\.copilot\\session-state', exclusions)).toBe(true)
    expect(isPathExcluded('C:\\Other\\Dir', exclusions)).toBe(false)
  })

  it('measureDirectoryBytes accurately counts files and bytes without infinite loops', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-test-'))
    try {
      fs.writeFileSync(path.join(tmp, 'file1.txt'), 'hello')
      fs.mkdirSync(path.join(tmp, 'sub'))
      fs.writeFileSync(path.join(tmp, 'sub', 'file2.txt'), 'world')

      const res = measureDirectoryBytes(tmp)
      expect(res.fileCount).toBe(2)
      expect(res.sizeBytes).toBe(10)
      expect(res.truncated).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('checkHarnessSessionStorage returns null when sessions under threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-home-'))
    try {
      const copilotDir = path.join(tmp, '.copilot', 'session-state')
      fs.mkdirSync(copilotDir, { recursive: true })
      fs.writeFileSync(path.join(copilotDir, 'small.json'), '{"ok": true}')

      const res = checkHarnessSessionStorage(tmp, 1024 * 1024)
      expect(res).toBeNull()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('checkHarnessSessionStorage warns when session storage exceeds threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-harness-home-large-'))
    try {
      const copilotDir = path.join(tmp, '.copilot', 'session-state')
      fs.mkdirSync(copilotDir, { recursive: true })
      // Create a 50KB file with threshold of 10KB
      fs.writeFileSync(path.join(copilotDir, 'events.jsonl'), Buffer.alloc(50 * 1024))

      const res = checkHarnessSessionStorage(tmp, 10 * 1024)
      expect(res).not.toBeNull()
      expect(res?.status).toBe('warn')
      expect(res?.name).toBe('Harness session storage')
      expect(res?.message).toContain('Copilot CLI')
      expect(res?.message).toContain('High session storage detected')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('checkAntivirusExclusionPosture warns and includes (disclaimer) when paths are not excluded', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-av-home-'))
    const tmpRoot = path.join(tmpHome, 'my-workspace')
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.mkdirSync(path.join(tmpHome, '.copilot'), { recursive: true })

    try {
      // Mock exclusions with completely unrelated path
      const exclusions = ['c:\\other_path']
      const res = checkAntivirusExclusionPosture(tmpRoot, tmpHome, exclusions)

      expect(res).not.toBeNull()
      expect(res?.status).toBe('warn')
      expect(res?.message).toContain('(disclaimer)')
      expect(res?.message).toContain('Not excluded from real-time AV scanning')
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('checkAntivirusExclusionPosture passes when workspace and harness paths are excluded', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-av-home-ok-'))
    const tmpRoot = path.join(tmpHome, 'my-workspace')
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.mkdirSync(path.join(tmpHome, '.copilot'), { recursive: true })

    try {
      const exclusions = [tmpRoot, path.join(tmpHome, '.copilot')]
      const res = checkAntivirusExclusionPosture(tmpRoot, tmpHome, exclusions)

      expect(res).not.toBeNull()
      expect(res?.status).toBe('ok')
      expect(res?.message).toContain('excluded from real-time Defender scanning')
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('doctor starts the Defender exclusion query and never runs it synchronously (Ruling 116)', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-av-async-'))
    defenderQueries.events.length = 0
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await runDoctorChecks(tmp, path.join(tmp, 'config.toml'), tmp, [])
      expect(defenderQueries.events.filter((e) => e === 'sync:defender')).toEqual([])
      expect(defenderQueries.events).toContain('spawn:defender')
    } finally {
      if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('doctor asks the hook servers while the Defender query is still running (Ruling 116 overlap)', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const priorServer = process.env.TOKEN_GOAT_HOOK_SERVER
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-av-overlap-'))
    defenderQueries.events.length = 0
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.TOKEN_GOAT_HOOK_SERVER = '1'
    try {
      await runDoctorChecks(tmp, path.join(tmp, 'config.toml'), tmp, [])
      const events = defenderQueries.events
      const queryAt = events.indexOf('spawn:defender')
      const statusAt = events.indexOf('status:start')
      const settledAt = events.indexOf('defender:settled')
      expect(queryAt, `events: ${events.join(' > ')}`).toBeGreaterThanOrEqual(0)
      expect(statusAt, `events: ${events.join(' > ')}`).toBeGreaterThan(queryAt)
      expect(settledAt, `events: ${events.join(' > ')}`).toBeGreaterThan(statusAt)
    } finally {
      if (priorServer === undefined) delete process.env.TOKEN_GOAT_HOOK_SERVER
      else process.env.TOKEN_GOAT_HOOK_SERVER = priorServer
      if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('ends the Defender query at its deadline, kills its child, and reports no paths (timeout path)', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    defenderOverride.mode = 'hang'
    defenderChildren.length = 0
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let unendedPid: number | undefined
    try {
      const paths = await startWindowsDefenderExclusionQuery()
      expect(paths).toBeNull()
      expect(checkAntivirusExclusionPosture(os.tmpdir(), os.tmpdir(), paths)).toBeNull()
      const child = defenderChildren[0]
      if (child === undefined) throw new Error('the Defender query spawned no child')
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      expect(child.exitCode, 'the deadline must end the child, not its own exit after 15 s').not.toBe(0)
    } finally {
      const stray: ChildProcess | undefined = defenderChildren[0]
      if (stray?.pid !== undefined && stray.exitCode === null && stray.signalCode === null && !killProcessTree(stray.pid).ok) {
        unendedPid = stray.pid
      }
      defenderOverride.mode = 'real'
      if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
    }
    if (unendedPid !== undefined) throw new Error(`could not end the Defender query tree of pid ${unendedPid}`)
  })

  it('reports no paths and no posture row when the Defender query cannot be spawned (throw path)', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    defenderQueries.events.length = 0
    defenderOverride.mode = 'throw'
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const paths = await startWindowsDefenderExclusionQuery()
      expect(paths).toBeNull()
      expect(checkAntivirusExclusionPosture(os.tmpdir(), os.tmpdir(), paths)).toBeNull()
      expect(defenderQueries.events).toContain('spawn:defender')
    } finally {
      defenderOverride.mode = 'real'
      if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
    }
  })
})
