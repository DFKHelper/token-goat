// Provenance: HAND-DERIVED; vi.doMock makes the guard import in hooks_bash.ts throw.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { walkRefusal as walkRefusalType } from '../src/hooks_bash.js'
import * as realStats from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

const event = (command: string) =>
  makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: 'walk-load-row', raw: {} })

describe('walk guard load failure is recorded and still allows', () => {
  afterEach(() => {
    vi.doUnmock('../src/unbounded_walk.js')
    vi.doUnmock('../src/stats.js')
    vi.resetModules()
  })

  type Loaded = { walkRefusal: typeof walkRefusalType; stat: ReturnType<typeof vi.fn> }
  async function loadWithFailingGuard(): Promise<Loaded> {
    const stat = vi.fn()
    vi.resetModules()
    vi.doMock('../src/unbounded_walk.js', () => {
      throw new Error('chunk missing')
    })
    vi.doMock('../src/stats.js', async (importOriginal) => ({
      ...(await importOriginal<typeof realStats>()),
      recordStat: stat,
    }))
    const { walkRefusal } = await import('../src/hooks_bash.js')
    return { walkRefusal, stat }
  }

  it('answers null (allow) and records walk_guard_load_failed once, with no command text', async () => {
    const { walkRefusal, stat } = await loadWithFailingGuard()
    expect(await walkRefusal(event('find / -name secret-token-name'))).toBeNull()
    expect(stat.mock.calls).toEqual([['walk_guard_load_failed', 0, 0]])
  })

  it('records nothing for a command the prefilter never sends to the guard', async () => {
    const { walkRefusal, stat } = await loadWithFailingGuard()
    expect(await walkRefusal(event('git status'))).toBeNull()
    expect(stat).not.toHaveBeenCalled()
  })

  it('still allows when the stat itself cannot be written', async () => {
    const { walkRefusal, stat } = await loadWithFailingGuard()
    stat.mockImplementation(() => {
      throw new Error('db locked')
    })
    expect(await walkRefusal(event('find / -name x'))).toBeNull()
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('files the kind under the other source, registered explicitly', () => {
    expect(realStats.isRegisteredKind('walk_guard_load_failed')).toBe(true)
    expect(realStats.kindToSource('walk_guard_load_failed')).toBe(realStats.SOURCE_OTHER)
  })
})

// Provenance: HAND-DERIVED; the commands are data for the guard and never run.
describe('walk guard judges a walker with no start by the hook cwd', () => {
  const walkers = ['du', 'ls *.zzz | xargs du', 'rg -l foo | xargs du -sh']
  const eventIn = (command: string, raw: Record<string, unknown>) =>
    makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: 'walk-cwd-row', raw })
  const refused = async (command: string, raw: Record<string, unknown>) => {
    const { walkRefusal } = await import('../src/hooks_bash.js')
    return (await walkRefusal(eventIn(command, raw))) !== null
  }

  const rootCwds = [
    ['slash root', '/'],
    ['drive root', 'C:/'],
    ['drive root, backslash', 'C:\\'],
    ['home', homedir()],
    ['home, trailing slash', homedir() + '/'],
  ] as const
  for (const [label, cwd] of rootCwds) {
    for (const cmd of walkers) {
      it(`refuses ${cmd} with cwd at ${label}`, async () => {
        expect(await refused(cmd, { cwd })).toBe(true)
      })
    }
  }

  for (const cmd of walkers) {
    it(`allows ${cmd} with cwd at a project under home`, async () => {
      expect(await refused(cmd, { cwd: join(homedir(), 'proj') })).toBe(false)
    })
    it(`allows ${cmd} with cwd absent, empty or not a string`, async () => {
      expect(await refused(cmd, {})).toBe(false)
      expect(await refused(cmd, { cwd: '' })).toBe(false)
      expect(await refused(cmd, { cwd: 7 })).toBe(false)
    })
  }

  it('allows a bounded command at every cwd', async () => {
    for (const cwd of ['/', 'C:/', homedir(), join(homedir(), 'proj')]) {
      expect(await refused('du -sh src', { cwd })).toBe(false)
    }
  })
})
